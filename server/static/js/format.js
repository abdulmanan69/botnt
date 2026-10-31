/* Pure formatting + derivation helpers. No DOM, no state. */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function bytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts * 1000) / 1000));
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

export const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
export const clockMs = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });
export const stamp = (d = new Date()) => d.toISOString().slice(11, 19);

export const initials = (s) => String(s.host?.hostname || s.host?.ip || s.remote || '??')
  .replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '??';

export const titleCase = (s) => String(s || '').replace(/[-_]/g, ' ')
  .replace(/^\w/, (c) => c.toUpperCase());

/* Presence is derived, never trusted from the wire: a host is "online" only
   while its next beacon window is still open. */
export const ONLINE = 'online', IDLE = 'idle', STALE = 'stale', OFFLINE = 'offline';

export function graceMs(s) {
  return Math.max(12000, ((Number(s.sleep) || 3) * 1.6 + 5) * 1000);
}

export function presence(s, now = Date.now()) {
  const age = now - (s.last_seen || 0) * 1000;
  if (age <= graceMs(s)) return ONLINE;
  if (age <= 120000) return IDLE;
  if (age <= 900000) return STALE;
  return OFFLINE;
}

/* 0..1 progress through the expected beacon window. */
export function beaconProgress(s, now = Date.now()) {
  const span = ((Number(s.sleep) || 3) * 1000) + ((Number(s.jitter) || 0) / 100 * 500);
  const age = now - (s.last_seen || 0) * 1000;
  return Math.min(1, Math.max(0, age / span));
}

export const STATE_LABEL = { online: 'Online', idle: 'Idle', stale: 'Stale', offline: 'Offline' };
export const STATE_ORDER = { online: 0, idle: 1, stale: 2, offline: 3 };

export const isWin = (s) => /win/i.test(s.host?.os || '');
export const isNix = (s) => /linux|darwin|bsd|mac/i.test(s.host?.os || '');
export const osLabel = (s) => String(s.host?.os || 'unknown').replace(/\//g, ' · ');

export function clip(text, n = 120) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export const num = (n) => Number(n || 0).toLocaleString();

export function parsePath(path, win) {
  const sep = win ? '\\' : '/';
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  const out = [];
  if (win) {
    const root = `${parts[0] || 'C:'}\\`;
    let acc = root;
    for (const p of parts.slice(1)) {
      acc = acc.endsWith(sep) ? acc + p : acc + sep + p;
      out.push({ name: p, path: acc });
    }
    return { root, parts: out };
  }
  let acc = '';
  for (const p of parts) {
    acc += sep + p;
    out.push({ name: p, path: acc });
  }
  return { root: '/', parts: out };
}

export function joinPath(base, name, win) {
  const sep = win ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

export function dirname(path, win) {
  const sep = win ? '\\' : '/';
  const trimmed = String(path || '').replace(/[\\/]+$/, '');
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return win ? `${trimmed.slice(0, 2)}\\` : '/';
  return trimmed.slice(0, idx) || sep;
}
