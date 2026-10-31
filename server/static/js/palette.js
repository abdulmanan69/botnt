/* Command palette (Ctrl/Cmd+K). */

import * as store from './store.js';
import { go, href } from './router.js';
import { ico } from './ui.js';
import { esc, presence, STATE_LABEL } from './format.js';

const NAV = [
  { label: 'Overview', icon: 'i-grid', run: () => go(href.overview()) },
  { label: 'Fleet', icon: 'i-fleet', run: () => go(href.fleet()) },
  { label: 'Payloads', icon: 'i-box', run: () => go(href.payloads()) },
  { label: 'Activity', icon: 'i-pulse', run: () => go(href.activity()) },
  { label: 'Environment', icon: 'i-env', run: () => go(href.environment()) },
];

const ACTIONS = [
  { label: 'Build a payload', icon: 'i-box', run: () => go(href.payloads()) },
  { label: 'Export the fleet as JSON', icon: 'i-down', run: () => document.querySelector('#view-fleet #fexport')?.click() },
  { label: 'Show online hosts only', icon: 'i-bolt', run: () => { store.setFilter({ state: 'online' }); go(href.fleet()); } },
  { label: 'Show offline hosts', icon: 'i-warn', run: () => { store.setFilter({ state: 'offline' }); go(href.fleet()); } },
  { label: 'Clear filters', icon: 'i-refresh', run: () => { store.setFilter({ q: '', state: 'all' }); go(href.fleet()); } },
];

const root = () => document.getElementById('palette');
const input = () => document.getElementById('palette-q');
const list = () => document.getElementById('palette-list');

let items = [];
let cursor = 0;

function hostItems(query) {
  return store.all()
    .map((s) => ({
      label: s.host?.hostname || s.id,
      icon: 'i-fleet',
      note: `${STATE_LABEL[presence(s)]} · ${s.remote || ''}`,
      run: () => go(href.host(s.id)),
    }))
    .filter((h) => !query || h.label.toLowerCase().includes(query) || h.note.toLowerCase().includes(query));
}

function build(q) {
  const query = q.trim().toLowerCase();
  const hosts = hostItems(query);
  const nav = [...NAV, ...ACTIONS].filter((a) => !query || a.label.toLowerCase().includes(query));
  const out = [];
  if (hosts.length) out.push({ group: `Hosts · ${hosts.length}` }, ...hosts.slice(0, 7));
  if (nav.length) out.push({ group: query ? 'Matches' : 'Actions' }, ...nav);
  return out;
}

function paint() {
  list().innerHTML = items.length ? items.map((it, i) => (it.group
    ? `<li class="grp">${esc(it.group)}</li>`
    : `<li data-i="${i}" class="${i === cursor ? 'on' : ''}">${ico(it.icon)}<span>${esc(it.label)}</span><em>${esc(it.note || '')}</em></li>`)).join('')
    : '<li class="grp">nothing matches</li>';
  list().querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
}

function run(i) {
  const it = items[i];
  if (!it || it.group) return;
  close();
  it.run();
}

export function open() {
  root().hidden = false;
  input().value = '';
  items = build('');
  cursor = 0;
  paint();
  input().focus();
}

export function close() {
  root().hidden = true;
  input().blur();
}

export const isOpen = () => !root().hidden;

export function init() {
  input().oninput = () => { items = build(input().value); cursor = 0; paint(); };

  input().onkeydown = (e) => {
    if (e.key === 'Escape') { close(); e.preventDefault(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      do { cursor = (cursor + dir + items.length) % items.length; } while (items[cursor]?.group && items.length);
      paint();
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); run(cursor); }
  };

  list().onclick = (e) => {
    const li = e.target.closest('[data-i]');
    if (li) run(Number(li.dataset.i));
  };
  root().onclick = (e) => { if (e.target === root()) close(); };
}
