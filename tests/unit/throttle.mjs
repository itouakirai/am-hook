// wrapper-lite 限流（429）的退避：wrapper.js 的 AmWrapper.throttle，以及真实的 downloads.mjs 在限流时的调度。
// 离线，只需 Node（wrapper-lite 的响应由桩掉的 fetch 给出）：
//   node --test tests/throttle.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
globalThis.AmI18n = { t: (key) => key, storefront: 'cn', catalogLang: async () => undefined };
globalThis.AmDecrypt = {};

// 桩掉的网络：amp-api 补充元数据返回空；/parse/song/<id>（服务端转发 wrapper-lite 的 /m3u8）由 behavior 决定
const requests = [];
let inFlight = 0;
let maxInFlight = 0;
let behavior = async () => ({ status: 200, body: { code: 0, data: { masterUrl: null } } });
globalThis.fetch = async (input) => {
  const url = String(input);
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (!url.includes('/parse/song/')) return json({ data: [] });
  const call = { id: url.split('/').pop(), at: Date.now(), inFlight: ++inFlight };
  requests.push(call);
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    const { status, body, headers } = await behavior(call);
    return json(body, status, headers);
  } finally {
    inFlight--;
  }
};

await import('../../web/wrapper.js');
const { AmWrapper } = globalThis;
const T = AmWrapper.throttle;
const { prefs } = await import('../../web/prefs.mjs');
const { downloads } = await import('../../web/download/downloads.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const limited = (retryAfter) => ({ status: 429, body: { code: 1, msg: 'wrapper-lite rate limited (HTTP 429)' }, headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) } });
const song = (n) => ({ id: String(100 + n), type: 'songs', attributes: { name: `Song ${n}`, artistName: 'A', trackNumber: n, playParams: { id: String(100 + n) } } });
const album = (count) => ({
  kind: 'album',
  id: '1',
  country: 'cn',
  resource: { id: '1', type: 'albums', attributes: { name: 'Album', artistName: 'A', trackCount: count } },
  tracks: Array.from({ length: count }, (_, i) => song(i + 1)),
});
async function until(check, ms = 30000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(20);
  }
}
const reset = () => { T.reset(); requests.length = 0; maxInFlight = 0; inFlight = 0; };
const errorOf = (promise) => promise.then(() => assert.fail('expected an error'), (err) => err);

test.beforeEach(reset);

test('错误归类：429、msg 里的 rate limited / 429 视为限流并进入冷却；banned 不重试；其余原样', async () => {
  behavior = async () => limited(7);
  let err = await errorOf(AmWrapper.songMaster('1'));
  assert.equal(err.throttled, true);
  const r = T.remaining();
  assert.ok(r >= 6900 && r <= 8100, `Retry-After: 7 → ${r} ms`);

  // 服务端把 wrapper-lite 的限流转成 500 / 502，只有 msg 能看出来
  T.reset();
  behavior = async () => ({ status: 500, body: { code: 1, msg: 'rate limited (concurrency)' } });
  err = await errorOf(AmWrapper.songMaster('1'));
  assert.equal(err.throttled, true);
  T.reset();
  behavior = async () => ({ status: 502, body: { code: 1, msg: 'wrapper-lite returned HTTP 429: too many requests' } });
  assert.equal((await errorOf(AmWrapper.songMaster('1'))).throttled, true);

  T.reset();
  behavior = async () => ({ status: 500, body: { code: 1, msg: 'banned' } });
  err = await errorOf(AmWrapper.songMaster('1'));
  assert.equal(err.final, true);
  assert.equal(err.throttled, undefined);
  assert.equal(T.remaining(), 0, 'banned 不进入冷却：重试没有意义');

  behavior = async () => ({ status: 500, body: { code: 1, msg: 'internal error' } });
  err = await errorOf(AmWrapper.songMaster('1'));
  assert.equal(err.throttled, undefined);
  assert.equal(err.final, undefined);
  assert.equal(T.remaining(), 0);
});

test('hit：优先用 Retry-After（封顶），没有时指数退避；同一轮里的限流不叠高级别', () => {
  T.hit(20000);
  assert.ok(T.remaining() >= 19000 && T.remaining() <= 21100);
  assert.equal(T.state().level, 1);
  for (let i = 0; i < 5; i++) T.hit(); // 6 首并发同时被限流
  assert.equal(T.state().level, 1);

  T.reset();
  T.hit();
  assert.ok(T.remaining() >= 3900 && T.remaining() <= 6100, String(T.remaining())); // 第一级约 5 秒，±20%

  T.reset();
  T.hit(99 * 3600 * 1000);
  assert.ok(T.remaining() <= 601000);
});

test('limit 每级减半，至少 1，0（不限）不变；冷却结束后连续成功才逐级恢复', async () => {
  assert.equal(T.limit(6), 6);
  T.hit(1);
  assert.equal(T.limit(6), 3);
  assert.equal(T.limit(1), 1);
  assert.equal(T.limit(0), 0);

  T.hit(60000);
  T.ok(); T.ok(); T.ok();
  assert.equal(T.state().level, 1, '冷却期内的成功不计恢复');

  T.reset();
  T.hit(1);
  await T.wait();
  T.ok(); T.ok();
  assert.equal(T.state().level, 1);
  T.ok();
  assert.equal(T.state().level, 0);
  assert.equal(T.limit(6), 6);
});

test('wait：冷却结束后才返回；中止（含已中止）时以 signal.reason 拒绝', async () => {
  assert.equal(await T.wait(), undefined);
  T.hit(1);
  await T.wait();
  assert.equal(T.remaining(), 0);

  T.hit(60000);
  const ctl = new AbortController();
  const pending = T.wait(ctl.signal);
  setTimeout(() => ctl.abort(new Error('stop')), 20);
  await assert.rejects(pending, /stop/);

  const done = new AbortController();
  done.abort(new Error('already'));
  await assert.rejects(T.wait(done.signal), /already/);
});

test('下载：4 首同时被限流后，冷却期内不发新请求，冷却后并发减半，限流不占用重试次数', async () => {
  prefs.set('download', { concurrency: 4, retries: 0 });
  // 开头同时发出的 4 个请求都被限流（Retry-After: 1）；之后的请求都得到响应（没有 master → 终态）
  let throttledAt = 0;
  behavior = async (call) => {
    await sleep(40);
    if (requests.indexOf(call) < 4) {
      throttledAt ||= Date.now();
      return limited(1);
    }
    return { status: 200, body: { code: 0, data: { masterUrl: null } } };
  };

  const job = await downloads.add(album(8));
  await until(() => job.tasks.length === 8 && job.tasks.every((x) => x.state === 'error'));

  const later = requests.slice(4);
  assert.equal(requests.length, 12, '4 首被限流的重新排队再请求一次 + 另外 4 首各请求一次');
  assert.equal(new Set(requests.slice(0, 4).map((c) => c.id)).size, 4);

  // 冷却期（至少 Retry-After 的 1 秒）内没有任何新请求
  const earliest = Math.min(...later.map((c) => c.at));
  assert.ok(earliest - throttledAt >= 950, `冷却期内就发出了请求：${earliest - throttledAt} ms`);

  // 级别 1：有效并发 4 → 2
  assert.ok(Math.max(...later.map((c) => c.inFlight)) <= 2, `冷却后同时进行 ${Math.max(...later.map((c) => c.inFlight))} 个`);

  // retries = 0，仍然没有因 429 失败：最终的错误不是限流，被限流的 4 首各重新排队一次且不计入失败重试
  for (const task of job.tasks) {
    assert.ok(!/429|rate/i.test(task.error), task.error);
    assert.equal(task.attempts, 1);
  }
  assert.equal(job.tasks.filter((x) => x.throttles === 1).length, 4);
});

test('banned 的歌曲不重试', async () => {
  prefs.set('download', { concurrency: 2, retries: 3 });
  behavior = async () => ({ status: 500, body: { code: 1, msg: 'banned' } });
  const job = await downloads.add(album(3));
  await until(() => job.tasks.length === 3 && job.tasks.every((x) => x.state === 'error'));
  assert.equal(requests.length, 3, '每首只请求一次');
  assert.equal(T.remaining(), 0);
});

test('限流重新排队次数用尽后按普通失败处理', async () => {
  prefs.set('download', { concurrency: 1, retries: 0 });
  behavior = async () => limited(0.001);
  const job = await downloads.add(album(1));
  await until(() => job.tasks.length === 1 && job.tasks[0].state === 'error', 90000);
  assert.ok(/429/.test(job.tasks[0].error));
  assert.equal(requests.length, 9, '第一次 + 8 次限流重新排队');
});
