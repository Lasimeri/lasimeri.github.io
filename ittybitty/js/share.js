// share.js — QR code, clipboard, Web Share API

let qrModule = null;

async function loadQR() {
  if (qrModule) return qrModule;
  const script = document.createElement('script');
  script.src = '/ittybitty/lib/qrcode.min.js';
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  qrModule = window.qrcode;
  return qrModule;
}

export async function generateQR(url, container) {
  container.innerHTML = '';

  if (url.length > 4296) {
    const warn = document.createElement('div');
    warn.className = 'qr-warning';
    warn.textContent = 'URL too long for QR code';
    container.appendChild(warn);
    return;
  }

  try {
    const qr = await loadQR();
    const typeNumber = 0; // auto-detect
    const errorCorrection = 'L';
    const code = qr(typeNumber, errorCorrection);
    code.addData(url);
    code.make();

    const canvas = document.createElement('canvas');
    const size = 256;
    const moduleCount = code.getModuleCount();
    const cellSize = size / moduleCount;
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, size, size);

    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        ctx.fillStyle = code.isDark(row, col) ? '#c8c8d0' : '#0a0a0f';
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }

    container.appendChild(canvas);
  } catch (e) {
    const err = document.createElement('div');
    err.className = 'qr-warning';
    err.textContent = 'failed to generate QR code';
    container.appendChild(err);
  }
}

export async function shareURL(url, title) {
  if (canShare()) {
    try {
      await navigator.share({ title: title || 'itty-bitty page', url });
      return { method: 'share', success: true };
    } catch {
      return { method: 'share', success: false };
    }
  }
  const success = await copyToClipboard(url);
  return { method: 'clipboard', success };
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-HTTPS or older browsers
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return true;
    } catch {
      return false;
    }
  }
}

export function getURLWarnings(url) {
  const len = typeof url === 'object' ? url.length : url.length;
  const warnings = [];

  if (len > 64000) {
    warnings.push({ level: 'error', message: 'URL exceeds 64KB — may not work in most browsers' });
  } else if (len > 8000) {
    warnings.push({ level: 'danger', message: 'URL exceeds 8KB — many services will truncate' });
  } else if (len > 2000) {
    warnings.push({ level: 'warn', message: 'URL exceeds 2KB — may not work in all sharing contexts' });
  }

  if (len > 4296) {
    warnings.push({ level: 'info', message: 'URL too long for QR code' });
  }

  return warnings;
}

export function canShare() {
  return typeof navigator !== 'undefined' && !!navigator.share;
}
