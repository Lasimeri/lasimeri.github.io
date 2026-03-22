// editor.js — CodeMirror 6 editor with live preview

import { encode, TYPE_MAP, FORMAT_MAP, bufToBase64url } from './url.js?v=2';
import { compress } from './compress.js?v=2';
import { encrypt } from './crypto.js?v=2';
import { render, detectType } from './render.js?v=2';
import { generateQR, shareURL, copyToClipboard, getURLWarnings, canShare } from './share.js?v=2';

let editor = null;
let previewDebounce = null;
let compressDebounce = null;

const TEMPLATES = {
  blank: null,
  minimal: null,
  dark: null,
};

async function loadTemplate(name) {
  if (TEMPLATES[name] !== null) return TEMPLATES[name];
  const resp = await fetch(`/ittybitty/templates/${name}.html`);
  TEMPLATES[name] = await resp.text();
  return TEMPLATES[name];
}

export async function createEditor() {
  const pane = document.getElementById('editor-pane');
  const previewContainer = document.getElementById('preview-container');
  const typeSelect = document.getElementById('type-select');
  const formatSelect = document.getElementById('format-select');
  const templateSelect = document.getElementById('template-select');
  const encryptCheck = document.getElementById('encrypt-check');
  const passphraseRow = document.getElementById('passphrase-row');
  const passphraseInput = document.getElementById('passphrase');
  const titleInput = document.getElementById('title-input');
  const generateBtn = document.getElementById('generate-btn');
  const counterRaw = document.getElementById('counter-raw');
  const counterCompressed = document.getElementById('counter-compressed');
  const counterUrl = document.getElementById('counter-url');
  const urlWarnings = document.getElementById('url-warnings');
  const outputSection = document.getElementById('output-section');
  const outputUrl = document.getElementById('output-url');
  const copyBtn = document.getElementById('copy-btn');
  const shareBtn = document.getElementById('share-btn');
  const qrBtn = document.getElementById('qr-btn');
  const openBtn = document.getElementById('open-btn');
  const qrContainer = document.getElementById('qr-container');

  // Show Web Share button if available
  if (canShare()) shareBtn.classList.remove('hidden');

  // Load CodeMirror from vendored bundle (single file, no CDN dep conflicts)
  const {
    EditorView, EditorState, basicSetup,
    html, markdown: markdownLang, json: jsonLang, oneDark,
  } = await import('../lib/codemirror-bundle.js');

  const langExtensions = {
    html: html(),
    markdown: markdownLang(),
    json: jsonLang(),
    svg: html(),
    text: [],
  };

  // Create editor
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      schedulePreview();
      scheduleCompress();
    }
  });

  editor = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [basicSetup, oneDark, langExtensions.html, updateListener],
    }),
    parent: pane,
  });

  // Type change → swap language extension
  typeSelect.addEventListener('change', () => {
    const type = typeSelect.value;
    const lang = langExtensions[type] || [];
    const doc = editor.state.doc.toString();
    editor.setState(
      EditorState.create({
        doc,
        extensions: [basicSetup, oneDark, Array.isArray(lang) ? lang : lang, updateListener],
      })
    );
    schedulePreview();
    scheduleCompress();
  });

  // Template loader
  templateSelect.addEventListener('change', async () => {
    const name = templateSelect.value;
    if (!name) return;
    const content = await loadTemplate(name);
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
    });
    templateSelect.value = '';
  });

  // Encrypt toggle
  encryptCheck.addEventListener('change', () => {
    passphraseRow.classList.toggle('hidden', !encryptCheck.checked);
    scheduleCompress();
  });

  // Live preview (debounced 300ms)
  function schedulePreview() {
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(updatePreview, 300);
  }

  function updatePreview() {
    const content = editor.state.doc.toString();
    if (!content.trim()) {
      previewContainer.innerHTML = '';
      return;
    }
    const type = typeSelect.value;
    previewContainer.innerHTML = '';
    render(content, type, previewContainer);
  }

  // Compression counter (debounced 300ms)
  function scheduleCompress() {
    clearTimeout(compressDebounce);
    compressDebounce = setTimeout(updateCounters, 300);
  }

  async function updateCounters() {
    const content = editor.state.doc.toString();
    const rawBytes = new TextEncoder().encode(content).length;
    counterRaw.textContent = `raw: ${formatBytes(rawBytes)}`;

    if (!content.trim()) {
      counterCompressed.textContent = 'compressed: 0 B';
      counterUrl.textContent = 'URL: 0 chars';
      counterUrl.className = '';
      urlWarnings.innerHTML = '';
      return;
    }

    try {
      const format = formatSelect.value;
      const data = new TextEncoder().encode(content);
      const compressed = await compress(data, format);
      let payload = compressed;

      if (encryptCheck.checked && passphraseInput.value) {
        payload = await encrypt(payload, passphraseInput.value);
      }

      const encoded = bufToBase64url(payload);
      const type = typeSelect.value;
      const formatChar = FORMAT_MAP[format];
      const typeChar = TYPE_MAP[type];
      const encFlag = encryptCheck.checked ? '1' : '0';
      const title = titleInput.value.trim();
      const titlePart = title ? `/${encodeTitle(title)}` : '';
      const urlLength = `${location.origin}/ittybitty/#${titlePart}/${typeChar}${formatChar}${encFlag},${encoded}`.length;

      counterCompressed.textContent = `compressed: ${formatBytes(payload.length)}`;
      counterUrl.textContent = `URL: ${urlLength.toLocaleString()} chars`;

      // Warnings
      const warnings = getURLWarnings({ length: urlLength });
      urlWarnings.innerHTML = warnings
        .map((w) => `<div class="warning ${w.level}">${w.message}</div>`)
        .join('');

      if (urlLength > 64000) {
        counterUrl.className = 'danger';
      } else if (urlLength > 8000) {
        counterUrl.className = 'warn';
      } else {
        counterUrl.className = '';
      }
    } catch (e) {
      counterCompressed.textContent = 'compressed: error';
    }
  }

  // Generate link
  generateBtn.addEventListener('click', async () => {
    const content = editor.state.doc.toString();
    if (!content.trim()) return;

    generateBtn.disabled = true;
    generateBtn.textContent = 'generating...';

    try {
      const format = formatSelect.value;
      const type = typeSelect.value;
      const data = new TextEncoder().encode(content);
      const compressed = await compress(data, format);
      let payload = compressed;
      const isEncrypted = encryptCheck.checked && passphraseInput.value;

      if (isEncrypted) {
        payload = await encrypt(payload, passphraseInput.value);
      }

      const fragment = encode({
        title: titleInput.value.trim(),
        type,
        format,
        encrypted: !!isEncrypted,
        data: payload,
      });

      const url = `${location.origin}/ittybitty/${fragment}`;
      outputUrl.value = url;
      outputSection.classList.remove('hidden');
      qrContainer.classList.add('hidden');
    } catch (e) {
      console.error('Generate failed:', e);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = 'generate link';
    }
  });

  // Copy
  copyBtn.addEventListener('click', async () => {
    const success = await copyToClipboard(outputUrl.value);
    copyBtn.textContent = success ? 'copied!' : 'failed';
    setTimeout(() => (copyBtn.textContent = 'copy'), 1500);
  });

  // Share
  shareBtn.addEventListener('click', () => {
    shareURL(outputUrl.value, titleInput.value.trim() || 'itty-bitty page');
  });

  // QR
  qrBtn.addEventListener('click', () => {
    qrContainer.classList.toggle('hidden');
    if (!qrContainer.classList.contains('hidden')) {
      generateQR(outputUrl.value, qrContainer);
    }
  });

  // Open
  openBtn.addEventListener('click', () => {
    window.open(outputUrl.value, '_blank');
  });

  // Title input triggers recount
  titleInput.addEventListener('input', scheduleCompress);
  passphraseInput.addEventListener('input', scheduleCompress);

  return {
    getContent: () => editor.state.doc.toString(),
    setContent: (text) => {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: text },
      });
    },
  };
}

function encodeTitle(title) {
  return encodeURIComponent(title.replace(/\s+/g, '-'));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
