/* Activity: full audit trail. */

import * as store from '../store.js';
import { href } from '../router.js';
import { ico, download } from '../ui.js';
import { ago, esc } from '../format.js';

const ICONS = { join: 'i-bolt', drop: 'i-warn', error: 'i-warn', result: 'i-term',
  blob: 'i-file', queue: 'i-up', build: 'i-box', boot: 'i-info' };
const KINDS = [['all', 'All'], ['join', 'Joined'], ['drop', 'Removed'], ['error', 'Errors'],
  ['queue', 'Commands'], ['blob', 'Files'], ['build', 'Builds']];

let kind = 'all';

const ms = (ev) => (ev.ts < 1e13 ? ev.ts * 1000 : ev.ts);

export const activity = {
  mount(root) {
    root.innerHTML = `
      <div class="page" style="padding-bottom:10px">
        <div class="page-head">
          <div class="ttl"><h1>Activity</h1>
            <p>Everything the fleet and the control plane did, newest first. Survives a reload of the
              browser; the server keeps the last 500 events.</p></div>
          <div class="spacer"></div>
          <button class="btn ghost sm" id="aexport">${ico('i-down')} Export</button>
          <button class="btn ghost sm" id="aclear">${ico('i-trash')} Clear view</button>
        </div>
        <div class="chips" id="akinds">${KINDS.map(([k, l]) =>
          `<button class="chip" data-k="${k}">${l}<span class="n"></span></button>`).join('')}</div>
      </div>
      <ul class="act-list" id="alist"></ul>`;

    root.querySelector('#akinds').onclick = (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (k) { kind = k; this.paint(root); }
    };
    root.querySelector('#aclear').onclick = () => { store.state.events.length = 0; store.emit(); };
    root.querySelector('#aexport').onclick = () => download('phantom-activity.json',
      JSON.stringify(store.state.events, null, 2), 'application/json');
    this.paint(root);
  },

  update(root) { this.paint(root); },

  paint(root) {
    const list = root.querySelector('#alist');
    if (!list) return;
    root.querySelectorAll('[data-k]').forEach((b) => {
      b.classList.toggle('on', b.dataset.k === kind);
      b.querySelector('.n').textContent = b.dataset.k === 'all' ? store.state.events.length
        : store.state.events.filter((x) => x.kind === b.dataset.k).length;
    });
    const rows = store.state.events.filter((a) => kind === 'all' || a.kind === kind);
    if (!rows.length) {
      list.innerHTML = `<div class="empty">${ico('i-pulse')}<span>Nothing here yet.</span></div>`;
      return;
    }
    list.innerHTML = rows.slice(0, 300).map((a) => `<li class="k-${a.kind}">
      <time>${ago(ms(a) / 1000, store.state.now)} ago</time>${ico(ICONS[a.kind] || 'i-info')}
      <span>${esc(a.text)}</span>
      ${a.sid ? `<a class="tiny" href="${href.host(a.sid)}">open</a>` : '<span></span>'}
    </li>`).join('');
  },
};
