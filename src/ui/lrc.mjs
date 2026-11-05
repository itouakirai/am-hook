// Apple Music TTML 歌词转 LRC（下载时嵌入标签或另存歌词文件），与参考实现 apple-music-downloader 的 lyrics.go 相同：
//   逐行：[mm:ss.xx]歌词；逐字（syllable）：[mm:ss.xx]<mm:ss.xx>词<mm:ss.xx>词…<结束时间>；
//   附加内容（发音、翻译）各占一行，时间与原句相同；没有时间轴的歌词只输出文字。
//   空间音频（全景声、双耳、缩混）比歌词晚 TTML 里 <audio lyricOffset role="spatial"/> 的时间，下载这些音质时整体推迟。
// 解析复用歌词界面的 parseTTML（lyrics/ttml.mjs）。

import { parseTTML } from './lyrics/ttml.mjs';

const pad = (n) => String(n).padStart(2, '0');
function stamp(ms) {
  const cs = Math.max(0, Math.floor(ms / 10));
  return `${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}
const lineTag = (ms) => `[${stamp(ms)}]`;
const wordTag = (ms) => `<${stamp(ms)}>`;

/** 逐字：每个词前是开始时间，最后补上末词的结束时间 */
function timedWords(tokens, shift) {
  if (!tokens.length) return '';
  const words = tokens.map((tok, i) => `${wordTag(tok.begin + shift)}${tok.text}${tok.spaceAfter && i < tokens.length - 1 ? ' ' : ''}`);
  return words.join('') + wordTag(tokens[tokens.length - 1].end + shift);
}

/**
 * options：{ syllable, translation, pronunciation, spatial（音频是空间音频版本，按 lyricOffset 推迟）, Parser }
 * （Parser 为 DOMParser，测试时可替换）
 * 返回 LRC 文本；没有可用的歌词时返回 ''
 */
export function ttmlToLrc(ttml, { syllable = false, translation = false, pronunciation = false, spatial = false, Parser } = {}) {
  const model = parseTTML(ttml, Parser);
  const shift = spatial ? model.audioOffsets.spatial || 0 : 0;
  const out = [];
  if (model.timing === 'None') {
    for (const line of model.lines) if (line.text) out.push(line.text);
    return out.join('\n');
  }
  const words = syllable && model.timing === 'Word';
  for (const line of model.lines) {
    const begin = (line.tokens.length ? line.tokens[0].begin : line.begin) + shift;
    const bg = line.background && line.background.text ? line.background : null;
    let main;
    if (words && line.tokens.length) {
      main = lineTag(begin) + timedWords(line.tokens, shift) + (bg && bg.tokens.length ? ` (${timedWords(bg.tokens, shift)})` : bg ? ` (${bg.text})` : '');
    } else {
      main = lineTag(begin) + line.text + (bg ? ` (${bg.text})` : '');
    }
    out.push(main);
    if (pronunciation) {
      // 逐字的发音（带 span）只有 tokens，逐行的只有文字
      const toks = line.pronunciationTokens;
      if (words && toks.length) out.push(lineTag(begin) + timedWords(toks, shift));
      else {
        const text = line.pronunciation || toks.map((tok) => tok.text + (tok.spaceAfter ? ' ' : '')).join('').trim();
        if (text) out.push(lineTag(begin) + text);
      }
    }
    if (translation && line.translation) out.push(lineTag(begin) + line.translation);
  }
  return out.join('\n');
}
