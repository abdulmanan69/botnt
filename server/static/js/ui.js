/* Small UI primitives: icons, toasts, dialogs, lightbox, downloads. */

import { esc } from './format.js';

export const ico = (name, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;

const toasts = () => document.getElementById('toasts');

export function toast(text, kind = 'ok', ms = 4200) {
  const node = document.createElement('div');
  node.className = 'toast' + (kind === 'ok' ? '' : ' ' + kind);
  node.innerHTML = `${ico(kind === 'ok' ? 'i-check' : 'i-warn')}<span>${esc(text)}</span>`;
  toasts().appendChild(node);
  while (toasts().children.length > 4) toasts().firstElementChild.remove();
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 200); }, ms);
}

export function download(name, text, mime = 'text/plain;charset=utf-8') {
  const href = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = href; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

export async function copy(text, label = 'copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('clipboard blocked by the browser', 'warn');
  }
}

/* ---------- modal ---------- */
const modalEl = () => document.getElementById('modal');
let closeModal = null;

export function modal({ title, body, actions = [], icon = 'i-info', onMount, wide = false }) {
  const root = modalEl();
  root.innerHTML = `<div class="modal-card" role="document" ${wide ? 'style="width:min(760px,100%)"' : ''}>
    <header>${ico(icon)}<h2>${esc(title)}</h2>
      <button class="btn ghost sm ico-only" data-close aria-label="Close">${ico('i-close')}</button></header>
    <div class="body">${body}</div>
    ${actions.length ? `<footer>${actions.map((a, i) =>
      `<button class="btn ${a.kind || 'ghost'}" data-i="${i}">${esc(a.label)}</button>`).join('')}</footer>` : ''}
  </div>`;
  root.hidden = false;
  let resolveFn = null;
  const done = new Promise((res) => { resolveFn = res; });
  const shut = (value) => {
    root.hidden = true; root.innerHTML = ''; closeModal = null;
    document.removeEventListener('keydown', onKey);
    if (value !== undefined) resolveFn?.(value);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') shut(undefined);
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      shut(actions[actions.length - 1]?.value ?? true);
    }
  };
  document.addEventListener('keydown', onKey);
  root.querySelector('[data-close]').onclick = () => shut(undefined);
  root.onclick = (e) => { if (e.target === root) shut(undefined); };
  root.querySelectorAll('footer .btn').forEach((btn, i) => {
    btn.onclick = () => shut(actions[i].value ?? true);
  });
  onMount?.(root, shut);
  root.querySelector('input,textarea')?.focus();
  closeModal = shut;
  return done;
}

export const cancelModal = () => closeModal?.();

export function confirm({ title, body, confirm: label = 'Confirm', danger = false, icon = 'i-warn' }) {
  return modal({
    title, body: `<p class="muted">${esc(body)}</p>`, icon,
    actions: [{ label: 'Cancel', kind: 'ghost', value: false },
      { label, kind: danger ? 'danger' : 'primary', value: true }],
  }).then((v) => v === true);
}

export function prompt({ title, label, value = '', hint = '', confirm: label2 = 'Save', icon = 'i-save' }) {
  return modal({
    title, icon,
    body: `<label class="field"><span>${esc(label)}</span>
      <input class="inp" id="pm-inp" value="${esc(value)}" placeholder="${esc(hint)}"></label>`,
    actions: [{ label: 'Cancel', kind: 'ghost', value: null }, { label: label2, kind: 'primary', value: true }],
  }).then((ok) => (ok ? document.getElementById('pm-inp')?.value ?? '' : null));
}

/* ---------- lightbox ---------- */
export function lightbox(src, caption = '') {
  const root = document.getElementById('lightbox');
  const isVideo = /\.(webm|mp4)$/i.test(new URL(src, location.href).pathname);
  root.innerHTML = `<button class="btn ghost ico-only lb-close" aria-label="Close">${ico('i-close')}</button>
    ${isVideo ? `<video src="${esc(src)}" controls autoplay></video>` : `<img src="${esc(src)}" alt="">`}
    <div class="lb-cap">${esc(caption)}</div>`;
  root.hidden = false;
  const shut = () => { root.hidden = true; root.innerHTML = ''; };
  root.onclick = shut;
  const onKey = (e) => { if (e.key === 'Escape') { shut(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

/* ---------- misc ---------- */
export const skeleton = (rows = 4, height = 13) =>
  `<div style="display:grid;gap:8px">${'<div class="sk" style="height:' + height + 'px"></div>'.repeat(rows)}</div>`;

export const empty = (icon, title, note = '', action = '') =>
  `<div class="empty">${ico(icon)}<b>${esc(title)}</b><span>${esc(note)}</span>${action}</div>`;
