// transfer.js — E2E encrypted file chunking, sending, receiving, hash verification

import { hashFile } from './crypto.js?v=3';

const CHUNK_SIZE = 16 * 1024; // 16KB per chunk
const BUFFER_THRESHOLD = 1024 * 1024; // 1MB — pause sending if buffered exceeds this

// Message type prefixes (prepended before encryption)
const MSG_CONTROL = 0x00;
const MSG_CHUNK = 0x01;

// --- E2E encryption (independent of DTLS transport layer) ---

async function encryptBinary(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, data
  );
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out.buffer;
}

async function decryptBinary(data, key) {
  const buf = new Uint8Array(data);
  const iv = buf.slice(0, 12);
  const ciphertext = buf.slice(12);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, ciphertext
  );
}

// --- Message framing ---

function packControl(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const packed = new Uint8Array(1 + json.length);
  packed[0] = MSG_CONTROL;
  packed.set(json, 1);
  return packed;
}

function packChunk(chunk) {
  const bytes = new Uint8Array(chunk);
  const packed = new Uint8Array(1 + bytes.length);
  packed[0] = MSG_CHUNK;
  packed.set(bytes, 1);
  return packed;
}

// --- Send ---

export async function sendFile(dc, file, roomKey, onProgress) {
  // Encrypted metadata
  const meta = packControl({
    type: 'meta',
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream'
  });
  dc.send(await encryptBinary(meta, roomKey));

  const buffer = await file.arrayBuffer();
  const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
  let sent = 0;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
    const chunk = buffer.slice(start, end);

    // Flow control — wait if buffer is full
    while (dc.bufferedAmount > BUFFER_THRESHOLD) {
      await new Promise((resolve) => {
        dc.onbufferedamountlow = resolve;
        dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;
      });
    }

    dc.send(await encryptBinary(packChunk(chunk), roomKey));
    sent += end - start;
    if (onProgress) onProgress(sent, file.size, i + 1, totalChunks);
  }

  // Encrypted completion + hash (hash is of plaintext file, computed before encryption)
  const hash = await hashFile(buffer);
  dc.send(await encryptBinary(packControl({ type: 'done', hash }), roomKey));
  return hash;
}

// --- Receive ---

export function receiveFile(dc, roomKey, onProgress, onComplete) {
  let meta = null;
  const chunks = [];
  let received = 0;

  dc.binaryType = 'arraybuffer';

  dc.onmessage = async (e) => {
    // Decrypt
    const decrypted = await decryptBinary(e.data, roomKey);
    const bytes = new Uint8Array(decrypted);
    const type = bytes[0];
    const payload = bytes.slice(1);

    if (type === MSG_CONTROL) {
      const msg = JSON.parse(new TextDecoder().decode(payload));

      if (msg.type === 'meta') {
        meta = msg;
        chunks.length = 0;
        received = 0;
        return;
      }

      if (msg.type === 'done') {
        const blob = new Blob(chunks, { type: meta.mimeType });
        const buffer = await blob.arrayBuffer();
        const localHash = await hashFile(buffer);
        onComplete({
          blob,
          name: meta.name,
          size: meta.size,
          hash: msg.hash,
          localHash,
          verified: localHash === msg.hash
        });
        return;
      }
    }

    if (type === MSG_CHUNK) {
      chunks.push(payload.buffer);
      received += payload.byteLength;
      if (onProgress && meta) onProgress(received, meta.size);
    }
  };
}
