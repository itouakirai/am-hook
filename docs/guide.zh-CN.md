# 使用指南

中文 | [English](guide.md)

## 界面与导航

- 界面支持中文 / English，导航底部的「界面语言」一键切换（会记住选择；首次访问按浏览器语言决定）。切换时正在进行的播放和下载不受影响。
- 导航底部的设置，保存在 localStorage，不会过期：
  - 主地区：用于搜索（以及之后的功能）。wrapper-lite 账号所在地区排在最前（最佳体验），其次是收藏的地区（默认收藏 US / CN / JP）；其他地区收在「更多地区」里，展开后可筛选，每个地区右侧的星标可收藏 / 取消收藏。默认为 wrapper-lite 的第一个地区。
  - 曲库语言（amp-api 的 `l`，与界面语言相互独立）：默认为各地区的默认语言，可选项只有 `/amp/v1/storefronts` 中该地区的 `supportedLanguageTags`。按地区分别记住，歌词也使用它。
- 首页显示 wrapper-lite 状态，以及最近搜索的关键词（点击可再次搜索，也可逐条删除）；页面底部有本项目的 GitHub 链接和对所用开源项目的致谢。
- 搜索：首页输入框既能粘贴链接，也能按关键词搜索（与 music.apple.com 相同的 amp-api 请求）。输入时显示补全词与直达结果；结果按最佳结果、艺人、专辑、歌曲、歌单、MV 分组，可「加载更多」。搜索使用主地区，也可在结果旁的按钮里修改。按 `/` 聚焦输入框；搜索词记在地址栏 `?q=` 中，可前进 / 后退与分享。搜索只在首页；其他页面顶部是「返回」按钮，回到上一页（直接打开链接进入时回到首页）。
- 地址栏、页面标题和浏览器前进 / 后退跟随当前页面，链接可以直接分享，刷新后仍停留在当前页。
- 实现方式：与 music.apple.com 相同，整站是单页应用。服务端对所有页面地址都返回 `app.html`，播放条、音频、解密 Worker 和歌词界面常驻其中；站内链接由前端路由（`app.mjs`）接管，用 `history.pushState` 改地址并切换页面视图（`web/views/`），文档不重新加载。不依赖任何请求头，通过 `http://<局域网 IP>` 访问时同样有效。

## 播放器

与 music.apple.com 相同，底部播放条常驻，在站内页面之间跳转时播放不中断。

- 专辑、歌单、艺人页开始的播放队列在离开页面后继续按顺序播放，系统媒体控制的上一首 / 下一首同样可用；在歌曲页单独播放另一首歌会结束队列，切换同一首歌的音质则保留。
- 与 music.apple.com 相同，整个队列共用一个 MediaSource：下一首提前获取并接在当前歌曲之后，歌曲之间 `<audio>` 不停止。切到其他应用（包括全屏应用）时后台也能无缝切歌，Android 通知栏的媒体卡片不会消失。EC-3 PCM 播放的歌曲仍在上一首结束后再切换。
- **AutoMix**，默认开启（设置中心 → 播放 → 歌曲之间的过渡，或待播清单标题旁的 AutoMix 开关）：按 Apple Music 对两首歌的音频分析（amp-api 的 `audio-analysis`：0.5 秒一点的响度曲线、拍点与小节、速度、人声区间）逐次规划过渡。去掉结尾与开头的静音，在上一首的尾奏里接入下一首（尾奏降到 −6 dB 后；下一首开头就很响时等到 −12 dB），下一首的人声出现前上一首已经退出。两首速度接近（含倍速 / 半速）且律动明显时，下一首的第一个强拍落在上一首的小节上；`<audio>` 播放时还会在重叠期间把下一首变速到上一首的速度（保持音高）并锁住相位，之后慢慢回到原速。连在一起的编排（结尾直接切进响亮的开头）与按顺序播放的同一张专辑保持无缝，没有分析的歌曲也按无缝衔接。交叉淡化是固定时长（1–12 秒）的选项。重叠期间两首同时播放，各种播放方式（ALAC/FLAC、AAC、EC-3、JOC）之间都能过渡；下一首已准备好时手动下一首用 1.2 秒交叉淡化过去。浏览器不能调节音频元素音量时（iOS Safari）不可用。
- 播放控件与 music.apple.com 相同：随机播放、上一首（已播放超过 3 秒时回到开头）、播放 / 暂停、下一首、重复播放（关 → 全部 → 单曲）。随机与重复状态会记住；专辑、歌单、艺人页的「随机播放」开启随机，「播放」按顺序播放。快退 / 快进用 ← / → 键或系统媒体控制。
- 待播清单：点播放条右侧的列表按钮打开。单击选中、双击播放，拖动整行调整顺序；悬停时封面左上角的 − 移出清单，「清除」清空后续歌曲。键盘 ↑/↓ 选择、Enter 播放、Delete 移除、Alt+↑/↓ 移动。触屏上点按播放、拖动右侧把手排序，随机 / 重复按钮在清单标题旁。
- 空格 / 方向键在任何页面都能控制播放；播放 MV 时会暂停音乐，反之亦然。
- **杜比全景声对象渲染（JOC）**，默认关闭：在设置中心「JOC 对象渲染」选择 Speaker 2.0 或双耳后，E-AC-3（Dolby Atmos）歌曲在浏览器内渲染，而不是只播放 5.1 声道或交给系统。内置的 EC-3 解码器输出核心声道，再用同一码流中的 JOC 与对象元数据重建 15 个对象与 LFE，渲染为立体声：Speaker 2.0 用等功率声像，双耳用 HRTF（约克大学 SADIE II 数据库的 20 位受试者，默认 D2），带早期反射与小房间混响。全部在 Web Worker 中完成。开启期间播放队列优先选全景声而不是 ALAC。播放方式、HRTF 与输出衰减对正在播放的歌曲立即生效（全屏播放界面的音质详情里也有同样的开关），按当前音量输出削波时每首提示一次。全景声混音及其双耳、缩混 AAC 版本通常比立体声母带小声，同一分组里的「非空间音频音量」可以把 ALAC / 立体声 AAC 调低几 dB（只衰减），让两者切歌时音量接近。
- **空间声场**（音质详情里的「空间声场」，双耳）：一个虚拟头部与码流里的 15 个对象（按 OAMD 位置实时移动，光球大小随电平）。拖动转头，渲染器按新的朝向重算每个对象的 HRTF 与房间反射，约 0.15 秒后就能听到；可以在房间里走动（走近对象变响，反射跟着变）、切到第一人称视角、点光球独奏或静音（JOC 对象是重建出来的空间分组而不是分轨，会有残留）、用「聚焦」让面朝的对象更响、放大对象的仰角，手机上可以用陀螺仪转头。为了让交互立刻听到，有 AudioWorklet 时（HTTPS 或 localhost）JOC 改为按播放进度逐帧渲染，只提前约 0.1 秒。

## 页面一览

下面的页面都是单页应用的路由：服务端返回 `app.html`，页面经 `/amp` 从 amp-api 加载数据。

| 页面 | 说明 |
|---|---|
| `/` | 首页：搜索、wrapper-lite 状态与最近搜索 |
| `/https://music.apple.com/<cc>/song/<slug>/<id>` | 歌曲页（见[歌曲](#歌曲)） |
| `/https://music.apple.com/<cc>/music-video/<slug>/<id>` | MV 页（见 [MV](#mv)） |
| `/https://music.apple.com/<cc>/post/<id>` | 艺人上传的视频（MV 页） |
| `/https://music.apple.com/<cc>/album/<slug>/<id>` | 专辑页（与 music.apple.com 相同的 `editorialVideo` 动态封面：宽屏方形、手机全宽 3:4；曲目列表、连续播放、相关推荐货架；数据来自与 music.apple.com 相同的 amp-api `albums` 请求）。带 `?i=` 的专辑链接与 music.apple.com 一样打开专辑页，选中（高亮）该曲目并滚动到它 |
| `/https://music.apple.com/<cc>/playlist/<slug>/<pl.id>` | 歌单页（编辑歌单与公开的用户歌单：与专辑页相同的动态封面；曲目带封面、艺人、专辑列；连续播放；精选艺人、策展人的更多歌单货架；数据来自与 music.apple.com 相同的 amp-api `playlists` 请求，经 `/amp` 获取） |
| `/https://music.apple.com/<cc>/artist/<slug>/<id>` | 艺人页（与 music.apple.com 相同的头部：按目录数据显示动态视频、通栏图片或圆形头像；最新发行、歌曲排行与连续播放、专辑 / MV / 歌单 / 相似艺人货架与「显示全部」、艺人简介；数据来自与 music.apple.com 相同的 amp-api `artists` 请求，经 `/amp` 获取）。歌曲页、MV 页、专辑页的艺人名（多位艺人时各自单独链接）与艺人货架都链接到这里 |
| `/new` | 新发现（侧边栏的「新发现」）：与 music.apple.com/{cc}/new 相同的编辑区块（amp-api `editorial/{cc}/groupings?name=music`），使用主地区，切换后重新加载——hero 大卡、四行曲目货架、专辑 / 歌单 / 电台 / 视频货架（列数与官网 shelf-grid 相同）与「探索更多」链接；`/https://music.apple.com/<cc>/new` 为固定地区 |
| `/new/top-charts[/<kind>]` | 排行榜（新发现「探索更多」中的链接，与 music.apple.com/{cc}/new/top-charts 相同，amp-api `catalog/{cc}/charts`，使用主地区）：带名次的热门歌曲（三行）、城市排行榜、每周热门 100 首，以及带名次的热门歌单 / 专辑 / 视频。各榜单的「查看全部」（`songs`、`playlists`、`albums`、`music-videos`，另有 `city-charts`、`daily-global-top-charts`）列出整个榜单并滚动分页，歌曲与歌单页的榜单行相同；歌曲、专辑、视频榜可按类型筛选（`?genreId=`，类型来自 `catalog/{cc}/genres`）；`/https://music.apple.com/<cc>/new/top-charts[/<kind>]` 为固定地区 |
| `/https://music.apple.com/<cc>/room/<id>`、`.../multi-room/<id>`、`.../grouping/<id>`、`.../curator/<slug>/<id>` | 编辑页，路由与 music.apple.com 相同：room 为区块的「查看全部」（全部内容的网格，滚动时分页加载）；multi-room（`editorial/{cc}/multirooms`，头图 + 区块）、grouping（`editorial/{cc}/groupings/{id}`，如「音乐视频」与各风格页）与 curator（`catalog/{cc}?ids[apple-curators]=`：其分组的区块，或全部歌单）沿用新发现的排版。编辑数据中的旧式链接（`collection/...?fcId=`、`viewGrouping?id=`、`viewFeature?id=`）在站内打开这些页面；电台打开本站的电台页，其他本站无法打开的内容链接到 Apple Music。在首页粘贴这些链接同样可以打开 |
| `/radio` | 广播（侧边栏的「广播」）：与 music.apple.com/{cc}/radio 相同的编辑区块，使用主地区，填过 media-user-token 时另有「你的电台」；`/https://music.apple.com/<cc>/radio` 为固定地区 |
| `/https://music.apple.com/<cc>/station/<slug>/ra.<id>` | 电台页：个人 / 编辑电台为接下来几首的曲目列表，直播电台与广播单集为 MV 页布局的播放与下载（见[广播与电台](#广播与电台)） |
| `/library[/<分类>]`、`/library/artists/<名称>`、`/library/playlist/p.<id>`、`/library/favorite-songs`、`/library/playlist-folder/f.<id>` | 资料库页面（分类 `recently-added`、`artists`、`albums`、`songs`、`music-videos`、`all-playlists`）、本地歌单、喜爱的歌曲与歌单文件夹。资料库数据保存在浏览器的 IndexedDB 中（`web/library.mjs`），见[资料库与歌单](#资料库与歌单) |
| `/settings` | 设置中心（下载设置等）。设置保存在浏览器中（`web/prefs.mjs`），见[批量下载与设置中心](#批量下载与设置中心) |

## 歌曲

- 自动解析全部音质（无损 ALAC / 杜比全景声 / AAC / HE-AAC，含双耳、缩混版本），显示封面、歌名等信息（经服务端 `/amp` 代理请求 Apple Music 目录接口 amp-api）。
- 每个音质的「更多」菜单中有 **下载解密文件**：在浏览器内解密并写入标签、封面与歌词（按设置中心的下载设置），显示进度，可随时取消。离开歌曲页后下载在后台继续（进度也在下载中心），完成后照常保存；回到该歌曲页时接着显示进度（关闭或刷新标签页会中断）。
- 内置播放器：MSE 加浏览器端解密。浏览器不支持 ALAC 时通过 FLAC-in-MP4 无损播放；EC-3 的 MSE 不可用时回退为多声道 PCM，并提示空间音频限制。下载保留原始编码。支持空格 / 方向键和系统媒体控制。

## 歌词与全屏播放界面

- 正在播放的歌曲有歌词时，播放条上出现「歌词」按钮（在任何页面都能打开，切歌后自动换成新歌的歌词）。
- 歌词视图由 [AMLL（Apple Music-like Lyrics）](https://github.com/amll-dev/applemusic-like-lyrics) 渲染：逐词 / 逐行高亮与弹簧滚动、和声、对唱、翻译与发音、间奏圆点，点击任意一行即可跳转。Esc 收起。
- 背景是 AMLL 由专辑封面生成的流动网格渐变，也可以选移植自 [YouLyPlus](https://github.com/ibratabian17/YouLyPlus) 的封面动态背景（三份旋转、环绕的封面经模糊与 Apple Music 式调色生成；浏览器支持时在 worker 中渲染，AMLL 背景不可用时也用它）。两种背景都可以随节拍律动（默认关闭，在歌词选项里开启）：从正在播放的声音里取底鼓、贝斯的起音，各种格式都支持——EC-3 与 JOC 在音量调节之前取样，AAC / ALAC 截取 `<audio>` 的声音（Chromium 系浏览器），播放本身的路径不受影响。
- 点击播放条的封面、标题或空白处展开全屏播放界面（没有歌词的歌曲也能展开，只显示封面与播放控件）。
  - 同 music.apple.com，界面里的标题旁有喜爱（☆）与「更多」按钮（添加到资料库、添加到歌单、前往专辑、复制链接）；右下角的歌词按钮（手机上在播放控件下方）显示 / 隐藏歌词。
  - 按钮的位置同 music.apple.com——关闭在左上角，歌词翻译在右上角，播放按钮没有底色、居中排成一行，歌名与艺人各占一行、过长时滚动。
  - 手机上同官网的手机版：顶部是收起界面的下拉把手，显示歌词时标题行收成一行小封面，底部只有上一首 / 播放 / 下一首，下面是歌词开关与待播清单开关——待播清单占据歌词的位置，随机 / 重复在清单标题旁；隐藏时封面与播放控件居中，这个选择保存在浏览器中。
- 右上角的歌词选项按钮（原来只有翻译菜单）：
  - 切换翻译与发音，调整字号（70%–150%）与字重（细体到特粗）；
  - 在 Apple Music 与 [AMLL 歌词库](https://amll.dev/reference/http-api/overview)之间切换歌词来源（由浏览器按 Apple Music 歌曲 ID 直接查询，未收录的歌曲仍用 Apple Music 歌词；不选它时不会向它发送请求）；
  - 在 AMLL 与封面动态背景之间切换，以及下载当前显示的 TTML 歌词。
  - 除翻译与发音外都保存在浏览器中。

## MV

- 视频、音频规格分列显示，默认选择最高码率视频和其音频组中的默认音轨；切换视频会更新推荐音轨，也可手动选择音频。
- 播放使用 MediaSource，支持进度跳转和有限缓冲。不支持的编码仍可下载；可选择 AVC/AAC 轨道获得更好的播放兼容性。
- 视频内独立的 CEA-608 字幕轨由前端解码为浏览器原生字幕，默认显示首条字幕，可通过视频字幕菜单切换或关闭。
- 下载时预取后面几个分段，按顺序解密，先写视频轨、再写音频轨的分段到 OPFS 临时文件，不在内存中拼接整部 MV。随后 Worker 把它改写为标准（progressive）MP4，`moov` 位于媒体数据之前，布局同参考实现的 `mv.Mux`：每个源 trun 一个 chunk，各轨道依次写入（视频与其字幕，然后是音频）。同时按设置中心的标签设置把标签与缩略图写入 `moov`；不进行转码。改写期间两份文件同时存在，OPFS 需要约两倍于 MV 的空间。
- 下载保留 CEA-608 字幕轨。Apple 的字幕轨以一个格式错误的空 sample 开头，新版 FFmpeg 会拒绝它（基于 mpv 的播放器会在播放不久后退出）；下载时会把它原位改写为等长的合法空字幕 sample。
- 完成后自动触发保存，也可点击「保存 MP4」；取消或失败会清理临时文件。离开 MV 页面会停止播放、取消进行中的下载，并尝试清理已完成文件。标签页关闭或崩溃留下的文件会在下次打开 MV 页面时删除（浏览器不支持 Web Locks 时，文件超过 24 小时才会删除）。
- 艺人上传的视频（官网 `post` 页，amp-api 的 `uploaded-videos`，新发现与编辑页中的链接会打开它）使用同一页面。与官网相同，不需要 wrapper-lite 也不需要解密：`assetTokens` 中的每一项都是未加密的标准 MP4（H.264 + AAC，`moov` 在前），由 `<video>` 直接播放。页面按分辨率列出，并显示大小与码率（来自 `HEAD` 请求）；没有单独的音频轨道。下载时把文件原样流式写入 OPFS（不支持 OPFS 时使用内存 Blob）。

## 广播与电台

- **广播**（`/radio`，侧边栏与手机菜单中「排行榜」与「设置」之间）：与 music.apple.com/{cc}/radio 相同的编辑区块（amp-api `editorial/{cc}/groupings?name=radio`），使用主地区；直播电台货架显示品牌图标、「直播」标记与正在播出的节目。填过 media-user-token 时最上面另有「你的电台」：个人电台（`stations?filter[identity]=personal`）与最近播放的电台（`me/recent/radio-stations`）。新发现、编辑页与广播中的电台链接都在站内打开电台页。
- **media-user-token**：wrapper-lite 还没有电台接口，电台用你 Apple Music 账号的 media-user-token 直接请求 Apple。第一次打开电台页时会请你填写（登录 music.apple.com 后在开发者工具 → Application → Cookies 里复制 `media-user-token`，粘贴整段 Cookie 也可以），先经 `/v1/me/storefront` 检验再保存。token 只保存在本浏览器的 localStorage，请求时经 `X-Media-User-Token` 交给服务端转发，服务端不保存、不缓存、不记录。被 Apple 拒绝时会再次提示；设置中心可以修改或清除。
- **电台页**（`/https://music.apple.com/<cc>/station/<slug>/ra.<id>`）按电台的 `playParams` 分三类（与 MusicKit 的判断相同）：
  - 个人电台与编辑电台（`format: tracks`，如风格电台、个人电台 `ra.u-…`）：与歌单页相同的头部与曲目列表，内容是电台「接下来的几首」（`POST /v1/me/stations/next-tracks/<id>`，每次 10 首），可以换一批或加载更多；播放到队尾前自动续取下一批，像电台一样一直播下去。曲目的「更多」菜单与歌曲相同（含下载），头部的「更多」可以下载列出的歌曲。
  - 广播单集（`format: stream`，`streamingRadioSubType: Episode`，音频或视频）：与 MV 页相同的布局，列出 HLS 的各码率与轨道，可以播放、跳转和下载（音频为 `.m4a`，视频为 `.mp4`，带标题、节目、播出日期与封面标签）。
  - 直播电台（`isLive`：Apple Music 1、各地广播，以及直播过的视频节目）：同样是 MV 页的布局，从直播窗口末尾附近开始播放，显示「直播」标记、当前歌曲（分片 `emsg` 中的 ID3，能对应到歌曲时链接到歌曲页）与节目表；不能下载。

## 资料库与歌单

与 music.apple.com 的「资料库」「歌单」相同，但**只保存在你的浏览器中**（IndexedDB）。服务端不保存任何资料库数据，也不需要账号；除了平常的目录请求，数据不会离开浏览器。

- 侧边栏：「资料库」分组（最近添加、艺人、专辑、歌曲、音乐视频）与「歌单」分组（所有歌单，然后是各个歌单；+ 新建歌单）。页面地址在 `/library/...` 下，刷新与（同一浏览器中）打开链接都能回到原页面。
- 添加：各处的「更多」菜单（搜索结果、货架、专辑 / 歌单 / 艺人 / 排行榜的曲目行）都有**添加到资料库** / **从资料库中删除**与**添加到歌单**子菜单（新建歌单…，然后是你的歌单，最近修改的在前）。专辑页、歌单页的播放按钮旁有 +，歌曲页有资料库与添加到歌单按钮。与 Apple Music 相同：添加专辑会同时添加其中全部歌曲与 MV；只添加单曲时，它的专辑与艺人也会出现在资料库中；删除专辑会一并删除其中的歌曲；添加 Apple Music 歌单只添加歌单本身（打开的仍是目录中的最新歌单）。歌单里已有的曲目会跳过。
- 资料库页面：歌曲（播放 / 随机播放筛选后的列表，按标题、艺人、专辑、添加时间或时长排序，长列表随滚动渲染）、专辑与音乐视频网格、艺人（列表旁显示所选艺人的专辑与歌曲，手机上点进各艺人）、最近添加、所有歌单。每页都可以筛选，排序方式会记住。
- 歌单（`/library/playlist/p.<id>`）：封面为前四张不同专辑封面拼成的 2×2 图，名称与描述（编辑）、播放 / 随机播放、拖动把手排序（鼠标与触屏相同，把手获得焦点时也可按 ↑ / ↓）、从歌单中删除、复制、导出与删除。歌单保存每首曲目的快照（歌名、艺人、专辑、封面、时长），打开时不需要请求目录，也可以包含不在资料库中的歌曲。
- 导入 / 导出（资料库页面的 ⋯ 菜单）：**导出资料库**保存 `am-hook-library-<日期>.json`，包含全部资料库条目与歌单；**导出歌单**保存单个歌单（`<名称>.am-hook-playlist.json`），方便分享。**导入…** 两种文件都能读：整库文件可以选择合并（保留现有内容，同一 id 的歌单保留较新的一份）或替换；歌单文件直接加入并打开。每一条都会校验：只保留 `/https://music.apple.com/...` 页面链接与 https 图片地址，无效条目跳过，分享来的文件无法注入链接或脚本。**清空资料库…** 确认后删除全部内容。
- 喜爱：与 Apple Music 相同，歌曲、MV、专辑、歌单（Apple Music 歌单与自己的歌单）和艺人都可以喜爱——各处「更多」菜单中的**喜爱** / **取消喜爱**，专辑页与歌单页的 + 旁、歌曲页以及艺人页操作行里的 ☆。喜爱的同时加入资料库（喜爱的艺人即使没有歌曲也会出现在「艺人」中）。喜爱的曲目带星形标记；歌曲、专辑、艺人、音乐视频与所有歌单页面有**喜爱**筛选。**喜爱的歌曲**（`/library/favorite-songs`，在侧边栏中，也排在所有歌单的最前面）是由喜爱的歌曲自动组成的歌单，最近喜爱的在前；取消喜爱即移出，「存储为歌单」可以复制成普通歌单。
- 歌单文件夹（`/library/playlist-folder/f.<id>`）：在「歌单」旁的 + 或 ⋯ 菜单中新建，可以嵌套；自己的歌单与添加的 Apple Music 歌单都能放进去——用**移到文件夹**（「更多」菜单与歌单页），或在侧边栏把歌单、文件夹拖到另一个文件夹上（拖到「歌单」标题上移到最上层）。侧边栏中文件夹在前，可以展开 / 收起（会记住；打开的歌单所在文件夹会自动展开）。文件夹页显示路径、子文件夹与歌单，可以新建歌单、新建文件夹、重命名、移动、导出文件夹与删除文件夹。与 Apple Music 相同，删除文件夹会一并删除其中的全部内容（确认时显示数量）；文件夹不能移到自身或自己的子文件夹里。
- 存储说明：数据按浏览器、按站点地址分开（`http://127.0.0.1:8888` 与 `http://<局域网 IP>:8888` 是两个资料库），换浏览器或地址时请导出再导入。同一浏览器的多个标签页会自动同步。浏览器不允许使用 IndexedDB 时（部分隐私模式），资料库只在本次会话的内存中，资料库页面会给出提示。

<details>
<summary><b>资料库文件格式（版本 1）</b></summary>

```jsonc
{
  "format": "am-hook-library", "version": 1, "exportedAt": "2026-10-04T12:00:00.000Z",
  "items": [   // 资料库：kind 为 song / music-video / album / playlist（Apple Music 歌单），addedAt 为毫秒
    { "kind": "song", "id": "1468058171", "country": "cn", "name": "…", "artist": "…", "artists": [{ "name": "…", "href": "/https://music.apple.com/cn/artist/…/159260351" }],
      "album": "…", "albumId": "1468058165", "albumHref": "/https://music.apple.com/cn/album/…/1468058165", "href": "/https://music.apple.com/cn/song/…/1468058171",
      "artwork": "https://…/{w}x{h}bb.jpg", "bgColor": "1d1d1f", "duration": 221000, "explicit": false, "addedAt": 1759579200000 }
  ],
  "playlists": [   // 本地歌单：tracks 为同样的曲目快照，另加 uid / addedAt
    { "id": "p.Ab3dE…", "name": "…", "description": "…", "folderId": "f.Xy9…", "favorite": 0, "createdAt": 1759579200000, "updatedAt": 1759579300000, "tracks": [ { "uid": "…", "addedAt": 1759579200000, "kind": "song", "id": "…" } ] }
  ],
  "folders": [   // 歌单文件夹；最上层的 parentId 为空
    { "id": "f.Xy9…", "name": "…", "parentId": "", "createdAt": 1759579200000, "updatedAt": 1759579200000 }
  ]
}
```

条目与歌单上的 `favorite`（毫秒，0 为未喜爱）、歌单与 Apple Music 歌单条目上的 `folderId`、`folders` 以及 `artist` 条目（喜爱的艺人）是后来加入的可选字段，因此版本号仍为 1：旧版本也能导入新文件，只是跳过不认识的内容。「导出文件夹」包含该文件夹、其子文件夹与其中的歌单。导入时指向不存在的文件夹或文件夹之间成环的，移到最上层。浏览器中的数据库升级为版本 2（新增 `folders`），已有的资料库原地升级。

</details>

## 批量下载与设置中心

- **设置中心**（`/settings`，侧边栏与手机菜单中「排行榜」下方的「设置」）：通用设置（主地区、曲库语言、界面语言、wrapper-lite，与导航底部相同）与下载设置，保存在 localStorage，修改立即生效（进行中的下载沿用开始时的设置），也为之后的播放设置预留了位置。下载设置参考 [apple-music-downloader](https://github.com/itouakirai/apple-music-downloader) 与 [amd.wol.moe](https://amd.wol.moe/)：
  - 音质：首选音质（下拉框分组列出：无损 ALAC / 杜比全景声；AAC 立体声 256 / 128 kbps 与 HE-AAC 64 kbps；AAC 双耳、AAC 缩混（来自全景声母带）同样有这三种码率）、ALAC 最高采样率、全景声上限（2768 / 2448）、没有首选音质时是否降级
  - MV：下载专辑、歌单时是否一起下载其中的 MV，MV 最高分辨率（同参考实现的 `mv-max`：不超过该高度、平均码率最高的视频）与音轨（同 `mv-audio-type`：杜比全景声 → AC-3 → AAC、AC-3 → AAC 或只用 AAC）
  - 性能：同时下载的曲目数、失败重试次数、是否用 OPFS 暂存
  - 保存方式：**ZIP**（整张专辑 / 歌单一个文件，不压缩，超过 4 GiB 时为 ZIP64）、**文件夹**（File System Access API 直接写入选定的本地文件夹，可建子文件夹，可跳过已存在的文件；需要 Chrome / Edge 桌面版）、**逐个文件**；歌单可附带 `.m3u8` 播放列表
  - 文件名模板：专辑 / 歌单文件夹（ZIP 名）、专辑曲目、歌单曲目、单曲；`/` 表示子文件夹，`{tracknum:02d}` 补零，变量有 `{title}` `{artist}` `{album}` `{album_artist}` `{composer}` `{genre}` `{tracknum}` `{tracktotal}` `{disk}` `{disktotal}` `{year}` `{release_date}` `{codec}` `{quality}` `{bit_depth}` `{sample_rate}` `{sample_rate_kHz}` `{explicit}` `{song_id}` `{album_id}` `{artist_id}` `{isrc}` `{upc}` `{record_label}` `{copyright}` `{playlist}` `{playlist_id}` `{curator}` `{index}`，编辑时实时预览；变量值里的 `/` 等非法字符替换为 `_`
  - 标签：可选写入的字段（标题、艺人、专辑、专辑艺人、作曲、流派、发行日期、曲目号、碟号、歌词、封面、版权、厂牌、UPC、ISRC、分级、歌曲 / 专辑 / 艺人 ID），排序字段，歌单曲目使用原专辑信息或歌单信息，去掉专辑名末尾的「 - EP」/「 - Single」（标签与文件名、文件夹名一致，默认关闭），元数据语言
  - 封面：JPEG / PNG 与尺寸，嵌入的封面和另存的 `cover.jpg` / `cover.png` 分开设置
  - 歌词：另存 `.lrc` / `.ttml`、逐字（增强型 LRC）、附带翻译 / 发音、歌词语言
- **下载**：专辑页与歌单页的下载按钮（播放、随机播放旁）打开对话框，可临时改音质并选择曲目（默认全部歌曲，以及设置中没有关闭时的 MV；未发行的曲目不能选择）；各处的「更多」菜单（曲目行、搜索结果、货架等）中的歌曲、MV、专辑与歌单也可直接下载；歌曲页各音质的「下载解密文件」同样经下载管理器（`web/download/downloads.mjs`）进行，带标签。
  - 每首歌在浏览器内解密后，`media.wasm` 在整理为标准 MP4 时把 iTunes 标签（`moov.udta.meta.ilst`，字段同 go-mp4tag）连同封面、歌词一起写入 `moov`，不需要第二次改写文件；封面与歌词与音频同时获取，取不到时只是不写入
  - 元数据来自 amp-api `songs?ids=…&include=albums,artists` 与 `music-videos?ids=…`（每 100 首一次请求）：作曲、ISRC、曲目号 / 碟号，以及所属专辑的 UPC、版权、厂牌与曲目数
  - MV 的下载同参考实现的 `mvDownloader`：从 wrapper-lite 取 MV master，按设置选视频与音轨，由 MV 引擎解密、合并并整理为 `.mp4`，文件名使用同样的模板（`{codec}` / `{quality}` 为视频与音频规格，如 `2160p HEVC Dolby Vision · Dolby Atmos`）。标签同参考实现的 `writeMVMP4Tags`（专辑信息取自专辑或歌单，另写 `PERFORMER`、`RELEASETIME`，封面为 MV 缩略图），媒体类型为音乐视频（`stik` 6）。需要 OPFS
  - ZIP 不复制数据：由 OPFS 中的各个文件与头部拼成一个 Blob，CRC-32 在 defrag 写出时顺带计算
- **下载中心**（`web/download/center.mjs`）：与播放条一样常驻在页面底部（播放条上方），站内跳转时下载不中断；显示总进度、速度与当前任务，展开后列出各专辑 / 歌单 / 单曲及每首歌的状态，可以取消、重试（整个任务或单首）、有失败曲目时仍然保存已完成的部分、再次保存、移除。移除或关闭标签页时删除临时文件；下载进行中关闭标签页会提示。
- **ALAC 检测**：专辑页、歌单页与歌曲页头部的波形按钮，以及歌曲「更多」菜单里的「检测 ALAC」，逐首检测最高音质的 ALAC（`web/alac-check.mjs`，对话框见 `views/alac-check-dialog.mjs`），不请求 `/key`。打开后不自动开始，可全选、全不选或勾选部分曲目；显示地区、专辑 / 歌单 / 歌曲 ID、每首的歌曲 ID 与检测时间，可复制文字报告。
  - **网页版与 wrapper-lite 的 master**：默认只用 amp-api 的 `extendedAssetUrls.enhancedHls`，不经过 wrapper-lite。两者可能是不同的打包，wrapper-lite 给出的有时音质更高（如歌曲 `1679278167`：网页版只有 24-bit / 48 kHz，wrapper-lite 的另有 24-bit / 96 kHz），勾选后同时检测 wrapper-lite 的 master；两边最高音质 ALAC 的 media m3u8 相同时只检测一次，不同时分别列出并标明哪边音质更高。歌曲页的音质列表（来自 wrapper-lite）也会取网页版的 master 比较，只在 wrapper-lite 中有的音质标为「仅 wrapper-lite」
  - **下载时检测**（设置中心，默认关闭）：下载 ALAC 时同时检测实际下载的那一份：原始分段在解密、修复之前顺带读出 moof 与原样帧末尾，不另发请求。结论显示在下载中心，并写入自定义标签 `----:com.apple.iTunes:ALAC_CHECK`（名称可改），内容如 `result=damaged; noEnd=25; hidden=0; oversize=0; frames=2108; escapes=25; format=16/44100; bad=#124@11.517:noEnd,…; packaged=…; endTagRepair=on; checked=…`
  - **原样帧末尾缺陷**（[AppleMusicDecrypt#136](https://github.com/WorldObservationLog/AppleMusicDecrypt/issues/136)）：Apple 打包时输出缓冲区只有一帧原始 PCM 大，原样帧（未压缩帧）多出的末尾 4 字节在缓冲区释放后才被复制，内容是堆管理数据。master m3u8 取自 amp-api 的 `extendedAssetUrls.enhancedHls`；每个分段只下载开头的 moof（几 KB），长度超过一帧 PCM 的 sample（16-bit 立体声 16388 字节、24-bit 24580 字节）再只读末尾 4 字节——cbcs 只加密整 16 字节块，这 4 字节是明文。PCM 之后不是 END 标记 `111` 的为「缺 END 标记」（FFmpeg 等会丢弃该帧）；是 `111` 但填充位不为零的为「隐藏缺陷」（解码不报错，最后一个样本已损坏）。列出帧号、时间与末尾 4 字节
  - **打包信息**：init 段 `mvhd` 的创建时间（打包日期）与 `udta/swre`（打包软件版本）
  - **实际位深与频宽**（可关闭）：第一个分段（约 15 秒）使用预取密钥，在浏览器内解密后由 `flac.wasm` 解码分析（`crates/am-flac-wasm/src/analysis.rs`）：低位是否全为零（如 24-bit 中实为 16-bit），以及平均频谱高于容器量化噪声 20 dB 的最高频率；只有其上方陡降时才判断为疑似升频（如 96 kHz 中只有 22 kHz 以下的内容）或 44.1 / 48 kHz 的有损来源，并画出频谱
