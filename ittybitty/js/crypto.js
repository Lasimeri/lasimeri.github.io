// crypto.js — AES-256-GCM encryption with PBKDF2 key derivation

const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

async function deriveKey(passphrase, salt) {
  const encoded = new TextEncoder().encode(passphrase);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoded,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt data with passphrase
// Returns: salt(16) || iv(12) || ciphertext
export async function encrypt(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(passphrase, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    data
  );

  const result = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(iv, SALT_LENGTH);
  result.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);
  return result;
}

// Decrypt data with passphrase
// Expects: salt(16) || iv(12) || ciphertext
export async function decrypt(data, passphrase) {
  const salt = data.slice(0, SALT_LENGTH);
  const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = data.slice(SALT_LENGTH + IV_LENGTH);
  const key = await deriveKey(passphrase, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext
  );

  return new Uint8Array(plaintext);
}
