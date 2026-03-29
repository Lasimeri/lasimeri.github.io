// main.js - Encrypted file hosting state machine

import {
  generateKey, exportKey, importKey, deriveRoomId,
  encrypt, decrypt
} from './crypto.js?v=1';
import { createFile, postChunk, fetchFile, listFiles, setLogger } from './storage.js?v=1';

const MAX_FILE_SIZE = 2.5 * 1024 * 1024;
const CHUNK_SIZE = 32000; // ~32KB raw -> ~58KB after base64+encrypt+base64 (fits 65536 comment limit)

// Rotating site key for public files
const PUB_SEED = 'seaof.glass:hosting:pub:v1';
function getPubEpoch() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
async function derivePubKey(epoch) {
  const raw = new TextEncoder().encode(PUB_SEED + ':' + epoch);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Inline fingerprint
async function getDeviceKey() {
  const signals = [];
  try {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 50;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#c4945a';
    ctx.fillText('seaof.glass:hosting', 2, 2);
    signals.push(c.toDataURL());
  } catch (e) { signals.push('canvas:n/a'); }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    signals.push(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'webgl:no-ext');
  } catch (e) { signals.push('webgl:n/a'); }
  signals.push(screen.width + 'x' + screen.height + 'x' + screen.colorDepth);
  signals.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  signals.push(navigator.language);
  signals.push(navigator.platform);
  signals.push(String(navigator.hardwareConcurrency || 0));
  const raw = new TextEncoder().encode(signals.join('|'));
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function derivePasswordKey(password, salt) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// --- DOM ---
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const logEl = $('log');
const uploadSection = $('upload-section');
const shareSection = $('share-section');
const downloadSection = $('download-section');
const fileInput = $('file-input');
const uploadBtn = $('upload-btn');
const modeSelect = $('mode-select');
const passwordInput = $('password-input');
const shareLinkEl = $('share-link');
const copyLinkBtn = $('copy-link');
const dlFilename = $('dl-filename');
const dlSize = $('dl-size');
const dlBtn = $('dl-btn');
const progressBar = $('progress-bar');
const progressText = $('progress-text');
const progressContainer = $('progress');
const dirList = $('directory-list');
const dirRefresh = $('dir-refresh');

function setStatus(msg) { statusEl.textContent = msg; }

function log(msg) {
  console.log('[host] ' + msg);
  const line = document.createElement('div');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

setLogger(log);

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function showProgress(cur, total, label) {
  const pct = Math.round((cur / total) * 100);
  progressBar.style.width = pct + '%';
  progressText.textContent = label + ' ' + pct + '%';
  progressContainer.classList.remove('hidden');
}

function hideProgress() { progressContainer.classList.add('hidden'); }

function bufToBase64(buf) {
  let b = '';
  for (let i = 0; i < buf.length; i++) b += String.fromCharCode(buf[i]);
  return btoa(b);
}

function base64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function compressData(data) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(data); w.close();
  const chunks = []; const r = cs.readable.getReader();
  while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const result = new Uint8Array(total); let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

async function decompressData(data) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(data); w.close();
  const chunks = []; const r = ds.readable.getReader();
  while (true) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const result = new Uint8Array(total); let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

async function hashData(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseFragment() {
  const frag = location.hash.slice(1);
  if (!frag) return null;
  const hasPassword = frag.endsWith(':p');
  const clean = hasPassword ? frag.slice(0, -2) : frag;
  if (clean.startsWith('d:')) return { mode: 'device', fileId: clean.slice(2), hasPassword };
  if (clean.startsWith('p:')) return { mode: 'public', fileId: clean.slice(2), hasPassword: false };
  return { mode: 'shareable', key: clean, hasPassword };
}

// --- Upload ---
uploadBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    setStatus('File too large - ' + formatBytes(MAX_FILE_SIZE) + ' limit');
    return;
  }

  const mode = modeSelect.value;
  const password = passwordInput.value;
  const hasPassword = password.length > 0 && mode !== 'public';

  uploadBtn.disabled = true;
  try {
    log('File: ' + file.name + ' (' + formatBytes(file.size) + '), mode: ' + mode);

    setStatus('Reading...');
    const rawData = new Uint8Array(await file.arrayBuffer());
    const hash = await hashData(rawData);
    log('SHA-256: ' + hash.slice(0, 16) + '...');

    setStatus('Compressing...');
    const compressed = await compressData(rawData);
    log('Compressed: ' + formatBytes(rawData.length) + ' -> ' + formatBytes(compressed.length) + ' (' + ((1 - compressed.length / rawData.length) * 100).toFixed(1) + '% reduction)');

    // Determine key
    let mainKey, keyExport, fileId;
    if (mode === 'public') {
      const epoch = getPubEpoch();
      log('Deriving site key (epoch: ' + epoch + ')...');
      mainKey = await derivePubKey(epoch);
      const rb = crypto.getRandomValues(new Uint8Array(8));
      fileId = epoch + '.' + Array.from(rb).map(b => b.toString(16).padStart(2, '0')).join('');
    } else if (mode === 'device') {
      log('Deriving device key...');
      mainKey = await getDeviceKey();
      const rb = crypto.getRandomValues(new Uint8Array(8));
      fileId = Array.from(rb).map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      log('Generating AES-256-GCM key...');
      mainKey = await generateKey();
      keyExport = await exportKey(mainKey);
      fileId = await deriveRoomId(mainKey);
    }
    log('File ID: ' + fileId);

    // Chunk, encrypt
    const totalChunks = Math.ceil(compressed.length / CHUNK_SIZE);
    log('Splitting into ' + totalChunks + ' chunks');

    const encChunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = compressed.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, compressed.length));
      let payload = bufToBase64(chunk);
      if (hasPassword) {
        const pwKey = await derivePasswordKey(password, fileId);
        payload = await encrypt(payload, pwKey);
      }
      payload = await encrypt(payload, mainKey);
      encChunks.push(payload);
      showProgress(i + 1, totalChunks, 'Encrypting');
    }

    // Metadata — only include filename for public files
    const metadata = {
      name: mode === 'public' ? file.name : null,
      size: file.size,
      compressedSize: compressed.length,
      type: file.type || 'application/octet-stream',
      hash: hash,
      chunks: totalChunks,
      mode: mode,
      hasPassword: hasPassword,
      ts: new Date().toISOString()
    };

    // Upload: metadata in body, ALL chunks as comments
    setStatus('Uploading...');
    showProgress(0, totalChunks, 'Uploading');
    const prefix = mode === 'public' ? 'pub-file' : 'file';
    const issueNumber = await createFile(fileId, metadata, prefix);

    for (let i = 0; i < encChunks.length; i++) {
      await postChunk(issueNumber, i, encChunks[i]);
      showProgress(i + 1, totalChunks, 'Uploading');
    }
    log('All ' + totalChunks + ' chunks uploaded');

    // Share link
    let fragment;
    if (mode === 'public') fragment = 'p:' + fileId;
    else if (mode === 'device') fragment = 'd:' + fileId + (hasPassword ? ':p' : '');
    else fragment = keyExport + (hasPassword ? ':p' : '');

    const url = location.origin + location.pathname + '#' + fragment;
    shareLinkEl.value = url;
    uploadSection.classList.add('hidden');
    shareSection.classList.remove('hidden');
    hideProgress();
    history.replaceState(null, '', location.pathname);
    setStatus('File hosted');
    log('Done');

  } catch (err) {
    setStatus('Error: ' + err.message);
    log('ERROR: ' + err.message);
    uploadBtn.disabled = false;
    hideProgress();
  }
});

// --- Download ---
async function downloadFile(password) {
  const parsed = parseFragment();
  if (!parsed) return;

  history.replaceState(null, '', location.pathname);
  uploadSection.classList.add('hidden');

  try {
    let mainKey, fileId;
    if (parsed.mode === 'public') {
      fileId = parsed.fileId;
      const epoch = fileId.split('.')[0];
      log('Public file, epoch: ' + epoch);
      mainKey = await derivePubKey(epoch);
    } else if (parsed.mode === 'device') {
      fileId = parsed.fileId;
      log('Device-bound file');
      mainKey = await getDeviceKey();
    } else {
      log('Importing key...');
      mainKey = await importKey(parsed.key);
      fileId = await deriveRoomId(mainKey);
    }
    log('File ID: ' + fileId);

    // Password prompt
    if (parsed.hasPassword && !password) {
      // Show password prompt inline
      const pw = prompt('This file requires a password:');
      if (!pw) { setStatus('Cancelled'); return; }
      location.hash = parsed.mode === 'device' ? 'd:' + fileId + ':p' : parsed.key + ':p';
      return downloadFile(pw);
    }

    setStatus('Fetching...');
    const { metadata, chunks } = await fetchFile(fileId);
    log('Found: ' + (metadata.name || '[encrypted]') + ' (' + formatBytes(metadata.size) + ', ' + metadata.chunks + ' chunks)');

    // Decrypt
    setStatus('Decrypting...');
    const decChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      let payload = await decrypt(chunks[i], mainKey);
      if (metadata.hasPassword && password) {
        const pwKey = await derivePasswordKey(password, fileId);
        payload = await decrypt(payload, pwKey);
      }
      decChunks.push(base64ToBuf(payload));
      showProgress(i + 1, chunks.length, 'Decrypting');
    }

    // Reassemble
    const totalLen = decChunks.reduce((a, c) => a + c.length, 0);
    const compressed = new Uint8Array(totalLen);
    let off = 0;
    for (const c of decChunks) { compressed.set(c, off); off += c.length; }

    // Decompress
    setStatus('Decompressing...');
    const decompressed = await decompressData(compressed);
    log('Decompressed: ' + formatBytes(decompressed.length));

    // Verify
    const hash = await hashData(decompressed);
    log(hash === metadata.hash ? 'SHA-256 verified' : 'WARNING: hash mismatch');

    hideProgress();

    // Show download UI
    dlFilename.textContent = metadata.name || 'encrypted-file';
    dlSize.textContent = formatBytes(metadata.size);
    downloadSection.classList.remove('hidden');
    setStatus('File ready');

    dlBtn.onclick = () => {
      const blob = new Blob([decompressed], { type: metadata.type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = metadata.name || 'file';
      a.click();
      URL.revokeObjectURL(url);
      log('Download: ' + (metadata.name || 'file'));
    };

  } catch (err) {
    setStatus('Error: ' + err.message);
    log('ERROR: ' + err.message);
    hideProgress();
  }
}

// --- Copy ---
copyLinkBtn.addEventListener('click', () => {
  shareLinkEl.select();
  navigator.clipboard.writeText(shareLinkEl.value);
  copyLinkBtn.textContent = 'Copied!';
  setTimeout(() => { copyLinkBtn.textContent = 'Copy'; }, 2000);
});

// --- Directory ---
function formatAge(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

async function loadDirectory() {
  dirList.innerHTML = '<div class="dir-empty">loading...</div>';
  log('Loading directory...');
  try {
    const files = await listFiles();
    log('Found ' + files.length + ' file(s)');
    if (files.length === 0) {
      dirList.innerHTML = '<div class="dir-empty">no files yet</div>';
      return;
    }
    dirList.innerHTML = '';
    for (const f of files) {
      const el = document.createElement('div');
      const badge = f.isPublic
        ? '<span class="dir-badge pub">public</span>'
        : '<span class="dir-badge enc">encrypted</span>';
      const label = f.isPublic && f.name ? f.name : f.id;

      if (f.isPublic) {
        el.className = 'dir-entry clickable';
        el.innerHTML = '<span class="dir-id">' + label + '</span>' + badge + '<span class="dir-age">' + formatAge(f.created) + '</span>';
        el.addEventListener('click', () => {
          location.hash = 'p:' + f.id;
          downloadFile(null);
        });
      } else {
        el.className = 'dir-entry';
        el.innerHTML = '<span class="dir-id">' + f.id + '</span>' + badge + '<span class="dir-age">' + formatAge(f.created) + '</span>';
      }
      dirList.appendChild(el);
    }
  } catch (err) {
    dirList.innerHTML = '<div class="dir-empty">failed to load</div>';
    log('Directory error: ' + err.message);
  }
}

dirRefresh.addEventListener('click', loadDirectory);

// --- Init ---
if (location.hash.length > 1) {
  downloadFile(null);
}
