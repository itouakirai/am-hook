// Run with: node --test tests/serverless.mjs
// Offline: covers the serverless backend (serverless/core.mjs, the Cloudflare entry and the Vercel entry) with a stubbed
// global fetch, and checks that scripts/build-static.mjs lays out src/ui/ the way src/assets.rs serves it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import vercel from '../api/handler.mjs';
import worker from '../serverless/cloudflare.mjs';
import {
  extractScriptPath, extractToken, handle, isAppleHttps, isPagePath, refreshDelay, resetTokenCache, validCatalogPath, wrapperConfig,
} from '../serverless/core.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.signature-0123`;
const realFetch = globalThis.fetch;

/** Replace global fetch with `routes(url, init)`; returns the list of requests made */
function stub(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ url, headers, method: init.method || 'GET', body: init.body, redirect: init.redirect });
    const response = await routes(url, { ...init, headers });
    if (!response) throw new Error(`unexpected request to ${url}`);
    return response;
  };
  return calls;
}
const reply = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
const get = (pathAndQuery, env, platform) => handle(new Request(`https://site.test${pathAndQuery}`), env, platform);

test.afterEach(() => { globalThis.fetch = realFetch; resetTokenCache(); });

/** music.apple.com with a scrapeable token, and an amp-api that only accepts `valid` */
function apple({ token, valid = token, body = { data: [] } }) {
  return (url, init) => {
    if (url === 'https://music.apple.com/us/browse') return reply('<script type="module" crossorigin src="/assets/index~abc123.js"></script>');
    if (url === 'https://music.apple.com/assets/index~abc123.js') return reply(`const a="x",b="${typeof token === 'function' ? token() : token}";`);
    if (url.startsWith('https://amp-api-edge.music.apple.com/')) {
      return init.headers.authorization === `Bearer ${valid}` ? reply(body) : reply({ errors: [{ title: 'Forbidden' }] }, { status: 403 });
    }
    return null;
  };
}

test('token helpers match src/amp.rs', () => {
  const html = '<script type="module" crossorigin src="/assets/index~1c4278bfb3.js"></script><script nomodule src="/assets/index-legacy~dc41388d00.js"></script>';
  assert.equal(extractScriptPath(html), '/assets/index~1c4278bfb3.js');
  assert.equal(extractScriptPath('<script src="/assets/index-legacy~dc41388d00.js">'), null);
  const js = 'const yo="2638.11.0-external",Ua="eyJ0eXAiOiJKV1QiLCJhbGci.eyJpc3MiOiJBTVBXZWJQbGF5.sig_nature-0123",b="eyJzZWNvbmQi.eyJzZWNvbmQiOjF9.abcdefghijkl";';
  assert.equal(extractToken(js), 'eyJ0eXAiOiJKV1QiLCJhbGci.eyJpc3MiOiJBTVBXZWJQbGF5.sig_nature-0123');
  assert.equal(extractToken('no token here'), null);

  const now = 1_000_000;
  assert.equal(refreshDelay(jwt({ exp: 1_007_200 }), now), 3600);
  assert.equal(refreshDelay(jwt({ exp: 9_000_000 }), now), 12 * 3600);
  assert.equal(refreshDelay(jwt({ exp: 1_000_100 }), now), 60);
  assert.equal(refreshDelay(jwt({ iss: 'x' }), now), 12 * 3600);
  assert.equal(refreshDelay('not-a-jwt', now), 12 * 3600);
});

test('path checks match src/amp.rs, src/state.rs and src/links.rs', () => {
  for (const ok of ['us/search', 'cn/search/suggestions', 'us/songs/1468058171', 'cn/rooms/6818358937/contents']) assert(validCatalogPath(ok), ok);
  for (const bad of ['', '../me/library', 'us/search?x', 'us/%2e%2e/x']) assert(!validCatalogPath(bad), bad);

  assert(isAppleHttps(new URL('https://play.itunes.apple.com/a.m3u8')));
  for (const bad of ['http://apple.com/a', 'https://apple.com:8443/a', 'https://user@apple.com/a', 'https://notapple.com/a', 'https://apple.com.evil.test/a']) {
    assert(!isAppleHttps(new URL(bad)), bad);
  }

  for (const page of [
    '/', '/new', '/new/top-charts', '/new/top-charts/music-videos', '/library', '/library/songs', '/library/all-playlists/',
    '/library/artists/Taylor%20Swift', '/library/playlist/p.A1b2_c3-d4', '/library/favorite-songs', '/library/playlist-folder/f.Ab3_x',
    '/https://music.apple.com/us/song/name/123', '/https://music.apple.com/cn/music-video/x/1836358807',
    '/https://music.apple.com/cn/post/6814689986', '/https://music.apple.com/cn/album/1561058084',
    '/https://music.apple.com/us/playlist/mix/pl.u-AkAmPlyUxqvoZ7', '/https://music.apple.com/us/artist/159260351',
    '/https://music.apple.com/cn/new', '/https://music.apple.com/cn/new/top-charts/songs', '/https://music.apple.com/us/multi-room/1532467784',
    '/https://music.apple.com/us/curator/1019400049', '/https:/music.apple.com/us/album/lover/1468058165',
  ]) assert(isPagePath(page), page);
  for (const other of [
    '/new/other', '/new/top-charts/x', '/top-charts', '/library/other', '/library/playlist/pl.123', '/library/artists/a/b',
    '/https://music.apple.com/us/album/name/abc', '/https://music.apple.com/us/music-video/123', '/https://music.apple.com/us/room/abc',
    '/https://music.apple.com/cn/new/top-charts/stations', '/http://music.apple.com/us/song/name/123', '/https://example.com/us/song/name/123',
    '/assets/missing.js', '/favicon.ico',
  ]) assert(!isPagePath(other), other);
});

test('amp proxy sends the scraped developer token and reuses it', async () => {
  const token = jwt({ iss: 'AMPWebPlay', exp: Math.floor(Date.now() / 1000) + 30 * 86400 });
  const calls = stub(apple({ token, body: { results: { ok: true } } }));
  const response = await get('/amp/v1/catalog/us/search?term=a%20b&types=songs');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { results: { ok: true } });
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300, s-maxage=300');
  const api = calls.at(-1);
  assert.equal(api.url, 'https://amp-api-edge.music.apple.com/v1/catalog/us/search?term=a%20b&types=songs');
  assert.equal(api.headers.authorization, `Bearer ${token}`);
  assert.equal(api.headers.origin, 'https://music.apple.com');

  const storefronts = await get('/amp/v1/storefronts?limit=200');
  assert.equal(storefronts.headers.get('cache-control'), 'public, max-age=86400, s-maxage=86400');
  assert.equal((await get('/amp/v1/editorial/cn/groupings?name=music')).status, 200);
  assert.equal(calls.filter((c) => c.url.startsWith('https://music.apple.com/')).length, 2, 'token scraped once');
  assert.equal(calls.at(-1).url, 'https://amp-api-edge.music.apple.com/v1/editorial/cn/groupings?name=music');
});

test('amp proxy rejects bad paths and refetches a rejected token once', async () => {
  const fresh = jwt({ iss: 'AMPWebPlay', n: 2 });
  let current = jwt({ iss: 'AMPWebPlay', n: 1 });
  const calls = stub(apple({ token: () => current, valid: fresh }));
  assert.equal((await get('/amp/v1/catalog/..%2Fme/library')).status, 400);
  assert.equal((await get(`/amp/v1/catalog/us/search?term=${'a'.repeat(5000)}`)).status, 400);
  assert.equal(await get('/amp/v1/me/library'), null);
  assert.equal(calls.length, 0, 'invalid requests never reach Apple');

  // The stale token is refused, the next scrape still returns it: one retry, then the upstream error is passed through
  const refused = await get('/amp/v1/catalog/us/songs/1');
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('cache-control'), 'no-store');
  assert.equal(calls.filter((c) => c.url.includes('amp-api-edge')).length, 2);

  current = fresh;
  assert.equal((await get('/amp/v1/catalog/us/songs/1')).status, 200);

  globalThis.fetch = async () => { throw new Error('offline'); };
  resetTokenCache();
  const down = await get('/amp/v1/catalog/us/songs/1');
  assert.equal(down.status, 502);
  assert.match((await down.json()).msg, /^developer token unavailable/);
});

test('a shared token store spares new instances the scrape', async () => {
  const token = jwt({ iss: 'AMPWebPlay', n: 3 });
  const stored = [];
  const calls = stub(apple({ token }));
  const store = { saved: null, async get() { return this.saved; }, async put(value, ttl) { this.saved = value; stored.push(ttl); } };
  assert.equal((await get('/amp/v1/storefronts', {}, { tokenStore: store })).status, 200);
  assert.deepEqual(stored, [12 * 3600]);
  resetTokenCache();
  calls.length = 0;
  assert.equal((await get('/amp/v1/storefronts', {}, { tokenStore: store })).status, 200);
  assert.deepEqual(calls.map((c) => new URL(c.url).host), ['amp-api-edge.music.apple.com']);
});

test('MV master is fetched as User-Agent: AM and only follows apple.com redirects', async () => {
  const start = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/hls/master.m3u8';
  const cdn = 'https://mvod.itunes.apple.com/itunes-assets/x/master.m3u8';
  let calls = stub((url) => (url === start ? new Response(null, { status: 302, headers: { location: cdn } }) : reply('#EXTM3U\n')));
  const ok = await get(`/parse/mv-master?url=${encodeURIComponent(start)}`);
  assert.deepEqual(await ok.json(), { code: 0, data: { masterUrl: cdn, masterBody: '#EXTM3U\n' } });
  assert.deepEqual(calls.map((c) => [c.url, c.headers['user-agent'], c.redirect]), [[start, 'AM', 'manual'], [cdn, 'AM', 'manual']]);

  calls = stub(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/master.m3u8' } }));
  assert.equal((await get(`/parse/mv-master?url=${encodeURIComponent(start)}`)).status, 502);
  assert.equal(calls.length, 1, 'the redirect target is never requested');

  calls = stub(() => null);
  for (const bad of ['', 'https://evil.test/a.m3u8', 'http://play.itunes.apple.com/a.m3u8', 'https://play.itunes.apple.com/a.mp4', 'not a url']) {
    assert.equal((await get(`/parse/mv-master?url=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  assert.equal(calls.length, 0);
});

test('without AM_HOOK_WRAPPER_URL the page is told to use a local wrapper-lite', async () => {
  const calls = stub(() => null);
  const host = await get('/assets/host.js');
  assert.match(host.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await host.text(), 'window.AM_HOOK_HOST = {"serverWrapper":false};\n');
  for (const p of ['/status', '/key?adamId=1&uri=skd://x', '/lyrics/1', '/parse/song/1', '/parse/mv/1', '/mv/webplayback/1']) {
    const response = await get(p);
    assert.equal(response.status, 501, p);
    assert.equal((await response.json()).code, 1);
  }
  const license = await handle(new Request('https://site.test/mv/license', { method: 'POST', body: '{}' }));
  assert.equal(license.status, 501);
  assert.equal(calls.length, 0);
  assert.equal(await get('/unknown'), null);
  assert.equal(await get('/https://music.apple.com/us/album/lover/1468058165'), null);
});

test('with AM_HOOK_WRAPPER_URL the wrapper-lite endpoints are relayed', async () => {
  assert.deepEqual(wrapperConfig({ AM_HOOK_WRAPPER_URL: ' https://w.test/base/ ', AM_HOOK_WRAPPER_AUTH: 'abc' }), { base: 'https://w.test/base', auth: 'Bearer abc' });
  assert.deepEqual(wrapperConfig({ AM_HOOK_WRAPPER_URL: 'https://user:p%40ss@w.test' }), { base: 'https://w.test', auth: `Basic ${btoa('user:p@ss')}` });
  assert.equal(wrapperConfig({}), null);

  const env = { AM_HOOK_WRAPPER_URL: 'https://w.test', AM_HOOK_WRAPPER_AUTH: 'Basic dXNlcjpwYXNz' };
  const master = 'https://play.itunes.apple.com/master.m3u8';
  const calls = stub((url) => {
    const u = new URL(url);
    if (u.href === master) return reply('#EXTM3U\n');
    if (u.host !== 'w.test') return null;
    const id = u.searchParams.get('adamId');
    switch (u.pathname) {
      case '/status': return reply({ code: 0, msg: 'SUCCESS', data: { regions: ['jp', 'us'] } });
      case '/m3u8': return reply({ code: 0, data: { m3u8: 'https://aod.itunes.apple.com/P1.m3u8' } });
      case '/key': return id === '9' ? reply({ code: 5, msg: 'no key' }) : reply({ code: 0, data: { ctx: 'Y3R4', rcx: '0x1' } });
      case '/lyrics': return id === '1' ? reply({ code: 404, msg: 'no lyrics' }) : reply({ code: 0, data: { lyrics: '<tt>lyrics</tt>' } });
      case '/webplayback': return reply({ code: 0, data: { m3u8: master } });
      case '/license': return reply({ code: 0, data: { license: 'bGljZW5zZQ==' } });
      default: return null;
    }
  });

  assert.equal(await (await get('/assets/host.js', env)).text(), 'window.AM_HOOK_HOST = {"serverWrapper":true};\n');
  const status = await get('/status', env);
  assert.deepEqual(await status.json(), { code: 0, msg: 'SUCCESS', regions: ['jp', 'us'] });
  assert.equal(calls.at(-1).headers.authorization, 'Basic dXNlcjpwYXNz');

  assert.deepEqual(await (await get('/parse/song/123', env)).json(), { code: 0, data: { masterUrl: 'https://aod.itunes.apple.com/P1.m3u8' } });
  assert.equal((await get('/parse/song/abc', env)).status, 400);

  const uri = 'skd://itunes.apple.com/P000000001/s1/e1';
  const key = await get(`/key?adamId=2&uri=${encodeURIComponent(uri)}`, env);
  assert.deepEqual(await key.json(), { ctx: 'Y3R4', rcx: '0x1' });
  assert.equal(new URL(calls.at(-1).url).searchParams.get('uri'), uri);
  assert.equal((await get(`/key?adamId=9&uri=${encodeURIComponent(uri)}`, env)).status, 502);
  assert.equal((await get('/key?adamId=2&uri=skd%3A%2F%2Fitunes.apple.com%2FP000000000%2Fs1%2Fe1', env)).status, 400);
  assert.equal((await get('/key?adamId=x&uri=skd://a', env)).status, 400);

  const lyrics = await get('/lyrics/2?language=zh-Hans-CN', env);
  assert.equal(await lyrics.text(), '<tt>lyrics</tt>');
  assert.match(lyrics.headers.get('content-type'), /^application\/ttml\+xml/);
  assert.equal(new URL(calls.at(-1).url).search, '?adamId=2&language=zh-Hans-CN');
  assert.equal((await get('/lyrics/1', env)).status, 404);
  assert.equal((await get('/lyrics/2?language=a%20b', env)).status, 400);

  assert.deepEqual(await (await get('/mv/webplayback/7', env)).json(), { code: 0, data: { m3u8: master } });
  assert.equal((await get('/mv/webplayback/7x', env)).status, 400);
  assert.deepEqual(await (await get('/parse/mv/7', env)).json(), { code: 0, data: { masterUrl: master, masterBody: '#EXTM3U\n' } });
  assert.equal(calls.at(-1).headers['user-agent'], 'AM');

  const post = (body) => handle(new Request('https://site.test/mv/license', { method: 'POST', body: JSON.stringify(body) }), env);
  const license = await post({ adamId: '7', challenge: 'Y2hhbGxlbmdl', uri: 'data:text/plain;base64,AAAA', 'drm-type': 'pr', extra: 1 });
  assert.deepEqual(await license.json(), { code: 0, data: { license: 'bGljZW5zZQ==' } });
  assert.deepEqual(JSON.parse(calls.at(-1).body), { adamId: '7', challenge: 'Y2hhbGxlbmdl', uri: 'data:text/plain;base64,AAAA', 'drm-type': 'pr' });
  assert.equal((await post({ adamId: '7', challenge: 'x', uri: 'https://x', 'drm-type': 'pr' })).status, 400);
  assert.equal((await post({ adamId: '7', challenge: 'x', uri: 'data:x', 'drm-type': 'wv' })).status, 400);
  assert.equal((await handle(new Request('https://site.test/mv/license', { method: 'POST', body: 'not json' }), env)).status, 400);

  globalThis.fetch = async () => { throw new Error('connection refused'); };
  assert.equal((await get('/status', env)).status, 502);
  assert.equal((await get('/mv/webplayback/7', env)).status, 502);
});

test('Cloudflare entry: caches amp responses, serves the app shell for page paths, 404s the rest', async () => {
  const token = jwt({ iss: 'AMPWebPlay', n: 4 });
  const calls = stub(apple({ token, body: { data: ['x'] } }));
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(key) { return store.get(String(key))?.clone(); },
      async put(key, response) { store.set(String(key), response); },
    },
  };
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const shell = [];
  const env = { ASSETS: { fetch: async (request) => { shell.push(request.url); return reply('<!doctype html>shell'); } } };
  try {
    const first = await worker.fetch(new Request('https://cf.test/amp/v1/catalog/us/songs/1'), env, ctx);
    assert.deepEqual(await first.json(), { data: ['x'] });
    await Promise.all(pending);
    assert.equal(await store.get('https://cf.test/__am-hook/developer-token').clone().text(), token);

    calls.length = 0;
    const second = await worker.fetch(new Request('https://cf.test/amp/v1/catalog/us/songs/1'), env, ctx);
    assert.deepEqual(await second.json(), { data: ['x'] });
    assert.equal(calls.length, 0, 'served from the cache');

    const page = await worker.fetch(new Request('https://cf.test/https://music.apple.com/us/album/lover/1468058165?i=1'), env, ctx);
    assert.equal(await page.text(), '<!doctype html>shell');
    assert.deepEqual(shell, ['https://cf.test/']);
    assert.equal((await worker.fetch(new Request('https://cf.test/library/songs'), env, ctx)).status, 200);
    assert.equal((await worker.fetch(new Request('https://cf.test/assets/missing.js'), env, ctx)).status, 404);
    assert.equal((await worker.fetch(new Request('https://cf.test/library/songs', { method: 'POST' }), env, ctx)).status, 404);
  } finally {
    delete globalThis.caches;
  }
});

test('Vercel entry: handles the original URL and the rewritten /api/handler?__path= form', async () => {
  const token = jwt({ iss: 'AMPWebPlay', n: 5 });
  const calls = stub(apple({ token }));
  assert.equal((await vercel(new Request('https://v.test/amp/v1/catalog/us/search?term=x'))).status, 200);
  assert.equal(calls.at(-1).url, 'https://amp-api-edge.music.apple.com/v1/catalog/us/search?term=x');
  assert.equal((await vercel(new Request('https://v.test/amp/v1/catalog/us/search?term=x&__path=/amp/v1/catalog/us/search'))).status, 200);
  assert.equal(calls.at(-1).url, 'https://amp-api-edge.music.apple.com/v1/catalog/us/search?term=x');
  assert.equal((await vercel(new Request('https://v.test/api/handler?__path=%2Famp%2Fv1%2Fcatalog%2Fus%2Fsearch&term=y'))).status, 200);
  assert.equal(calls.at(-1).url, 'https://amp-api-edge.music.apple.com/v1/catalog/us/search?term=y');
  // Vercel appends the rewrite's named segments to the query; they must not reach amp-api
  assert.equal((await vercel(new Request('https://v.test/amp/v1/catalog/us/search?term=z&__rest=v1%2Fcatalog%2Fus%2Fsearch&__path=%2Famp%2Fv1%2Fcatalog%2Fus%2Fsearch'))).status, 200);
  assert.equal(calls.at(-1).url, 'https://amp-api-edge.music.apple.com/v1/catalog/us/search?term=z');
  assert.equal((await vercel(new Request('https://v.test/api/handler?__path=/status'))).status, 501);
  assert.equal((await vercel(new Request('https://v.test/api/handler'))).status, 404);

  const rewrites = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).rewrites;
  for (const { source, destination } of rewrites) {
    assert(destination === '/index.html' || destination === `/api/handler?__path=${source}`, source);
    // named segments are stripped by the handler only when they start with `__`
    if (destination === '/index.html') continue;
    for (const [, name] of source.matchAll(/:(\w+)/g)) assert(name.startsWith('__'), source);
  }
});

test('build-static lays out src/ui the way src/assets.rs serves it', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'am-hook-dist-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts/build-static.mjs'), out], { stdio: 'pipe' });
    const same = (built, source) => assert(fs.readFileSync(path.join(out, built)).equals(fs.readFileSync(path.join(root, 'src/ui', source))), built);
    same('index.html', 'app.html');
    same('assets/app.mjs', 'app.mjs');
    same('assets/hook.wasm', 'hook.wasm');
    same('assets/mv/hls.mjs', 'mv-hls.mjs');
    same('assets/mv/style.css', 'mv.css');
    same('assets/lyrics/panel.mjs', 'lyrics/panel.mjs');
    same('assets/views/home.html', 'views/home.html');
    assert(!fs.existsSync(path.join(out, 'assets/host.js')), 'host.js is generated by the function');
    // Everything the app shell loads is either built or served by the function
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    for (const [, url] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      assert(url === '/assets/host.js' || fs.existsSync(path.join(out, url)), url);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
