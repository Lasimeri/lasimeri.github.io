// main.js — UI state machine, Module config, launch sequence

var QII = QII || {};

(function() {
  var $ = function(id) { return document.getElementById(id); };

  // DOM
  var statusEl = $('status');
  var statusBadge = $('status-badge');
  var launchBtn = $('launch');
  var progressEl = $('progress-section');
  var progressBar = $('progress-bar');
  var progressText = $('progress-text');
  var canvasEl = $('canvas');
  var consoleEl = $('console-log');
  var rendererInputs = document.querySelectorAll('input[name="renderer"]');
  var dataModeInputs = document.querySelectorAll('input[name="datamode"]');
  var pakInput = $('pak-input');
  var pakUploadSection = $('pak-upload');
  var cacheInfo = $('cache-info');
  var controlsHint = $('controls-hint');
  var canvasWrap = $('canvas-wrap');

  // State
  var state = 'idle'; // idle | loading | extracting | booting | running | error

  function setState(s, msg) {
    state = s;
    statusBadge.textContent = s;
    statusBadge.className = 'status-badge status-' + s;
    if (msg) statusEl.textContent = msg;
  }

  function log(msg) {
    console.log('[qii] ' + msg);
    var line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
    consoleEl.classList.remove('hidden');
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(1) + ' GB';
  }

  function showProgress(loaded, total) {
    progressEl.classList.remove('hidden');
    var pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
    progressBar.style.width = pct + '%';
    progressText.textContent = pct + '% (' + formatBytes(loaded) + ' / ' + formatBytes(total) + ')';
  }

  function getRenderer() {
    for (var i = 0; i < rendererInputs.length; i++) {
      if (rendererInputs[i].checked) return rendererInputs[i].value;
    }
    return QII.DEFAULT_RENDERER;
  }

  function getDataMode() {
    for (var i = 0; i < dataModeInputs.length; i++) {
      if (dataModeInputs[i].checked) return dataModeInputs[i].value;
    }
    return 'demo';
  }

  // Toggle upload section visibility
  dataModeInputs.forEach(function(input) {
    input.addEventListener('change', function() {
      pakUploadSection.classList.toggle('hidden', getDataMode() !== 'upload');
    });
  });

  // Update cache info on load
  function updateCacheInfo() {
    QII.storage.list().then(function(keys) {
      var pakKeys = keys.filter(function(k) { return k.endsWith('.pak'); });
      if (pakKeys.length > 0) {
        cacheInfo.textContent = 'cached: ' + pakKeys.join(', ');
        cacheInfo.classList.remove('hidden');
      } else {
        cacheInfo.textContent = '';
        cacheInfo.classList.add('hidden');
      }
    }).catch(function() {});
  }
  updateCacheInfo();

  // Handle PAK upload
  pakInput.addEventListener('change', function() {
    if (!pakInput.files.length) return;
    setState('loading', 'Uploading PAK files...');
    log('Uploading ' + pakInput.files.length + ' PAK file(s)');
    QII.loader.handleUserPaks(pakInput.files).then(function(results) {
      results.forEach(function(r) {
        log('Cached: ' + r.name + ' (' + formatBytes(r.size) + ')');
      });
      setState('idle', 'PAK files cached. Ready to launch.');
      updateCacheInfo();
    }).catch(function(err) {
      setState('error', 'Upload failed: ' + err.message);
      log('ERROR: ' + err.message);
    });
  });

  // Launch
  launchBtn.addEventListener('click', function() {
    if (state === 'running' || state === 'booting') return;

    launchBtn.disabled = true;
    setState('loading', 'Preparing game data...');
    log('Launch initiated — renderer: ' + getRenderer());

    var dataPromise;
    if (getDataMode() === 'upload') {
      // Use only cached PAKs (user must have uploaded first)
      dataPromise = QII.storage.list().then(function(keys) {
        var pakKeys = keys.filter(function(k) { return k.endsWith('.pak'); });
        if (pakKeys.length === 0) throw new Error('No PAK files uploaded. Upload at least pak0.pak first.');
        var paks = {};
        return Promise.all(pakKeys.map(function(key) {
          return QII.storage.get(key).then(function(data) { paks[key] = data; });
        })).then(function() { return paks; });
      });
    } else {
      dataPromise = QII.loader.loadGameData(
        function(loaded, total) { showProgress(loaded, total); },
        function(msg) { setState('loading', msg); log(msg); }
      );
    }

    dataPromise.then(function(paks) {
      progressEl.classList.add('hidden');
      setState('booting', 'Starting Quake II engine...');
      log('Game data ready: ' + Object.keys(paks).join(', '));
      bootEngine(paks);
    }).catch(function(err) {
      setState('error', 'Failed: ' + err.message);
      log('ERROR: ' + err.message);
      launchBtn.disabled = false;
    });
  });

  function bootEngine(paks) {
    var renderer = QII.RENDERERS[getRenderer()];
    var args = renderer.args.slice();

    // Show canvas
    canvasWrap.classList.remove('hidden');
    controlsHint.classList.remove('hidden');

    var outputEl = consoleEl;

    window.Module = {
      _canLockPointer: true,
      canvas: canvasEl,
      print: function(text) {
        if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
        console.log(text);
        var line = document.createElement('div');
        line.textContent = text;
        outputEl.appendChild(line);
        outputEl.scrollTop = outputEl.scrollHeight;
      },
      printErr: function(text) {
        console.error(text);
        var line = document.createElement('div');
        line.textContent = '[err] ' + text;
        line.style.color = 'var(--error)';
        outputEl.appendChild(line);
        outputEl.scrollTop = outputEl.scrollHeight;
      },
      setStatus: function(text) {
        if (!Module.setStatus.last) Module.setStatus.last = { time: Date.now(), text: '' };
        if (text === Module.setStatus.last.text) return;
        var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
        var now = Date.now();
        if (m && now - Module.setStatus.last.time < 30) return;
        Module.setStatus.last.time = now;
        Module.setStatus.last.text = text;
        if (text) log('Engine: ' + text);
      },
      locateFile: function(path) {
        return QII.ENGINE_PATH + path;
      },
      preRun: [function() {
        // Ensure /baseq2/ exists (may not if index.data preload differs)
        try {
          var root = FS.readdir('/');
          if (root.indexOf('baseq2') === -1) {
            FS.mkdir('/baseq2');
          }
        } catch(e) {
          FS.mkdir('/baseq2');
        }
        // Write PAK files to Emscripten virtual filesystem
        var pakNames = Object.keys(paks);
        for (var i = 0; i < pakNames.length; i++) {
          var name = pakNames[i];
          var data = new Uint8Array(paks[name]);
          log('Writing ' + name + ' to /baseq2/ (' + formatBytes(data.length) + ')');
          FS.writeFile('/baseq2/' + name, data);
        }
      }],
      hideConsole: function() {
        canvasEl.style.display = 'block';
        canvasEl.focus();
      },
      showConsole: function() {
        outputEl.scrollTop = outputEl.scrollHeight;
      },
      exportFile: function(filePath) {
        try {
          var parts = filePath.split('/');
          var data = new Uint8Array(FS.readFile(filePath));
          var blob = new Blob([data], { type: 'application/octet-stream' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = parts[parts.length - 1];
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          console.error('Export error:', err);
        }
      },
      winResized: function() {},
      setGamma: function(vidGamma) {
        vidGamma = Number(Number(vidGamma).toFixed(2));
        canvasEl.style.filter = vidGamma < 0 ? null : 'brightness(' + (vidGamma * 2.0) + ')';
      },
      captureMouse: function() {
        if (Module._canLockPointer && !Module._attemptPointerLock()) {
          Module._canLockPointer = false;
          document.addEventListener('keydown', Module._lockPointerOnKey);
        }
      },
      _attemptPointerLock: function() {
        if (document.pointerLockElement === null) {
          canvasEl.requestPointerLock();
        }
        return document.pointerLockElement !== null;
      },
      _lockPointerOnKey: function(event) {
        if (event.key === 'Escape' || Module._attemptPointerLock()) {
          document.removeEventListener('keydown', Module._lockPointerOnKey);
          Module._canLockPointer = true;
        }
      },
      totalDependencies: 0,
      monitorRunDependencies: function(left) {
        Module.totalDependencies = Math.max(Module.totalDependencies, left);
        if (!left) {
          setState('running', 'Quake II is running');
          log('Engine initialized — all dependencies loaded');
        }
      },
      onRuntimeInitialized: function() {
        log('WASM runtime initialized');
      },
      arguments: args
    };

    Module.setStatus('Downloading...');

    window.onerror = function(msg) {
      setState('error', 'Engine error — see console');
      log('FATAL: ' + msg);
    };

    // Dynamically load the Emscripten glue script
    var script = document.createElement('script');
    script.src = QII.ENGINE_PATH + 'index.js';
    script.onerror = function() {
      setState('error', 'Failed to load engine');
      log('ERROR: Could not load ' + QII.ENGINE_PATH + 'index.js');
      launchBtn.disabled = false;
    };
    document.body.appendChild(script);
    log('Loading Emscripten engine...');
  }
})();
