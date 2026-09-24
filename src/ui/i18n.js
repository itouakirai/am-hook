/*
 * am-hook 界面语言（中文 / English）
 *
 *   t(key, vars)          取当前语言文案，{name} 占位符由 vars 替换
 *   apply(root)           刷新静态文字：data-i18n（textContent）、data-i18n-html（innerHTML，仅限本文件内的可信文案）、
 *                         data-i18n-attr="title=key,aria-label=key2"（属性）
 *   setLang / toggle      切换语言并记住选择；onChange(fn) 在切换后回调，页面据此重绘动态内容
 *   [data-lang-toggle]    页面上的切换按钮，自动绑定
 * 初始语言：上次的选择，否则按浏览器语言（zh* 为中文，其余为英文）。
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'am-hook:lang';

  const dict = {
    zh: {
      'lang.button': 'EN',
      'lang.title': 'Switch to English',

      'status.checking': '检查 wrapper-lite…',
      'status.online': 'wrapper-lite 在线',
      'status.down': 'wrapper-lite 不可用',
      'footer.tagline': 'am-hook · 浏览器端解密',
      'footer.note': '仅供个人学习使用',
      'nav.home': '主页',

      'home.heading': '好音乐，值得细听。',
      'home.intro': '从一首歌开始。粘贴 Apple Music 歌曲链接，探索每一种音质，在浏览器里聆听，或下载收藏。',
      'home.formHint': '支持歌曲链接、带 ?i= 的专辑分享链接及歌曲 ID',
      'home.step1': '粘贴歌曲链接',
      'home.step2': '选择喜欢的音质',
      'home.step3': '播放，或下载收藏',
      'home.inputLabel': '歌曲链接或 ID',
      'home.submit': '探索音质',
      'home.example': '示例：',
      'home.recent': '最近解析',
      'home.clear': '清空',
      'home.invalid': '无法识别：请输入 song 链接、带 ?i= 的专辑链接或纯数字歌曲 ID。',

      'song.pageTitle': 'am-hook · 音质解析',
      'song.play': '播放',
      'song.external': '外部播放',
      'song.externalTitle': '用外部播放器播放最高音质',
      'song.reparse': '重新解析',
      'song.variants': '可用音质',
      'song.count': '{total} 个音质 · {playable} 个可在浏览器播放',
      'song.fallbackTitle': '歌曲 {id}',
      'song.noMeta': '未能获取歌曲信息',
      'song.coverAlt': '{title} 封面',
      'song.badId': '无法从链接中识别歌曲 ID。',
      'song.loading': '正在获取 master m3u8…',
      'song.parseFailed': '解析失败',
      'song.parseFailedHttp': '解析失败（HTTP {status}）',

      'q.lossless': '无损',
      'q.atmos': '杜比全景声',
      'q.binaural': '双耳',
      'q.downmix': '缩混',

      'row.play': '播放 {name}',
      'row.playTitle': '在线播放',
      'row.unsupported': '当前浏览器不支持该编码',
      'row.unsupportedTitle': '当前浏览器不支持 {codecs}，{hint}',
      'row.playable': '浏览器可播',
      'row.external': '需外部播放器',
      'row.downloadOnly': '仅可下载',
      'row.channels': '声道 {n}',
      'row.more': '更多',
      'row.moreAria': '{name} 更多操作',
      'row.cancel': '取消下载',
      'row.cancelAria': '取消下载 {name}',

      'menu.download': '下载解密文件',
      'menu.downloadHint': '浏览器内解密 · {file}',
      'menu.serverDownload': '通过服务器下载',
      'menu.serverDownloadHint': '由服务端解密，消耗服务器流量',
      'menu.players': '外部播放器',
      'menu.playersHint': '服务端解密 · 所有音质',
      'menu.morePlayers': '显示其他平台（{n}）',
      'menu.lessPlayers': '收起其他平台',
      'menu.copy': '复制地址',
      'menu.copyHint': 'M3U8 用于播放器，文件用于 IDM 等下载工具',
      'menu.copyFile': '文件',

      'toast.copiedM3u8': '已复制 media m3u8 地址',
      'toast.copiedFile': '已复制 media file 地址',
      'toast.player': '正在唤起 {name}…若没有反应，请确认已安装 {name} 并已注册对应的链接协议',

      'dl.busy': '该音质正在下载',
      'dl.preparing': '正在准备下载…',
      'dl.progress': '浏览器解密下载中 {pct}% · {done} / {total}',
      'dl.done': '解密完成，已交给浏览器保存（{size}）',
      'dl.cancelled': '已取消下载',
      'dl.failed': '下载失败：{msg}',

      'player.back': '后退 10 秒',
      'player.forward': '前进 10 秒',
      'player.play': '播放',
      'player.pause': '暂停',
      'player.seek': '播放进度',
      'player.mode': '播放方式',
      'player.volume': '音量',
      'player.unknownTitle': '未知歌曲',
      'player.direct': '直连',
      'player.pcmMode': '多声道 PCM',
      'player.pcmChannels': '{n}.1 PCM',
      'player.pcmNotice': '正在播放解码后的多声道 PCM；保留 5.1/7.1 声道，但不包含完整的 Atmos 空间音频效果。实际输出取决于设备。',
      'player.flacNotice': '当前浏览器不支持直接播放 ALAC，已在浏览器内无损转码为 FLAC 播放；下载仍保留原始 ALAC。',
      'player.hintExternal': '可在该音质的「更多」菜单中选择外部播放器播放',
      'player.hintDownload': '可下载解密文件后用本地播放器播放',
      'player.errorGeneric': '播放出错，请换一个音质，或{hint}。',
      'player.errorCodec': '当前浏览器不支持 {codecs} 编码，{hint}。',
      'player.errorFailed': '当前浏览器无法播放 {label}（{codecs}），{hint}。',
      'player.errorAutoplay': '浏览器阻止了自动播放，请点击播放按钮。',
      'player.errorAppend': 'SourceBuffer 追加失败，浏览器可能不支持该编码',

      'err.worker': '解密 Worker 出错',
      'err.template': '获取解密模板失败：{msg}',
      'err.m3u8Http': '获取 media m3u8 失败（HTTP {status}）',
      'err.m3u8Map': 'media m3u8 缺少 EXT-X-MAP BYTERANGE',
      'err.m3u8Empty': 'media m3u8 中没有可播放的分段',
      'err.m3u8Key': 'media m3u8 缺少轨道密钥信息',
      'err.segmentHttp': '分段请求失败（HTTP {status}）',
      'err.segmentLength': '分段长度不符（{got}/{want}）',
    },
    en: {
      'lang.button': '中文',
      'lang.title': '切换到中文',

      'status.checking': 'Checking wrapper-lite…',
      'status.online': 'wrapper-lite online',
      'status.down': 'wrapper-lite unavailable',
      'footer.tagline': 'am-hook · in-browser decryption',
      'footer.note': 'For personal study only',
      'nav.home': 'Home',

      'home.heading': 'Good music. Every detail.',
      'home.intro': 'Start with a song. Paste an Apple Music link, explore its audio qualities, and listen in your browser or save it for later.',
      'home.formHint': 'Song links, album links with ?i=, or a song ID',
      'home.step1': 'Paste a song link',
      'home.step2': 'Find your audio quality',
      'home.step3': 'Listen or download',
      'home.inputLabel': 'Song link or ID',
      'home.submit': 'Explore',
      'home.example': 'Example: ',
      'home.recent': 'Recent',
      'home.clear': 'Clear',
      'home.invalid': 'Unrecognized input: enter a song link, an album link with ?i=, or a numeric song ID.',

      'song.pageTitle': 'am-hook · Audio qualities',
      'song.play': 'Play',
      'song.external': 'External player',
      'song.externalTitle': 'Play the highest quality in an external player',
      'song.reparse': 'Reparse',
      'song.variants': 'Available qualities',
      'song.count': '{total} qualities · {playable} playable in browser',
      'song.fallbackTitle': 'Song {id}',
      'song.noMeta': 'Song info unavailable',
      'song.coverAlt': '{title} cover',
      'song.badId': 'Could not find a song ID in the link.',
      'song.loading': 'Fetching master m3u8…',
      'song.parseFailed': 'Parse failed',
      'song.parseFailedHttp': 'Parse failed (HTTP {status})',

      'q.lossless': 'Lossless',
      'q.atmos': 'Dolby Atmos',
      'q.binaural': 'Binaural',
      'q.downmix': 'Downmix',

      'row.play': 'Play {name}',
      'row.playTitle': 'Play in browser',
      'row.unsupported': 'Codec not supported by this browser',
      'row.unsupportedTitle': 'This browser can\'t decode {codecs}; {hint}',
      'row.playable': 'Plays in browser',
      'row.external': 'External player',
      'row.downloadOnly': 'Download only',
      'row.channels': '{n} ch',
      'row.more': 'More',
      'row.moreAria': 'More actions for {name}',
      'row.cancel': 'Cancel download',
      'row.cancelAria': 'Cancel download of {name}',

      'menu.download': 'Download decrypted file',
      'menu.downloadHint': 'Decrypted in the browser · {file}',
      'menu.serverDownload': 'Download via server',
      'menu.serverDownloadHint': 'Decrypted by the server; uses server bandwidth',
      'menu.players': 'External players',
      'menu.playersHint': 'Server-decrypted · every quality',
      'menu.morePlayers': 'Show other platforms ({n})',
      'menu.lessPlayers': 'Hide other platforms',
      'menu.copy': 'Copy URL',
      'menu.copyHint': 'M3U8 for players, file for download managers such as IDM',
      'menu.copyFile': 'File',

      'toast.copiedM3u8': 'Copied media m3u8 URL',
      'toast.copiedFile': 'Copied media file URL',
      'toast.player': 'Opening {name}… If nothing happens, make sure {name} is installed and handles its link protocol',

      'dl.busy': 'This quality is already downloading',
      'dl.preparing': 'Preparing download…',
      'dl.progress': 'Decrypting in browser {pct}% · {done} / {total}',
      'dl.done': 'Decrypted and handed to the browser to save ({size})',
      'dl.cancelled': 'Download cancelled',
      'dl.failed': 'Download failed: {msg}',

      'player.back': 'Back 10 seconds',
      'player.forward': 'Forward 10 seconds',
      'player.play': 'Play',
      'player.pause': 'Pause',
      'player.seek': 'Playback position',
      'player.mode': 'Playback method',
      'player.volume': 'Volume',
      'player.unknownTitle': 'Unknown song',
      'player.direct': 'Direct',
      'player.pcmMode': 'Multichannel PCM',
      'player.pcmChannels': '{n}.1 PCM',
      'player.pcmNotice': 'Playing decoded multichannel PCM. 5.1/7.1 channels are retained, but the full Atmos spatial experience is unavailable. Output depends on your device.',
      'player.flacNotice': 'This browser cannot play ALAC directly, so it is being converted losslessly to FLAC for playback. Downloads retain the original ALAC.',
      'player.hintExternal': 'pick an external player from that quality\'s More menu',
      'player.hintDownload': 'download the decrypted file and play it locally',
      'player.errorGeneric': 'Playback failed. Try another quality, or {hint}.',
      'player.errorCodec': 'This browser can\'t decode {codecs}; {hint}.',
      'player.errorFailed': 'This browser can\'t play {label} ({codecs}); {hint}.',
      'player.errorAutoplay': 'The browser blocked autoplay. Press play to start.',
      'player.errorAppend': 'SourceBuffer append failed; the browser may not support this codec',

      'err.worker': 'Decryption worker error',
      'err.template': 'Failed to get the decryption template: {msg}',
      'err.m3u8Http': 'Failed to fetch media m3u8 (HTTP {status})',
      'err.m3u8Map': 'media m3u8 has no EXT-X-MAP BYTERANGE',
      'err.m3u8Empty': 'media m3u8 has no playable segments',
      'err.m3u8Key': 'media m3u8 is missing the track key',
      'err.segmentHttp': 'Segment request failed (HTTP {status})',
      'err.segmentLength': 'Segment length mismatch ({got}/{want})',
    },
  };

  function detect() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && dict[saved]) return saved;
    } catch {}
    const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    return /^zh\b/i.test(prefs[0] || '') ? 'zh' : 'en';
  }

  let lang = detect();
  const listeners = new Set();

  function t(key, vars) {
    const s = dict[lang][key] ?? dict.zh[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s;
  }

  function apply(root = document) {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split('=').map((s) => s.trim());
        el.setAttribute(attr, t(key));
      }
    });
    root.querySelectorAll('[data-lang-toggle]').forEach((btn) => {
      btn.querySelector('.lang-label').textContent = t('lang.button');
      btn.title = t('lang.title');
      btn.setAttribute('aria-label', t('lang.title'));
    });
  }

  function setLang(next) {
    if (!dict[next] || next === lang) return;
    lang = next;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    apply();
    listeners.forEach((fn) => fn(lang));
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-lang-toggle]')) setLang(lang === 'zh' ? 'en' : 'zh');
  });

  global.AmI18n = {
    t,
    apply,
    setLang,
    toggle: () => setLang(lang === 'zh' ? 'en' : 'zh'),
    onChange: (fn) => listeners.add(fn),
    get lang() { return lang; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
