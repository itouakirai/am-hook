/**
 * Parse the Apple lyric dialect, and the AMLL TTML DB dialect (https://github.com/amll-dev/amll-ttml-db), which writes
 * translations and romanizations inline as <span ttm:role="x-translation|x-roman"> and credits authors in <amll:meta>.
 * All times in the public model are milliseconds.
 */
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
const attribute = (node, ns, name, fallback = '') => node?.getAttributeNS(ns, name) || fallback;
const role = node => attribute(node, META, 'role');
const isBackground = node => role(node) === 'x-bg';
const inline = (node, name) => children(node, 'span').find(span => role(span) === name);
// Text of the node itself, without background vocals or inline translations
const cleanText = node => [...(node?.childNodes || [])]
  .filter(n => n.nodeType === 3 || (n.nodeType === 1 && !role(n)))
  .map(n => n.textContent).join('').trim().replace(/\s+/g, ' ');

function tokens(node) {
  return children(node, 'span').filter(span => !role(span)).map(span => ({
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
  translation ||= inline(node, 'x-translation');
  pronunciation ||= inline(node, 'x-roman');
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
  const head = child(child(root, 'head'), 'metadata');
  const metadata = child(head, 'iTunesMetadata');
  const agents = Object.fromEntries(children(head, 'agent').filter(node => node.namespaceURI === META).flatMap(node => {
    const id = attribute(node, XML, 'id');
    if (!id) return [];
    const type = attribute(node, META, 'type') || node.getAttribute('type');
    const name = children(node, 'name').find(name => name.namespaceURI === META)?.textContent.trim();
    return [[id, { id, ...(type ? { type } : {}), ...(name ? { name } : {}) }]];
  }));
  const amllMeta = key => children(head, 'meta').filter(meta => meta.getAttribute('key') === key).map(meta => meta.getAttribute('value'));
  const translation = localization(metadata, 'translations', 'translation');
  const pronunciation = localization(metadata, 'transliterations', 'transliteration');
  const sections = children(body, 'div').map((section, sectionIndex) => ({
    begin: parseTime(section.getAttribute('begin') || '0'),
    end: parseTime(section.getAttribute('end') || '0'),
    type: attribute(section, APPLE, 'songPart', 'Verse').toLowerCase(),
    lines: children(section, 'p').map((line, lineIndex) => {
      const key = attribute(line, APPLE, 'key', `${sectionIndex}:${lineIndex}`);
      const pr = pronunciation.entries.get(key);
      // A replacement (e.g. zh-Hans-CN for a zh-Hant original) supersedes the lyrics, keeping its own word timing
      const replacement = translation.type === 'replacement' ? translation.entries.get(key) : null;
      const tr = replacement ? null : translation.entries.get(key);
      const bgNode = children(line, 'span').find(isBackground);
      const background = readVoice(bgNode, children(tr, 'span').find(isBackground), children(pr, 'span').find(isBackground));
      const main = readVoice(line, tr, pr);
      if (replacement) {
        Object.assign(main, { text: cleanText(replacement), tokens: tokens(replacement) });
        const bgReplacement = children(replacement, 'span').find(isBackground);
        if (bgReplacement) Object.assign(background, { text: cleanText(bgReplacement), tokens: tokens(bgReplacement) });
      }
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
    agents,
    sections, lines: sections.flatMap(section => section.lines),
    credits: children(child(metadata, 'songwriters'), 'songwriter').map(cleanText),
    authors: amllMeta('ttmlAuthorGithubLogin'),
    translation: { language: translation.language, type: translation.type, automatic: translation.automatic },
    pronunciation: { language: pronunciation.language, automatic: pronunciation.automatic },
  };
}
