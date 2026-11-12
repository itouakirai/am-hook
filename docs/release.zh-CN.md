# 发布和更新指南

维护者文档：如何发布新版本，以及二进制的自动更新如何工作。

## 自动编译和发布

本项目使用 GitHub Actions 自动编译多平台二进制文件。

### 触发自动编译

当推送带有 `v` 前缀的 tag 时，会自动触发编译：

```sh
# 1. 确保代码已提交
git add -A
git commit -m "your changes"

# 2. 创建 tag（版本号需要与 Cargo.toml 中一致）
git tag v0.2.0

# 3. 推送代码和 tag
git push origin main
git push origin v0.2.0
```

### 编译产物

GitHub Actions 会自动编译以下平台的二进制文件：

- `am-hook-windows-x86_64.exe` - Windows 64位
- `am-hook-linux-x86_64` - Linux 64位
- `am-hook-macos-x86_64` - macOS Intel
- `am-hook-macos-aarch64` - macOS Apple Silicon

所有文件会自动上传到 GitHub Release。

## 自动更新功能

### 检查更新

启动时在后台检查是否有新版本（不阻塞服务启动，GitHub 不可达时只打印警告）：

```sh
am-hook --check-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

输出示例：
```
New version available: v0.2.1 (current: 0.2.0)
Run with --auto-update to automatically install updates
```

### 自动安装更新

自动下载并安装最新版本：

```sh
am-hook --auto-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

#### Windows 系统

Windows 无法替换正在运行的可执行文件，更新过程如下：

1. 新版本下载到 `am-hook-new.exe`
2. 程序提示需要手动重启
3. 手动操作：
   - 停止 am-hook
   - 将当前的 exe（如 `am-hook-windows-x86_64.exe`）重命名为备份名
   - 将 `am-hook-new.exe` 重命名为原来的 exe 文件名
   - 重新启动 am-hook

#### Linux/macOS 系统

Unix 系统会自动完成更新：

1. 当前版本复制备份为同目录下的 `am-hook-backup`
2. 新版本原子替换当前可执行文件（文件名不变）；替换失败时当前文件保持不变
3. 正在运行的进程仍是旧版本，重启程序后生效

### 更新源

更新从 GitHub Releases 下载，仓库地址在代码中配置：
- 仓库：`itouakirai/am-hook`
- API：`https://api.github.com/repos/itouakirai/am-hook/releases/latest`
- 下载：`https://github.com/itouakirai/am-hook/releases/download/{tag}/{asset}`

## 发布新版本流程

功能提交不改更新日志；发布时用一个提交 `chore: release vX.Y.Z` 收齐：

1. 在 `CHANGELOG.md` 与 `CHANGELOG.en.md` 顶部各加一节 `## vX.Y.Z (YYYY-MM-DD)`，按 `### 新功能` / `### 修复` / `### 变更`（英文为 `### New` / `### Fixes` / `### Changed`）整理自上次发布以来的提交
2. 更新 `Cargo.toml` 的 `version`，以及 `Cargo.lock` 里 `am-hook` 的版本（`cargo check` 会自动改）
3. 提交 `chore: release vX.Y.Z`，打轻量 tag `vX.Y.Z`
4. 先推送 `main`，再推送 tag
5. `release.yml` 编译 4 个平台的二进制，并从两份更新日志中按 `## vX.Y.Z` 取出对应小节作为 Release 说明（附上 `.github/RELEASE_TEMPLATE.md` 的「下载」部分）
6. 用 `gh run list` 确认 **Build Test** 与 Release 都通过：CI 用最新的 stable Rust 跑 `clippy -D warnings`，可能有本地版本还没有的 lint

## 测试

每次推送到 `main` 分支或创建 PR 时，`build-test.yml` 会自动运行：

- 在 Ubuntu、Windows、macOS 上运行 `cargo check`、`cargo build` 与 `cargo test --workspace`
- 在 Ubuntu 上运行 `cargo clippy --workspace --all-targets -- -D warnings` 与 `node tests/run.mjs unit`

浏览器界面测试（`node tests/run.mjs ui`）与需要 Apple CDN / wrapper-lite 的在线测试（`node tests/run.mjs live`、`cargo test --test e2e_test -- --ignored`）不在 CI 中运行，发布前请在本地执行，见 [development.zh-CN.md](development.zh-CN.md#测试)。
