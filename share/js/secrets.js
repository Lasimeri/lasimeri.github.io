// secrets.js — AES-256-GCM runtime decryption of embedded secrets
// All sensitive strings are encrypted at rest, decrypted only in RAM

// Key material — split and reassembled at runtime
const _k = ['R4vN', 'Zw2L', 'mQ9p', 'g7Kx'];
const _ki = [1, 3, 2, 0]; // assembly order

async function _deriveKey() {
  const phrase = _ki.map(i => _k[i]).join('');
  const raw = new TextEncoder().encode(phrase);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['decrypt']);
}

let _cachedKey = null;

export async function unlock(hexCipher) {
  if (!_cachedKey) _cachedKey = await _deriveKey();
  const bytes = new Uint8Array(hexCipher.match(/.{2}/g).map(b => parseInt(b, 16)));
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, _cachedKey, ciphertext
  );
  return new TextDecoder().decode(plain);
}
