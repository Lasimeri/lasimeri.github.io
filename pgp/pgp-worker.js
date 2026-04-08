// Web Worker for PGP WASM — compiles and runs crypto off the main thread
let wasm;

self.onmessage = async function(e) {
  const { type, id } = e.data;

  try {
    if (type === 'init') {
      self.postMessage({ id, status: 'loading module' });
      const mod = await import('/pgp/wasm/pkg/glass_pgp.js');
      self.postMessage({ id, status: 'fetching wasm' });
      const bytes = await fetch('/pgp/wasm/pkg/glass_pgp_bg.wasm').then(r => r.arrayBuffer());
      self.postMessage({ id, status: 'compiling wasm' });
      await mod.default({ module_or_path: bytes });
      wasm = mod;
      self.postMessage({ id, type: 'ready' });
    }

    else if (type === 'keygen') {
      const { name, email, passphrase } = e.data;
      self.postMessage({ id, status: 'generating rsa-4096 keypair...' });
      const result = wasm.pgp_keygen(name, email, passphrase);
      self.postMessage({ id, type: 'result', data: result });
    }

    else if (type === 'encrypt') {
      const { plaintext, pubkey } = e.data;
      self.postMessage({ id, status: 'encrypting...' });
      const encrypted = wasm.pgp_encrypt(new Uint8Array(plaintext), pubkey);
      self.postMessage({ id, type: 'result', data: Array.from(encrypted) });
    }

    else if (type === 'decrypt') {
      const { encrypted, seckey, passphrase } = e.data;
      self.postMessage({ id, status: 'decrypting...' });
      const decrypted = wasm.pgp_decrypt(new Uint8Array(encrypted), seckey, passphrase);
      self.postMessage({ id, type: 'result', data: Array.from(decrypted) });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: err.message || String(err) });
  }
};
