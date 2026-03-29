// main.js - Encrypted file hosting state machine

import {
  generateKey, exportKey, importKey, deriveRoomId,
  encrypt, decrypt
} from './crypto.js?v=1';
import { createFile, postChunk, fetchFile, listFiles, setLogger } from './storage.js?v=1';

const MAX_FILE_SIZE = 2.5 * 1024 * 1024; // 2.5 MB raw limit
const CHUNK_SIZE = 48000; // ~48KB per chunk (leaves room for base64 overhead within 65536 char limit)

// --- DOM ---
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const logEl = $('log');
const uploadSection = $('upload-section');
const shareSection = $('share-section');
const downloadSection = $('download-section');
const fileInput = $('file-input');
const uploadBtn = $('upload-btn');
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

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function showProgress(current, total, label) {
  const pct = Math.round((current / total) * 100);
  progressBar.style.width = pct + '%';
  progressText.textContent = label + ' ' + pct + '%';
  progressContainer.classList.remove('hidden');
}

function hideProgress() {
  progressContainer.classList.add('hidden');
}

function bufToBase64(buf) {
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

function base64ToBuf(b64) {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

// Compress using deflate
async function compressData(data) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

async function decompressData(data) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

// SHA-256 hash
async function hashData(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Upload ---
uploadBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    setStatus('File too large - ' + formatBytes(MAX_FILE_SIZE) + ' limit');
    log('BLOCKED: ' + file.name + ' (' + formatBytes(file.size) + ') exceeds limit');
    return;
  }

  uploadBtn.disabled = true;
  try {
    log('File: ' + file.name + ' (' + formatBytes(file.size) + ')');

    // Read file
    setStatus('Reading file...');
    const arrayBuf = await file.arrayBuffer();
    const rawData = new Uint8Array(arrayBuf);
    log('Read ' + formatBytes(rawData.length));

    // Hash original
    const hash = await hashData(rawData);
    log('SHA-256: ' + hash.slice(0, 16) + '...');

    // Compress
    setStatus('Compressing...');
    log('Compressing...');
    const compressed = await compressData(rawData);
    const ratio = ((1 - compressed.length / rawData.length) * 100).toFixed(1);
    log('Compressed: ' + formatBytes(rawData.length) + ' -> ' + formatBytes(compressed.length) + ' (' + ratio + '% reduction)');

    // Generate encryption key
    setStatus('Generating key...');
    const key = await generateKey();
    const keyExport = await exportKey(key);
    const fileId = await deriveRoomId(key);
    log('File ID: ' + fileId);

    // Split compressed data into chunks and encrypt each
    const totalChunks = Math.ceil(compressed.length / CHUNK_SIZE);
    log('Splitting into ' + totalChunks + ' chunks (' + formatBytes(CHUNK_SIZE) + ' each)');

    const encryptedChunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, compressed.length);
      const chunkBuf = compressed.slice(start, end);
      const chunkB64 = bufToBase64(chunkBuf);
      const encChunk = await encrypt(chunkB64, key);
      encryptedChunks.push(encChunk);
      showProgress(i + 1, totalChunks, 'Encrypting');
    }
    log('All chunks encrypted');

    // Metadata
    const metadata = {
      name: file.name,
      size: file.size,
      compressedSize: compressed.length,
      type: file.type || 'application/octet-stream',
      hash: hash,
      chunks: totalChunks,
      ts: new Date().toISOString()
    };

    // Upload: issue body = metadata + chunk 0, comments = chunks 1..N
    setStatus('Uploading...');
    showProgress(0, totalChunks, 'Uploading');
    const issueNumber = await createFile(fileId, metadata, encryptedChunks[0]);
    showProgress(1, totalChunks, 'Uploading');

    for (let i = 1; i < encryptedChunks.length; i++) {
      await postChunk(issueNumber, i, encryptedChunks[i]);
      showProgress(i + 1, totalChunks, 'Uploading');
    }
    log('All ' + totalChunks + ' chunks uploaded');

    // Show share link
    const url = location.origin + location.pathname + '#' + keyExport;
    shareLinkEl.value = url;
    uploadSection.classList.add('hidden');
    shareSection.classList.remove('hidden');
    hideProgress();
    history.replaceState(null, '', location.pathname);

    setStatus('File hosted - share the link');
    log('Done');

  } catch (err) {
    setStatus('Error: ' + err.message);
    log('ERROR: ' + err.message);
    uploadBtn.disabled = false;
    hideProgress();
  }
});

// --- Download ---
async function downloadFile() {
  const frag = location.hash.slice(1);
  if (!frag) return;

  history.replaceState(null, '', location.pathname);
  uploadSection.classList.add('hidden');

  try {
    setStatus('Importing key...');
    log('Importing key from URL...');
    const key = await importKey(frag);
    const fileId = await deriveRoomId(key);
    log('File ID: ' + fileId);

    setStatus('Fetching file...');
    log('Searching for file...');
    const { metadata, chunks } = await fetchFile(fileId);
    log('Found: ' + metadata.name + ' (' + formatBytes(metadata.size) + ', ' + metadata.chunks + ' chunks)');

    // Decrypt all chunks
    setStatus('Decrypting...');
    const decryptedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const decB64 = await decrypt(chunks[i], key);
      const chunkBuf = base64ToBuf(decB64);
      decryptedChunks.push(chunkBuf);
      showProgress(i + 1, chunks.length, 'Decrypting');
    }
    log('All chunks decrypted');

    // Reassemble compressed data
    const totalLen = decryptedChunks.reduce((a, c) => a + c.length, 0);
    const compressed = new Uint8Array(totalLen);
    let off = 0;
    for (const c of decryptedChunks) { compressed.set(c, off); off += c.length; }
    log('Reassembled: ' + formatBytes(compressed.length) + ' compressed');

    // Decompress
    setStatus('Decompressing...');
    log('Decompressing...');
    const decompressed = await decompressData(compressed);
    log('Decompressed: ' + formatBytes(decompressed.length));

    // Verify hash
    const hash = await hashData(decompressed);
    if (hash === metadata.hash) {
      log('SHA-256 verified');
    } else {
      log('WARNING: SHA-256 mismatch! Expected ' + metadata.hash.slice(0, 16) + '... got ' + hash.slice(0, 16) + '...');
    }

    hideProgress();

    // Show download UI
    dlFilename.textContent = metadata.name;
    dlSize.textContent = formatBytes(metadata.size);
    downloadSection.classList.remove('hidden');
    setStatus('File ready');

    // Wire download button
    dlBtn.onclick = () => {
      const blob = new Blob([decompressed], { type: metadata.type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = metadata.name;
      a.click();
      URL.revokeObjectURL(url);
      log('Download started: ' + metadata.name);
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

// --- File Directory ---
async function loadDirectory() {
  dirList.innerHTML = '<div class="dir-empty">loading...</div>';
  log('Loading file directory...');
  try {
    const files = await listFiles();
    log('Found ' + files.length + ' file(s)');
    if (files.length === 0) {
      dirList.innerHTML = '<div class="dir-empty">no files yet</div>';
    } else {
      dirList.innerHTML = '';
      for (const f of files) {
        const el = document.createElement('div');
        el.className = 'dir-entry';
        el.innerHTML = '<span class="dir-id">' + f.id + '</span><span class="dir-age">' + formatAge(f.created) + '</span>';
        dirList.appendChild(el);
      }
    }
  } catch (err) {
    dirList.innerHTML = '<div class="dir-empty">failed to load</div>';
    log('Directory error: ' + err.message);
  }
}

function formatAge(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

dirRefresh.addEventListener('click', loadDirectory);

// --- Init ---
if (location.hash.length > 1) {
  downloadFile();
}
