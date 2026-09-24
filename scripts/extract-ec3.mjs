// Extract the standalone E-AC-3 decoder WASM from @mediabunny/ac3 1.59.1.
// Run: npm pack @mediabunny/ac3@1.59.1, unpack it, then
// node scripts/extract-ec3.mjs path/to/package/dist/modules/build/ac3.js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(process.argv[2], 'utf8');
const match = source.match(/function findWasmBinary\(\) \{ return binaryDecode\(([\s\S]*?)\); \}/);
if (!match) throw new Error('Embedded WASM was not found');
const binaryString = vm.runInNewContext(match[1]);
const wasm = Uint8Array.from(binaryString, (char) => char.charCodeAt(0));
if (String.fromCharCode(...wasm.subarray(0, 4)) !== '\0asm') throw new Error('Invalid WASM header');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui');
writeFileSync(resolve(root, 'ec3.wasm'), wasm);
const runtime = '/* @mediabunny/ac3 1.59.1; Copyright Vanilagy and contributors; MPL-2.0. See EC3-LICENSE.txt. */\n' + source
  .replace(match[0], 'function findWasmBinary() { return Module["wasmBinary"]; }')
  .replace(/^"use strict";\s*Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);/, '')
  .replace(/exports\.default = Module;\s*$/, 'export default Module;');
writeFileSync(resolve(root, 'ec3-runtime.mjs'), runtime);
console.log(`ec3.wasm ${wasm.length} bytes; runtime ${runtime.length} characters`);
