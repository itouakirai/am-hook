/*
 * 部署环境（window.AM_HOOK_HOST），在 wrapper.js 之前加载。
 *   serverWrapper  服务端能否转发 wrapper-lite；不能时页面只用本地模式（浏览器直连）
 * am-hook 二进制原样提供本文件；serverless 部署（Vercel / Cloudflare）由函数按环境变量生成同名响应，见 serverless/core.mjs。
 */
window.AM_HOOK_HOST = { serverWrapper: true };
