// 设置中心（/settings，views/settings.mjs）的存储：播放（playback：按网络选择的播放音质、杜比全景声优先、歌曲之间的过渡）、
// JOC 对象渲染（joc）与下载设置（download）。
// 保存在 localStorage（不会过期），同一浏览器的其他标签页修改后自动同步。
//
//   prefs.get(section)          该分组的当前设置（已合并默认值、校验过的副本）
//   prefs.set(section, patch)   修改并保存，通知 onChange
//   prefs.reset(section)        恢复默认
//   prefs.onChange(fn)          设置变化后回调 fn(section, value)，返回取消订阅的函数
//   DEFAULTS / OPTIONS          默认值与各选项的可选值（设置页据此渲染）
//   pickVariant(variants, o)    按首选音质与降级顺序（fallbackChain）选歌曲的变体，classify 为变体的种类

const STORAGE_KEY = 'am-hook:settings';

/** iTunes 标签中可选写入的字段（与 amd.wol.moe 的「嵌入标签字段」相同） */
export const TAG_FIELDS = [
  'title', 'artist', 'album', 'album_artist', 'composer', 'genre', 'created', 'tracknum', 'disk',
  'lyrics', 'cover', 'copyright', 'record_company', 'upc', 'isrc', 'rtng', 'song_id', 'album_id', 'artist_id',
];

/** 首选音质按下拉框的分组排列（set.codecGroup.*）；取值见下面的 pickVariant */
export const CODEC_GROUPS = [
  ['hires', ['alac', 'atmos']],
  ['stereo', ['aac', 'aac-128', 'aac-he']],
  ['binaural', ['aac-binaural', 'aac-binaural-128', 'he-binaural']],
  ['downmix', ['aac-downmix', 'aac-downmix-128', 'he-downmix']],
];

/* ---------- 音质选择（downloads.mjs 下载歌曲时调用） ---------- */
/** 各首选音质默认的降级顺序（不含首选本身）；设置中心可按首选音质改写，存在 fallbackOrder 中 */
export const DEFAULT_FALLBACK = {
  alac: ['aac', 'aac-he'],
  atmos: ['alac', 'aac', 'aac-he'],
  aac: ['aac-he', 'alac'],
  'aac-128': ['aac-he', 'aac', 'alac'],
  'aac-he': ['aac-128', 'aac', 'alac'],
  'aac-binaural': ['aac', 'aac-he', 'alac'],
  'aac-binaural-128': ['he-binaural', 'aac-128', 'aac-he', 'aac', 'alac'],
  'he-binaural': ['aac-binaural-128', 'aac-he', 'aac-128', 'aac', 'alac'],
  'aac-downmix': ['aac', 'aac-he', 'alac'],
  'aac-downmix-128': ['he-downmix', 'aac-128', 'aac-he', 'aac', 'alac'],
  'he-downmix': ['aac-downmix-128', 'aac-he', 'aac-128', 'aac', 'alac'],
};

/** 实际使用的降级顺序：fallback 关闭时为空，否则为该首选音质自定义的顺序或默认顺序 */
export function fallbackChain(options) {
  if (!options.fallback) return [];
  const custom = options.fallbackOrder && options.fallbackOrder[options.codec];
  return Array.isArray(custom) ? custom : DEFAULT_FALLBACK[options.codec] || [];
}

/** master 变体的种类与排序值（GROUP-ID：audio-alac-stereo-96000-24、audio-atmos-2768、audio-stereo-256[-binaural|-downmix]、audio-HE-stereo-64…） */
export function classify(v) {
  const g = (v.group_id || '').toLowerCase();
  if (g.includes('alac')) return { kind: 'alac', rank: (v.sample_rate || 0) * 100 + (v.bit_depth || 0) };
  if (g.includes('atmos')) return { kind: 'atmos', rank: Number((g.match(/atmos-(\d+)/) || [])[1]) || 0 };
  const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
  const he = g.includes('he-');
  if (g.includes('binaural')) return { kind: he ? 'he-binaural' : 'aac-binaural', rank: kbps };
  if (g.includes('downmix')) return { kind: he ? 'he-downmix' : 'aac-downmix', rank: kbps };
  return { kind: he ? 'aac-he' : 'aac', rank: kbps };
}

/** 带码率上限的首选音质（master 有 audio-stereo-128[-binaural|-downmix]）；其余取值就是 classify 的种类 */
const CAPPED = {
  'aac-128': { kind: 'aac', kbps: 128 },
  'aac-binaural-128': { kind: 'aac-binaural', kbps: 128 },
  'aac-downmix-128': { kind: 'aac-downmix', kbps: 128 },
};

/**
 * 按首选音质（及上限）选变体；没有时按降级顺序（fallbackChain）依次尝试。返回 { variant, fallback } 或 null。
 * 没有 master 的歌曲只有 /webplayback 的 AAC-LC 256（wrapper.js，GROUP-ID 同 master 的 AAC 256），同样按顺序判断：
 * 首选或降级顺序中没有 AAC 256 时跳过
 */
export function pickVariant(variants, options) {
  const { codec, alacMax, atmosMax } = options;
  for (const choice of [codec, ...fallbackChain(options)]) {
    const { kind, kbps } = CAPPED[choice] || { kind: choice };
    const list = variants.map((v) => ({ v, c: classify(v) })).filter(({ v, c }) => c.kind === kind
      && (kind !== 'alac' || !v.sample_rate || v.sample_rate <= alacMax)
      && (kind !== 'atmos' || c.rank <= atmosMax)
      && (!kbps || c.rank <= kbps));
    if (!list.length) continue;
    list.sort((a, b) => b.c.rank - a.c.rank || (b.v.bandwidth || 0) - (a.v.bandwidth || 0));
    return { variant: list[0].v, fallback: choice !== codec };
  }
  return null;
}

/* ---------- 播放音质（player.js 的 pickPlayable 按此选队列中每首歌的音质） ---------- */
/**
 * 当前网络：'cellular'（移动数据，或浏览器开启了省流量 Save-Data）/ 'wifi'（Wi-Fi、有线等）/ null（浏览器不提供，
 * 如桌面版 Chrome 与 Safari，按 Wi-Fi 处理）。来自 Network Information API 的 navigator.connection
 */
export function networkKind() {
  const c = globalThis.navigator && navigator.connection;
  if (!c) return null;
  if (c.type === 'cellular' || c.saveData) return 'cellular';
  return c.type && c.type !== 'unknown' ? 'wifi' : null;
}

/** 网络变化后回调 fn（只在支持 navigator.connection 的浏览器上触发），返回取消订阅的函数 */
export function onNetworkChange(fn) {
  const c = globalThis.navigator && navigator.connection;
  if (!c || !c.addEventListener) return () => {};
  c.addEventListener('change', fn);
  return () => c.removeEventListener('change', fn);
}

/** 按当前网络生效的播放设置：{ quality, spatial, network, transition, crossfade } */
export function playbackFor(value = state.playback) {
  const network = networkKind();
  return {
    quality: network === 'cellular' ? value.cellular : value.wifi,
    spatial: value.spatial,
    network,
    transition: value.transition,
    crossfade: value.crossfade,
  };
}

export const OPTIONS = {
  // 播放音质：efficient = HE-AAC，high = AAC 256 kbps，lossless = ALAC 最高 24-bit / 48 kHz，hires = ALAC 最高 24-bit / 192 kHz
  // spatial：杜比全景声是否优先于上面的音质（auto：开启 JOC 对象渲染时优先；always；off：只在手动换音质时使用）
  playback: {
    quality: ['efficient', 'high', 'lossless', 'hires'],
    spatial: ['auto', 'always', 'off'],
    // 歌曲之间的过渡（player.js 的 Mixer，规划见 automix.js）：off 无缝衔接；automix 按 Apple Music 的音频分析规划；crossfade 固定时长
    transition: ['off', 'automix', 'crossfade'],
  },
  download: {
    // 首选音质；没有时按 fallback 降级
    codec: CODEC_GROUPS.flatMap(([, list]) => list),
    alacMax: [192000, 96000, 48000, 44100],
    atmosMax: [2768, 2448],
    saveMode: ['zip', 'folder', 'files'],
    // source：跟随原图（模板中 /{w}x{h} 前一段的扩展名，如 xxx.rgb.jpg → jpg）
    coverFormat: ['jpg', 'png', 'source'],
    lyricsFormat: ['lrc', 'ttml'],
    // MV：最高分辨率（高度）与音轨（同参考实现的 mv-max / mv-audio-type）
    mvMax: [2160, 1440, 1080, 720, 480],
    mvAudio: ['atmos', 'ac3', 'aac'],
  },
  // JOC 对象渲染（E-AC-3 Dolby Atmos，player.js 的 JocEngine）：off 为浏览器自己的解码（MSE / 内置 EC-3 PCM）
  joc: {
    mode: ['off', 'speaker', 'binaural'],
    // 双耳渲染的 HRTF：约克大学 SADIE II 数据库的 20 位受试者（src/ui/joc-hrtf-*.jochrtf）
    dataset: ['D1', 'D2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'H11', 'H12', 'H13', 'H14', 'H15', 'H16', 'H17', 'H18', 'H19', 'H20'],
  },
};

export const DEFAULTS = {
  playback: {
    wifi: 'hires',
    cellular: 'high',
    spatial: 'auto',
    transition: 'automix',
    // 交叉淡化的时长（秒，1–12）
    crossfade: 6,
  },
  download: {
    codec: 'alac',
    alacMax: 192000,
    atmosMax: 2768,
    // 首选音质不存在时按降级顺序改用其他音质（否则跳过该曲目）
    fallback: true,
    // 自定义的降级顺序：{ 首选音质: [音质…] }，没有的首选音质用 DEFAULT_FALLBACK
    fallbackOrder: {},
    // ALAC：为缺少 END 标记的原样帧补上标记（AppleMusicDecrypt#136，见 crates/am-alac）
    alacRepair: true,
    // ALAC：下载时检测原样帧（alac-check.mjs），结果写入自定义标签 ----:com.apple.iTunes:<alacCheckTagName>
    alacCheckTag: false,
    alacCheckTagName: 'ALAC_CHECK',
    // 专辑 / 歌单中的 MV 一起下载（下载对话框中默认勾选）
    mv: true,
    mvMax: 2160,
    // atmos：全景声 → AC-3 → AAC；ac3：AC-3 → AAC；aac：只用 AAC
    mvAudio: 'atmos',
    // 同时下载的曲目数；每首歌内部另有 4 路分段并发
    concurrency: 2,
    // 失败后自动重试的次数
    retries: 2,
    // 用浏览器文件系统（OPFS）暂存，内存占用与专辑大小无关
    opfs: true,
    // zip：整张专辑 / 歌单打包为一个 ZIP；folder：写入选定的本地文件夹（File System Access API）；files：逐个文件保存
    saveMode: 'zip',
    // 保存到文件夹时跳过已存在的文件
    skipExisting: true,
    // 为歌单另存 .m3u8 播放列表
    m3u: true,
    // 文件夹 / ZIP 名与文件名模板；文件名模板中的 / 表示子文件夹
    albumFolder: '{album_artist} - {album}',
    playlistFolder: '{playlist}',
    songFile: '{disk}-{tracknum:02d} {title}',
    playlistFile: '{index:02d}. {artist} - {title}',
    singleFile: '{artist} - {title}',
    // 标签
    embed: [...TAG_FIELDS],
    sortTags: false,
    // 歌单中的曲目写入原专辑信息（专辑名、曲目号等）；关闭时专辑为歌单名、曲目号为歌单中的序号
    playlistAlbumInfo: true,
    // 去掉专辑名末尾 Apple Music 附加的 ` - EP` / ` - Single`（标签与文件名、文件夹名一致）
    stripAlbumSuffix: false,
    // 元数据（歌名、专辑名等）的语言；空为跟随曲库语言
    metaLang: '',
    // 封面：嵌入标签的与另存的 cover 文件分开设置
    coverFormat: 'jpg',
    coverSize: 3000,
    // 原始尺寸：{w}x{h}bb 换成 0x0ss，忽略尺寸设置
    coverOriginal: false,
    saveCover: true,
    saveCoverFormat: 'jpg',
    saveCoverSize: 3000,
    saveCoverOriginal: false,
    // 歌词
    saveLyrics: false,
    lyricsFormat: 'lrc',
    // 嵌入标签的歌词格式：多数播放器只认 LRC（或纯文本），TTML 原样写入
    lyricsEmbedFormat: 'lrc',
    syllable: false,
    lyricsTranslation: true,
    lyricsPronunciation: false,
    // wrapper-lite /lyrics 的 language；空为跟随元数据语言
    lyricsLang: '',
    // wrapper-lite /lyrics 的 script（发音用的文字，如 ko-Hang）；空为不传，即 wrapper-lite 默认的 en-Latn
    lyricsScript: '',
  },
  joc: {
    mode: 'off',
    // 输出衰减（dB，-60–0）：15 个对象叠加可能超过满刻度，削波时播放器会提示
    gain: 0,
    dataset: 'D2',
    // ALAC / AAC 的音量补偿（dB，-20–0）：全景声混音通常比立体声母带小声，调低立体声让切歌时音量接近
    stereoGain: 0,
  },
};

const LANG_TAG = /^[A-Za-z0-9-]{0,35}$/;
/** iTunes 自定义字段名（----:com.apple.iTunes:<名称>） */
export const TAG_NAME = /^[A-Za-z0-9 _.-]{1,64}$/;
const int = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const template = (v, fallback) => (typeof v === 'string' && v.trim() && v.length <= 300 ? v : fallback);

/** 降级顺序：只保留已知音质，去掉首选本身与重复项 */
function cleanOrder(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const list = OPTIONS.download.codec;
  return Object.fromEntries(list.filter((c) => Array.isArray(raw[c]))
    .map((c) => [c, [...new Set(raw[c])].filter((x) => x !== c && list.includes(x))]));
}

/** 合并默认值并逐项校验：localStorage 里的值可能来自旧版本或被手动改过 */
function clean(section, raw) {
  const d = DEFAULTS[section];
  const r = raw && typeof raw === 'object' ? raw : {};
  if (section === 'playback') {
    const o = OPTIONS.playback;
    return {
      wifi: oneOf(r.wifi, o.quality, d.wifi),
      cellular: oneOf(r.cellular, o.quality, d.cellular),
      spatial: oneOf(r.spatial, o.spatial, d.spatial),
      transition: oneOf(r.transition, o.transition, d.transition),
      crossfade: int(r.crossfade, 1, 12, d.crossfade),
    };
  }
  if (section === 'joc') {
    return {
      mode: oneOf(r.mode, OPTIONS.joc.mode, d.mode),
      gain: int(r.gain, -60, 0, d.gain),
      dataset: oneOf(r.dataset, OPTIONS.joc.dataset, d.dataset),
      stereoGain: int(r.stereoGain, -20, 0, d.stereoGain),
    };
  }
  if (section !== 'download') return { ...d, ...r };
  const o = OPTIONS.download;
  return {
    codec: oneOf(r.codec, o.codec, d.codec),
    alacMax: oneOf(Number(r.alacMax), o.alacMax, d.alacMax),
    atmosMax: oneOf(Number(r.atmosMax), o.atmosMax, d.atmosMax),
    fallback: bool(r.fallback, d.fallback),
    fallbackOrder: cleanOrder(r.fallbackOrder),
    alacRepair: bool(r.alacRepair, d.alacRepair),
    alacCheckTag: bool(r.alacCheckTag, d.alacCheckTag),
    alacCheckTagName: typeof r.alacCheckTagName === 'string' && TAG_NAME.test(r.alacCheckTagName.trim()) ? r.alacCheckTagName.trim() : d.alacCheckTagName,
    mv:bool(r.mv, d.mv),
    mvMax: oneOf(Number(r.mvMax), o.mvMax, d.mvMax),
    mvAudio: oneOf(r.mvAudio, o.mvAudio, d.mvAudio),
    concurrency: int(r.concurrency, 1, 6, d.concurrency),
    retries: int(r.retries, 0, 5, d.retries),
    opfs: bool(r.opfs, d.opfs),
    saveMode: oneOf(r.saveMode, o.saveMode, d.saveMode),
    skipExisting: bool(r.skipExisting, d.skipExisting),
    m3u: bool(r.m3u, d.m3u),
    albumFolder: template(r.albumFolder, d.albumFolder),
    playlistFolder: template(r.playlistFolder, d.playlistFolder),
    songFile: template(r.songFile, d.songFile),
    playlistFile: template(r.playlistFile, d.playlistFile),
    singleFile: template(r.singleFile, d.singleFile),
    embed: Array.isArray(r.embed) ? TAG_FIELDS.filter((f) => r.embed.includes(f)) : [...d.embed],
    sortTags: bool(r.sortTags, d.sortTags),
    playlistAlbumInfo: bool(r.playlistAlbumInfo, d.playlistAlbumInfo),
    stripAlbumSuffix: bool(r.stripAlbumSuffix, d.stripAlbumSuffix),
    metaLang: typeof r.metaLang === 'string' && LANG_TAG.test(r.metaLang.trim()) ? r.metaLang.trim() : d.metaLang,
    coverFormat: oneOf(r.coverFormat, o.coverFormat, d.coverFormat),
    coverSize: int(r.coverSize, 100, 10000, d.coverSize),
    coverOriginal: bool(r.coverOriginal, d.coverOriginal),
    saveCover: bool(r.saveCover, d.saveCover),
    saveCoverOriginal: bool(r.saveCoverOriginal, d.saveCoverOriginal),
    // 旧版本只有一组封面设置，另存的封面沿用它
    saveCoverFormat: oneOf(r.saveCoverFormat, o.coverFormat, oneOf(r.coverFormat, o.coverFormat, d.saveCoverFormat)),
    saveCoverSize: int(r.saveCoverSize, 100, 10000, int(r.coverSize, 100, 10000, d.saveCoverSize)),
    saveLyrics: bool(r.saveLyrics, d.saveLyrics),
    lyricsFormat: oneOf(r.lyricsFormat, o.lyricsFormat, d.lyricsFormat),
    lyricsEmbedFormat: oneOf(r.lyricsEmbedFormat, o.lyricsFormat, d.lyricsEmbedFormat),
    syllable: bool(r.syllable, d.syllable),
    lyricsTranslation: bool(r.lyricsTranslation, d.lyricsTranslation),
    lyricsPronunciation: bool(r.lyricsPronunciation, d.lyricsPronunciation),
    lyricsLang: typeof r.lyricsLang === 'string' && LANG_TAG.test(r.lyricsLang.trim()) ? r.lyricsLang.trim() : d.lyricsLang,
    lyricsScript: typeof r.lyricsScript === 'string' && LANG_TAG.test(r.lyricsScript.trim()) ? r.lyricsScript.trim() : d.lyricsScript,
  };
}

function load() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch {}
  return Object.fromEntries(Object.keys(DEFAULTS).map((section) => [section, clean(section, raw[section])]));
}

let state = load();
const listeners = new Set();

function store() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function emit(section) {
  for (const fn of listeners) fn(section, get(section));
}

function get(section) {
  const value = state[section];
  return {
    ...value,
    ...(value.embed ? { embed: [...value.embed] } : {}),
    ...(value.fallbackOrder ? { fallbackOrder: Object.fromEntries(Object.entries(value.fallbackOrder).map(([k, v]) => [k, [...v]])) } : {}),
  };
}

export const prefs = {
  get,
  set(section, patch) {
    state = { ...state, [section]: clean(section, { ...state[section], ...patch }) };
    store();
    emit(section);
    return get(section);
  },
  reset(section) {
    state = { ...state, [section]: clean(section, null) };
    store();
    emit(section);
    return get(section);
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// 其他标签页修改后同步
addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  const before = JSON.stringify(state);
  state = load();
  if (JSON.stringify(state) !== before) for (const section of Object.keys(DEFAULTS)) emit(section);
});
