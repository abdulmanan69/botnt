/* Login page: post the credentials, then hand over to the console. */

import { api, TOKEN } from './js/api.js';

const form = document.getElementById('login');
const err = document.getElementById('err');
const errText = document.getElementById('err-text');
const go = document.getElementById('go');

const next = (() => {
  const raw = new URLSearchParams(location.search).get('next') || '/';
  return raw.startsWith('/') ? raw : '/';
})();

function fail(text) {
  errText.textContent = text;
  err.classList.add('on');
  go.disabled = false;
  go.textContent = 'Sign in';
}

document.getElementById('reveal').onclick = () => {
  const pass = document.getElementById('pass');
  pass.type = pass.type === 'password' ? 'text' : 'password';
};

form.onsubmit = async (e) => {
  e.preventDefault();
  err.classList.remove('on');
  go.disabled = true;
  go.textContent = 'Signing in…';
  try {
    const user = document.getElementById('user').value.trim();
    const pass = document.getElementById('pass').value;
    if (!user || !pass) { fail('both fields are required'); return; }
    await api.login(user, pass, document.getElementById('remember').checked);
    location.replace(TOKEN ? `${next}${next.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : next);
  } catch (e2) {
    fail(e2.message === 'signed out' ? 'wrong user or password' : e2.message);
  }
};

document.getElementById('user').focus();
