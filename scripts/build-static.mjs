#!/usr/bin/env node
// 生成 serverless 部署（Vercel / Cloudflare）用的静态目录 dist/：
// 按 src/assets.rs 的资源表把 web/ 下的文件复制到各自的对外地址（web/<path> → /assets/<path>），
// 单页应用外壳 web/app.html 为 dist/index.html。
// 资源表只有 src/assets.rs 一份，二进制与 serverless 部署提供的文件因此保持一致。
//
// 与二进制（src/assets.rs 的 Served）相同：文本资源里对其他资源的引用换成内容哈希地址
// （/assets/h/views/home.<hash>.mjs），哈希按换完后的内容计算；每个资源同时写到原地址与哈希地址。
// 哈希地址由 vercel.json 与 dist/_headers（Cloudflare，只在 --cloudflare 时生成）设为长期缓存。
// src/assets.rs 的测试会比对两边的输出。
// 用法：node scripts/build-static.mjs [输出目录] [--cloudflare]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const args = process.argv.slice(2);
const cloudflare = args.includes('--cloudflare');
const out = path.resolve(root, args.find((arg) => !arg.startsWith('--')) || 'dist');
// 由函数按环境变量生成（serverless/core.mjs），不能有同名静态文件，也不加哈希
const HOST_JS = '/assets/host.js';
const HASHED_PREFIX = '/assets/h/';
// 与 src/assets.rs 的 mime_of 一致：只有这些文本资源里的引用会换成哈希地址
const TEXT = /\.(html|m?js|css)$/;

const table = fs.readFileSync(path.join(root, 'src/assets.rs'), 'utf8');
const files = [...table.matchAll(/^\s*asset!\(\s*"([\w./-]+)"\s*\)/gm)].map(([, file]) => file);
if (!files.length) throw new Error('no asset!("...") entries found in src/assets.rs');
// 外壳排第一，与 src/assets.rs 的 build() 一致
const assets = [['/', 'app.html'], ...files.map((file) => [`/assets/${file}`, file])]
  .map(([url, file]) => ({ url, text: TEXT.test(file) && url !== HOST_JS, source: fs.readFileSync(path.join(web, file)) }));
const index = new Map(assets.map((asset, i) => [asset.url, i]));

/** FNV-1a 64，16 位十六进制 */
function fnv(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

function hashedUrl(url, hash) {
  const rest = url.slice('/assets/'.length);
  const nameAt = rest.lastIndexOf('/') + 1;
  const dot = rest.slice(nameAt).lastIndexOf('.');
  return dot < 0 ? `${HASHED_PREFIX}${rest}.${hash}` : `${HASHED_PREFIX}${rest.slice(0, nameAt + dot)}.${hash}${rest.slice(nameAt + dot)}`;
}

function resolve(base, relative) {
  const parts = base.split('/');
  parts.pop();
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** 引用其他资源的位置：{ start, end, target }（按字节偏移，与 Rust 的实现一致） */
function references(i) {
  const asset = assets[i];
  if (!asset.text) return [];
  const text = asset.source.toString('utf8');
  const refs = [];
  for (const m of text.matchAll(/\/assets\/[A-Za-z0-9_./-]+|'(\.\.?\/[A-Za-z0-9_./-]+)'|"(\.\.?\/[A-Za-z0-9_./-]+)"/g)) {
    const relative = m[1] ?? m[2];
    const url = relative === undefined ? m[0] : resolve(asset.url, relative);
    const target = index.get(url);
    if (target === undefined || target === i || url === HOST_JS) continue;
    const start = Buffer.byteLength(text.slice(0, m.index + (relative === undefined ? 0 : 1)));
    refs.push({ start, end: start + Buffer.byteLength(relative ?? m[0]), target });
  }
  return refs;
}

const refs = assets.map((_, i) => references(i));
const order = [];
const state = new Array(assets.length).fill(0);
function visit(i) {
  if (state[i] === 2) return;
  if (state[i] === 1) throw new Error(`asset references form a cycle through ${assets[i].url}`);
  state[i] = 1;
  for (const { target } of refs[i]) visit(target);
  state[i] = 2;
  order.push(i);
}
assets.forEach((_, i) => visit(i));

const bodies = [];
const hashed = [];
for (const i of order) {
  const { source } = assets[i];
  const parts = [];
  let at = 0;
  for (const { start, end, target } of refs[i]) {
    parts.push(source.subarray(at, start), Buffer.from(hashed[target]));
    at = end;
  }
  parts.push(source.subarray(at));
  bodies[i] = Buffer.concat(parts);
  if (assets[i].url !== HOST_JS) hashed[i] = hashedUrl(assets[i].url, fnv(bodies[i]));
}

fs.rmSync(out, { recursive: true, force: true });
let count = 0;
const write = (url, body) => {
  const target = path.join(out, url === '/' ? 'index.html' : url);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  count++;
};
assets.forEach(({ url }, i) => {
  if (url === HOST_JS) return;
  write(url, bodies[i]);
  if (url !== '/') write(hashed[i], bodies[i]);
});
// Cloudflare Workers 静态资源的响应头，只作用于命中的静态文件（Worker 给出的 404 不受影响）。
// Vercel 用 vercel.json 的 headers，并会把 _headers 当作普通文件公开，因此不生成
if (cloudflare) fs.writeFileSync(path.join(out, '_headers'), `${HASHED_PREFIX}*\n  Cache-Control: public, max-age=31536000, immutable\n`);
console.log(`${count} files -> ${path.relative(root, out) || out}`);
