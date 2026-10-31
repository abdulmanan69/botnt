/* Bootstrap: session, routing, chrome, shortcuts, socket wiring. */

import * as store from './store.js';
import { start, href, go } from './router.js';
import { connect, onEvent } from './socket.js';
import { api, url } from './api.js';
import { esc, initials } from './format.js';
import { toast, modal, cancelModal } from './ui.js';
import { overview } from './views/overview.js';
import { fleet } from './views/fleet.js';
import { host } from './views/host.js';
import { payloads } from './views/payloads.js';
import { activity } from './views/activity.js';
import { environment } from './views/environment.js';
import * as palette from './palette.js';

const VIEWS = { overview, fleet, host, payloads, activity, environment };
const TITLES = { overview: 'Overview', fleet: 'Fleet', host: 'Host', payloads: 'Payloads',
  activity: 'Activity', environment: 'Environment' };

let mounted = null;

function crumbs(route) {
  const box = document.getElementById('crumbs');
  const s = route.id ? store.get(route.id) : null;
  box.innerHTML = `<a href="${href.overview()}">Phantom</a><span class="sep">/</span>`
    + `<strong>${esc(TITLES[route.view])}</strong>`
    + (s ? `<span class="sep">/</span><a class="ellip" href="${href.host(s.id, route.tool)}">${esc(s.host?.hostname || s.id)}</a>`
      + `<span class="sep">/</span><span>${esc(route.tool)}</span>` : '');
  document.title = s ? `${s.host?.hostname || 'host'} · Phantom` : `${TITLES[route.view]} · Phantom`;
}

function chrome() {
  const c = store.counts();
  const conn = document.getElementById('conn');
  conn.className = 'conn' + (store.state.conn === 'live' ? ' live' : store.state.conn === 'down' ? ' down' : '');
  conn.querySelector('b').textContent = store.state.conn === 'live' ? 'live'
    : store.state.conn === 'down' ? 'reconnecting' : 'connecting';

  const nav = document.getElementById('nav-fleet');
  nav.hidden = !c.total;
  nav.textContent = c.online ? `${c.online}/${c.total}` : c.total;

  const bell = document.getElementById('bell-count');
  bell.hidden = !store.state.unread;
  bell.textContent = store.state.unread;

  const act = document.getElementById('nav-activity');
  act.hidden = !store.state.unread;
  act.textContent = store.state.unread;
}

function render() {
  const route = store.state.route;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === route.view));
  chrome();
  crumbs(route);

  const key = route.view + (route.view === 'host' ? ':' + route.id + ':' + route.tool : '');
  const el = document.getElementById('view-' + route.view);
  if (!el) return;

  if (mounted && mounted.key === key) { mounted.mod.update?.(el, route, mounted.ctx); return; }
  if (mounted) {
    const prev = document.getElementById('view-' + mounted.view);
    if (prev) {
      mounted.mod.unmount?.(prev, store.state.route, mounted.ctx);
      prev.hidden = true; prev.classList.remove('on'); prev.innerHTML = '';
    }
  }
  document.querySelectorAll('.view').forEach((v) => { v.hidden = true; v.classList.remove('on'); });
  el.hidden = false;
  el.classList.add('on');
  const ctx = { timers: [] };
  mounted = { key, view: route.view, mod: VIEWS[route.view], ctx };
  VIEWS[route.view].mount(el, route, ctx);
  document.getElementById('main').scrollTop = 0;
}

function tick() {
  store.state.now = Date.now();
  store.emit();
}

onEvent((msg) => {
  if (msg.type === 'new_session') toast(`${msg.session?.host?.hostname || 'a host'} checked in`);
  if (msg.type === 'drop') toast(`${store.get(msg.session_id)?.host?.hostname || 'host'} went away`, 'warn');
  if (msg.type === 'blob' && msg.blob?.kind === 'file') addDownload(msg.blob);
});

function addDownload(blob) {
  const bar = document.getElementById('downloads');
  const a = document.createElement('a');
  a.href = url.blob(blob.url); a.textContent = blob.name; a.download = blob.name;
  document.getElementById('dl-list').prepend(a);
  bar.hidden = false;
}

const SHORTCUTS = [
  ['Ctrl / ⌘ K', 'Command palette'],
  ['/', 'Focus fleet filter'],
  ['g then o', 'Overview'],
  ['g then f', 'Fleet'],
  ['g then p', 'Payloads'],
  ['g then a', 'Activity'],
  ['g then e', 'Environment'],
  ['?', 'This sheet'],
  ['Esc', 'Close overlay'],
];

function help() {
  modal({
    title: 'Keyboard shortcuts', icon: 'i-help',
    body: `<dl class="kv">${SHORTCUTS.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`,
    actions: [{ label: 'Close', kind: 'primary', value: true }],
  });
}

let prefix = null;
let prefixTimer = null;

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (palette.isOpen()) palette.close(); else palette.open();
    return;
  }
  if (e.key === 'Escape') { cancelModal(); if (palette.isOpen()) palette.close(); return; }
  if (typing || palette.isOpen()) return;

  if (e.key === '?') { e.preventDefault(); help(); return; }
  if (e.key === '/') {
    e.preventDefault();
    if (store.state.route.view !== 'fleet') go(href.fleet());
    setTimeout(() => document.getElementById('fq')?.focus(), 40);
    return;
  }
  if (prefix === 'g') {
    prefix = null;
    const map = { o: href.overview(), f: href.fleet(), p: href.payloads(),
      a: href.activity(), e: href.environment() };
    if (map[e.key]) { e.preventDefault(); go(map[e.key]); }
    return;
  }
  if (e.key === 'g') {
    prefix = 'g';
    clearTimeout(prefixTimer);
    prefixTimer = setTimeout(() => { prefix = null; }, 1200);
  }
});

async function logout() {
  try { await api.logout(); } catch { /* ignore */ }
  location.href = '/login';
}

async function boot() {
  let me;
  try {
    me = await api.me();
  } catch {
    return;
  }
  store.state.me = me;
  if (!me.auth_required) {
    document.getElementById('user-role').textContent = 'no auth configured';
  }
  document.getElementById('user-name').textContent = me.user || 'operator';
  document.getElementById('user-initials').textContent = initials({ host: { hostname: me.user || 'op' } });

  try {
    const [cfg, tools, builds] = await Promise.all([api.config(), api.tools(), api.builds()]);
    store.state.config = cfg;
    store.state.tools = tools;
    store.state.builds = builds || [];
    document.getElementById('ws-endpoint').textContent = (cfg.callback || '').replace(/^https?:\/\//, '');
  } catch (err) {
    toast('could not load the control plane config: ' + err.message, 'bad');
  }
  try { store.state.events = (await api.events()).slice().reverse(); } catch { /* ignore */ }

  document.getElementById('omni').onclick = () => palette.open();
  document.getElementById('palette-btn').onclick = () => palette.open();
  document.getElementById('shortcuts').onclick = help;
  document.getElementById('bell').onclick = () => go(href.activity());
  document.getElementById('user-btn').onclick = logout;

  palette.init();
  store.subscribe(render);
  start();
  connect();
  setInterval(tick, 1000);
  store.log('boot', 'console opened');
}

boot();
