// main.js — UI orchestration and state machine

import {
  generateKey, exportKey, importKey, deriveRoomId
} from './crypto.js';
import {
  createRoom, postAnswer, pollForAnswer, pollForRoom, closeRoom
} from './signaling.js';
import {
  createPeerConnection, createOffer, createAnswer,
  acceptAnswer, onDataChannel, waitForOpen, onConnectionState
} from './rtc.js';
import { sendFile, receiveFile } from './transfer.js';

// --- DOM ---
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const createBtn = $('create-room');
const joinSection = $('join-section');
const shareSection = $('share-section');
const shareLinkEl = $('share-link');
const copyBtn = $('copy-link');
const fileInput = $('file-input');
const sendBtn = $('send-file');
const progressEl = $('progress');
const progressBar = $('progress-bar');
const progressText = $('progress-text');
const receivedEl = $('received');
const connState = $('conn-state');

let pc = null;
let dc = null;
let roomKey = null;
let issueNumber = null;
let abortController = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function showProgress(sent, total) {
  progressEl.classList.remove('hidden');
  const pct = Math.round((sent / total) * 100);
  progressBar.style.width = `${pct}%`;
  progressText.textContent = `${pct}% (${formatBytes(sent)} / ${formatBytes(total)})`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function setupReceiver(channel) {
  receiveFile(channel,
    (received, total) => showProgress(received, total),
    (result) => {
      progressEl.classList.add('hidden');
      const el = document.createElement('div');
      el.className = 'received-file';
      const url = URL.createObjectURL(result.blob);
      el.innerHTML = `
        <a href="${url}" download="${escapeHtml(result.name)}">${escapeHtml(result.name)}</a>
        <span class="file-size">${formatBytes(result.size)}</span>
        <span class="hash-status ${result.verified ? 'verified' : 'failed'}">
          ${result.verified ? 'SHA-256 verified' : 'HASH MISMATCH'}
        </span>
      `;
      receivedEl.appendChild(el);
      receivedEl.classList.remove('hidden');
    }
  );
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setupConnectionMonitor() {
  onConnectionState(pc, (state) => {
    connState.textContent = state;
    connState.className = `conn-state ${state}`;
    if (state === 'disconnected' || state === 'failed') {
      setStatus('Peer disconnected');
    }
  });
}

// --- Create Room (Peer A) ---
createBtn.addEventListener('click', async () => {
  try {
    createBtn.disabled = true;
    setStatus('Generating encryption key...');

    roomKey = await generateKey();
    const roomId = await deriveRoomId(roomKey);
    const keyStr = await exportKey(roomKey);

    setStatus('Creating WebRTC offer...');
    pc = createPeerConnection();
    const { dataChannel, sdp } = await createOffer(pc);
    dc = dataChannel;

    setStatus('Posting encrypted offer...');
    issueNumber = await createRoom(roomId, sdp, roomKey);

    // Build share URL
    const url = `${location.origin}${location.pathname}#${keyStr}`;
    shareLinkEl.value = url;
    joinSection.classList.add('hidden');
    shareSection.classList.remove('hidden');

    // Strip key from browser history
    history.replaceState(null, '', location.pathname);

    setStatus('Waiting for peer...');
    abortController = new AbortController();
    const answerSdp = await pollForAnswer(
      issueNumber, roomKey, abortController.signal
    );

    setStatus('Connecting...');
    await acceptAnswer(pc, answerSdp);

    await waitForOpen(dc);
    setupReceiver(dc);
    setupConnectionMonitor();

    // Cleanup signaling
    closeRoom(issueNumber).catch(() => {});

    setStatus('Connected — ready to transfer files');
    fileInput.disabled = false;
    sendBtn.disabled = false;

  } catch (err) {
    setStatus(`Error: ${err.message}`);
    createBtn.disabled = false;
  }
});

// --- Join Room (Peer B) ---
async function joinRoom() {
  const fragment = location.hash.slice(1);
  if (!fragment) return;

  // Strip key from history immediately
  history.replaceState(null, '', location.pathname);

  joinSection.classList.add('hidden');
  setStatus('Decrypting room key...');

  try {
    roomKey = await importKey(fragment);
    const roomId = await deriveRoomId(roomKey);

    setStatus('Searching for room...');
    abortController = new AbortController();
    const found = await pollForRoom(roomId, roomKey, abortController.signal);
    issueNumber = found.issueNumber;

    setStatus('Creating WebRTC answer...');
    pc = createPeerConnection();
    const dcPromise = onDataChannel(pc);
    const answerSdp = await createAnswer(pc, found.sdpOffer);

    setStatus('Posting encrypted answer...');
    await postAnswer(issueNumber, answerSdp, roomKey);

    setStatus('Connecting...');
    dc = await dcPromise;
    await waitForOpen(dc);
    setupReceiver(dc);
    setupConnectionMonitor();

    // Cleanup signaling
    closeRoom(issueNumber).catch(() => {});

    setStatus('Connected — ready to transfer files');
    fileInput.disabled = false;
    sendBtn.disabled = false;

  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

// --- Send File ---
sendBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  sendBtn.disabled = true;
  setStatus(`Sending ${file.name}...`);

  try {
    await sendFile(dc, file, (sent, total) => showProgress(sent, total));
    progressEl.classList.add('hidden');
    setStatus(`Sent ${file.name} — SHA-256 verified`);
  } catch (err) {
    setStatus(`Send error: ${err.message}`);
  }

  sendBtn.disabled = false;
});

// --- Copy Link ---
copyBtn.addEventListener('click', () => {
  shareLinkEl.select();
  navigator.clipboard.writeText(shareLinkEl.value);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
});

// --- Init ---
if (location.hash.length > 1) {
  joinRoom();
}
