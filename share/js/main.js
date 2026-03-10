// main.js — UI orchestration and state machine

import {
  generateKey, exportKey, importKey, deriveRoomId
} from './crypto.js?v=8';
import {
  createRoom, postAnswer, pollForAnswer, pollForRoom, closeRoom,
  setLogger
} from './signaling.js?v=8';
import {
  createPeerConnection, createOffer, createAnswer,
  acceptAnswer, onDataChannel, waitForOpen
} from './rtc.js?v=8';
import { sendFile, receiveFile } from './transfer.js?v=8';

// --- DOM ---
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const debugEl = $('debug');
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

function log(msg) {
  console.log(`[sea] ${msg}`);
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugEl.appendChild(line);
  debugEl.scrollTop = debugEl.scrollHeight;
  debugEl.classList.remove('hidden');
}

// Wire signaling debug logs to UI
setLogger(log);

let failTimeout = null;

function handleStateChange(type, state) {
  log(`${type}: ${state}`);
  if (type === 'connection') {
    connState.classList.remove('hidden');

    if (state === 'connected') {
      // Cancel any pending failure message
      if (failTimeout) { clearTimeout(failTimeout); failTimeout = null; }
      connState.textContent = state;
      connState.className = `conn-state ${state}`;
    } else if (state === 'failed') {
      // Delay — TURN fallback may still recover the connection
      if (!failTimeout) {
        failTimeout = setTimeout(() => {
          if (pc?.connectionState === 'failed') {
            connState.textContent = 'failed';
            connState.className = 'conn-state failed';
            setStatus('Connection failed — peers may be behind incompatible NATs');
          }
          failTimeout = null;
        }, 5000);
      }
    } else if (state === 'disconnected') {
      connState.textContent = state;
      connState.className = `conn-state ${state}`;
      setStatus('Peer disconnected');
    } else {
      // connecting, new, etc.
      connState.textContent = state;
      connState.className = `conn-state ${state}`;
    }
  }
}

function showProgress(sent, total, speed) {
  progressEl.classList.remove('hidden');
  const pct = Math.round((sent / total) * 100);
  progressBar.style.width = `${pct}%`;
  const speedStr = speed ? ` — ${formatBytes(speed)}/s` : '';
  progressText.textContent = `${pct}% (${formatBytes(sent)} / ${formatBytes(total)})${speedStr}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function setupReceiver(channel, key) {
  receiveFile(channel, key,
    (received, total, speed) => showProgress(received, total, speed),
    (result) => {
      progressEl.classList.add('hidden');
      const el = document.createElement('div');
      el.className = 'received-file';
      const url = URL.createObjectURL(result.blob);
      const speedStr = result.avgSpeed ? ` @ ${formatBytes(result.avgSpeed)}/s` : '';
      el.innerHTML = `
        <a href="${url}" download="${escapeHtml(result.name)}">${escapeHtml(result.name)}</a>
        <span class="file-size">${formatBytes(result.size)}${speedStr}</span>
        <span class="hash-status ${result.verified ? 'verified' : 'failed'}">
          ${result.verified ? 'SHA-256 verified' : 'HASH MISMATCH'}
        </span>
      `;
      receivedEl.appendChild(el);
      receivedEl.classList.remove('hidden');
      log(`Received: ${result.name} (${result.verified ? 'verified' : 'HASH MISMATCH'}${speedStr})`);
    }
  );
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Create Room (Peer A) ---
createBtn.addEventListener('click', async () => {
  try {
    createBtn.disabled = true;
    setStatus('Generating encryption key...');
    log('Generating AES-256-GCM key');

    roomKey = await generateKey();
    const roomId = await deriveRoomId(roomKey);
    const keyStr = await exportKey(roomKey);
    log(`Room ID: ${roomId}`);

    setStatus('Creating WebRTC offer...');
    pc = createPeerConnection(handleStateChange);
    log('Peer connection created with STUN + TURN servers');
    const { dataChannel, sdp } = await createOffer(pc);
    dc = dataChannel;
    log('SDP offer created, ICE gathering complete');

    setStatus('Posting encrypted offer...');
    issueNumber = await createRoom(roomId, sdp, roomKey);
    log(`Signaling issue #${issueNumber} created`);

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
    log('Received encrypted answer from peer');

    setStatus('Connecting...');
    await acceptAnswer(pc, answerSdp);
    log('Remote description set, establishing P2P connection...');

    await waitForOpen(dc);
    log('DataChannel open — E2E encrypted with room key');
    setupReceiver(dc, roomKey);

    // Cleanup signaling
    closeRoom(issueNumber).catch(() => {});
    log('Signaling issue closed');

    setStatus('Connected — ready to transfer files (E2E encrypted)');
    fileInput.disabled = false;
    sendBtn.disabled = false;

  } catch (err) {
    setStatus(`Error: ${err.message}`);
    log(`ERROR: ${err.message}`);
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
  log('Extracting room key from URL fragment');

  try {
    roomKey = await importKey(fragment);
    const roomId = await deriveRoomId(roomKey);
    log(`Room ID: ${roomId}`);

    setStatus('Searching for room...');
    abortController = new AbortController();
    const found = await pollForRoom(roomId, roomKey, abortController.signal);
    issueNumber = found.issueNumber;
    log(`Found signaling issue #${issueNumber}, decrypted SDP offer`);

    setStatus('Creating WebRTC answer...');
    pc = createPeerConnection(handleStateChange);
    log('Peer connection created with STUN + TURN servers');
    const dcPromise = onDataChannel(pc);
    const answerSdp = await createAnswer(pc, found.sdpOffer);
    log('SDP answer created, ICE gathering complete');

    setStatus('Posting encrypted answer...');
    await postAnswer(issueNumber, answerSdp, roomKey);
    log('Answer posted to signaling issue');

    setStatus('Connecting...');
    dc = await dcPromise;
    log('DataChannel received');
    await waitForOpen(dc);
    log('DataChannel open — E2E encrypted with room key');
    setupReceiver(dc, roomKey);

    // Cleanup signaling
    closeRoom(issueNumber).catch(() => {});
    log('Signaling issue closed');

    setStatus('Connected — ready to transfer files (E2E encrypted)');
    fileInput.disabled = false;
    sendBtn.disabled = false;

  } catch (err) {
    setStatus(`Error: ${err.message}`);
    log(`ERROR: ${err.message}`);
  }
}

// --- Send File ---
sendBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  sendBtn.disabled = true;
  setStatus(`Sending ${file.name}...`);
  log(`Sending: ${file.name} (${formatBytes(file.size)}) — E2E encrypting chunks`);

  try {
    await sendFile(dc, file, roomKey, (sent, total, chunks, totalChunks, speed) => showProgress(sent, total, speed));
    progressEl.classList.add('hidden');
    setStatus(`Sent ${file.name}`);
    log(`Sent: ${file.name} complete`);
  } catch (err) {
    setStatus(`Send error: ${err.message}`);
    log(`SEND ERROR: ${err.message}`);
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
