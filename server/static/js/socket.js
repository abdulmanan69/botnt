/* Live socket: snapshot + incremental events, autoreconnect with backoff. */

import { TOKEN } from './api.js';
import * as store from './store.js';
import { clip } from './format.js';

let ws = null;
let tries = 0;
let timer = null;

const listeners = new Set();
export const onEvent = (fn) => (listeners.add(fn), () => listeners.delete(fn));

function schedule() {
  clearTimeout(timer);
  const wait = Math.min(15000, 900 * 2 ** tries++);
  store.setConn('down');
  timer = setTimeout(connect, wait);
}

export function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));

  ws.onopen = () => { tries = 0; store.setConn('live'); };
  ws.onclose = () => { ws = null; schedule(); };
  ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handle(msg);
    listeners.forEach((fn) => fn(msg));
  };
}

function hostName(sid) {
  const s = store.get(sid);
  return s?.host?.hostname || s?.remote || 'host';
}

function mergeCommand(sid, cmd) {
  const s = store.get(sid);
  if (!s) return;
  const pending = (s.pending || []).filter((c) => c.id !== cmd.id);
  const timeline = (s.timeline || []).filter((c) => c.id !== cmd.id);
  if (cmd.status === 'done' || cmd.status === 'error') {
    timeline.push(cmd);
    store.upsert({ ...s, pending, timeline: timeline.slice(-160), queued: pending.length });
  } else {
    store.upsert({ ...s, pending: [...pending, cmd], queued: pending.length + 1 });
  }
}

function handle(msg) {
  switch (msg.type) {
    case 'snapshot':
      (msg.sessions || []).forEach(store.upsert);
      if (Array.isArray(msg.events) && !store.state.events.length) {
        store.state.events = msg.events.slice().reverse();
      }
      break;

    case 'new_session':
      store.upsert(msg.session);
      break;

    case 'drop':
      store.log('drop', `${hostName(msg.session_id)} removed`, null);
      store.remove(msg.session_id);
      break;

    case 'command': {
      const cmd = msg.command || {};
      mergeCommand(msg.session_id, cmd);
      if (cmd.status === 'error') {
        store.log('error', `${hostName(msg.session_id)}: ${clip(cmd.result?.text || 'failed', 90)}`, msg.session_id);
      } else if (cmd.status === 'done') {
        store.log('result', `${hostName(msg.session_id)} returned ${cmd.tool || cmd.type}`, msg.session_id);
      }
      break;
    }

    case 'blob':
      if (msg.blob) {
        const s = store.get(msg.session_id);
        if (s) store.upsert({ ...s, blobs: [...(s.blobs || []), msg.blob].slice(-60) });
        store.log('blob', `${hostName(msg.session_id)} sent ${msg.blob.name}`, msg.session_id);
      }
      break;

    case 'stream': {
      const s = store.get(msg.session_id);
      if (s) store.upsert({ ...s, streams: { ...(s.streams || {}), [msg.kind]: msg.on } });
      break;
    }

    case 'event':
      if (msg.event) {
        store.state.events.unshift(msg.event);
        store.state.events = store.state.events.slice(0, 400);
        if (store.state.route.view !== 'activity') store.state.unread = Math.min(99, store.state.unread + 1);
        store.emit();
      }
      break;

    default:
      break;
  }
}

export const isLive = () => ws?.readyState === 1;
