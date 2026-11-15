// tests/run.mjs 把它作为 live 测试的 Playwright 包：与原包相同，只是新建的页面 / 上下文默认 bypassCSP。
// 页面的 CSP（src/security.rs）不允许 eval，而 Playwright 的 waitForFunction 等要在页面里求值字符串。
// CSP 本身由 tests/live/csp_live.cjs 在不绕过的情况下检查（它直接加载原包，见 AM_PLAYWRIGHT_REAL）。
const real = require(process.env.AM_PLAYWRIGHT_REAL);

function patchBrowser(browser) {
  const newContext = browser.newContext.bind(browser);
  const newPage = browser.newPage.bind(browser);
  browser.newContext = (options = {}) => newContext({ bypassCSP: true, ...options });
  browser.newPage = (options = {}) => newPage({ bypassCSP: true, ...options });
  return browser;
}

const chromium = Object.create(real.chromium);
chromium.launch = async (...args) => patchBrowser(await real.chromium.launch(...args));
chromium.launchPersistentContext = (dir, options = {}) => real.chromium.launchPersistentContext(dir, { bypassCSP: true, ...options });

module.exports = { ...real, chromium };
