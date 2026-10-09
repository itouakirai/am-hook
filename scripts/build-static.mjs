#!/usr/bin/env node
// 生成 serverless 部署（Vercel / Cloudflare）用的静态目录 dist/：
// 按 src/assets.rs 的资源表把 src/ui/ 下的文件复制到各自的对外地址，单页应用外壳为 dist/index.html。
// 资源表只有 src/assets.rs 一份，二进制与 serverless 部署提供的文件因此保持一致。
// 用法：node scripts/build-static.mjs [输出目录]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = path.join(root, 'src/ui');
const out = path.resolve(root, process.argv[2] || 'dist');
// 由函数按环境变量生成（serverless/core.mjs），不能有同名静态文件
const DYNAMIC = new Set(['/assets/host.js']);

const table = fs.readFileSync(path.join(root, 'src/assets.rs'), 'utf8');
const assets = [...table.matchAll(/asset!\(\s*"(\/[\w./-]*)"\s*,\s*\w+\s*,\s*"([\w./-]+)"\s*\)/g)].map(([, url, file]) => ({ url, file }));
if (!assets.some((asset) => asset.url === '/')) throw new Error('app shell not found in src/assets.rs');

fs.rmSync(out, { recursive: true, force: true });
let count = 0;
for (const { url, file } of assets) {
  if (DYNAMIC.has(url)) continue;
  const target = path.join(out, url === '/' ? 'index.html' : url);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(ui, file), target);
  count++;
}
console.log(`${count} files -> ${path.relative(root, out) || out}`);
