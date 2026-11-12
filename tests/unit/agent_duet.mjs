// 歌词的对唱侧（AMLL LyricLine 的 isDuet）：离线，只需 Node：
//   node --test tests/agent_duet.mjs
// 按 parseTTML 的输出手工构造歌曲（只给 duetSides 用到的 agents 与每行的 agent），检查 web/lyrics/ttml.mjs 的 duetSides
// 照 AMLL（packages/ttml 的 amll-converter）逐行决定的显示侧：第一位主唱在主侧（type 为 other 时在对唱侧），同一位主唱不换侧，
// 换人就换侧；合唱（type 为 group，如 v1000）不在对唱侧，也不打断交替。和声跟随所属主歌词行由 tests/lyrics_ui.cjs 在页面里检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { duetSides } from '../../web/lyrics/ttml.mjs';

/** 按 parseTTML 的输出构造歌曲：singers 为每行的 ttm:agent；不给 agents 时整个省略 */
const song = (singers, agents) => ({ ...(agents ? { agents } : {}), lines: singers.map((agent) => ({ agent })) });

/** parseTTML 的 agents：xml:id → { id, type } */
const declare = (types) => Object.fromEntries(Object.entries(types).map(([id, type]) => [id, { id, type }]));
const PEOPLE = declare({ v1: 'person', v2: 'person' });
const CHORUS = declare({ v1: 'person', v2: 'person', v1000: 'group' });

test('只有一位主唱时全部在主侧', () => {
  assert.deepEqual(duetSides(song(['v1', 'v1', 'v1'], declare({ v1: 'person' }))), [false, false, false]);
});

test('两位主唱轮流唱时左右交替', () => {
  assert.deepEqual(duetSides(song(['v1', 'v2', 'v1', 'v2'], PEOPLE)), [false, true, false, true]);
});

test('第一位主唱在主侧，即使它是 v2', () => {
  assert.deepEqual(duetSides(song(['v2', 'v1'], PEOPLE)), [false, true]);
});

test('第一位主唱的 type 为 other 时从对唱侧开始，之后照常交替', () => {
  assert.deepEqual(duetSides(song(['v1', 'v1', 'v2', 'v1'], declare({ v1: 'other', v2: 'person' }))), [true, true, false, true]);
  // other 只决定第一位主唱的显示侧，后来才出现的 other 照常换侧
  assert.deepEqual(duetSides(song(['v2', 'v1', 'v3'], declare({ v1: 'person', v2: 'person', v3: 'other' }))), [false, true, false]);
});

test('合唱（type 为 group）不在对唱侧，也不打断主唱的交替', () => {
  assert.deepEqual(duetSides(song(['v1', 'v1000', 'v2', 'v1000', 'v1'], CHORUS)), [false, false, true, false, false]);
});

test('以合唱开头时，之后的第一位主唱仍在主侧', () => {
  assert.deepEqual(duetSides(song(['v1000', 'v2', 'v1'], CHORUS)), [false, false, true]);
});

test('agents 里没有声明的歌手中途出现时，和普通主唱一样换侧', () => {
  assert.deepEqual(duetSides(song(['v1', 'v2', 'v3', 'v1'], PEOPLE)), [false, true, false, true]);
});

test('同一位主唱连续几行不换侧，中间隔着合唱也一样', () => {
  assert.deepEqual(duetSides(song(['v2', 'v2', 'v1', 'v1', 'v1000', 'v1', 'v2'], CHORUS)), [false, false, true, true, false, true, false]);
});

test('歌曲没有 agents 时不报错，仍按 ttm:agent 的 id 交替', () => {
  assert.deepEqual(duetSides(song(['v2', 'v1', 'v1', 'v2'])), [false, true, true, false]);
});
