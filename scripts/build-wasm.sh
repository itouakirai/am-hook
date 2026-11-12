#!/usr/bin/env sh
# 构建浏览器端 wasm（随二进制内嵌发布）：
#   crates/am-wasm -> web/decrypt/hook.wasm（歌曲解密）
#   crates/am-flac-wasm -> web/flac/flac.wasm（ALAC 转 FLAC）
#   crates/am-media-wasm -> web/media/media.wasm（MV 的 PlayReady / CENC / 合并，歌曲与 MV 的 defrag，AAC-LC 歌曲的 Widevine）
#   crates/joc-wasm -> web/joc/joc.wasm（E-AC-3 JOC 对象渲染：Speaker 2.0 / 双耳）
# 修改 crates/ 下任一相关 crate 后需重新运行并提交产物。
# 需要：rustup target add wasm32-unknown-unknown，以及 wasm-opt（binaryen）。WASM_OPT 可指定 wasm-opt 命令，
# 例如 WASM_OPT="npx -y -p binaryen@123.0.0 wasm-opt"；没有 wasm-opt 时产物明显更大，不要提交。
# hook.wasm、media.wasm 与 joc.wasm 用 Cargo.toml 的 wasm profile（按体积优化，解密热点与 joc-core 的 DSP 保持 opt-level 3）；
# flac.wasm 的转码在播放路径上，保持 release（opt-level 3）。
set -eu
cd "$(dirname "$0")/.."
WASM_OPT=${WASM_OPT:-wasm-opt}

cargo build -p am-wasm --profile wasm --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/wasm/am_wasm.wasm web/decrypt/hook.wasm
cargo build -p am-flac-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_flac_wasm.wasm web/flac/flac.wasm
cargo build -p am-media-wasm --profile wasm --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/wasm/am_media_wasm.wasm web/media/media.wasm
cargo build -p joc-wasm --profile wasm --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/wasm/joc_wasm.wasm web/joc/joc.wasm

if $WASM_OPT --version >/dev/null 2>&1; then
  $WASM_OPT -Oz --enable-bulk-memory web/decrypt/hook.wasm -o web/decrypt/hook.wasm
  $WASM_OPT -O3 --enable-bulk-memory web/flac/flac.wasm -o web/flac/flac.wasm
  $WASM_OPT -Oz --enable-bulk-memory web/media/media.wasm -o web/media/media.wasm
  $WASM_OPT -Oz --enable-bulk-memory web/joc/joc.wasm -o web/joc/joc.wasm
else
  echo "warning: wasm-opt not found (set WASM_OPT); the outputs are not optimized" >&2
fi

ls -l web/decrypt/hook.wasm
ls -l web/flac/flac.wasm
ls -l web/media/media.wasm
ls -l web/joc/joc.wasm
