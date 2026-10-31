/* Hash router. Views are plain objects; the router only resolves + normalises. */

import * as store from './store.js';

const VIEWS = new Set(['overview', 'fleet', 'host', 'payloads', 'activity', 'environment']);

export function parse(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = VIEWS.has(parts[0]) ? parts[0] : 'overview';
  if (view === 'host') return { view, id: parts[1] || null, tool: parts[2] || 'console' };
  return { view, id: null, tool: 'console' };
}

export const href = {
  overview: () => '#/overview',
  fleet: () => '#/fleet',
  payloads: () => '#/payloads',
  activity: () => '#/activity',
  environment: () => '#/environment',
  host: (id, tool = 'console') => `#/host/${id}/${tool}`,
};

export function go(path) {
  if (location.hash === path) apply();
  else location.hash = path;
}

export function apply() {
  const route = parse();
  if (route.view === 'host' && route.id && !store.get(route.id)) {
    const first = store.visible()[0];
    if (first) { location.replace(href.host(first.id)); return; }
    location.replace(href.fleet()); return;
  }
  store.state.route = route;
  store.state.selected = route.id;
  if (route.view === 'activity') store.markRead();
  else store.emit();
}

export function start() {
  window.addEventListener('hashchange', apply);
  if (!location.hash) location.replace('#/overview');
  else apply();
}
