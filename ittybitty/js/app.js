// app.js — main routing and orchestration

import { decode, detectLegacy } from './url.js?v=2';
import { decompress } from './compress.js?v=2';
import { decrypt } from './crypto.js?v=2';
import { render, detectType } from './render.js?v=2';

const $ = (id) => document.getElementById(id);

const views = {
  editor: $('editor-view'),
  render: $('render-view'),
  decrypt: $('decrypt-view'),
  loading: $('loading-view'),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

async function route() {
  const hash = location.hash;

  if (!hash || hash === '#' || hash === '#/') {
    showView('editor');
    const { createEditor } = await import('./editor.js');
    await createEditor();
    return;
  }

  showView('loading');

  try {
    // Check for legacy itty-bitty format
    const fragment = hash.slice(1);
    let parsed;

    if (detectLegacy(fragment)) {
      // Legacy format — attempt LZMA decode
      parsed = decodeLegacy(fragment);
    } else {
      parsed = decode(fragment);
    }

    const { title, type, format, encrypted, data } = parsed;

    // Show title
    if (title) {
      $('render-title').textContent = title;
      document.title = `${title} — itty-bitty sea of glass`;
    }

    if (encrypted) {
      showView('decrypt');
      setupDecrypt(data, format, type, title);
      return;
    }

    await renderContent(data, format, type);
  } catch (e) {
    console.error('Route error:', e);
    $('loading-view').querySelector('.loading-text').textContent =
      'failed to decode URL';
  }
}

async function renderContent(data, format, type) {
  showView('loading');

  try {
    const decompressed = await decompress(data, format);
    const text = new TextDecoder().decode(decompressed);
    const resolvedType = type || detectType(text);

    showView('render');
    render(text, resolvedType, $('render-container'));

    // Wire "edit a copy" button
    $('edit-btn').onclick = () => {
      // Clear hash to go to editor, then set content
      history.pushState(null, '', '/ittybitty/');
      showView('editor');
      import('./editor.js').then(async ({ createEditor }) => {
        const ed = await createEditor();
        ed.setContent(text);
      });
    };
  } catch (e) {
    console.error('Render error:', e);
    $('loading-view').querySelector('.loading-text').textContent =
      'failed to decompress content';
    showView('loading');
  }
}

function setupDecrypt(data, format, type, title) {
  const input = $('decrypt-passphrase');
  const btn = $('decrypt-btn');
  const error = $('decrypt-error');

  async function attemptDecrypt() {
    const passphrase = input.value;
    if (!passphrase) return;

    btn.disabled = true;
    btn.textContent = 'decrypting...';
    error.classList.add('hidden');

    try {
      const decrypted = await decrypt(data, passphrase);
      await renderContent(decrypted, format, type);
    } catch (e) {
      error.textContent = 'wrong passphrase or corrupted data';
      error.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'decrypt';
    }
  }

  btn.onclick = attemptDecrypt;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') attemptDecrypt();
  };
  input.focus();
}

function decodeLegacy(fragment) {
  // Original itty-bitty format: /Title/data:text/html;...;base64,DATA
  // or just: XQA...  (LZMA compressed)
  let title = '';
  let rest = fragment;

  if (fragment.startsWith('/')) {
    const parts = fragment.slice(1).split('/');
    if (parts.length > 1) {
      title = decodeURIComponent(parts[0].replace(/-/g, ' '));
      rest = parts.slice(1).join('/');
    }
  }

  // Detect LZMA by magic bytes
  const isLzma = rest.startsWith('XQA');
  const format = isLzma ? 'lzma' : 'gzip';

  // Strip data URL prefix if present
  let b64Data = rest;
  const commaIdx = rest.indexOf(',');
  if (commaIdx !== -1 && rest.startsWith('data:')) {
    b64Data = rest.slice(commaIdx + 1);
  }

  // Decode standard base64 (not base64url)
  const binary = atob(b64Data);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);

  return { title, type: 'html', format, encrypted: false, data };
}

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/ittybitty/js/sw.js').catch(() => {});
}

// Route on load and hash change
window.addEventListener('DOMContentLoaded', route);
window.addEventListener('hashchange', () => location.reload());
