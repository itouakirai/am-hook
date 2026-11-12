/*
 * 部署环境（window.AM_HOOK_HOST），在 wrapper.js 之前加载。
 *   serverWrapper  服务端能否转发 wrapper-lite；不能时页面只用本地模式（浏览器直连）
 *   wrapper        可选，本地模式的默认值 { url, rate, concurrency }（二进制 --local-wrapper-only 时由启动参数给出）
 *   hint           可选，本地 wrapper-lite 设置上方的提示（--wrapper-hint / AM_HOOK_WRAPPER_HINT），其中的网址显示为链接
 * am-hook 二进制（src/handlers.rs 的 host_js_handler）与 serverless 部署（serverless/core.mjs）都按启动参数 / 环境变量生成同名响应；
 * 本文件是默认内容，供直接打开静态文件时使用。
 */
window.AM_HOOK_HOST = { serverWrapper: true };
