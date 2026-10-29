// 歌词的对唱侧（AMLL LyricLine 的 isDuet）：离线，只需 Node：
//   node --test tests/agent_duet.mjs
// 按 parseTTML 的输出手工构造歌曲（只给 toAmllLines 用到的 agents 与 lines），检查 src/ui/lyrics/panel.mjs 的 toAmllLines
// 照 AMLL（packages/ttml 的 amll-converter）逐行决定的显示侧：第一位主唱在主侧（type 为 other 时在对唱侧），同一位主唱不换侧，
// 换人就换侧；合唱（type 为 group，如 v1000）不在对唱侧，也不打断交替；和声跟随所属的主歌词行。
import test from 'node:test';
import assert from 'node:assert/strict';

// panel.mjs 引入的 amll-core.mjs 是浏览器构建，加载时就要用到 DOM 的全局对象（如继承 MouseEvent），这里只给加载所需的空壳。
// Event 与 CustomEvent 用 Node 自带的；Node 已有的全局对象都不替换
class Node {}
class Element extends Node {
  style = { setProperty() {}, removeProperty() {} };
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
}
class HTMLElement extends Element {}
class MouseEvent extends Event {}
class KeyboardEvent extends Event {}
class Observer { observe() {} unobserve() {} disconnect() {} }
const browser = {
  window: {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  MouseEvent, KeyboardEvent, Node, Element, HTMLElement,
  customElements: { define() {}, get: () => undefined },
  document: {
    querySelector: () => null, querySelectorAll: () => [], createElement: () => new HTMLElement(),
    addEventListener() {}, documentElement: {}, body: {},
  },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  ResizeObserver: Observer, MutationObserver: Observer,
};
for (const [name, value] of Object.entries(browser)) if (!(name in globalThis)) globalThis[name] = value;
const { toAmllLines } = await import('../src/ui/lyrics/panel.mjs');

/** parseTTML 的一个声部：一个逐词时间不为 0 的词；text 为空时是没有和声的空声部 */
const voice = (text, begin, end) => ({
  text, tokens: text ? [{ begin, end, text, spaceAfter: false }] : [], translation: '', pronunciation: '', pronunciationTokens: [],
});

/** 按 parseTTML 的输出构造歌曲：singers 为每行的 ttm:agent，backgrounds 为带和声的行（下标）；不给 agents 时整个省略 */
function song(singers, { agents, backgrounds = [] } = {}) {
  const lines = singers.map((agent, i) => {
    const begin = 1000 * (i + 1);
    return {
      key: `L${i + 1}`, begin, end: begin + 900, agent, ...voice(`Line ${i + 1}`, begin, begin + 500),
      background: backgrounds.includes(i) ? voice(`(echo ${i + 1})`, begin + 500, begin + 900) : voice(''),
    };
  });
  return agents ? { agents, lines } : { lines };
}

/** parseTTML 的 agents：xml:id → { id, type } */
const declare = (types) => Object.fromEntries(Object.entries(types).map(([id, type]) => [id, { id, type }]));
const PEOPLE = declare({ v1: 'person', v2: 'person' });
const CHORUS = declare({ v1: 'person', v2: 'person', v1000: 'group' });

/** 转换后每行的 isDuet（选项同歌词界面的默认值）；和声行记为 'bg:<isDuet>'，多出或少了和声行都会让比较失败 */
const sides = (parsed) => toAmllLines(parsed, { translation: false, pronunciation: false })
  .map((line) => (line.isBG ? `bg:${line.isDuet}` : line.isDuet));

test('只有一位主唱时全部在主侧', () => {
  assert.deepEqual(sides(song(['v1', 'v1', 'v1'], { agents: declare({ v1: 'person' }) })), [false, false, false]);
});

test('两位主唱轮流唱时左右交替', () => {
  assert.deepEqual(sides(song(['v1', 'v2', 'v1', 'v2'], { agents: PEOPLE })), [false, true, false, true]);
});

test('第一位主唱在主侧，即使它是 v2', () => {
  assert.deepEqual(sides(song(['v2', 'v1'], { agents: PEOPLE })), [false, true]);
});

test('第一位主唱的 type 为 other 时从对唱侧开始，之后照常交替', () => {
  assert.deepEqual(sides(song(['v1', 'v1', 'v2', 'v1'], { agents: declare({ v1: 'other', v2: 'person' }) })), [true, true, false, true]);
  // other 只决定第一位主唱的显示侧，后来才出现的 other 照常换侧
  assert.deepEqual(sides(song(['v2', 'v1', 'v3'], { agents: declare({ v1: 'person', v2: 'person', v3: 'other' }) })), [false, true, false]);
});

test('合唱（type 为 group）不在对唱侧，也不打断主唱的交替', () => {
  assert.deepEqual(sides(song(['v1', 'v1000', 'v2', 'v1000', 'v1'], { agents: CHORUS })), [false, false, true, false, false]);
});

test('以合唱开头时，之后的第一位主唱仍在主侧', () => {
  assert.deepEqual(sides(song(['v1000', 'v2', 'v1'], { agents: CHORUS })), [false, false, true]);
});

test('agents 里没有声明的歌手中途出现时，和普通主唱一样换侧', () => {
  assert.deepEqual(sides(song(['v1', 'v2', 'v3', 'v1'], { agents: PEOPLE })), [false, true, false, true]);
});

test('同一位主唱连续几行不换侧，中间隔着合唱也一样', () => {
  assert.deepEqual(sides(song(['v2', 'v2', 'v1', 'v1', 'v1000', 'v1', 'v2'], { agents: CHORUS })), [false, false, true, true, false, true, false]);
});

test('和声跟随所属主歌词行的显示侧', () => {
  assert.deepEqual(sides(song(['v2', 'v1', 'v1', 'v2'], { agents: PEOPLE, backgrounds: [1, 3] })), [false, true, 'bg:true', true, false, 'bg:false']);
});

test('歌曲没有 agents 时不报错，仍按 ttm:agent 的 id 交替', () => {
  assert.deepEqual(sides(song(['v2', 'v1', 'v1', 'v2'])), [false, true, true, false]);
});
