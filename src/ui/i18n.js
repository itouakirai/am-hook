/*
 * am-hook 界面语言（中文 / English）
 *
 *   t(key, vars)          取当前语言文案，{name} 占位符由 vars 替换
 *   apply(root)           刷新静态文字：data-i18n（textContent）、data-i18n-html（innerHTML，仅限本文件内的可信文案）、
 *                         data-i18n-attr="title=key,aria-label=key2"（属性）
 *   setLang / toggle      切换语言并记住选择；onChange(fn) 在切换后回调，页面据此重绘动态内容
 *   [data-lang-toggle]    页面上的切换按钮，自动绑定
 * 初始语言：上次的选择，否则按浏览器语言（zh* 为中文，其余为英文）。
 *
 * 主地区与曲库语言（amp-api 的 storefront 与 l，与界面语言相互独立），选择保存在 localStorage，不会过期：
 *   storefronts()         异步：全部地区 { cc: { name, tags, default } }，取自 /amp/v1/storefronts（取不到时为 null）
 *   setRegions(list)      wrapper-lite 账号所在地区（app.mjs 根据 /status 设置），regions 为当前值
 *   storefront            主地区：用户的选择，否则为 wrapper-lite 的第一个地区，否则为 us；setStorefront(cc) 修改
 *   favorites             收藏的地区（默认 us / cn / jp），在选择面板里直接列出；toggleFavorite(cc) 收藏 / 取消
 *   ampLang(cc)           该地区选定的曲库语言（未选择时为 null，即地区默认语言）；setAmpLang(cc, tag) 修改
 *   catalogLang(cc)       异步：请求该地区 amp-api 用的 l：选定的语言，否则为地区默认语言（取不到地区信息时为 undefined）
 *   onSettingsChange(fn)  主地区、收藏或曲库语言变化后回调 fn({ kind: 'storefront' | 'favorites' | 'ampLang', cc })
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'am-hook:lang';

  const dict = {
    zh: {
      "mv.preview": "视频预览",
      "mv.quality": "画质与音轨",
      "mv.custom": "自由组合",
      "mv.unavailable": "暂无可用轨道",
      "mv.failed": "MV 加载失败",
      "mv.play": "播放所选轨道",
      "mv.download": "下载 MP4",
      "mv.cancel": "取消",
      "mv.save": "保存 MP4",
      "mv.hint": "选择视频和音频轨道。下载会在浏览器内逐段处理并合并为 MP4。",
      "mv.video": "视频轨道",
      "mv.audio": "音频轨道",
      "mv.loading": "正在解析 MV…",
      "mv.ready": "已就绪，请选择轨道后播放或下载。",
      "mv.license": "正在准备音视频轨道…",
      "mv.buffering": "正在缓冲…",
      "mv.playing": "播放已就绪",
      "mv.pressPlay": "请点击视频中的播放按钮",
      "mv.downloading": "下载中 {percent}% · {size} MB",
      "mv.defrag": "正在整理为标准 MP4…",
      "mv.complete": "MP4 已生成，可点击“保存 MP4”再次保存。",
      "mv.cancelled": "已取消",
      "mv.downloadOnly": "当前浏览器仅支持下载",
      "mv.channels": "声道",
      "mv.recommended": "视频推荐",
      "mv.postKind": "视频",
      "mv.postQuality": "画质",
      "mv.postHint": "艺人上传的视频是未加密的 MP4（含音频），与官网一样直接播放；下载时原样保存，不需要解密。",
      "mv.postUnavailable": "这个视频没有可播放的文件",

      'lang.caption': '界面语言',
      'lang.button': '中文',
      'lang.title': 'Switch to English',

      'settings.storefront': '主地区',
      'settings.storefrontHint': '用于搜索等功能。选择 wrapper-lite 账号所在地区可获得最佳体验。',
      'settings.best': 'wrapper-lite 地区 · 最佳体验',
      'settings.outside': '非 wrapper-lite 地区：可以搜索与浏览，部分内容可能无法播放。',
      'settings.selected': '当前选择',
      'settings.favorites': '收藏的地区',
      'settings.favorite': '收藏“{name}”',
      'settings.unfavorite': '取消收藏“{name}”',
      'settings.more': '更多地区',
      'settings.less': '收起',
      'settings.filter': '筛选地区',
      'settings.noMatch': '没有匹配的地区',
      'settings.ampLang': '曲库语言',
      'settings.ampLangHint': '{storefront}的歌曲、专辑、艺人等信息所用的语言（Apple Music 提供的可选语言）。',
      'settings.default': '默认',
      'settings.loading': '正在获取地区列表…',
      'settings.failed': '无法获取地区列表。',
      'settings.retry': '重试',
      'settings.close': '关闭',
      'settings.wrapper': 'wrapper-lite',
      'wrapper.hint': '解密模板、歌词、MV 的 license 等请求所用的 wrapper-lite。',
      'wrapper.server': '服务端',
      'wrapper.serverSub': '经 am-hook 转发，限制与鉴权见启动参数',
      'wrapper.local': '本地',
      'wrapper.localSub': '由浏览器直接请求你自己的 wrapper-lite',
      'wrapper.url': '地址',
      'wrapper.rate': '每秒请求数上限',
      'wrapper.concurrency': '同时请求数上限',
      'wrapper.zero': '0 表示不限，只作用于当前页面',
      'wrapper.authPlaceholder': '不发送',
      'wrapper.authSub': '只填 token 时自动加上“Bearer ”前缀',
      'wrapper.cors': '请求由浏览器直接发出：填写的 wrapper-lite 需允许跨源请求（CORS，填了 Authorization 时还需允许该请求头），或在浏览器中安装解除跨域限制的插件。MV 的 master 播放列表仍由 am-hook 获取。',
      'wrapper.save': '保存并检测',
      'wrapper.checking': '正在检测…',
      'wrapper.ok': '已连接 · {count} 个地区',
      'wrapper.failed': '无法使用：{msg}',
      'wrapper.badAuth': 'Authorization 含有不能放进请求头的字符',
      'wrapper.badUrl': '请填写以 http:// 或 https:// 开头的地址',
      'wrapper.badNumber': '上限须为不小于 0 的整数',
      'wrapper.noUrl': '没有填写本地 wrapper-lite 的地址',
      'wrapper.unreachable': '无法连接 {url}（未运行、地址有误或不允许跨源请求）',
      'wrapper.invalid': 'wrapper-lite 返回的不是 JSON',
      'wrapper.noMaster': 'wrapper-lite 没有返回 m3u8 地址',

      'status.checking': '检查中…',
      'status.online': '在线',
      'status.down': '不可用',
      'status.region': '{count} 个地区',
      'status.regions': '{count} 个地区',
      'status.more': '另外 {count} 个地区',
      'status.expand': '展开全部地区',
      'status.collapse': '收起地区',
      'status.current': '当前主地区',
      'footer.tagline': 'am-hook · 浏览器端解密',
      'footer.note': '仅供个人学习使用',
      'footer.github': '在 GitHub 上查看',
      'footer.thanks': '致谢以下开源项目：',
      'nav.home': '主页',
      'nav.new': '新发现',
      'nav.charts': '排行榜',
      'nav.back': '返回',
      'nav.menu': '菜单',
      'nav.label': '导航',

      'home.inputLabel': '搜索，或输入歌曲 / MV 链接',
      'home.placeholder': '在此搜索或粘贴Apple Music链接',
      'home.submit': '解析',
      'home.search': '搜索',
      'home.empty': '请输入关键词或链接。',
      'search.results': '“{term}” 的搜索结果',
      'search.top': '最佳结果',
      'search.songs': '歌曲',
      'search.mvs': '音乐视频',
      'search.more': '加载更多',
      'search.loading': '正在搜索…',
      'search.none': '没有找到相关的歌曲或音乐视频。',
      'search.failed': '搜索失败：{msg}',
      'search.storefront': '地区',
      'search.close': '关闭',
      'search.explicit': '含不当内容',
      'search.albums': '专辑',
      'search.playlists': '歌单',
      'search.artists': '艺人',
      'search.placeholder': '搜索',
      'search.all': '全部',
      'search.seeAll': '查看全部',
      'home.example': '已支持链接示例',
      'home.recent': '最近搜索',
      'home.removeRecent': '删除“{term}”',
      'home.clear': '清空',
      'home.invalid': '无法识别：请输入歌曲、MV 或专辑链接。',
      'home.detectSong': '歌曲',
      'home.detectMv': 'MV',
      'home.detectPost': '视频',
      'home.detectAlbum': '专辑',
      'home.detectPlaylist': '歌单',
      'home.detectArtist': '艺人',
      'home.detectRoom': '精选',
      'home.detectGrouping': '分类',
      'home.detectCurator': '策展人',
      'home.detectNew': '新发现',
      'album.pageTitle': 'am-hook · 专辑',
      'album.loading': '正在载入专辑…',
      'album.failed': '专辑加载失败：{msg}',
      'album.badId': '无效的专辑链接。',
      'album.play': '播放',
      'album.shuffle': '随机播放',
      'album.more': '更多',
      'album.less': '收起',
      'album.disc': '碟 {n}',
      'album.songs': '{n} 首歌曲',
      'album.videos': '{n} 个视频',
      'album.minutes': '{n} 分钟',
      'album.hours': '{h} 小时 {m} 分钟',
      'album.popular': '热门',
      'album.playTrack': '播放 {name}',
      'album.quality': '音质与下载',
      'album.video': '音乐视频',
      'album.trackFailed': '无法播放《{name}》：{msg}',
      'album.noPlayable': '《{name}》没有浏览器可直接播放的音质，请打开歌曲页下载。',
      'album.coverAlt': '《{title}》封面',
      'action.play': '播放',
      'action.shuffle': '随机播放',
      'action.more': '更多',
      'action.moreFor': '更多 · {name}',
      'action.playMv': '播放音乐视频',
      'action.goAlbum': '前往专辑',
      'action.copySite': '复制本站链接',
      'action.copyApple': '复制 AM 链接',
      'action.copied': '已复制链接',
      'action.noSongs': '《{name}》里没有可播放的歌曲',
      'action.failed': '无法播放：{msg}',
      'playlist.pageTitle': 'am-hook · 歌单',
      'playlist.loading': '正在载入歌单…',
      'playlist.failed': '歌单加载失败：{msg}',
      'playlist.badId': '无效的歌单链接。',
      'playlist.updated': '更新于 {date}',
      'nav.library': '资料库',
      'nav.playlists': '歌单',
      'library.pageTitle': 'am-hook · 资料库',
      'library.recently-added': '最近添加',
      'library.artists': '艺人',
      'library.albums': '专辑',
      'library.songs': '歌曲',
      'library.music-videos': '音乐视频',
      'library.all-playlists': '所有歌单',
      'library.filter': '筛选',
      'library.sortBy': '排序方式',
      'library.sort.recent': '最近添加',
      'library.sort.title': '标题',
      'library.sort.artist': '艺人',
      'library.sort.album': '专辑',
      'library.sort.duration': '时长',
      'library.menu': '资料库选项',
      'library.empty.recently-added': '资料库还是空的',
      'library.empty.artists': '资料库里还没有艺人',
      'library.empty.albums': '资料库里还没有专辑',
      'library.empty.songs': '资料库里还没有歌曲',
      'library.empty.music-videos': '资料库里还没有音乐视频',
      'library.empty.all-playlists': '还没有歌单',
      'library.emptyHint': '在歌曲、专辑或歌单的「更多」菜单中选择「添加到资料库」。资料库只保存在这个浏览器中，可以导出备份。',
      'library.emptyPlaylistsHint': '新建歌单，或把 Apple Music 歌单添加到资料库。',
      'library.noMatch': '没有与「{q}」匹配的内容',
      'library.memoryOnly': '这个浏览器不允许保存资料库（例如隐私模式），关闭标签页后资料库与歌单会丢失，请及时导出。',
      'library.goArtist': '前往艺人页',
      'library.add': '添加到资料库',
      'library.remove': '从资料库中删除',
      'library.inLibrary': '已在资料库中（点按删除）',
      'library.addedToLibrary': '已将「{name}」添加到资料库',
      'library.removedFrom': '已将「{name}」从资料库中删除',
      'library.addToPlaylist': '添加到歌单',
      'library.newPlaylist': '新建歌单',
      'library.newPlaylistEllipsis': '新建歌单…',
      'library.untitled': '未命名歌单',
      'library.playlistName': '名称',
      'library.description': '描述',
      'library.descriptionHint': '添加描述（可选）',
      'library.create': '创建',
      'library.save': '保存',
      'library.cancel': '取消',
      'library.edit': '编辑',
      'library.editEllipsis': '编辑…',
      'library.editPlaylist': '编辑歌单',
      'library.duplicate': '复制歌单',
      'library.copySuffix': '副本',
      'library.created': '已创建「{name}」',
      'library.addedTo': '已将 {n} 首添加到「{name}」',
      'library.alreadyIn': '「{name}」中已有这些曲目',
      'library.nothingToAdd': '没有可以添加的曲目',
      'library.failed': '操作失败：{msg}',
      'library.songCount': '{n} 首',
      'library.localPlaylist': '我的歌单',
      'library.emptyPlaylist': '这个歌单还没有曲目',
      'library.emptyPlaylistHint': '在歌曲、专辑或歌单的「更多」菜单中选择「添加到歌单」。',
      'library.removeFromPlaylist': '从歌单中删除',
      'library.moveHandle': '拖动以排序（也可以按 ↑ / ↓）',
      'library.moveTrack': '移动 {name}（第 {pos} / {total} 首），按 ↑ / ↓ 调整顺序',
      'library.notFoundTitle': '找不到歌单',
      'library.notFound': '这个歌单不在本浏览器的资料库中（可能已删除，或是在其他浏览器中创建的）。可以在原浏览器中导出歌单后在这里导入。',
      'library.deletePlaylistEllipsis': '删除歌单…',
      'library.deleteTitle': '删除歌单「{name}」？',
      'library.deleteMessage': '歌单将从这个浏览器中删除，资料库中的歌曲不受影响。此操作无法撤销。',
      'library.delete': '删除',
      'library.deleted': '已删除「{name}」',
      'library.exportLibrary': '导出资料库',
      'library.exportHint': '资料库与全部歌单，保存为 JSON 文件',
      'library.exportPlaylist': '导出歌单',
      'library.exported': '已导出 {items} 个资料库条目、{playlists} 个歌单、{folders} 个文件夹',
      'library.importMenu': '导入…',
      'library.importMenuHint': '导入资料库或歌单文件',
      'library.import': '导入',
      'library.importTitle': '导入「{name}」',
      'library.importSummary': '包含 {items} 个资料库条目、{playlists} 个歌单（共 {tracks} 首曲目）、{folders} 个文件夹。',
      'library.importDropped': '{n} 条无效内容将被跳过。',
      'library.importHint': '「合并」保留现有内容并加入文件中的条目；「替换」先清空现有的资料库与歌单。',
      'library.importMerge': '合并',
      'library.importReplace': '替换',
      'library.imported': '已导入 {items} 个资料库条目、{playlists} 个歌单、{folders} 个文件夹',
      'library.importFormat': '这不是 am-hook 资料库或歌单文件',
      'library.importVersion': '文件来自更新版本的 am-hook，请先升级',
      'library.importEmpty': '文件中没有可以导入的内容',
      'library.clearMenu': '清空资料库…',
      'library.clearTitle': '清空资料库？',
      'library.clearMessage': '将删除这个浏览器中的全部资料库条目与歌单，此操作无法撤销。建议先导出备份。',
      'library.clear': '清空',
      'library.cleared': '资料库已清空',
      'library.favorite': '喜爱',
      'library.unfavorite': '取消喜爱',
      'library.favorited': '已喜爱',
      'library.favoritedName': '已喜爱「{name}」，并已添加到资料库',
      'library.unfavoritedName': '已取消喜爱「{name}」',
      'library.favorites': '喜爱',
      'library.favoritesOnly': '只显示喜爱的项目',
      'library.favoriteSongs': '喜爱的歌曲',
      'library.autoPlaylist': '自动更新',
      'library.noFavorites': '还没有喜爱的项目',
      'library.noFavoritesHint': '在「更多」菜单或详情页的 ☆ 中选择「喜爱」。',
      'library.emptyFavorites': '还没有喜爱的歌曲',
      'library.emptyFavoritesHint': '在歌曲的「更多」菜单中选择「喜爱」，歌曲会出现在这里并加入资料库。',
      'library.saveAsPlaylist': '存储为歌单',
      'library.new': '新建',
      'library.newFolder': '新建歌单文件夹',
      'library.newFolderEllipsis': '新建歌单文件夹…',
      'library.folderName': '名称',
      'library.untitledFolder': '未命名文件夹',
      'library.renameFolder': '重命名文件夹',
      'library.renameFolderEllipsis': '重命名…',
      'library.deleteFolderEllipsis': '删除文件夹…',
      'library.deleteFolderTitle': '删除文件夹「{name}」？',
      'library.deleteFolderMessage': '文件夹中的 {playlists} 个歌单与 {folders} 个子文件夹将一并删除（Apple Music 歌单从资料库中移除），此操作无法撤销。',
      'library.deleteEmptyFolderMessage': '这个文件夹是空的，删除后无法撤销。',
      'library.exportFolder': '导出文件夹',
      'library.moveToFolder': '移到文件夹',
      'library.movedTo': '已移到「{name}」',
      'library.topLevel': '歌单（最上层）',
      'library.currentLocation': '当前位置',
      'library.folderCount': '{n} 个歌单',
      'library.folderNotFound': '找不到文件夹',
      'library.folderNotFoundHint': '这个文件夹不在本浏览器的资料库中（可能已删除）。',
      'library.empty.playlist-folder': '文件夹是空的',
      'library.emptyFolderHint': '把歌单拖到侧边栏的这个文件夹上，或在歌单的「更多」菜单中选择「移到文件夹」。',
      'library.expandFolder': '展开 {name}',
      'library.collapseFolder': '收起 {name}',
      'artist.pageTitle': 'am-hook · 艺人',
      'artist.loading': '正在载入艺人…',
      'artist.failed': '艺人加载失败：{msg}',
      'artist.badId': '无效的艺人链接。',
      'artist.seeAll': '显示全部',
      'artist.about': '关于 {name}',
      'artist.hometown': '家乡',
      'artist.origin': '发源地',
      'artist.born': '出生日期',
      'artist.formed': '成立时间',
      'artist.genre': '流派',
      'artist.portraitAlt': '{name} 的照片',
      'artist.openInApple': '在 Apple Music 中查看 {name}',
      'browse.loading': '正在载入…',
      'browse.failed': '加载失败：{msg}',
      'browse.empty': '这里暂时没有内容。',
      'browse.badId': '无效的链接。',
      'browse.prev': '上一页',
      'browse.next': '下一页',
      'browse.seeAll': '查看全部 · {name}',
      'browse.playlists': '歌单',
      'browse.loadMore': '正在载入更多…',
      'browse.openInApple': '在 Apple Music 中打开',
      'browse.external': '在 Apple Music 中打开（外部链接）',
      'charts.title': '排行榜',
      'charts.genre': '类型',
      'charts.allGenres': '所有类型',
      'charts.genreTitle.songs': '热门{genre}歌曲',
      'charts.genreTitle.albums': '热门{genre}专辑',
      'charts.genreTitle.music-videos': '热门{genre}视频',
      'home.tagAtmos': '空间音频',
      'home.tagAac': '通用',
      'home.tagMv': '视频',
      'home.fmtAlac': '最高 24-bit / 192 kHz，逐比特还原录音室母带。',
      'home.fmtAtmos': 'EC-3 多声道，浏览器内解码播放。',
      'home.fmtAac': '256 kbps 立体声，兼容性最好。',
      'home.fmtMv': '自选画质与音轨，合并下载为 MP4。',

      'song.pageTitle': 'am-hook · 音质解析',
      'song.play': '播放',
      'song.reparse': '重新解析',
      'song.variants': '可用音质',
      'song.count': '{total} 个音质 · {playable} 个可在浏览器播放',
      'song.fallbackTitle': '歌曲 {id}',
      'song.noMeta': '未能获取歌曲信息',
      'song.coverAlt': '{title} 封面',
      'song.badId': '无法从链接中识别歌曲 ID。',
      'song.loading': '正在获取 master m3u8…',
      'song.parseFailed': '解析失败',

      'q.lossless': '无损',
      'q.atmos': '杜比全景声',
      'q.binaural': '双耳',
      'q.downmix': '缩混',

      'row.play': '播放 {name}',
      'row.playTitle': '在线播放',
      'row.unsupported': '当前浏览器不支持该编码',
      'row.unsupportedTitle': '当前浏览器不支持 {codecs}，{hint}',
      'row.playable': '浏览器可播',
      'row.downloadOnly': '仅可下载',
      'row.channels': '声道 {n}',
      'row.more': '更多',
      'row.moreAria': '{name} 更多操作',
      'row.cancel': '取消下载',
      'row.cancelAria': '取消下载 {name}',

      'menu.download': '下载解密文件',
      'menu.downloadHint': '浏览器内解密 · {file}',


      'dl.busy': '该音质正在下载',
      'dl.preparing': '正在准备下载…',
      'dl.progress': '浏览器解密下载中 {pct}% · {done} / {total}',
      'dl.defrag': '正在整理为标准 MP4…',
      'dl.done': '解密完成，已交给浏览器保存（{size}）',
      'dl.cancelled': '已取消下载',
      'dl.failed': '下载失败：{msg}',

      'player.previous': '上一首',
      'player.next': '下一首',
      'player.shuffle': '随机播放',
      'player.repeat.off': '重复播放',
      'player.repeat.all': '重复播放：全部',
      'player.repeat.one': '重复播放：单曲',
      'player.play': '播放',
      'player.pause': '暂停',
      'player.seek': '播放进度',
      'player.mode': '播放方式',
      'player.volume': '音量',
      'player.unknownTitle': '未知歌曲',
      'player.pcmMode': '多声道 PCM',
      'player.pcmChannels': '{n}.1 PCM',
      'player.pcmNotice': '正在播放解码后的多声道 PCM；保留 5.1/7.1 声道，但不包含完整的 Atmos 空间音频效果。实际输出取决于设备。',
      'player.flacNotice': '当前浏览器不支持直接播放 ALAC，已在浏览器内无损转码为 FLAC 播放；下载仍保留原始 ALAC。',
      'player.hintDownload': '可下载解密文件后用本地播放器播放',
      'player.errorGeneric': '播放出错，请换一个音质，或{hint}。',
      'player.errorCodec': '当前浏览器不支持 {codecs} 编码，{hint}。',
      'player.errorFailed': '当前浏览器无法播放 {label}（{codecs}），{hint}。',
      'player.errorAutoplay': '浏览器阻止了自动播放，请点击播放按钮。',
      'player.errorAppend': 'SourceBuffer 追加失败，浏览器可能不支持该编码',
      'player.queue': '待播清单',
      'player.queueClear': '清除',
      'player.queueEmpty': '没有待播的歌曲。在专辑、歌单或艺人页开始播放后，后续歌曲会列在这里。',
      'player.queueHint': '双击播放，拖动调整顺序（也可按 Alt+↑/↓），Delete 移除',
      'player.queueRemove': '从待播清单移除「{name}」',

      'lyrics.title': '歌词',
      'lyrics.open': '歌词',
      'lyrics.close': '收起歌词',
      'lyrics.show': '显示歌词',
      'lyrics.hide': '隐藏歌词',
      'lyrics.translationMenu': '歌词选项',
      'lyrics.showTranslation': '显示翻译',
      'lyrics.hideTranslation': '隐藏翻译',
      'lyrics.showPronunciation': '显示发音',
      'lyrics.hidePronunciation': '隐藏发音',
      'lyrics.follow': '回到当前歌词',
      'lyrics.credits': '创作者：',
      'lyrics.creditsSeparator': '、',
      'lyrics.aiTranslation': '翻译由 AI 生成',
      'lyrics.none': '这首歌没有歌词',
      'lyrics.failed': '歌词加载失败，请稍后重试',
      'lyrics.fontSize': '字号',
      'lyrics.fontSmaller': '缩小歌词',
      'lyrics.fontLarger': '放大歌词',
      'lyrics.fontWeight': '字重',
      'lyrics.weightLighter': '减细',
      'lyrics.weightBolder': '加粗',
      'lyrics.weight300': '细体',
      'lyrics.weight400': '常规',
      'lyrics.weight500': '中等',
      'lyrics.weight600': '中粗',
      'lyrics.weight700': '粗体',
      'lyrics.weight800': '特粗',
      'lyrics.source': '歌词来源',
      'lyrics.sourceApple': 'Apple Music',
      'lyrics.sourceAmll': 'AMLL 歌词库',
      'lyrics.backdrop': '背景',
      'lyrics.backdropAmll': 'AMLL 流动背景',
      'lyrics.backdropClassic': '经典背景',
      'lyrics.amllMissing': 'AMLL 歌词库未收录这首歌，正在显示 Apple Music 的歌词',
      'lyrics.amllFailed': '无法连接 AMLL 歌词库，正在显示 Apple Music 的歌词',
      'lyrics.appleMissing': 'Apple Music 没有这首歌的歌词，正在显示 AMLL 歌词库的歌词',
      'lyrics.amllCredit': '歌词来自 AMLL 歌词库，制作者：{authors}',
      'lyrics.amllCreditAnon': '歌词来自 AMLL 歌词库',
      'lyrics.download': '下载 TTML 歌词',

      'err.worker': '解密 Worker 出错',
      'err.defrag': '解碎片失败：{msg}',
      'err.template': '获取解密模板失败：{msg}',
      'err.m3u8Http': '获取 media m3u8 失败（HTTP {status}）',
      'err.m3u8Map': 'media m3u8 缺少 EXT-X-MAP BYTERANGE',
      'err.m3u8Empty': 'media m3u8 中没有可播放的分段',
      'err.m3u8Key': 'media m3u8 缺少轨道密钥信息',
      'err.segmentHttp': '分段请求失败（HTTP {status}）',
      'err.segmentLength': '分段长度不符（{got}/{want}）',
    },
    en: {
      "mv.preview": "Video preview",
      "mv.quality": "Video & audio quality",
      "mv.custom": "Mix & match",
      "mv.unavailable": "No tracks available",
      "mv.failed": "Unable to load music video",
      "mv.play": "Play selected tracks",
      "mv.download": "Download MP4",
      "mv.cancel": "Cancel",
      "mv.save": "Save MP4",
      "mv.hint": "Choose video and audio tracks. Downloads are processed segment by segment and merged into MP4 in your browser.",
      "mv.video": "Video tracks",
      "mv.audio": "Audio tracks",
      "mv.loading": "Loading music video…",
      "mv.ready": "Ready. Choose tracks to play or download.",
      "mv.license": "Preparing video and audio…",
      "mv.buffering": "Buffering…",
      "mv.playing": "Ready to play",
      "mv.pressPlay": "Press play in the video controls",
      "mv.downloading": "Downloading {percent}% · {size} MB",
      "mv.defrag": "Converting to progressive MP4…",
      "mv.complete": "MP4 is ready. Use Save MP4 to save it again.",
      "mv.cancelled": "Cancelled",
      "mv.downloadOnly": "Download only in this browser",
      "mv.channels": "channels",
      "mv.recommended": "Recommended for video",
      "mv.postKind": "VIDEO",
      "mv.postQuality": "Video quality",
      "mv.postHint": "Artist-uploaded videos are unencrypted MP4 files with audio. They play directly like on music.apple.com and download as-is, without decryption.",
      "mv.postUnavailable": "This video has no playable files",

      'lang.caption': 'Interface',
      'lang.button': 'English',
      'lang.title': '切换到中文',

      'settings.storefront': 'Primary storefront',
      'settings.storefrontHint': 'Used for search and more. Storefronts of the wrapper-lite account give the best experience.',
      'settings.best': 'wrapper-lite storefronts · best experience',
      'settings.outside': 'Not a wrapper-lite storefront: search and browsing work, some content may not play.',
      'settings.selected': 'Selected',
      'settings.favorites': 'Favorites',
      'settings.favorite': 'Add “{name}” to favorites',
      'settings.unfavorite': 'Remove “{name}” from favorites',
      'settings.more': 'More storefronts',
      'settings.less': 'Show less',
      'settings.filter': 'Filter storefronts',
      'settings.noMatch': 'No matching storefronts',
      'settings.ampLang': 'Catalog language',
      'settings.ampLangHint': 'Language of song, album and artist info in {storefront} (as offered by Apple Music).',
      'settings.default': 'Default',
      'settings.loading': 'Loading storefronts…',
      'settings.failed': 'Could not load storefronts.',
      'settings.retry': 'Retry',
      'settings.close': 'Close',
      'settings.wrapper': 'wrapper-lite',
      'wrapper.hint': 'The wrapper-lite used for decryption templates, lyrics, MV licenses and more.',
      'wrapper.server': 'Server',
      'wrapper.serverSub': 'Relayed by am-hook; limits and Authorization come from its options',
      'wrapper.local': 'Local',
      'wrapper.localSub': 'The browser requests your own wrapper-lite directly',
      'wrapper.url': 'URL',
      'wrapper.rate': 'Max requests per second',
      'wrapper.concurrency': 'Max concurrent requests',
      'wrapper.zero': '0 = unlimited; applies to this page only',
      'wrapper.authPlaceholder': 'Not sent',
      'wrapper.authSub': 'A bare token is sent as “Bearer <token>”',
      'wrapper.cors': 'Requests are sent by the browser: this wrapper-lite must allow cross-origin requests (CORS, including the Authorization header if set), or install a browser extension that lifts CORS restrictions. MV master playlists are still fetched by am-hook.',
      'wrapper.save': 'Save and check',
      'wrapper.checking': 'Checking…',
      'wrapper.ok': 'Connected · {count} storefronts',
      'wrapper.failed': 'Unavailable: {msg}',
      'wrapper.badAuth': 'Authorization contains characters not allowed in a header',
      'wrapper.badUrl': 'Enter a URL starting with http:// or https://',
      'wrapper.badNumber': 'Limits must be whole numbers, 0 or more',
      'wrapper.noUrl': 'No local wrapper-lite URL set',
      'wrapper.unreachable': 'Could not reach {url} (not running, wrong URL, or cross-origin requests not allowed)',
      'wrapper.invalid': 'wrapper-lite did not return JSON',
      'wrapper.noMaster': 'wrapper-lite returned no m3u8 URL',

      'status.checking': 'Checking…',
      'status.online': 'Online',
      'status.down': 'Unavailable',
      'status.region': '{count} region',
      'status.regions': '{count} regions',
      'status.more': '{count} more regions',
      'status.expand': 'Show all regions',
      'status.collapse': 'Collapse regions',
      'status.current': 'Current storefront',
      'footer.tagline': 'am-hook · in-browser decryption',
      'footer.note': 'For personal study only',
      'footer.github': 'View on GitHub',
      'footer.thanks': 'Thanks to these open-source projects:',
      'nav.home': 'Home',
      'nav.new': 'New',
      'nav.charts': 'Top Charts',
      'nav.back': 'Back',
      'nav.menu': 'Menu',
      'nav.label': 'Navigation',

      'home.inputLabel': 'Search, or enter a song / MV link',
      'home.placeholder': 'Search or paste an Apple Music link here',
      'home.submit': 'Parse',
      'home.search': 'Search',
      'home.empty': 'Enter a keyword or a link.',
      'search.results': 'Results for “{term}”',
      'search.top': 'Top Results',
      'search.songs': 'Songs',
      'search.mvs': 'Music Videos',
      'search.more': 'Load more',
      'search.loading': 'Searching…',
      'search.none': 'No songs or music videos found.',
      'search.failed': 'Search failed: {msg}',
      'search.storefront': 'Storefront',
      'search.close': 'Close',
      'search.explicit': 'Explicit',
      'search.albums': 'Albums',
      'search.playlists': 'Playlists',
      'search.artists': 'Artists',
      'search.placeholder': 'Search',
      'search.all': 'All',
      'search.seeAll': 'See All',
      'home.example': 'Supported link examples',
      'home.recent': 'Recent Searches',
      'home.removeRecent': 'Remove “{term}”',
      'home.clear': 'Clear',
      'home.invalid': 'Unrecognized input: enter a song, music-video or album link.',
      'home.detectSong': 'Song',
      'home.detectMv': 'MV',
      'home.detectPost': 'Video',
      'home.detectAlbum': 'Album',
      'home.detectPlaylist': 'Playlist',
      'home.detectArtist': 'Artist',
      'home.detectRoom': 'Collection',
      'home.detectGrouping': 'Category',
      'home.detectCurator': 'Curator',
      'home.detectNew': 'New',
      'album.pageTitle': 'am-hook · Album',
      'album.loading': 'Loading album…',
      'album.failed': 'Failed to load album: {msg}',
      'album.badId': 'Invalid album link.',
      'album.play': 'Play',
      'album.shuffle': 'Shuffle',
      'album.more': 'MORE',
      'album.less': 'LESS',
      'album.disc': 'Disc {n}',
      'album.songs': '{n} songs',
      'album.videos': '{n} videos',
      'album.minutes': '{n} minutes',
      'album.hours': '{h} hr {m} min',
      'album.popular': 'Popular',
      'album.playTrack': 'Play {name}',
      'album.quality': 'Qualities & download',
      'album.video': 'Music video',
      'album.trackFailed': 'Cannot play “{name}”: {msg}',
      'album.noPlayable': '“{name}” has no quality this browser can play directly; open the song page to download it.',
      'album.coverAlt': 'Cover of {title}',
      'action.play': 'Play',
      'action.shuffle': 'Shuffle',
      'action.more': 'More',
      'action.moreFor': 'More · {name}',
      'action.playMv': 'Play music video',
      'action.goAlbum': 'Go to album',
      'action.copySite': 'Copy am-hook link',
      'action.copyApple': 'Copy AM link',
      'action.copied': 'Link copied',
      'action.noSongs': '“{name}” has no playable songs',
      'action.failed': 'Cannot play: {msg}',
      'playlist.pageTitle': 'am-hook · Playlist',
      'playlist.loading': 'Loading playlist…',
      'playlist.failed': 'Failed to load playlist: {msg}',
      'playlist.badId': 'Invalid playlist link.',
      'playlist.updated': 'Updated {date}',
      'nav.library': 'Library',
      'nav.playlists': 'Playlists',
      'library.pageTitle': 'am-hook · Library',
      'library.recently-added': 'Recently Added',
      'library.artists': 'Artists',
      'library.albums': 'Albums',
      'library.songs': 'Songs',
      'library.music-videos': 'Music Videos',
      'library.all-playlists': 'All Playlists',
      'library.filter': 'Filter',
      'library.sortBy': 'Sort by',
      'library.sort.recent': 'Recently Added',
      'library.sort.title': 'Title',
      'library.sort.artist': 'Artist',
      'library.sort.album': 'Album',
      'library.sort.duration': 'Duration',
      'library.menu': 'Library options',
      'library.empty.recently-added': 'Your library is empty',
      'library.empty.artists': 'No artists in your library yet',
      'library.empty.albums': 'No albums in your library yet',
      'library.empty.songs': 'No songs in your library yet',
      'library.empty.music-videos': 'No music videos in your library yet',
      'library.empty.all-playlists': 'No playlists yet',
      'library.emptyHint': 'Choose “Add to Library” from the More menu of a song, album or playlist. Your library is stored only in this browser; export it to keep a backup.',
      'library.emptyPlaylistsHint': 'Create a playlist, or add an Apple Music playlist to your library.',
      'library.noMatch': 'Nothing matches “{q}”',
      'library.memoryOnly': 'This browser does not allow saving the library (for example in private browsing). Your library and playlists will be lost when this tab closes, so export them.',
      'library.goArtist': 'Go to artist',
      'library.add': 'Add to Library',
      'library.remove': 'Delete from Library',
      'library.inLibrary': 'In your library (click to delete)',
      'library.addedToLibrary': 'Added “{name}” to your library',
      'library.removedFrom': 'Deleted “{name}” from your library',
      'library.addToPlaylist': 'Add to Playlist',
      'library.newPlaylist': 'New Playlist',
      'library.newPlaylistEllipsis': 'New Playlist…',
      'library.untitled': 'Untitled Playlist',
      'library.playlistName': 'Name',
      'library.description': 'Description',
      'library.descriptionHint': 'Add a description (optional)',
      'library.create': 'Create',
      'library.save': 'Save',
      'library.cancel': 'Cancel',
      'library.edit': 'Edit',
      'library.editEllipsis': 'Edit…',
      'library.editPlaylist': 'Edit Playlist',
      'library.duplicate': 'Duplicate Playlist',
      'library.copySuffix': 'Copy',
      'library.created': 'Created “{name}”',
      'library.addedTo': 'Added {n} to “{name}”',
      'library.alreadyIn': 'Already in “{name}”',
      'library.nothingToAdd': 'Nothing to add',
      'library.failed': 'Something went wrong: {msg}',
      'library.songCount': '{n} songs',
      'library.localPlaylist': 'My Playlist',
      'library.emptyPlaylist': 'This playlist is empty',
      'library.emptyPlaylistHint': 'Choose “Add to Playlist” from the More menu of a song, album or playlist.',
      'library.removeFromPlaylist': 'Remove from Playlist',
      'library.moveHandle': 'Drag to reorder (or press ↑ / ↓)',
      'library.moveTrack': 'Move {name} ({pos} of {total}); press ↑ / ↓ to reorder',
      'library.notFoundTitle': 'Playlist not found',
      'library.notFound': 'This playlist is not in this browser’s library (it may have been deleted, or created in another browser). Export it there and import it here.',
      'library.deletePlaylistEllipsis': 'Delete Playlist…',
      'library.deleteTitle': 'Delete “{name}”?',
      'library.deleteMessage': 'The playlist will be deleted from this browser. Songs in your library are not affected. This cannot be undone.',
      'library.delete': 'Delete',
      'library.deleted': 'Deleted “{name}”',
      'library.exportLibrary': 'Export Library',
      'library.exportHint': 'Library and all playlists as a JSON file',
      'library.exportPlaylist': 'Export Playlist',
      'library.exported': 'Exported {items} library items, {playlists} playlists and {folders} folders',
      'library.importMenu': 'Import…',
      'library.importMenuHint': 'Import a library or playlist file',
      'library.import': 'Import',
      'library.importTitle': 'Import “{name}”',
      'library.importSummary': 'Contains {items} library items, {playlists} playlists ({tracks} tracks) and {folders} folders.',
      'library.importDropped': '{n} invalid entries will be skipped.',
      'library.importHint': 'Merge keeps what you have and adds the file’s entries. Replace clears your library and playlists first.',
      'library.importMerge': 'Merge',
      'library.importReplace': 'Replace',
      'library.imported': 'Imported {items} library items, {playlists} playlists and {folders} folders',
      'library.importFormat': 'This is not an am-hook library or playlist file',
      'library.importVersion': 'This file comes from a newer am-hook. Upgrade first.',
      'library.importEmpty': 'Nothing to import in this file',
      'library.clearMenu': 'Clear Library…',
      'library.clearTitle': 'Clear your library?',
      'library.clearMessage': 'Every library item and playlist in this browser will be deleted. This cannot be undone. Export a backup first.',
      'library.clear': 'Clear',
      'library.cleared': 'Library cleared',
      'library.favorite': 'Favorite',
      'library.unfavorite': 'Undo Favorite',
      'library.favorited': 'Favorited',
      'library.favoritedName': 'Favorited “{name}” and added it to your library',
      'library.unfavoritedName': 'Removed “{name}” from favorites',
      'library.favorites': 'Favorites',
      'library.favoritesOnly': 'Show only favorites',
      'library.favoriteSongs': 'Favorite Songs',
      'library.autoPlaylist': 'Updates automatically',
      'library.noFavorites': 'No favorites yet',
      'library.noFavoritesHint': 'Choose “Favorite” from a More menu or the ☆ on a detail page.',
      'library.emptyFavorites': 'No favorite songs yet',
      'library.emptyFavoritesHint': 'Choose “Favorite” from a song’s More menu. It appears here and is added to your library.',
      'library.saveAsPlaylist': 'Save as Playlist',
      'library.new': 'New',
      'library.newFolder': 'New Playlist Folder',
      'library.newFolderEllipsis': 'New Playlist Folder…',
      'library.folderName': 'Name',
      'library.untitledFolder': 'Untitled Folder',
      'library.renameFolder': 'Rename Folder',
      'library.renameFolderEllipsis': 'Rename…',
      'library.deleteFolderEllipsis': 'Delete Folder…',
      'library.deleteFolderTitle': 'Delete “{name}”?',
      'library.deleteFolderMessage': 'The {playlists} playlists and {folders} subfolders inside will also be deleted (Apple Music playlists are removed from your library). This cannot be undone.',
      'library.deleteEmptyFolderMessage': 'This folder is empty. This cannot be undone.',
      'library.exportFolder': 'Export Folder',
      'library.moveToFolder': 'Move to Folder',
      'library.movedTo': 'Moved to “{name}”',
      'library.topLevel': 'Playlists (top level)',
      'library.currentLocation': 'Current location',
      'library.folderCount': '{n} playlists',
      'library.folderNotFound': 'Folder not found',
      'library.folderNotFoundHint': 'This folder is not in this browser’s library (it may have been deleted).',
      'library.empty.playlist-folder': 'This folder is empty',
      'library.emptyFolderHint': 'Drag playlists onto this folder in the sidebar, or choose “Move to Folder” from a playlist’s More menu.',
      'library.expandFolder': 'Expand {name}',
      'library.collapseFolder': 'Collapse {name}',
      'artist.pageTitle': 'am-hook · Artist',
      'artist.loading': 'Loading artist…',
      'artist.failed': 'Failed to load artist: {msg}',
      'artist.badId': 'Invalid artist link.',
      'artist.seeAll': 'See All',
      'artist.about': 'About {name}',
      'artist.hometown': 'Hometown',
      'artist.origin': 'Origin',
      'artist.born': 'Born',
      'artist.formed': 'Formed',
      'artist.genre': 'Genre',
      'artist.portraitAlt': 'Photo of {name}',
      'artist.openInApple': 'View {name} on Apple Music',
      'browse.loading': 'Loading…',
      'browse.failed': 'Failed to load: {msg}',
      'browse.empty': 'Nothing here yet.',
      'browse.badId': 'Invalid link.',
      'browse.prev': 'Previous',
      'browse.next': 'Next',
      'browse.seeAll': 'See All · {name}',
      'browse.playlists': 'Playlists',
      'browse.loadMore': 'Loading more…',
      'browse.openInApple': 'Open in Apple Music',
      'browse.external': 'Open in Apple Music (external link)',
      'charts.title': 'Top Charts',
      'charts.genre': 'Genre',
      'charts.allGenres': 'All Genres',
      'charts.genreTitle.songs': 'Top {genre} Songs',
      'charts.genreTitle.albums': 'Top {genre} Albums',
      'charts.genreTitle.music-videos': 'Top {genre} Music Videos',
      'home.tagAtmos': 'Spatial',
      'home.tagAac': 'Universal',
      'home.tagMv': 'Video',
      'home.fmtAlac': 'Up to 24-bit / 192 kHz, bit-for-bit studio masters.',
      'home.fmtAtmos': 'Multichannel EC-3, decoded right in the browser.',
      'home.fmtAac': '256 kbps stereo that plays everywhere.',
      'home.fmtMv': 'Pick video and audio tracks, save as MP4.',

      'song.pageTitle': 'am-hook · Audio qualities',
      'song.play': 'Play',
      'song.reparse': 'Reparse',
      'song.variants': 'Available qualities',
      'song.count': '{total} qualities · {playable} playable in browser',
      'song.fallbackTitle': 'Song {id}',
      'song.noMeta': 'Song info unavailable',
      'song.coverAlt': '{title} cover',
      'song.badId': 'Could not find a song ID in the link.',
      'song.loading': 'Fetching master m3u8…',
      'song.parseFailed': 'Parse failed',

      'q.lossless': 'Lossless',
      'q.atmos': 'Dolby Atmos',
      'q.binaural': 'Binaural',
      'q.downmix': 'Downmix',

      'row.play': 'Play {name}',
      'row.playTitle': 'Play in browser',
      'row.unsupported': 'Codec not supported by this browser',
      'row.unsupportedTitle': 'This browser can\'t decode {codecs}; {hint}',
      'row.playable': 'Plays in browser',
      'row.downloadOnly': 'Download only',
      'row.channels': '{n} ch',
      'row.more': 'More',
      'row.moreAria': 'More actions for {name}',
      'row.cancel': 'Cancel download',
      'row.cancelAria': 'Cancel download of {name}',

      'menu.download': 'Download decrypted file',
      'menu.downloadHint': 'Decrypted in the browser · {file}',


      'dl.busy': 'This quality is already downloading',
      'dl.preparing': 'Preparing download…',
      'dl.progress': 'Decrypting in browser {pct}% · {done} / {total}',
      'dl.defrag': 'Converting to progressive MP4…',
      'dl.done': 'Decrypted and handed to the browser to save ({size})',
      'dl.cancelled': 'Download cancelled',
      'dl.failed': 'Download failed: {msg}',

      'player.previous': 'Previous',
      'player.next': 'Next',
      'player.shuffle': 'Shuffle',
      'player.repeat.off': 'Repeat',
      'player.repeat.all': 'Repeat: All',
      'player.repeat.one': 'Repeat: One',
      'player.play': 'Play',
      'player.pause': 'Pause',
      'player.seek': 'Playback position',
      'player.mode': 'Playback method',
      'player.volume': 'Volume',
      'player.unknownTitle': 'Unknown song',
      'player.pcmMode': 'Multichannel PCM',
      'player.pcmChannels': '{n}.1 PCM',
      'player.pcmNotice': 'Playing decoded multichannel PCM. 5.1/7.1 channels are retained, but the full Atmos spatial experience is unavailable. Output depends on your device.',
      'player.flacNotice': 'This browser cannot play ALAC directly, so it is being converted losslessly to FLAC for playback. Downloads retain the original ALAC.',
      'player.hintDownload': 'download the decrypted file and play it locally',
      'player.errorGeneric': 'Playback failed. Try another quality, or {hint}.',
      'player.errorCodec': 'This browser can\'t decode {codecs}; {hint}.',
      'player.errorFailed': 'This browser can\'t play {label} ({codecs}); {hint}.',
      'player.errorAutoplay': 'The browser blocked autoplay. Press play to start.',
      'player.errorAppend': 'SourceBuffer append failed; the browser may not support this codec',
      'player.queue': 'Playing Next',
      'player.queueClear': 'Clear',
      'player.queueEmpty': 'Nothing up next. Start playing from an album, playlist or artist page and the following songs show up here.',
      'player.queueHint': 'Double-click to play, drag to reorder (or press Alt+↑/↓), Delete to remove',
      'player.queueRemove': 'Remove “{name}” from Playing Next',

      'lyrics.title': 'Lyrics',
      'lyrics.open': 'Lyrics',
      'lyrics.close': 'Close lyrics',
      'lyrics.show': 'Show lyrics',
      'lyrics.hide': 'Hide lyrics',
      'lyrics.translationMenu': 'Lyrics options',
      'lyrics.showTranslation': 'Show translations',
      'lyrics.hideTranslation': 'Hide translations',
      'lyrics.showPronunciation': 'Show pronunciations',
      'lyrics.hidePronunciation': 'Hide pronunciations',
      'lyrics.follow': 'Back to current line',
      'lyrics.credits': 'Written by:',
      'lyrics.creditsSeparator': ', ',
      'lyrics.aiTranslation': 'Translation generated by AI',
      'lyrics.none': 'This song has no lyrics',
      'lyrics.failed': 'Failed to load lyrics. Try again later.',
      'lyrics.fontSize': 'Text Size',
      'lyrics.fontSmaller': 'Smaller lyrics',
      'lyrics.fontLarger': 'Larger lyrics',
      'lyrics.fontWeight': 'Font Weight',
      'lyrics.weightLighter': 'Lighter',
      'lyrics.weightBolder': 'Bolder',
      'lyrics.weight300': 'Light',
      'lyrics.weight400': 'Regular',
      'lyrics.weight500': 'Medium',
      'lyrics.weight600': 'Semibold',
      'lyrics.weight700': 'Bold',
      'lyrics.weight800': 'Heavy',
      'lyrics.source': 'Lyrics Source',
      'lyrics.sourceApple': 'Apple Music',
      'lyrics.sourceAmll': 'AMLL TTML DB',
      'lyrics.backdrop': 'Background',
      'lyrics.backdropAmll': 'AMLL Mesh Gradient',
      'lyrics.backdropClassic': 'Classic',
      'lyrics.amllMissing': 'This song is not in the AMLL TTML DB. Showing Apple Music lyrics.',
      'lyrics.amllFailed': 'Couldn’t reach the AMLL TTML DB. Showing Apple Music lyrics.',
      'lyrics.appleMissing': 'Apple Music has no lyrics for this song. Showing lyrics from the AMLL TTML DB.',
      'lyrics.amllCredit': 'Lyrics from the AMLL TTML DB by {authors}',
      'lyrics.amllCreditAnon': 'Lyrics from the AMLL TTML DB',
      'lyrics.download': 'Download TTML',

      'err.worker': 'Decryption worker error',
      'err.defrag': 'Defragmentation failed: {msg}',
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

  /* ---------- 主地区与曲库语言 ---------- */

  /**
   * 地区表取自 /amp/v1/storefronts（一次返回全部地区，几乎不变），保存在 localStorage：
   * 有保存的地区表就直接使用，保存超过 STOREFRONTS_TTL 时在后台重新拉取替换（失败时继续用旧的）。
   * 每个地区记为 { name, tags: supportedLanguageTags, default: defaultLanguageTag }。
   */
  const STOREFRONTS_KEY = 'am-hook:storefronts:v3';
  const STOREFRONTS_TTL = 30 * 24 * 3600 * 1000;
  let storefrontsPromise = null;

  async function fetchStorefronts() {
    const map = {};
    // 跟随分页 next（如 /v1/storefronts?offset=25），经 /amp 代理
    for (let path = '/v1/storefronts', page = 0; path && page < 20; page++) {
      const res = await fetch('/amp' + path);
      if (!res.ok) throw new Error(`storefronts ${res.status}`);
      const data = await res.json();
      for (const item of (data && data.data) || []) {
        const a = item && item.attributes;
        if (item.id && a && Array.isArray(a.supportedLanguageTags) && a.supportedLanguageTags.length) {
          map[String(item.id).toLowerCase()] = {
            name: a.name || String(item.id).toUpperCase(),
            tags: a.supportedLanguageTags,
            default: a.defaultLanguageTag || a.supportedLanguageTags[0],
          };
        }
      }
      path = data && data.next;
    }
    if (!Object.keys(map).length) throw new Error('no storefronts');
    return map;
  }

  function refreshStorefronts() {
    return fetchStorefronts().then((map) => {
      try { localStorage.setItem(STOREFRONTS_KEY, JSON.stringify({ at: Date.now(), map })); } catch {}
      return map;
    });
  }

  function storefronts() {
    if (!storefrontsPromise) {
      const cached = readJson(STOREFRONTS_KEY);
      if (cached && cached.map && Object.keys(cached.map).length) {
        storefrontsPromise = Promise.resolve(cached.map);
        if (!(Date.now() - cached.at < STOREFRONTS_TTL)) {
          refreshStorefronts().then((map) => { storefrontsPromise = Promise.resolve(map); }, () => {});
        }
      } else {
        // 失败不缓存，下次调用重试
        storefrontsPromise = refreshStorefronts().catch(() => { storefrontsPromise = null; return null; });
      }
    }
    return storefrontsPromise;
  }

  async function storefrontInfo(cc) {
    if (!/^[a-z]{2}$/i.test(cc || '')) return null;
    const map = await storefronts();
    return (map && map[cc.toLowerCase()]) || null;
  }

  const STOREFRONT_KEY = 'am-hook:storefront';
  const AMP_LANG_KEY = 'am-hook:amp-lang';
  const FAVORITES_KEY = 'am-hook:storefront-favorites';
  /** 没有改过收藏时默认收藏的常用地区 */
  const DEFAULT_FAVORITES = ['us', 'cn', 'jp'];
  const settingsListeners = new Set();
  let regions = [];

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }
  function savedStorefront() {
    let saved = null;
    try { saved = localStorage.getItem(STOREFRONT_KEY); } catch {}
    return /^[a-z]{2}$/.test(saved || '') ? saved : null;
  }
  /** 地区 → 选定的曲库语言（只记录与地区默认语言不同的选择） */
  function ampLangs() {
    const map = readJson(AMP_LANG_KEY);
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  }
  const currentStorefront = () => savedStorefront() || regions[0] || 'us';
  const emitSettings = (kind, cc) => settingsListeners.forEach((fn) => fn({ kind, cc }));

  /** wrapper-lite 账号所在地区；没有选择过主地区时主地区随之变化 */
  function setRegions(list) {
    const before = currentStorefront();
    regions = [...new Set((list || []).map((cc) => String(cc).toLowerCase()).filter((cc) => /^[a-z]{2}$/.test(cc)))];
    if (currentStorefront() !== before) emitSettings('storefront', currentStorefront());
  }

  function setStorefront(cc) {
    cc = String(cc || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(cc) || cc === savedStorefront()) return;
    const before = currentStorefront();
    try { localStorage.setItem(STOREFRONT_KEY, cc); } catch {}
    if (currentStorefront() !== before) emitSettings('storefront', cc);
  }

  /** 收藏的地区（按收藏顺序）；收藏全部取消后为空数组，不再回到默认 */
  function favorites() {
    const list = readJson(FAVORITES_KEY);
    return Array.isArray(list) ? list.filter((cc) => typeof cc === 'string' && /^[a-z]{2}$/.test(cc)) : DEFAULT_FAVORITES.slice();
  }

  function toggleFavorite(cc) {
    cc = String(cc || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(cc)) return;
    const list = favorites();
    const next = list.includes(cc) ? list.filter((code) => code !== cc) : [...list, cc];
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch {}
    emitSettings('favorites', cc);
  }

  function ampLang(cc) {
    const tag = ampLangs()[String(cc || '').toLowerCase()];
    return typeof tag === 'string' ? tag : null;
  }

  /** tag 为空或为地区默认语言时清除选择（跟随地区默认语言） */
  async function setAmpLang(cc, tag) {
    cc = String(cc || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(cc)) return;
    const sf = await storefrontInfo(cc);
    if (!sf) return;
    const next = tag && sf.tags.includes(tag) && tag !== sf.default ? tag : null;
    if (next === ampLang(cc)) return;
    const map = ampLangs();
    if (next) map[cc] = next; else delete map[cc];
    try { localStorage.setItem(AMP_LANG_KEY, JSON.stringify(map)); } catch {}
    emitSettings('ampLang', cc);
  }

  /**
   * amp-api 的 l 参数：选定的曲库语言，否则为地区默认语言（如 cn → zh-Hans-CN）。
   * 地区不支持的语言不会报错，而是静默回退到地区默认语言，所以只在地区的 supportedLanguageTags 里选；
   * 取不到地区信息时为 undefined（不传 l，amp-api 同样使用地区默认语言）。
   */
  async function catalogLang(cc) {
    const sf = await storefrontInfo(cc);
    if (!sf) return undefined;
    const chosen = ampLang(cc);
    return chosen && sf.tags.includes(chosen) ? chosen : sf.default;
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-lang-toggle]')) setLang(lang === 'zh' ? 'en' : 'zh');
  });
  // 其他标签页修改设置后同步
  global.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) setLang(e.newValue);
    if (e.key === STOREFRONT_KEY) emitSettings('storefront', currentStorefront());
    if (e.key === AMP_LANG_KEY) emitSettings('ampLang', null);
    if (e.key === FAVORITES_KEY) emitSettings('favorites', null);
  });

  global.AmI18n = {
    t,
    apply,
    setLang,
    toggle: () => setLang(lang === 'zh' ? 'en' : 'zh'),
    /** 返回取消订阅的函数（页面视图卸载时调用） */
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    get lang() { return lang; },
    storefronts,
    setRegions,
    get regions() { return regions.slice(); },
    get storefront() { return currentStorefront(); },
    setStorefront,
    get favorites() { return favorites(); },
    toggleFavorite,
    ampLang,
    setAmpLang,
    catalogLang,
    onSettingsChange: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
