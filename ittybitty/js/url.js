// url.js — URL fragment encoder/decoder

export const TYPE_MAP = {
  html: 'h',
  markdown: 'm',
  svg: 's',
  json: 'j',
  text: 't',
};

export const FORMAT_MAP = {
  gzip: 'g',
  lzma: 'l',
  none: 'n',
};

const TYPE_REVERSE = Object.fromEntries(
  Object.entries(TYPE_MAP).map(([k, v]) => [v, k])
);

const FORMAT_REVERSE = Object.fromEntries(
  Object.entries(FORMAT_MAP).map(([k, v]) => [v, k])
);

// Encode a page into a URL fragment
// Returns string starting with #
export function encode({ title, type, format, encrypted, data }) {
  const t = TYPE_MAP[type] || 'h';
  const f = FORMAT_MAP[format] || 'b';
  const e = encrypted ? '1' : '0';
  const header = `${t}${f}${e}`;
  const encoded = bufToBase64url(data);
  const titlePart = title
    ? `/${encodeURIComponent(title.replace(/\s+/g, '-'))}`
    : '';
  return `#${titlePart}/${header},${encoded}`;
}

// Decode a URL fragment into components
// Returns { title, type, format, encrypted, data: Uint8Array }
export function decode(fragment) {
  let frag = fragment.startsWith('#') ? fragment.slice(1) : fragment;

  // Parse: /optional-title/TFE,DATA  or  /TFE,DATA
  if (frag.startsWith('/')) frag = frag.slice(1);

  const parts = frag.split('/');
  let title = '';
  let payload;

  if (parts.length > 1) {
    title = decodeURIComponent(parts[0].replace(/-/g, ' '));
    payload = parts.slice(1).join('/');
  } else {
    payload = parts[0];
  }

  const commaIdx = payload.indexOf(',');
  if (commaIdx === -1 || commaIdx > 3) {
    throw new Error('Invalid fragment format: missing header');
  }

  const header = payload.slice(0, commaIdx);
  const dataStr = payload.slice(commaIdx + 1);

  const type = TYPE_REVERSE[header[0]] || 'html';
  const format = FORMAT_REVERSE[header[1]] || 'gzip';
  const encrypted = header[2] === '1';
  const data = base64urlToBuf(dataStr);

  return { title, type, format, encrypted, data };
}

// Detect if a fragment looks like an original itty-bitty URL
export function detectLegacy(fragment) {
  const frag = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const clean = frag.startsWith('/') ? frag.slice(1) : frag;

  // Original format uses data: URIs
  if (clean.includes('data:')) return true;

  // Or has LZMA magic bytes in base64 (XQA prefix)
  // Find the data portion (after last /)
  const parts = clean.split('/');
  const last = parts[parts.length - 1];

  // New format always has a comma at position 3 (TFE,DATA)
  const commaIdx = last.indexOf(',');
  if (commaIdx === 3) {
    const header = last.slice(0, 3);
    // Check if all 3 chars are valid header chars
    if (
      'hmsjt'.includes(header[0]) &&
      'bgln'.includes(header[1]) &&
      '01'.includes(header[2])
    ) {
      return false; // Valid new format
    }
  }

  // If starts with XQA (LZMA) or doesn't have our header format, it's legacy
  if (last.startsWith('XQA')) return true;

  return true; // Default to legacy for unknown formats
}

// Base64url encode (RFC 4648 §5, no padding)
export function bufToBase64url(buf) {
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Base64url decode
export function base64urlToBuf(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  b64 += '='.repeat(pad);
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}
