// transfer.js — file chunking, sending, receiving, hash verification

import { hashFile } from './crypto.js';

const CHUNK_SIZE = 16 * 1024; // 16KB per chunk
const BUFFER_THRESHOLD = 1024 * 1024; // 1MB — pause sending if buffered exceeds this

export async function sendFile(dc, file, onProgress) {
  const metadata = JSON.stringify({
    type: 'meta',
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream'
  });
  dc.send(metadata);

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

    dc.send(chunk);
    sent += end - start;
    if (onProgress) onProgress(sent, file.size, i + 1, totalChunks);
  }

  const hash = await hashFile(buffer);
  dc.send(JSON.stringify({ type: 'done', hash }));
  return hash;
}

export function receiveFile(dc, onProgress, onComplete) {
  let meta = null;
  const chunks = [];
  let received = 0;

  dc.binaryType = 'arraybuffer';

  dc.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);

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
        const verified = localHash === msg.hash;
        onComplete({
          blob,
          name: meta.name,
          size: meta.size,
          hash: msg.hash,
          localHash,
          verified
        });
        return;
      }
    }

    // Binary chunk
    chunks.push(e.data);
    received += e.data.byteLength;
    if (onProgress && meta) onProgress(received, meta.size);
  };
}
