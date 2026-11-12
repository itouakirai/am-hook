// Serves web/ to Playwright route handlers the way the binary lays it out (src/assets.rs):
// /assets/<path> is web/<path>, and every other same-origin path gets the single-page app shell web/app.html.
// Sources are served as is (no content-hashed URLs); the page loads them through their plain /assets/ URLs.
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '../../web');
const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};

/** Page or asset path -> file under web/ */
function webFile(pathname) {
  return pathname.startsWith('/assets/') ? pathname.slice('/assets/'.length) : 'app.html';
}

/** Fulfills a route from web/; a missing file throws, so a broken asset path fails the test loudly */
function serveWeb(route, url) {
  const file = webFile(url.pathname);
  const full = path.join(WEB, file);
  if (!fs.existsSync(full)) throw new Error(`no web/${file} for ${url.pathname}`);
  return route.fulfill({ body: fs.readFileSync(full), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
}

module.exports = { WEB, webFile, serveWeb };
