/* All cryptography and MP4 processing runs here, away from the UI thread. */
importScripts('/assets/mv/go.js');
const ready = (async () => {
  const go = new Go();
  const response = await fetch('/assets/mv/core.wasm');
  if (!response.ok) throw new Error(`WASM HTTP ${response.status}`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
  go.run(instance);
  if (!self.mvCoreReady) throw new Error('MV core failed to start');
})();
const methods = { challenge: 'mvChallenge', license: 'mvLicense', closeSession: 'mvCloseSession', init: 'mvInit', fragment: 'mvFragment', muxInit: 'mvMuxInit', release: 'mvRelease' };
self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    await ready;
    if (!methods[method]) throw new Error('Unknown MV operation');
    const result = self[methods[method]](...args);
    if (result?.error) throw new Error(result.error);
    self.postMessage({ id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
