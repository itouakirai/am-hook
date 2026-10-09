# am-hook

中文 | [English](README.md)

一个用 Rust 编写的 Apple Music 解密工具，支持歌曲（FairPlay HLS）和 MV（PlayReady HLS）。

**解密完全在浏览器中完成**：服务端只与 wrapper-lite 通信（master 播放列表、解密模板、许可证），媒体数据由浏览器直接从 Apple CDN 获取，并在 Web Worker 中用 WebAssembly 解密，不消耗服务器流量。

![am-hook 首页](docs/home.zh-CN.png)

## 快速开始

```sh
cargo build --release

# 浏览器端解密，服务端只提供播放列表、解密模板与许可证
am-hook --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

浏览器打开 `http://127.0.0.1:8888/` 粘贴链接即可。也可以把 Apple Music 链接直接拼在服务地址后面打开对应页面：

| 首页输入 | 打开的页面 |
|---|---|
| `https://music.apple.com/cn/song/<slug>/<id>` | `/https://music.apple.com/cn/song/<slug>/<id>` |
| `https://music.apple.com/cn/album/<slug>/<albumId>?i=<id>` | `/https://music.apple.com/cn/album/<slug>/<albumId>?i=<id>` |
| `https://music.apple.com/cn/music-video/<slug>/<id>` | `/https://music.apple.com/cn/music-video/<slug>/<id>` |
| `https://music.apple.com/cn/post/<id>` | `/https://music.apple.com/cn/post/<id>` |
| `https://music.apple.com/cn/playlist/<slug>/<pl.id>` | `/https://music.apple.com/cn/playlist/<slug>/<pl.id>` |
| `https://music.apple.com/cn/artist/<slug>/<id>` | `/https://music.apple.com/cn/artist/<slug>/<id>` |

例如：`http://127.0.0.1:8888/https://music.apple.com/cn/music-video/super-bowl-lix-halftime-show-live/1836358807`。链接中的国家代码决定获取展示信息时使用的地区。

### 环境要求

- Rust 2021 edition 工具链
- 运行中的 [wrapper-lite](https://github.com/WorldObservationLog/wrapper) 密钥服务（默认 `http://127.0.0.1:12340`）
- 支持 Web Worker 和 WebAssembly 的现代浏览器。播放使用 MediaSource（EC-3 PCM 回退使用 Web Audio）；MV 下载需要 OPFS。

> OPFS 只在安全上下文中可用，也就是 HTTPS 或 `localhost` / `127.0.0.1`。通过 `http://<局域网 IP>` 访问时，歌曲下载退回内存 Blob（大文件占用较多内存），MV 无法下载；播放不受影响。

## Web 界面

- 界面支持中文 / English，导航底部的「界面语言」一键切换（会记住选择；首次访问按浏览器语言决定）。切换时正在进行的播放和下载不受影响。
- 导航底部的设置，保存在 localStorage，不会过期：
  - 主地区：用于搜索（以及之后的功能）。wrapper-lite 账号所在地区排在最前（最佳体验），其次是收藏的地区（默认收藏 US / CN / JP）；其他地区收在「更多地区」里，展开后可筛选，每个地区右侧的星标可收藏 / 取消收藏。默认为 wrapper-lite 的第一个地区。
  - 曲库语言（amp-api 的 `l`，与界面语言相互独立）：默认为各地区的默认语言，可选项只有 `/amp/v1/storefronts` 中该地区的 `supportedLanguageTags`。按地区分别记住，歌词也使用它。
- 首页显示 wrapper-lite 状态，以及最近搜索的关键词（点击可再次搜索，也可逐条删除）；页面底部有本项目的 GitHub 链接和对所用开源项目的致谢。
- 搜索：首页输入框既能粘贴链接，也能按关键词搜索（与 music.apple.com 相同的 amp-api 请求）。输入时显示补全词与直达结果；结果按最佳结果、艺人、专辑、歌曲、歌单、MV 分组，可「加载更多」。搜索使用主地区，也可在结果旁的按钮里修改。按 `/` 聚焦输入框；搜索词记在地址栏 `?q=` 中，可前进 / 后退与分享。搜索只在首页；其他页面顶部是「返回」按钮，回到上一页（直接打开链接进入时回到首页）。
- 全局播放条：与 music.apple.com 相同，底部播放条常驻，在站内页面之间跳转时播放不中断。
  - 专辑、歌单、艺人页开始的播放队列在离开页面后继续按顺序播放，系统媒体控制的上一首 / 下一首同样可用；在歌曲页单独播放另一首歌会结束队列，切换同一首歌的音质则保留。
  - 与 music.apple.com 相同，整个队列共用一个 MediaSource：下一首提前获取并接在当前歌曲之后，歌曲之间 `<audio>` 不停止。切到其他应用（包括全屏应用）时后台也能无缝切歌，Android 通知栏的媒体卡片不会消失。EC-3 PCM 播放的歌曲仍在上一首结束后再切换。
  - 播放控件与 music.apple.com 相同：随机播放、上一首（已播放超过 3 秒时回到开头）、播放 / 暂停、下一首、重复播放（关 → 全部 → 单曲）。随机与重复状态会记住；专辑、歌单、艺人页的「随机播放」开启随机，「播放」按顺序播放。快退 / 快进用 ← / → 键或系统媒体控制。
  - 待播清单：点播放条右侧的列表按钮打开。单击选中、双击播放，拖动整行调整顺序；悬停时封面左上角的 − 移出清单，「清除」清空后续歌曲。键盘 ↑/↓ 选择、Enter 播放、Delete 移除、Alt+↑/↓ 移动。触屏上点按播放、拖动右侧把手排序，随机 / 重复按钮在清单标题旁。
  - 地址栏、页面标题和浏览器前进 / 后退跟随当前页面，链接可以直接分享，刷新后仍停留在当前页。
  - 空格 / 方向键在任何页面都能控制播放；播放 MV 时会暂停音乐，反之亦然。
  - 实现方式：与 music.apple.com 相同，整站是单页应用。服务端对所有页面地址都返回 `app.html`，播放条、音频、解密 Worker 和歌词界面常驻其中；站内链接由前端路由（`app.mjs`）接管，用 `history.pushState` 改地址并切换页面视图（`src/ui/views/`），文档不重新加载。不依赖任何请求头，通过 `http://<局域网 IP>` 访问时同样有效。

### 资料库与歌单

与 music.apple.com 的「资料库」「歌单」相同，但**只保存在你的浏览器中**（IndexedDB）。服务端不保存任何资料库数据，也不需要账号；除了平常的目录请求，数据不会离开浏览器。

- 侧边栏：「资料库」分组（最近添加、艺人、专辑、歌曲、音乐视频）与「歌单」分组（所有歌单，然后是各个歌单；+ 新建歌单）。页面地址在 `/library/...` 下，刷新与（同一浏览器中）打开链接都能回到原页面。
- 添加：各处的「更多」菜单（搜索结果、货架、专辑 / 歌单 / 艺人 / 排行榜的曲目行）都有**添加到资料库** / **从资料库中删除**与**添加到歌单**子菜单（新建歌单…，然后是你的歌单，最近修改的在前）。专辑页、歌单页的播放按钮旁有 +，歌曲页有资料库与添加到歌单按钮。与 Apple Music 相同：添加专辑会同时添加其中全部歌曲与 MV；只添加单曲时，它的专辑与艺人也会出现在资料库中；删除专辑会一并删除其中的歌曲；添加 Apple Music 歌单只添加歌单本身（打开的仍是目录中的最新歌单）。歌单里已有的曲目会跳过。
- 资料库页面：歌曲（播放 / 随机播放筛选后的列表，按标题、艺人、专辑、添加时间或时长排序，长列表随滚动渲染）、专辑与音乐视频网格、艺人（列表旁显示所选艺人的专辑与歌曲，手机上点进各艺人）、最近添加、所有歌单。每页都可以筛选，排序方式会记住。
- 歌单（`/library/playlist/p.<id>`）：封面为前四张不同专辑封面拼成的 2×2 图，名称与描述（编辑）、播放 / 随机播放、拖动把手排序（鼠标与触屏相同，把手获得焦点时也可按 ↑ / ↓）、从歌单中删除、复制、导出与删除。歌单保存每首曲目的快照（歌名、艺人、专辑、封面、时长），打开时不需要请求目录，也可以包含不在资料库中的歌曲。
- 导入 / 导出（资料库页面的 ⋯ 菜单）：**导出资料库**保存 `am-hook-library-<日期>.json`，包含全部资料库条目与歌单；**导出歌单**保存单个歌单（`<名称>.am-hook-playlist.json`），方便分享。**导入…** 两种文件都能读：整库文件可以选择合并（保留现有内容，同一 id 的歌单保留较新的一份）或替换；歌单文件直接加入并打开。每一条都会校验：只保留 `/https://music.apple.com/...` 页面链接与 https 图片地址，无效条目跳过，分享来的文件无法注入链接或脚本。**清空资料库…** 确认后删除全部内容。
- 喜爱：与 Apple Music 相同，歌曲、MV、专辑、歌单（Apple Music 歌单与自己的歌单）和艺人都可以喜爱——各处「更多」菜单中的**喜爱** / **取消喜爱**，专辑页与歌单页的 + 旁、歌曲页以及艺人页操作行里的 ☆。喜爱的同时加入资料库（喜爱的艺人即使没有歌曲也会出现在「艺人」中）。喜爱的曲目带星形标记；歌曲、专辑、艺人、音乐视频与所有歌单页面有**喜爱**筛选。**喜爱的歌曲**（`/library/favorite-songs`，在侧边栏中，也排在所有歌单的最前面）是由喜爱的歌曲自动组成的歌单，最近喜爱的在前；取消喜爱即移出，「存储为歌单」可以复制成普通歌单。
- 歌单文件夹（`/library/playlist-folder/f.<id>`）：在「歌单」旁的 + 或 ⋯ 菜单中新建，可以嵌套；自己的歌单与添加的 Apple Music 歌单都能放进去——用**移到文件夹**（「更多」菜单与歌单页），或在侧边栏把歌单、文件夹拖到另一个文件夹上（拖到「歌单」标题上移到最上层）。侧边栏中文件夹在前，可以展开 / 收起（会记住；打开的歌单所在文件夹会自动展开）。文件夹页显示路径、子文件夹与歌单，可以新建歌单、新建文件夹、重命名、移动、导出文件夹与删除文件夹。与 Apple Music 相同，删除文件夹会一并删除其中的全部内容（确认时显示数量）；文件夹不能移到自身或自己的子文件夹里。
- 存储说明：数据按浏览器、按站点地址分开（`http://127.0.0.1:8888` 与 `http://<局域网 IP>:8888` 是两个资料库），换浏览器或地址时请导出再导入。同一浏览器的多个标签页会自动同步。浏览器不允许使用 IndexedDB 时（部分隐私模式），资料库只在本次会话的内存中，资料库页面会给出提示。

文件格式（版本 1）：

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

### 歌曲

- 自动解析全部音质（无损 ALAC / 杜比全景声 / AAC / HE-AAC，含双耳、缩混版本），显示封面、歌名等信息（经服务端 `/amp` 代理请求 Apple Music 目录接口 amp-api）。
- 每个音质的「更多」菜单中有 **下载解密文件**：在浏览器内解密，显示进度，可随时取消。离开歌曲页后下载在后台继续，完成后照常保存；回到该歌曲页时接着显示进度（关闭或刷新标签页会中断）。
- 内置播放器：MSE 加浏览器端解密。浏览器不支持 ALAC 时通过 FLAC-in-MP4 无损播放；EC-3 的 MSE 不可用时回退为多声道 PCM，并提示空间音频限制。下载保留原始编码。支持空格 / 方向键和系统媒体控制。
- 歌词：正在播放的歌曲有歌词时，播放条上出现「歌词」按钮（在任何页面都能打开，切歌后自动换成新歌的歌词）。歌词视图由 [AMLL（Apple Music-like Lyrics）](https://github.com/amll-dev/applemusic-like-lyrics) 渲染：逐词 / 逐行高亮与弹簧滚动、和声、对唱、翻译与发音、间奏圆点，点击任意一行即可跳转。背景是 AMLL 由专辑封面生成的流动网格渐变，也可以选引入 AMLL 前的经典背景（仿 Apple Music 网页版，由多份旋转的封面经扭曲、模糊生成；浏览器不支持 WebGL 时也用它），Esc 收起。点击播放条的封面、标题或空白处展开全屏播放界面（没有歌词的歌曲也能展开，只显示封面与播放控件）。同 music.apple.com，界面里的标题旁有喜爱（☆）与「更多」按钮（添加到资料库、添加到歌单、前往专辑、复制链接）；右下角的歌词按钮（手机上在播放控件下方）显示 / 隐藏歌词；按钮的位置同 music.apple.com——关闭在左上角，歌词翻译在右上角，播放按钮没有底色、居中排成一行，歌名与艺人各占一行、过长时滚动；手机上同官网的手机版：顶部是收起界面的下拉把手，显示歌词时标题行收成一行小封面，底部只有上一首 / 播放 / 下一首，下面是歌词开关与待播清单开关——待播清单占据歌词的位置，随机 / 重复在清单标题旁；隐藏时封面与播放控件居中，这个选择保存在浏览器中。右上角的歌词选项按钮（原来只有翻译菜单）可以切换翻译与发音、调整字号（70%–150%）与字重（细体到特粗）、在 Apple Music 与 [AMLL 歌词库](https://amll.dev/reference/http-api/overview)之间切换歌词来源（由浏览器按 Apple Music 歌曲 ID 直接查询，未收录的歌曲仍用 Apple Music 歌词；不选它时不会向它发送请求）、在 AMLL 与经典背景之间切换，以及下载当前显示的 TTML 歌词；除翻译与发音外都保存在浏览器中。

### MV

- 视频、音频规格分列显示，默认选择最高码率视频和其音频组中的默认音轨；切换视频会更新推荐音轨，也可手动选择音频。
- 播放使用 MediaSource，支持进度跳转和有限缓冲。不支持的编码仍可下载；可选择 AVC/AAC 轨道获得更好的播放兼容性。
- 视频内独立的 CEA-608 字幕轨由前端解码为浏览器原生字幕，默认显示首条字幕，可通过视频字幕菜单切换或关闭。
- 下载逐段解密、按时间交错写入 OPFS 临时文件，不在内存中拼接整部 MV。随后 Worker 把它改写为标准（progressive）MP4，`moov` 位于媒体数据之前；每条轨道切成不超过 1 秒的 chunk 并按时间顺序写入，同一时刻的音频、视频和字幕相邻存放，播放器可以从头到尾顺序读取。不进行转码或写 tag。改写期间两份文件同时存在，OPFS 需要约两倍于 MV 的空间。
- 下载保留 CEA-608 字幕轨。Apple 的字幕轨以一个格式错误的空 sample 开头，新版 FFmpeg 会拒绝它（基于 mpv 的播放器会在播放不久后退出）；下载时会把它原位改写为等长的合法空字幕 sample。
- 完成后自动触发保存，也可点击「保存 MP4」；取消或失败会清理临时文件。离开 MV 页面会停止播放、取消进行中的下载，并尝试清理已完成文件。标签页关闭或崩溃留下的文件会在下次打开 MV 页面时删除（浏览器不支持 Web Locks 时，文件超过 24 小时才会删除）。
- 艺人上传的视频（官网 `post` 页，amp-api 的 `uploaded-videos`，新发现与编辑页中的链接会打开它）使用同一页面。与官网相同，不需要 wrapper-lite 也不需要解密：`assetTokens` 中的每一项都是未加密的标准 MP4（H.264 + AAC，`moov` 在前），由 `<video>` 直接播放。页面按分辨率列出，并显示大小与码率（来自 `HEAD` 请求）；没有单独的音频轨道。下载时把文件原样流式写入 OPFS（不支持 OPFS 时使用内存 Blob）。

## 工作原理

### 歌曲：浏览器端解密

浏览器端流程（`src/ui/decrypt.js`）：

1. 直接从 `aod.itunes.apple.com` 获取 media m3u8（CDN 允许跨域和 Range 请求），解析出 init 段、各分片的字节范围，以及每个分片对应的 key。
2. 首个分片使用内嵌在 wasm 中的固定模板（`skd://itunes.apple.com/P000000000/s1/e1`），其余分片使用经 `/key` 获取的轨道模板。
3. 分片用 Range 请求拉取，交给 Worker 池（每个 Worker 一个 `hook.wasm` 实例）原地解密；解密逻辑位于 `crates/am-mp4`。
4. **播放**：浏览器支持原编码时，解密后的分片直接喂给 MSE。不支持 ALAC 但支持 FLAC-in-MP4 时，按需加载 `flac.wasm`，把 ALAC packet 无损转成 FLAC frame 并重新封装成较小的 fMP4 fragment。EC-3 在 MSE 支持时直接播放，否则按需加载 `ec3.wasm`，通过 Web Audio 播放 5.1/7.1 声道 PCM（不渲染 Atmos 对象）。拖动时直接定位到对应原始分片。
5. **下载**：4 路并发拉取和解密，结果按原始偏移写入 OPFS 临时文件，完成后像参考下载器的 `DefragmentMP4` 那样转为 progressive MP4（`M4A ` ftyp，`moov` 位于媒体数据之前），再交给浏览器保存。不支持 OPFS 时退回内存 Blob。

`hook.wasm` 会在解密后修复可确认的 ALAC 包尾错误（如歌曲 `1691044818`）：根据 init 中的轨道与 sample description，定位 PCM 完整的未压缩单声道／立体声包，将缺失或损坏的 3-bit `TYPE_END` 恢复为 `111`。修复不改变 PCM、sample 长度或 Range 偏移。压缩包、PCM 截断及没有足够尾部空间的包不做原地修复；转 FLAC 时仍保留可追加结束标记的兜底。

box 处理：FairPlay 元数据 box（`sinf`、`senc`、`saiz`、`saio`、`pssh`，以及分组类型为 `seig`/`seam` 的 `sgpd`、`sbgp`）替换为等长的 `free` box，字节长度和 Range 偏移保持不变。init 段中的 `enca` box 改写为原始编码（`ec-3`、`mp4a`、`alac` 等）。

### MV

- `/parse/mv/<adamId>` 从 wrapper-lite `/webplayback` 获取 master 地址，再以 `User-Agent: AM` 获取内容，返回播放列表文本和最终 CDN 地址。
- `/mv/webplayback/<adamId>` 和 `/mv/license` 分别转发到 wrapper-lite `/webplayback` 和 `/license`（只使用 PlayReady；许可证失败会显示错误，不切换其他 DRM）。
- 音视频轨道 m3u8 和分片均由浏览器直连 Apple 获取。
- challenge 构建、license 解析、CENC/CBCS 解密、字幕修复、fragmented MP4 合并以及转为 progressive MP4 在 Worker 中由 `media.wasm` 完成（Rust 实现，见 [crates/am-media](crates/am-media/README.md)）。
- 暂不支持直播、discontinuity 或中途更换初始化段的清单。

## 服务端接口

| 接口 | 说明 |
|---|---|
| `GET /` | 首页。下面的各页面地址与首页一样都返回单页应用 `app.html`，页面内容由前端加载 |
| `GET /https://music.apple.com/<cc>/song/<slug>/<id>` | 歌曲页 |
| `GET /https://music.apple.com/<cc>/music-video/<slug>/<id>` | MV 页 |
| `GET /https://music.apple.com/<cc>/post/<id>` | 艺人上传的视频（MV 页） |
| `GET /status` | wrapper-lite 状态与可用地区 |
| `GET /parse/song/<adamId>` | 通过 wrapper-lite 获取歌曲 master m3u8，返回各音质变体 |
| `GET /key?adamId=<adamId>&uri=<skd-uri>` | 转发 wrapper-lite `/key` 返回的歌曲轨道解密模板 JSON |
| `GET /lyrics/<adamId>?language=<语言>` | 通过 wrapper-lite `/lyrics` 获取 TTML 歌词，原样返回 XML；没有歌词时返回 404。`language` 可选，为歌曲所在地区的曲库语言（选定的语言，否则为地区默认语言，如 `zh-Hans-CN`） |
| `GET /parse/mv/<adamId>` | MV master 播放列表文本与最终 CDN 地址 |
| `GET /https://music.apple.com/<cc>/album/<slug>/<id>` | 专辑页（与 music.apple.com 相同的 `editorialVideo` 动态封面：宽屏方形、手机全宽 3:4；曲目列表、连续播放、相关推荐货架；数据来自与 music.apple.com 相同的 amp-api `albums` 请求）。带 `?i=` 的专辑链接与 music.apple.com 一样打开专辑页，选中（高亮）该曲目并滚动到它 |
| `GET /https://music.apple.com/<cc>/playlist/<slug>/<pl.id>` | 歌单页（编辑歌单与公开的用户歌单：与专辑页相同的动态封面；曲目带封面、艺人、专辑列；连续播放；精选艺人、策展人的更多歌单货架；数据来自与 music.apple.com 相同的 amp-api `playlists` 请求，经 `/amp` 获取） |
| `GET /https://music.apple.com/<cc>/artist/<slug>/<id>` | 艺人页（与 music.apple.com 相同的头部：按目录数据显示动态视频、通栏图片或圆形头像；最新发行、歌曲排行与连续播放、专辑 / MV / 歌单 / 相似艺人货架与「显示全部」、艺人简介；数据来自与 music.apple.com 相同的 amp-api `artists` 请求，经 `/amp` 获取）。歌曲页、MV 页、专辑页的艺人名（多位艺人时各自单独链接）与艺人货架都链接到这里 |
| `GET /library[/<分类>]`、`GET /library/artists/<名称>`、`GET /library/playlist/p.<id>`、`GET /library/favorite-songs`、`GET /library/playlist-folder/f.<id>` | 资料库页面（分类 `recently-added`、`artists`、`albums`、`songs`、`music-videos`、`all-playlists`）、本地歌单、喜爱的歌曲与歌单文件夹。服务端只返回单页应用，资料库数据保存在浏览器的 IndexedDB 中（`src/ui/library.mjs`） |
| `GET /new` | 新发现（侧边栏的「新发现」）：与 music.apple.com/{cc}/new 相同的编辑区块（amp-api `editorial/{cc}/groupings?name=music`），使用主地区，切换后重新加载——hero 大卡、四行曲目货架、专辑 / 歌单 / 电台 / 视频货架（列数与官网 shelf-grid 相同）与「探索更多」链接；`/https://music.apple.com/<cc>/new` 为固定地区 |
| `GET /new/top-charts[/<kind>]` | 排行榜（新发现「探索更多」中的链接，与 music.apple.com/{cc}/new/top-charts 相同，amp-api `catalog/{cc}/charts`，使用主地区）：带名次的热门歌曲（三行）、城市排行榜、每周热门 100 首，以及带名次的热门歌单 / 专辑 / 视频。各榜单的「查看全部」（`songs`、`playlists`、`albums`、`music-videos`，另有 `city-charts`、`daily-global-top-charts`）列出整个榜单并滚动分页，歌曲与歌单页的榜单行相同；歌曲、专辑、视频榜可按类型筛选（`?genreId=`，类型来自 `catalog/{cc}/genres`）；`/https://music.apple.com/<cc>/new/top-charts[/<kind>]` 为固定地区 |
| `GET /https://music.apple.com/<cc>/room/<id>`、`.../multi-room/<id>`、`.../grouping/<id>`、`.../curator/<slug>/<id>` | 编辑页，路由与 music.apple.com 相同：room 为区块的「查看全部」（全部内容的网格，滚动时分页加载）；multi-room（`editorial/{cc}/multirooms`，头图 + 区块）、grouping（`editorial/{cc}/groupings/{id}`，如「音乐视频」与各风格页）与 curator（`catalog/{cc}?ids[apple-curators]=`：其分组的区块，或全部歌单）沿用新发现的排版。编辑数据中的旧式链接（`collection/...?fcId=`、`viewGrouping?id=`、`viewFeature?id=`）在站内打开这些页面；电台等本站无法打开的内容链接到 Apple Music。在首页粘贴这些链接同样可以打开 |
| `GET /amp/v1/catalog/<path>?<query>` | 代理 Apple Music 目录接口（`amp-api-edge.music.apple.com/v1/catalog/...`，首页搜索使用），自动附带 music.apple.com 网页版 developer token，查询参数原样转发。使用启动时预热的专用 HTTP/2 连接，缓存成功响应，合并相同的并发请求，并通过 `Server-Timing` 标明缓存命中（`cache;desc=hit/miss/shared`）与上游耗时 |
| `GET /amp/v1/editorial/<path>?<query>` | 代理编辑内容接口（`amp-api-edge.music.apple.com/v1/editorial/...`：groupings、rooms、multirooms，新发现与编辑页使用），方式与 `/amp/v1/catalog` 相同，共用连接与缓存 |
| `GET /amp/v1/storefronts` | amp-api 全部地区信息（查询参数原样转发，以便跟随分页 `next`）；页面只拉取一次并保存在 localStorage（超过 30 天后在后台刷新），用于主地区列表与曲库语言的可选项（各地区的 `supportedLanguageTags`）（地区不支持的 `l` 会被静默回退到默认语言，如 `cn` 只支持 `zh-Hans-CN` / `en-GB`） |
| `GET /mv/webplayback/<adamId>`、`POST /mv/license` | MV 转发到 wrapper-lite `/webplayback` 与 `/license` |
| `/assets/...` | 内嵌在二进制中的前端路由、页面视图（`/assets/views/`）、脚本、样式与按需加载的 WASM（`no-cache` + ETag） |

## 命令行参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-l, --listen <ADDR>` | `0.0.0.0:8888` | 监听地址 |
| `-p, --port <PORT>` | 可选 | 设置时覆盖 `--listen` 中的端口 |
| `-w, --wrapper-url <URL>` | `http://127.0.0.1:12340` | wrapper-lite 密钥服务地址 |
| `--wrapper-rate <N>` | `24` | 每秒发往 wrapper-lite 的最大请求数（任意 1 秒内，超出的请求按顺序排队）。0 不限 |
| `--wrapper-concurrency <N>` | `24` | 同时进行的 wrapper-lite 请求上限。0 不限。wrapper-lite 运行在 QEMU 中、负载高时请求超时的话可调低（如 `8`） |
| `--wrapper-auth <VALUE>` | 不发送 | wrapper-lite 请求的 `Authorization` 头。只填 token 时自动加 `Bearer ` 前缀；已带认证方案（`Bearer …`、`Basic …`）则原样发送。也可用环境变量 `AM_HOOK_WRAPPER_AUTH` 设置（不会出现在进程列表中） |
| `--amp-keepalive <SECONDS>` | `30` | amp-api 连接保活：空闲达到该时长时发送一个轻量请求（0 关闭）。无论是否开启，启动时都会先获取 token 并建立连接 |
| `--amp-cache-mb <MB>` | `32` | amp-api 响应缓存（目录 5 分钟、地区表 24 小时；0 关闭）。相同的并发请求始终只请求一次上游 |

## 构建

```sh
cargo build --release
```

二进制位于 `target/release/am-hook`（Windows 下为 `am-hook.exe`）。浏览器端资源（包括预编译的 WASM）都提交在 `src/ui/` 下并内嵌进二进制，普通构建只需要 Rust。只有修改对应源码后才需要重新生成：

| 产物 | 源码 | 重新生成 |
|---|---|---|
| `hook.wasm`、`flac.wasm`、`media.wasm` | `crates/am-wasm`、`crates/am-flac-wasm`、`crates/am-media-wasm`（及 `am-mp4`、`am-alac`、`temari`、`am-media`） | `rustup target add wasm32-unknown-unknown` 后运行 `scripts/build-wasm.sh` |
| `mv-cea608.mjs` | `browser/cea608` | `node scripts/build-cea608.cjs <typescript 包路径>` |
| `lyrics/amll-core.mjs`、`lyrics/amll.css` | `@applemusic-like-lyrics/core`，见 [browser/amll](browser/amll/README.md) | `node scripts/build-amll.cjs <node_modules 路径>` |
| `ec3.wasm`、`ec3-runtime.mjs` | `@mediabunny/ac3` 1.59.1 | `node scripts/extract-ec3.mjs`，见 [EC3-SOURCE.md](src/ui/EC3-SOURCE.md) |

## 测试

```sh
cargo test --workspace
```

单元测试覆盖浏览器媒体核心（PlayReady license 解密、CENC/CBCS、字幕修复、defrag）、URL 解析、m3u8 解析、MP4 box 修补（含 wasm 原地解密路径与并行路径结果一致）、缓存去重和 MV 接口。离线集成测试还检查 Apple CDN 地址不会被代理。

需要真实 Apple CDN 或 wrapper-lite 的测试默认忽略，不在 GitHub Actions 中运行。请在本地能访问 Apple CDN 且 wrapper-lite 已启动时运行（默认 `http://127.0.0.1:12340`，可用环境变量 `AM_HOOK_WRAPPER` 覆盖）：

```sh
cargo test --test e2e_test -- --ignored
```

这些测试验证歌词。

浏览器端测试是普通的 Node 脚本：

| 类型 | 命令 |
|---|---|
| 离线，仅需 Node | `node --test tests/player_*.cjs`、`node tests/mv_hls.cjs`、`node tests/mv_captions.cjs` |
| 离线，Playwright + Chrome 与本地 fixture | `node tests/ui_layout.cjs <playwright>`、`node tests/lyrics_ui.cjs <playwright>`、`node tests/mv_ui.cjs <playwright>`、`node tests/library_ui.cjs <playwright>`（资料库与歌单：添加、歌单、排序、刷新后保留、导出 / 导入与文件校验、喜爱、文件夹与拖放、数据库升级） |
| 在线（需运行 am-hook、wrapper-lite 并能访问 Apple CDN） | `node tests/mv_live.cjs <playwright> [base]`、`node tests/mv_captions_live.cjs <playwright> [base]`、`node tests/alac_recovery.cjs <playwright>`、`node tests/alac_source_recovery.cjs <playwright>`、`node tests/search_ui.cjs <playwright> [base]`、`node tests/album_ui.cjs <playwright> [base]`、`node tests/playlist_ui.cjs <playwright> [base]`、`node tests/artist_ui.cjs <playwright> [base]`、`node tests/browse_ui.cjs <playwright> [base]`（需能访问 music.apple.com）、`node tests/app_ui.cjs <playwright> [base]`（单页应用：跳转后继续播放、队列、前进 / 后退、歌词） |

`<playwright>` 为 Playwright 包路径；在线测试的 `[base]` 省略时：MV 测试默认 `http://127.0.0.1:18888`，其余测试默认 `AM_HOOK_URL` 或 `http://127.0.0.1:8888`（ALAC 测试只读 `AM_HOOK_URL`）。

## 项目结构

```
src/
  cli.rs               命令行参数解析
  main.rs              服务启动
  lib.rs               路由构建
  amp.rs               amp-api 目录接口代理（自动获取并刷新 music.apple.com 网页版 developer token）
  log.rs               请求日志
  m3u8.rs              Apple Music 链接解析、HLS 播放列表解析和加密标记剥离
  state.rs             配置与共享客户端
  wrapper.rs           wrapper-lite 请求客户端（master m3u8、解密模板、歌词）
  ui.rs                Web 接口（状态、解析、模板、歌词、MV 转发、静态资源；fallback 为 Apple Music 页面路径返回单页应用）
  ui/
    app.html / app.mjs 单页应用：常驻播放条与歌词界面；前端路由接管站内链接并切换页面视图
    views/             页面视图：<name>.html 页面内容、<name>.mjs 页面脚本（home / song / mv / album / playlist / artist / browse：新发现与编辑页，样式在 browse.css）
    app.css / mv.css   样式
    i18n.js            中英文文案；主地区与曲库语言设置
    settings.mjs       主地区 / 曲库语言选择面板
    library.mjs        资料库与歌单的存储（IndexedDB、标签页间同步、导入 / 导出格式与校验）；页面在 views/library*.mjs，共用的对话框与菜单在 views/library-ui.mjs
    player.js          歌曲播放器（MSE）与播放队列；页面视图经 scope() 使用常驻的播放器
    motion-art.mjs     专辑、歌单、艺人页的动态封面（editorialVideo HLS，MSE 播放）
    decrypt.js         歌曲解密：m3u8 解析、Worker 池、模板、下载与 OPFS
    hook-worker.js     Worker：调用 wasm 解密、写入 OPFS
    hook.wasm          crates/am-wasm 的编译产物
    flac.wasm / flac-transcode-worker.js / flac-init.bin   ALAC 转 FLAC 播放
    ec3.wasm / ec3-runtime.mjs / ec3-decode-worker.js      EC-3 PCM 回退
    lyrics/            歌词界面（打包好的 AMLL，见 browser/amll；ttml.mjs 解析 TTML，panel.mjs 接入播放器，backdrop*.mjs 绘制经典背景）
    mv-hls.mjs / mv-engine.mjs                            MV 清单解析、播放与下载
    media-worker.js / media.wasm                          MV 与歌曲 defrag 共用的 Worker；crates/am-media-wasm 的编译产物
    mv-captions.mjs / mv-cea608.mjs                       CEA-608 字幕
crates/
  am-mp4/              ISOBMFF 解析、box 修补、sample 解密（服务端与 wasm 共用）；内嵌首段固定模板
  am-alac/             保守的 ALAC 包尾修复
  am-wasm/             am-mp4 的浏览器端 C ABI 导出（wasm32-unknown-unknown）
  am-flac-wasm/        浏览器端 ALAC 解码与 FLAC frame 写入
  am-media/            浏览器媒体核心：PlayReady、CENC/CBCS、字幕修复、MP4 合并与 defrag
  am-media-wasm/       am-media 的浏览器端 C ABI 导出
  temari/              内置的 Temari FairPlay 解密库
browser/
  cea608/              来自 hls.js 的 CEA-608 解析器
  amll/                AMLL 歌词播放器的打包入口与构建说明
scripts/               WASM / 资源构建脚本
tests/                 Rust 集成测试与 Node 浏览器测试（app.cjs 为打开页面的公用函数）
```

## 许可证

am-hook 以 [GNU Affero 通用公共许可证 v3.0（仅此版本）](LICENSE)（AGPL-3.0-only）发布，因为 Web 界面内嵌了以 AGPL 授权的 [AMLL](https://github.com/amll-dev/applemusic-like-lyrics) 歌词播放器。如果将修改后的版本作为网络服务运行，需要向其用户提供对应的源代码。

内置的第三方组件保留各自的许可证：`crates/temari`（MIT）、hls.js CEA-608 解析器（Apache-2.0，`browser/cea608/LICENSE`）、`@mediabunny/ac3`（MPL-2.0，`src/ui/EC3-LICENSE.txt`），以及 AMLL 及其依赖（AGPL-3.0-only，`browser/amll`）。
