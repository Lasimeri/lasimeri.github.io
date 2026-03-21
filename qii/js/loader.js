// loader.js — demo download, ZIP extraction, PAK management

var QII = QII || {};

QII.loader = (function() {

  function fetchDirect(url, onProgress) {
    return fetch(url).then(function(response) {
      if (!response.ok) throw new Error('Download failed: ' + response.status);
      var total = parseInt(response.headers.get('Content-Length') || '0', 10);
      var loaded = 0;
      var chunks = [];
      var reader = response.body.getReader();
      function pump() {
        return reader.read().then(function(result) {
          if (result.done) {
            var blob = new Blob(chunks);
            return blob.arrayBuffer();
          }
          chunks.push(result.value);
          loaded += result.value.length;
          if (onProgress) onProgress(loaded, total);
          return pump();
        });
      }
      return pump();
    });
  }

  function downloadDemo(onProgress) {
    return fetch(QII.DEMO_EXE_URL).then(function(response) {
      if (!response.ok) throw new Error('Download failed: ' + response.status);

      var total = parseInt(response.headers.get('Content-Length') || '0', 10);
      var loaded = 0;
      var chunks = [];
      var reader = response.body.getReader();

      function pump() {
        return reader.read().then(function(result) {
          if (result.done) {
            var blob = new Blob(chunks);
            return blob.arrayBuffer();
          }
          chunks.push(result.value);
          loaded += result.value.length;
          if (onProgress) onProgress(loaded, total);
          return pump();
        });
      }

      return pump();
    });
  }

  function extractPak(exeBuffer) {
    return JSZip.loadAsync(exeBuffer).then(function(zip) {
      var pakFile = zip.file(QII.PAK_PATH_IN_EXE);
      if (!pakFile) {
        // Try case-insensitive search
        var found = null;
        var target = QII.PAK_PATH_IN_EXE.toLowerCase();
        zip.forEach(function(path, entry) {
          if (path.toLowerCase() === target) found = entry;
        });
        if (!found) throw new Error('pak0.pak not found in archive');
        pakFile = found;
      }
      return pakFile.async('arraybuffer');
    });
  }

  function verifyPak(buffer) {
    if (!crypto.subtle) {
      // crypto.subtle unavailable (non-HTTPS) — skip verification
      console.warn('[qii] SHA-256 verification skipped (requires HTTPS)');
      return Promise.resolve(buffer);
    }
    return crypto.subtle.digest('SHA-256', buffer).then(function(hashBuf) {
      var arr = new Uint8Array(hashBuf);
      var hex = '';
      for (var i = 0; i < arr.length; i++) {
        hex += ('0' + arr[i].toString(16)).slice(-2);
      }
      if (hex !== QII.PAK0_SHA256) {
        throw new Error('pak0.pak hash mismatch: ' + hex);
      }
      return buffer;
    });
  }

  function loadGameData(onProgress, onStatus) {
    // Returns a dict of { filename: ArrayBuffer }
    return QII.storage.list().then(function(keys) {
      var paks = {};
      var pakKeys = keys.filter(function(k) { return k.endsWith('.pak'); });

      if (pakKeys.length > 0) {
        if (onStatus) onStatus('Loading cached game data...');
        var promises = pakKeys.map(function(key) {
          return QII.storage.get(key).then(function(data) {
            paks[key] = data;
          });
        });
        return Promise.all(promises).then(function() { return paks; });
      }

      // No cached data — try direct PAK URL first, fall back to exe download
      if (QII.DIRECT_PAK_URL) {
        if (onStatus) onStatus('Downloading pak0.pak (~47 MB)...');
        return fetchDirect(QII.DIRECT_PAK_URL, onProgress).then(function(pakBuffer) {
          if (onStatus) onStatus('Verifying pak0.pak...');
          return verifyPak(pakBuffer);
        }).then(function(pakBuffer) {
          if (onStatus) onStatus('Caching pak0.pak...');
          return QII.storage.put('pak0.pak', pakBuffer).then(function() {
            paks['pak0.pak'] = pakBuffer;
            return paks;
          });
        });
      }

      if (onStatus) onStatus('Downloading shareware demo (~37 MB)...');
      return downloadDemo(onProgress).then(function(exeBuffer) {
        if (onStatus) onStatus('Extracting pak0.pak...');
        return extractPak(exeBuffer);
      }).then(function(pakBuffer) {
        if (onStatus) onStatus('Verifying pak0.pak...');
        return verifyPak(pakBuffer);
      }).then(function(pakBuffer) {
        if (onStatus) onStatus('Caching pak0.pak...');
        return QII.storage.put('pak0.pak', pakBuffer).then(function() {
          paks['pak0.pak'] = pakBuffer;
          return paks;
        });
      });
    });
  }

  function handleUserPaks(files) {
    var promises = [];
    for (var i = 0; i < files.length; i++) {
      (function(file) {
        var p = file.arrayBuffer().then(function(buf) {
          return QII.storage.put(file.name, buf).then(function() {
            return { name: file.name, size: buf.byteLength };
          });
        });
        promises.push(p);
      })(files[i]);
    }
    return Promise.all(promises);
  }

  return {
    downloadDemo: downloadDemo,
    extractPak: extractPak,
    verifyPak: verifyPak,
    loadGameData: loadGameData,
    handleUserPaks: handleUserPaks
  };
})();
