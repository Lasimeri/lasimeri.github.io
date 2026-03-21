// storage.js — IndexedDB wrapper for PAK file caching

var QII = QII || {};

QII.storage = (function() {
  var DB_NAME = 'qii-assets';
  var STORE_NAME = 'files';
  var DB_VERSION = 1;

  function open() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function(e) { reject(e.target.error); };
    });
  }

  function tx(mode) {
    return open().then(function(db) {
      return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
    });
  }

  function wrap(storeOp) {
    return new Promise(function(resolve, reject) {
      storeOp.onsuccess = function(e) { resolve(e.target.result); };
      storeOp.onerror = function(e) { reject(e.target.error); };
    });
  }

  return {
    get: function(name) {
      return tx('readonly').then(function(store) {
        return wrap(store.get(name));
      });
    },
    put: function(name, data) {
      return tx('readwrite').then(function(store) {
        return wrap(store.put(data, name));
      });
    },
    has: function(name) {
      return tx('readonly').then(function(store) {
        return wrap(store.count(name)).then(function(c) { return c > 0; });
      });
    },
    delete: function(name) {
      return tx('readwrite').then(function(store) {
        return wrap(store.delete(name));
      });
    },
    list: function() {
      return tx('readonly').then(function(store) {
        return wrap(store.getAllKeys());
      });
    }
  };
})();
