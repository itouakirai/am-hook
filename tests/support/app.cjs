// 单页应用（web/app.html）：播放条常驻，页面视图由前端路由（app.mjs）切换，与 music.apple.com 相同。
// 页面内容、播放条（#player）与地址栏都在同一个文档中；为兼容已有测试，页面仍经 openPage / pageFrame 获取。

/** 页面视图挂载完成（#view 中出现页面元素） */
const ready = (page) => page.waitForSelector('#view > .app-page', { state: 'attached' });

/** 页面内容所在的 Page（单页应用中就是页面本身） */
exports.pageFrame = async (page) => { await ready(page); return page; };

/** 打开站内页面，返回页面内容所在的 Page */
exports.openPage = async (page, url) => {
  await page.goto(url);
  return exports.pageFrame(page);
};
