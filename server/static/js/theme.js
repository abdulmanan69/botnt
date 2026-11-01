/* Theme + accent state: persisted, applied on <html>, mirrored to theme-color. */

const THEME_KEY = 'phantom-theme';
const ACCENT_KEY = 'phantom-accent';
const META_COLOR = { dark: '#0a0a0a', light: '#eef0f3' };

export const ACCENTS = [
  ['amber', 'Amber gold'],
  ['blue', 'Classic blue'],
  ['violet', 'Violet'],
  ['cyan', 'Cyan'],
  ['slate', 'Graphite'],
];

const root = () => document.documentElement;

export const theme = () => (root().classList.contains('dark') ? 'dark' : 'light');
export const accent = () => root().dataset.accent || 'amber';

function paintMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = META_COLOR[theme()];
}

function announce() {
  document.dispatchEvent(new CustomEvent('phantom:theme', { detail: { theme: theme(), accent: accent() } }));
}

export function setTheme(next) {
  const value = next === 'light' ? 'light' : 'dark';
  root().classList.toggle('dark', value === 'dark');
  try { localStorage.setItem(THEME_KEY, value); } catch { /* private mode */ }
  paintMeta();
  document.querySelectorAll('[data-theme-label]').forEach((el) => {
    el.textContent = value === 'dark' ? 'Dark' : 'Light';
  });
  announce();
}

export const toggleTheme = () => setTheme(theme() === 'dark' ? 'light' : 'dark');

export function setAccent(name) {
  if (!ACCENTS.some(([key]) => key === name)) return;
  root().dataset.accent = name;
  try { localStorage.setItem(ACCENT_KEY, name); } catch { /* private mode */ }
  announce();
}

/** Paint the shared swatch strip into any container. */
export function swatches(host) {
  host.innerHTML = ACCENTS.map(([key, label]) => `<button class="swatch" type="button"
      data-accent-pick="${key}" title="${label}" aria-label="${label} accent"
      aria-pressed="${accent() === key}"><i></i></button>`).join('');
  host.onclick = (e) => {
    const b = e.target.closest('[data-accent-pick]');
    if (b) setAccent(b.dataset.accentPick);
  };
  const sync = () => host.querySelectorAll('[data-accent-pick]').forEach((b) => {
    b.setAttribute('aria-pressed', String(accent() === b.dataset.accentPick));
  });
  sync();
  document.addEventListener('phantom:theme', sync);
}

export function init() {
  paintMeta();
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.onclick = toggleTheme;
  });
}
