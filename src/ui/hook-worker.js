/*
 * am-hook 浏览器端 Worker（由 decrypt.js 管理），消息格式 { id, op, ... } -> { id, ok, result | error }
 *
 *   decrypt     用 hook.wasm 原地处理一段数据并以 transfer 方式交回：
 *               kind=init 改写 init segment；kind=frag 用固定模板（key=fixed）或轨道模板解密 fragment
 *   file-open   在 OPFS 中创建下载文件并取得同步访问句柄（createSyncAccessHandle 只能在 Worker 中使用）
 *   file-write  把解密后的数据写到文件的指定偏移
 *   file-close  刷盘并释放句柄
 */
'use strict';

const MAX_TEMPLATES = 8;
let wasmPromise = null;
/** keyUri -> 模板句柄，按插入顺序淘汰 */
const templates = new Map();
let file = null;

/** Worker 取不到页面的 AmI18n：错误信息按每条消息附带的 lang 选择语言 */
const MESSAGES = {
  zh: {
    wasm: '加载 hook.wasm 失败（HTTP {0}）',
    noTemplate: '缺少解密模板',
    template: '解析解密模板失败：{0}',
    decrypt: '解密失败：{0}',
    write: '写入 OPFS 不完整（{0}/{1}）',
  },
  en: {
    wasm: 'Failed to load hook.wasm (HTTP {0})',
    noTemplate: 'Missing decryption template',
    template: 'Failed to parse the decryption template: {0}',
    decrypt: 'Decryption failed: {0}',
    write: 'Incomplete OPFS write ({0}/{1})',
  },
};
let lang = 'zh';

function msg(key, ...args) {
  return (MESSAGES[lang] || MESSAGES.zh)[key].replace(/\{(\d)\}/g, (_, i) => args[i]);
}

function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const res = await fetch('/assets/hook.wasm');
      if (!res.ok) throw new Error(msg('wasm', res.status));
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      return instance.exports;
    })();
    wasmPromise.catch(() => { wasmPromise = null; });
  }
  return wasmPromise;
}

function lastError(w) {
  return new TextDecoder().decode(new Uint8Array(w.memory.buffer, w.hook_error_ptr(), w.hook_error_len()));
}

/** 把 bytes 拷入 wasm 内存交给 fn 处理，再拷回 bytes。每次都重新取 memory.buffer，分配可能使其增长 */
function inWasm(w, bytes, fn) {
  const ptr = w.hook_alloc(bytes.length);
  try {
    new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
    fn(ptr, bytes.length);
    bytes.set(new Uint8Array(w.memory.buffer, ptr, bytes.length));
  } finally {
    w.hook_free(ptr, bytes.length);
  }
}

function templateHandle(w, key, json) {
  if (key === 'fixed') return w.hook_fixed_template();
  const cached = templates.get(key);
  if (cached) return cached;
  if (!json) throw new Error(msg('noTemplate'));
  let handle = 0;
  inWasm(w, new TextEncoder().encode(json), (ptr, len) => { handle = w.hook_template_load(ptr, len); });
  if (!handle) throw new Error(msg('template', lastError(w)));
  templates.set(key, handle);
  if (templates.size > MAX_TEMPLATES) {
    const [oldKey, oldHandle] = templates.entries().next().value;
    templates.delete(oldKey);
    w.hook_template_free(oldHandle);
  }
  return handle;
}

async function decrypt({ kind, key, template, init, buf }) {
  const w = await loadWasm();
  const bytes = new Uint8Array(buf);
  try {
    if (kind === 'init') {
      inWasm(w, bytes, (ptr, len) => w.hook_patch_init(ptr, len));
    } else {
      const handle = key ? templateHandle(w, key, template) : 0;
      inWasm(w, bytes, (ptr, len) => {
        if (handle && !w.hook_decrypt_fragment(handle, ptr, len)) throw new Error(msg('decrypt', lastError(w)));
        if (init) inWasm(w, new Uint8Array(init), (initPtr, initLen) => {
          if (!w.hook_repair_alac(ptr, len, initPtr, initLen)) throw new Error(msg('decrypt', lastError(w)));
        });
      });
    }
  } catch (err) {
    // wasm 内部 panic 后实例状态不可信，下次重新加载
    if (err instanceof WebAssembly.RuntimeError) {
      wasmPromise = null;
      templates.clear();
    }
    throw err;
  }
  return buf;
}

async function fileOpen({ dir, name }) {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(dir, { create: true });
  const handle = await folder.getFileHandle(name, { create: true });
  // 旧版 Safari 的同步句柄方法返回 Promise，统一 await
  file = await handle.createSyncAccessHandle();
  await file.truncate(0);
}

async function fileWrite({ at, buf }) {
  const written = await file.write(new Uint8Array(buf), { at });
  if (written !== buf.byteLength) throw new Error(msg('write', written, buf.byteLength));
}

async function fileClose() {
  if (!file) return;
  const f = file;
  file = null;
  await f.flush();
  await f.close();
}

const ops = { decrypt, 'file-open': fileOpen, 'file-write': fileWrite, 'file-close': fileClose };

self.onmessage = async (e) => {
  const { id, op } = e.data;
  if (e.data.lang) lang = e.data.lang;
  try {
    const result = await ops[op](e.data);
    self.postMessage({ id, ok: true, result }, result instanceof ArrayBuffer ? [result] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err), name: err && err.name });
  }
};
