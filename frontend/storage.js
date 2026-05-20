export const createStorageModule = ({
  ref,
  indexedDB,
  localStorage,
  LZString,
  Worker,
  Blob,
  URL,
  console,
}) => {
  const STORAGE_KEY = 'qwen_vllm_sessions';
  const LAST_SESSION_KEY = 'qwen_last_active_session';
  const INITIAL_FORCE_SCROLL_KEY = 'qwen_initial_force_scroll_enabled';

  const loadInitialForceScrollPreference = () => {
    try {
      const raw = localStorage.getItem(INITIAL_FORCE_SCROLL_KEY);
      if (raw === null) return true;
      return raw === 'true';
    } catch (e) {
      console.warn('Failed to load initial force scroll preference', e);
      return true;
    }
  };

  const initialForceScrollEnabled = ref(loadInitialForceScrollPreference());
  const hasUserInteractedWithScroll = ref(false);
  const isInitialLoading = ref(true);

  const persistInitialForceScrollPreference = (enabled) => {
    try {
      localStorage.setItem(INITIAL_FORCE_SCROLL_KEY, enabled ? 'true' : 'false');
    } catch (e) {
      console.warn('Failed to persist initial force scroll preference', e);
    }
  };

  const setInitialForceScrollEnabled = (enabled) => {
    initialForceScrollEnabled.value = !!enabled;
    persistInitialForceScrollPreference(initialForceScrollEnabled.value);
  };

  const saveLastActiveSessionId = (sessionId) => {
    if (!sessionId) return;
    try {
      localStorage.setItem(LAST_SESSION_KEY, sessionId);
    } catch (e) {
      console.warn('Failed to persist last active session id', e);
    }
  };

  const loadLastActiveSessionId = () => {
    try {
      return localStorage.getItem(LAST_SESSION_KEY);
    } catch (e) {
      console.warn('Failed to load last active session id', e);
      return null;
    }
  };

  const initDB = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open('QwenVLLMDatabase', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
      };
    });

  const saveToIndexedDB = async (sessionsData) => {
    try {
      const db = await initDB();
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      const jsonString = JSON.stringify(sessionsData);
      const compressed = LZString.compressToUTF16(jsonString);
      store.put({ id: 'all_sessions', data: compressed });

      return await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.error('Failed to save to IndexedDB', e);
      return undefined;
    }
  };

  const loadFromIndexedDB = async () => {
    try {
      const db = await initDB();
      const tx = db.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const request = store.get('all_sessions');
      const LARGE_DECOMPRESS_THRESHOLD = 2 * 1024 * 1024;

      const decompressInWorker = (compressedText) =>
        new Promise((resolve, reject) => {
          if (typeof Worker === 'undefined') {
            reject(new Error('Worker not available'));
            return;
          }

          const workerCode = `
            self.onmessage = function(e) {
              try {
                const compressed = e.data;
                const decompressed = LZString.decompressFromUTF16(compressed);
                self.postMessage({ ok: true, data: decompressed });
              } catch (err) {
                self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
              }
            };
          `;

          const blob = new Blob([workerCode], { type: 'application/javascript' });
          const workerUrl = URL.createObjectURL(blob);
          const worker = new Worker(workerUrl);

          worker.onmessage = (event) => {
            URL.revokeObjectURL(workerUrl);
            worker.terminate();
            if (event.data && event.data.ok) {
              resolve(event.data.data);
            } else {
              reject(new Error(event.data?.error || 'Worker decompression failed'));
            }
          };

          worker.onerror = (errorEvent) => {
            URL.revokeObjectURL(workerUrl);
            worker.terminate();
            reject(errorEvent.error || new Error(errorEvent.message || 'Worker runtime error'));
          };

          worker.postMessage(compressedText);
        });

      return await new Promise((resolve) => {
        request.onsuccess = () => {
          if (request.result && request.result.data) {
            const compressed = request.result.data;
            const useWorker =
              typeof compressed === 'string' && compressed.length * 2 >= LARGE_DECOMPRESS_THRESHOLD;

            const parseAndResolve = (decompressedText) => {
              try {
                resolve(JSON.parse(decompressedText));
              } catch (e) {
                console.error('Failed to parse from IndexedDB', e);
                resolve(null);
              }
            };

            const fallbackMainThread = () => {
              try {
                const decompressed = LZString.decompressFromUTF16(compressed);
                parseAndResolve(decompressed);
              } catch (e) {
                console.error('Failed to parse from IndexedDB', e);
                resolve(null);
              }
            };

            if (!useWorker) {
              fallbackMainThread();
              return;
            }

            decompressInWorker(compressed)
              .then((decompressed) => {
                parseAndResolve(decompressed);
              })
              .catch((workerErr) => {
                console.warn('Worker decompression failed, fallback to main thread', workerErr);
                fallbackMainThread();
              });
          } else {
            resolve(null);
          }
        };
        request.onerror = () => resolve(null);
      });
    } catch (e) {
      console.error('Failed to load from IndexedDB', e);
      return null;
    }
  };

  return {
    STORAGE_KEY,
    initialForceScrollEnabled,
    hasUserInteractedWithScroll,
    isInitialLoading,
    setInitialForceScrollEnabled,
    saveLastActiveSessionId,
    loadLastActiveSessionId,
    saveToIndexedDB,
    loadFromIndexedDB,
  };
};
