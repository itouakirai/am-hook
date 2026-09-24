#!/usr/bin/env sh
# 构建浏览器端解密核心 crates/am-wasm -> src/ui/hook.wasm（随二进制内嵌发布）。
# 修改 crates/am-mp4 / crates/am-wasm / crates/temari 后需重新运行并提交产物。
# 需要：rustup target add wasm32-unknown-unknown；可选 wasm-opt（binaryen）进一步压缩。
set -eu
cd "$(dirname "$0")/.."

cargo build -p am-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_wasm.wasm src/ui/hook.wasm

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-bulk-memory src/ui/hook.wasm -o src/ui/hook.wasm
fi

ls -l src/ui/hook.wasm
