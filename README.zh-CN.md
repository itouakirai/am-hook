# am-hook

中文 | [English](README.md)

一个用 Rust 编写的 Apple Music FairPlay HLS 解密反向代理。它监听本地端口，包装 Apple Music CDN 的源地址，剥离 HLS 播放列表中的加密标记，并在内存中原地解密 FairPlay 保护的 fMP4 分片，让播放器和下载工具拿到干净、可直接播放的内容。

## 工作原理

请求格式为：

```
http://<host>:8888/https://aod.itunes.apple.com/itunes-assets/...
```

只处理包含 `aod.itunes.apple.com/itunes-assets/` 的源地址。根据文件名特征分为三类：

| 类型 | 文件名特征 | 行为 |
|---|---|---|
| Master m3u8 | `P<数字>_<非A开头>.m3u8` | 原样转发 |
| Media m3u8 | `P<数字>_A<数字>_...m3u8` | 提取元数据，剥离 `#EXT-X-KEY` 行，返回未加密标记的播放列表 |
| Media file | 与 media m3u8 对应，`.m3u8` 替换为 `_m.mp4` | 按范围拉取分片，原地解密 sample，替换加密元数据 box，流式返回 |

### 解密流程

1. media m3u8 请求建立轨道上下文，包含 `adamId`、`skd://` URI、`fileuri`、首个分片范围和全部分片字节范围。
2. 上下文补齐后，后台监控立即通过 `GET /key?adamId=<adamId>&uri=<skd-uri>` 向 wrapper-lite 获取该轨道的解密模板。
3. 第一个分片使用内嵌在二进制中的固定模板（对应 `skd://itunes.apple.com/P000000000/s1/e1`），后续分片使用轨道专属模板。
4. media file 请求将 HTTP Range 映射到分片，只从 CDN 拉取所需字节，原地解密 sample，并缓存在内存中。
5. FairPlay 元数据 box（`sinf`、`senc`、`saiz`、`saio`、`sgpd`、`sbgp`）全部替换为等长的 `free` box，字节长度和 HTTP Range 偏移保持精准。init 段中的 `enca` box 原地改写为原始编码（`ec-3`、`mp4a`、`alac` 等）。

## 环境要求

- Rust 2021 edition 工具链（`cargo build`）
- 运行中的 wrapper-lite 密钥服务（默认 `http://127.0.0.1:12340`）

## 构建

```sh
cargo build --release
```

Windows 下生成的二进制位于 `target/release/am-hook.exe`。

## 运行

```sh
am-hook --listen 0.0.0.0:8888 --wrapper-url http://192.168.31.105:3001
```

全部参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-l, --listen <ADDR>` | `0.0.0.0:8888` | 监听地址 |
| `-p, --port <PORT>` | 可选 | 设置时覆盖 `--listen` 中的端口 |
| `-w, --wrapper-url <URL>` | `http://127.0.0.1:12340` | wrapper-lite 密钥服务地址 |
| `--cache-ttl <SECONDS>` | `1800` | 轨道上下文 TTL 淘汰时间 |
| `--lru-cache-mb <MB>` | `128` | 已解密分片的内存 LRU 缓存容量 |

## 测试

```sh
cargo test
```

单元测试覆盖 URL 解析、m3u8 改写和 MP4 box 修补。端到端测试连接真实 wrapper-lite 实例，验证解密后的分片以正确的 E-AC-3 同步字（`0x0B 0x77`）开头。

## 项目结构

```
src/
  cli.rs               命令行参数解析
  main.rs              服务启动
  proxy.rs             请求路由和 Range 流式响应
  m3u8.rs              HLS 播放列表解析和加密标记剥离
  mp4.rs               ISOBMFF 解析、box 修补、sample 解密
  state.rs             轨道上下文和 LRU 缓存
  wrapper.rs           wrapper-lite 密钥请求客户端
  monitor.rs           后台模板拉取和 TTL 清理
  embedded_template.rs 首段固定模板
  fixed_template.json  内嵌模板数据
crates/temari/         内置的 Temari FairPlay 解密库
tests/e2e_test.rs      端到端集成测试
```
