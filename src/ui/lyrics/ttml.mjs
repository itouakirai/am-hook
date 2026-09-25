/** Parse the Apple lyric dialect. All times in the public model are milliseconds. */
export function parseTime(value = '0') {
  const parts = String(value).split(':');
  if (parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error(`无效的时间：${value}`);
  }
  return Math.round(parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000);
}

const APPLE = 'http://music.apple.com/lyric-ttml-internal';
const META = 'http://www.w3.org/ns/ttml#metadata';
const XML = 'http://www.w3.org/XML/1998/namespace';
const children = (node, name) => [...(node?.children || [])].filter(child => child.localName === name);
const child = (node, name) => children(node, name)[0];
const cleanText = node => node?.textContent.trim().replace(/\s+/g, ' ') || '';
const attribute = (node, ns, name, fallback = '') => node?.getAttributeNS(ns, name) || fallback;
const isBackground = node => attribute(node, META, 'role') === 'x-bg';

function tokens(node) {
  return children(node, 'span').filter(span => !isBackground(span)).map(span => ({
    begin: parseTime(span.getAttribute('begin') || '0'),
    end: parseTime(span.getAttribute('end') || '0'),
    text: span.textContent || '',
    spaceAfter: span.nextSibling?.nodeType === 3,
  }));
}

function localization(metadata, collection, element) {
  const source = child(child(metadata, collection), element);
  return {
    language: attribute(source, XML, 'lang'),
    automatic: source?.getAttribute('automaticallyCreated') === 'true',
    type: source?.getAttribute('type') || '',
    entries: new Map(children(source, 'text').map(text => [text.getAttribute('for'), text])),
  };
}

function readVoice(node, translation, pronunciation) {
  return {
    text: cleanText(node), tokens: tokens(node),
    translation: translation?.textContent.trim() || '',
    pronunciation: children(pronunciation, 'span').length ? '' : cleanText(pronunciation),
    pronunciationTokens: tokens(pronunciation),
  };
}

export function parseTTML(xml, Parser = globalThis.DOMParser) {
  if (!Parser) throw new Error('需要 DOMParser');
  const document = new Parser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'tt') {
    throw new Error('无法解析 TTML：XML 格式不正确');
  }
  const root = document.documentElement;
  const body = child(root, 'body');
  if (!body) throw new Error('TTML 缺少 body');
  const metadata = child(child(child(root, 'head'), 'metadata'), 'iTunesMetadata');
  const translation = localization(metadata, 'translations', 'translation');
  const pronunciation = localization(metadata, 'transliterations', 'transliteration');
  const sections = children(body, 'div').map((section, sectionIndex) => ({
    begin: parseTime(section.getAttribute('begin') || '0'),
    end: parseTime(section.getAttribute('end') || '0'),
    type: attribute(section, APPLE, 'songPart', 'Verse').toLowerCase(),
    lines: children(section, 'p').map((line, lineIndex) => {
      const key = attribute(line, APPLE, 'key', `${sectionIndex}:${lineIndex}`);
      const tr = translation.entries.get(key), pr = pronunciation.entries.get(key);
      const bgNode = children(line, 'span').find(isBackground);
      const background = readVoice(bgNode, children(tr, 'span').find(isBackground), children(pr, 'span').find(isBackground));
      const main = readVoice(line, tr, pr);
      // The web renderer displays replacement entries as a secondary line too.
      // It separates a parenthesized background translation even when that row
      // has no timed background vocal (e.g. 01.ttml L2).
      const bgText = background.translation.replace(/[()]/g, '') || main.translation.match(/\(+([^)]+)\)+/)?.[1]?.trim() || '';
      if (bgText) main.translation = main.translation.replaceAll(`(${bgText})`, '').trim();
      background.translation = bgText;
      return { key, begin: parseTime(line.getAttribute('begin') || '0'), end: parseTime(line.getAttribute('end') || '0'), agent: attribute(line, META, 'agent', 'v1'), ...main, background };
    }),
  }));
  return {
    timing: attribute(root, APPLE, 'timing', 'None'),
    language: attribute(root, XML, 'lang', 'en'),
    duration: parseTime(body.getAttribute('dur') || '0'),
    sections, lines: sections.flatMap(section => section.lines),
    credits: children(child(metadata, 'songwriters'), 'songwriter').map(cleanText),
    translation: { language: translation.language, type: translation.type, automatic: translation.automatic },
    pronunciation: { language: pronunciation.language, automatic: pronunciation.automatic },
  };
}
