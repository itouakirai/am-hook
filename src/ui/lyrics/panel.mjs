/*
 * 在线播放的歌词界面：用 AMLL（Apple Music-like Lyrics，见 browser/amll）显示歌词，接到 AmPlayer 上。
 *
 *   歌词     AmWrapper.lyrics()：wrapper-lite /lyrics 的 TTML 原文（经服务端 GET /lyrics/<adamId>?language=<曲库语言>，或浏览器直连本地 wrapper-lite），
 *            language 取歌曲所在地区的曲库语言（AmI18n.catalogLang：选定的语言，否则为地区默认语言），取不到时不传；首次打开歌词界面时才请求并缓存；没有歌词时隐藏按钮。
 *            歌词来源选 AMLL 歌词库时先由浏览器直接请求 AMLL TTML DB（https://amll.dev/reference/http-api/overview，允许跨域）的
 *            GET /v1/lyrics/get?appleMusicId=<adamId>，未收录或请求失败时仍用上面的 Apple Music 歌词。
 *            ttml.mjs 解析 TTML，toAmllLines() 转成 AMLL 的 LyricLine
 *   选项     原来的「歌词翻译」按钮弹出的菜单：翻译 / 发音、字号、字重、歌词来源、背景、下载当前显示的 TTML；除翻译 / 发音外都保存在浏览器中
 *   时间     每帧把 player.transport().currentTime 交给 DomLyricPlayer，点击歌词行跳转并继续播放
 *   背景     歌曲页已有的专辑封面，交给 AMLL 的 MeshGradientRenderer 生成流动背景（浏览器不支持 WebGL 时改用经典背景），
 *            或在菜单里选经典背景：引入 AMLL 前的 ArtworkBackdrop（backdrop.mjs，仿 Apple Music 网页版的旋转封面）
 *
 * 歌词界面只在打开时运行动画循环；关闭后停止，背景保留最后一帧。
 *
 * 同 music.apple.com 的全屏播放界面：点击播放条（封面、标题、空白处）总能展开，没有歌词的歌曲只显示封面与播放控件；
 * 展开后播放条上的歌词按钮（随播放条并入界面，固定在右下角，手机上在控件下方）改为显示 / 隐藏歌词，隐藏时封面与控件居中，这个选择保存在浏览器中。
 */
import { parseTTML } from './ttml.mjs';
import { DomLyricPlayer, BackgroundRender, MeshGradientRenderer } from './amll-core.mjs';
import { ArtworkBackdrop } from './backdrop.mjs';

const validTokens = (voice) => voice.tokens.filter((token) => token.begin !== 0 || token.end !== 0);
const plainText = (voice) => validTokens(voice).map((t) => t.text + (t.spaceAfter ? ' ' : '')).join('').trim() || voice.text;
const same = (a, b) => a.replace(/[()]/g, '').trim().toLowerCase() === b.replace(/[()]/g, '').trim().toLowerCase();

/* 歌词翻译按钮与菜单的图标，取自 music.apple.com：按钮图标（17×16，路径坐标经 translate(-.51 4.44) scale(.101)），
 * 菜单项图标（显示 / 隐藏翻译按页面语言显示「文」或「A」，见 app.css 的 .lang-zh / .lang-en） */
const TRANSLATE_PATHS = ["M12.46-.44c0-12.76 8.13-20.17 20.37-20.17h47.4c12.24 0 20.4 7.41 20.4 20.17v4.47H98.3c-1.98 0-3.83.18-5.55.52v-4.7c0-8.62-4.82-13.14-13-13.14H33.3c-8.13-.01-13 4.52-13 13.14v28.34c0 8.62 4.88 13.04 12.99 13.04h5.16c2.07 0 3.76 1.24 3.76 4v12.32l15.71-14.03c1.92-1.7 3.1-2.3 5.76-2.3h14.24v7.37H63.37l-16.3 13.92c-2.92 2.56-4.53 3.87-6.9 3.87-3.41 0-5.27-2.38-5.27-6.07V48.59h-2.07c-12.24 0-20.37-7.39-20.37-20.2z","M39.43 28.52c-1.04 2.73.48 5.21 3.3 5.21 1.85 0 3-.98 3.71-3.05l2.96-8.6h14.37l3.01 8.6c.66 2.07 1.8 3.05 3.68 3.05 2.87 0 4.3-2.5 3.34-5.2L61.7-3.8c-.88-2.4-2.66-3.71-5.16-3.71-2.47 0-4.25 1.3-5.13 3.7L39.43 28.53ZM51.4 16.07l5.14-14.95 5.2 14.95H51.41Zm80.04 71.09-16.31-13.93H98.3c-12.77 0-20.38-7.38-20.38-20.13V24.2c0-12.77 7.6-20.17 20.38-20.17h47.38c12.24 0 20.37 7.4 20.37 20.16v28.83c0 12.81-8.13 20.2-20.37 20.2h-2.02v11.72c0 3.69-1.92 6.07-5.26 6.07-2.39 0-3.98-1.3-6.97-3.85Zm-6.9-66.08-2.42-4.92c-.93-1.85-2.8-2.68-4.58-1.7a3.35 3.35 0 0 0-1.55 4.57l2.37 4.97a3.35 3.35 0 0 0 4.47 1.66c1.84-.9 2.53-2.87 1.7-4.58Zm-21.63 9.57c0 1.87 1.5 3.25 3.46 3.25h3.74a32.44 32.44 0 0 0 7.25 13.18 35.9 35.9 0 0 1-11.69 4.86c-1.87.45-3 2.25-2.62 4.22.55 1.93 2.5 2.8 4.6 2.23a38.7 38.7 0 0 0 14.74-6.69 38.3 38.3 0 0 0 14.14 6.69c2.42.52 4.41-.2 4.9-2.23.6-2.12-.37-3.77-2.5-4.22a34.4 34.4 0 0 1-11.64-4.86 30.5 30.5 0 0 0 7.2-13.18h3.74c2.02 0 3.5-1.38 3.5-3.25s-1.48-3.26-3.5-3.26h-31.86c-1.97 0-3.46 1.4-3.46 3.26m19.48 12.3a26.45 26.45 0 0 1-5.46-9.05h10.74a27.3 27.3 0 0 1-5.28 9.05"];
const MENU_ICONS = {
  showTranslation: '<svg width="16" height="16" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2" viewBox="0 0 133 133"><g fill-rule="nonzero"><path d="M45.928,39.077L86.723,39.077C88.495,39.077 89.739,37.958 89.739,36.341C89.739,34.724 88.444,33.594 86.723,33.594L45.928,33.594C44.218,33.594 42.974,34.724 42.974,36.341C42.974,37.958 44.166,39.077 45.928,39.077ZM58.696,54.689L64.254,54.689C67.361,54.689 69.32,52.69 69.32,49.583L69.371,32.875L78.698,26.305C79.828,25.569 80.295,24.449 80.295,23.402C80.295,21.732 79.019,20.219 76.863,20.219L54.156,20.219C52.239,20.219 50.85,21.483 50.85,23.173C50.85,24.893 52.187,26.064 54.156,26.064L76.739,26.064L76.739,21.867L65.538,29.618C63.785,30.81 63.267,32.158 63.267,34.356L63.319,48.843L58.696,48.843C56.769,48.843 55.442,50.025 55.442,51.746C55.442,53.456 56.79,54.689 58.696,54.689ZM45.94,23.567C47.609,23.567 48.698,22.334 48.698,20.521L48.698,16.318L83.859,16.318L83.859,20.521C83.859,22.344 84.968,23.567 86.595,23.567C88.264,23.567 89.384,22.334 89.384,20.521L89.384,13.571C89.384,11.965 88.109,10.886 86.388,10.886L46.251,10.886C44.437,10.886 43.193,11.965 43.193,13.571L43.193,20.521C43.193,22.334 44.282,23.567 45.94,23.567ZM64.575,13.977L70.182,11.925L67.803,5.255C67.181,3.669 65.482,2.902 63.906,3.462C62.341,4.021 61.574,5.721 62.123,7.359L64.575,13.977Z" class="lang-zh" transform="translate(-14.82 19.351) scale(1.2236)"/><path d="M50.179,51.898C51.951,51.898 53.184,51.038 53.961,48.769L57.507,38.396L74.958,38.396L78.545,48.769C79.271,51.028 80.514,51.898 82.297,51.898C84.483,51.898 85.913,50.53 85.913,48.51C85.913,47.784 85.747,47.049 85.364,46.003L71.682,9.117C70.75,6.599 68.854,5.304 66.181,5.304C63.559,5.304 61.767,6.599 60.783,9.117L47.091,46.003C46.759,47.049 46.593,47.784 46.593,48.499C46.593,50.541 48.023,51.898 50.179,51.898ZM59.466,32.499L65.953,13.628L66.502,13.628L72.988,32.499L59.466,32.499Z" class="lang-en" transform="translate(-14.82 19.351) scale(1.2236)"/></g></svg>',
  hideTranslation: '<svg width="16" height="16" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2" viewBox="0 0 133 133"><g fill-rule="nonzero"><path d="M63.055,74.43L63.097,86.115L57.441,86.115C55.083,86.115 53.459,87.562 53.459,89.668C53.459,91.76 55.108,93.269 57.441,93.269L64.241,93.269C68.043,93.269 70.44,90.823 70.44,87.021L70.456,81.813L63.055,74.43ZM56.065,67.457L41.818,67.457C39.725,67.457 38.203,68.84 38.203,70.818C38.203,72.797 39.662,74.166 41.818,74.166L62.79,74.166L56.065,67.457ZM87.718,67.457L93.881,73.613C94.841,73.035 95.425,72.044 95.425,70.818C95.425,68.84 93.84,67.457 91.734,67.457L87.718,67.457ZM71.332,51.091L80.081,59.83L81.915,58.538C83.298,57.638 83.869,56.267 83.869,54.986C83.869,52.943 82.308,51.091 79.67,51.091L71.332,51.091ZM63.233,39.671L59.899,39.671L66.553,46.318L88.23,46.318L88.23,51.461C88.23,53.691 89.587,55.188 91.578,55.188C93.62,55.188 94.99,53.679 94.99,51.461L94.99,42.957C94.99,40.992 93.43,39.671 91.324,39.671L63.233,39.671L71.041,39.671L68.584,32.781C67.823,30.841 65.744,29.902 63.815,30.587C61.901,31.271 60.962,33.352 61.634,35.356L63.233,39.671ZM41.832,55.188C42.422,55.188 42.952,55.062 43.408,54.83L38.471,49.905L38.471,51.461C38.471,53.679 39.804,55.188 41.832,55.188Z" class="lang-zh"/><path d="M50.819,62.224L43.241,82.64C42.834,83.92 42.631,84.82 42.631,85.695C42.631,88.193 44.381,89.854 47.019,89.854C49.187,89.854 50.696,88.801 51.647,86.025L55.986,73.333L61.955,73.333L50.819,62.224ZM59.382,39.155L59.994,37.507C61.198,34.426 63.391,32.841 66.599,32.841C69.87,32.841 72.19,34.426 73.33,37.507L82.51,62.256L68.944,48.706L66.992,43.027L66.32,43.027L65.538,45.303L59.382,39.155Z" class="lang-en"/></g></svg>',
  showPronunciation: '<svg width="17" height="16" viewBox="0 0 17 16"><path d="M3.95 15.45c.16.19.38.28.66.28.2 0 .4-.05.57-.16.17-.1.38-.26.62-.48l2.43-2.23h4.4a3.7 3.7 0 0 0 1.8-.4c.5-.28.88-.67 1.14-1.19.26-.5.4-1.13.4-1.86v-5.7c0-.72-.14-1.34-.4-1.85s-.64-.9-1.14-1.18a3.7 3.7 0 0 0-1.8-.41H3.37a3.7 3.7 0 0 0-1.82.4C1.06.96.7 1.36.43 1.87c-.26.5-.4 1.13-.4 1.86v5.7c0 .72.14 1.34.4 1.85.27.52.64.9 1.13 1.18.5.27 1.08.41 1.77.41h.38v1.8c0 .34.08.6.24.79Zm3.27-3.52L5 14.26v-2.11c0-.23-.05-.38-.14-.47-.1-.1-.24-.14-.44-.14h-.96c-.67 0-1.16-.17-1.48-.52-.32-.35-.48-.87-.48-1.56V3.81c0-.68.16-1.2.48-1.55.32-.34.81-.52 1.48-.52h9.1c.66 0 1.16.18 1.48.52.32.35.48.87.48 1.55v5.65c0 .7-.16 1.2-.48 1.56-.32.35-.82.52-1.48.52H8.16c-.22 0-.39.03-.52.08s-.27.15-.42.31Zm-4.29-6.5c0-.41.32-.74.7-.74h4.39c.39 0 .7.33.7.73 0 .4-.31.74-.7.74H3.64a.72.72 0 0 1-.7-.74Zm.7 1.46c-.38 0-.7.34-.7.74 0 .4.32.74.7.74h1.5c.38 0 .7-.33.7-.74 0-.4-.32-.74-.7-.74h-1.5Zm6.54-1.47c0-.4.32-.73.7-.73h1.5c.38 0 .7.33.7.73 0 .4-.32.74-.7.74h-1.5a.72.72 0 0 1-.7-.74ZM7.98 6.9c-.39 0-.7.34-.7.74 0 .4.31.74.7.74h2.21c.39 0 .7-.33.7-.74 0-.4-.31-.74-.7-.74H8Z"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M6.3 13.2c-.3 0-.52-.12-.72-.36L2.3 8.9a.9.9 0 0 1-.22-.57c0-.45.33-.77.78-.77.27 0 .46.1.64.32l2.77 3.4 5.42-8.5c.19-.3.39-.42.69-.42.45 0 .77.31.77.75 0 .17-.06.35-.18.54L7.03 12.8c-.17.26-.41.4-.73.4Z"/></svg>',
  download: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 10.9c-.2 0-.37-.08-.53-.23L4.4 7.7a.7.7 0 0 1-.22-.5c0-.4.3-.7.7-.7.2 0 .38.08.5.22l1.4 1.48.52.6-.05-1.27V1.75c0-.42.33-.75.75-.75s.76.33.76.75v5.78l-.05 1.27.52-.6 1.4-1.48a.68.68 0 0 1 .5-.22c.4 0 .7.3.7.7 0 .2-.07.36-.22.5l-3.07 2.97c-.16.15-.33.23-.53.23ZM3.3 15c-1.53 0-2.3-.76-2.3-2.28V10.4c0-.42.33-.75.75-.75s.75.33.75.75v2.3c0 .52.28.79.8.79h9.4c.52 0 .8-.27.8-.79v-2.3c0-.42.33-.75.75-.75s.75.33.75.75v2.32C15 14.24 14.23 15 12.7 15H3.3Z"/></svg>',
  minus: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.75 8.75a.75.75 0 0 1 0-1.5h10.5a.75.75 0 0 1 0 1.5H2.75Z"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 14c-.42 0-.75-.33-.75-.75v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5a.75.75 0 0 1 1.5 0v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5c0 .42-.33.75-.75.75Z"/></svg>',
  hidePronunciation: '<svg width="16" height="16" viewBox="0 0 16 16" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2"><path d="m.93 2.9 1.19 1.19-.02.03c-.31.38-.47.92-.47 1.6v6.34c0 .77.2 1.35.57 1.74.38.39.96.58 1.74.58h1.14c.23 0 .4.05.51.15.1.1.16.28.16.53v2.37l2.63-2.6c.18-.19.35-.3.5-.36.15-.06.35-.09.6-.09h2.94l1.64 1.64H9.57l-2.84 2.51c-.28.25-.52.43-.73.55-.2.12-.42.18-.65.18-.34 0-.6-.1-.78-.32a1.3 1.3 0 0 1-.28-.88v-2.04h-.45c-.8 0-1.49-.16-2.06-.47a3.17 3.17 0 0 1-1.32-1.33 4.43 4.43 0 0 1-.46-2.1V5.67c0-.82.15-1.52.46-2.1.13-.25.28-.47.47-.67ZM1.04 0c.19 0 .34.07.48.2l16.72 16.7c.13.14.2.3.2.48s-.07.33-.2.46a.6.6 0 0 1-.47.2.64.64 0 0 1-.47-.2L.57 1.14A.64.64 0 0 1 .38.65C.38.47.45.32.58.2.7.07.85 0 1.03 0ZM14.7 1.77c.83 0 1.54.16 2.12.47.58.3 1.02.75 1.33 1.33.3.58.45 1.28.45 2.1v6.45c0 .82-.15 1.52-.45 2.1-.14.26-.3.49-.5.7l-1.19-1.2.05-.05c.3-.38.46-.92.46-1.61V5.72c0-.76-.2-1.34-.57-1.73-.38-.39-.96-.58-1.75-.58h-8.5L4.5 1.77h10.2ZM6.36 9.08a.83.83 0 1 1 0 1.66H4.71a.83.83 0 1 1 0-1.66h1.65Zm5.53 0c.46 0 .83.37.83.83v.07l-.9-.9h.07ZM4.4 6.38 6 7.97H4.7a.83.83 0 0 1-.3-1.6Zm9.7-.06a.83.83 0 1 1 0 1.66h-1.66a.83.83 0 1 1 0-1.66h1.66Zm-4.42 0a.83.83 0 0 1 .68 1.3l-1.3-1.3h.62Z" style="fill-rule:nonzero" transform="translate(.4 .14) scale(.81615)"/></svg>',
};

const SVG = 'http://www.w3.org/2000/svg';
const svgNode = (name, attrs) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/* 歌词开关的图标，取自 music.apple.com 的 toggle-button--lyrics（64×64）：未显示歌词时为空心气泡，显示时为实心气泡 */
const LYRICS_PATHS = {
  off: 'M18.53 62.724c1.764 0 3.115-.81 5.257-2.707l9.816-8.638h16.62c8.72 0 13.777-5.152 13.777-13.777V15.053c0-8.625-5.056-13.777-13.777-13.777H13.777C5.057 1.276 0 6.42 0 15.053v22.549c0 8.633 5.27 13.777 13.456 13.777h1.016v6.793c0 2.812 1.511 4.552 4.057 4.552zm1.57-7.16v-8.11c0-1.81-.805-2.485-2.486-2.485h-3.55c-5.165 0-7.654-2.603-7.654-7.654V15.34c0-5.033 2.489-7.632 7.654-7.632h35.872c5.149 0 7.654 2.599 7.654 7.632v21.975c0 5.051-2.505 7.654-7.654 7.654H33.188c-1.835 0-2.702.33-4.012 1.65zm-2.212-32.177c0 3.398 2.156 5.936 5.388 5.936 1.361 0 2.592-.302 3.372-1.263h.385c-.868 2.231-3 3.845-5.303 4.4-.95.243-1.327.737-1.327 1.425 0 .8.658 1.36 1.51 1.36 3.174 0 8.8-3.775 8.8-10.6 0-4.138-2.602-7.336-6.588-7.336-3.576 0-6.237 2.518-6.237 6.078m15.663 0c0 3.398 2.134 5.936 5.387 5.936 1.34 0 2.593-.302 3.373-1.263h.39c-.865 2.231-3.023 3.845-5.308 4.4-.947.243-1.327.737-1.327 1.425 0 .8.636 1.36 1.51 1.36 3.178 0 8.779-3.775 8.779-10.6 0-4.138-2.577-7.336-6.567-7.336-3.577 0-6.237 2.518-6.237 6.078',
  on: 'M17.347 62.821c1.254 0 2.21-.572 3.705-1.933L31.78 51.26h18.443C58.943 51.26 64 46.13 64 37.504V14.956C64 6.33 58.944 1.179 50.223 1.179H13.777C5.057 1.179 0 6.322 0 14.956v22.548C0 46.137 5.27 51.26 13.456 51.26h.994v8.327c0 1.97 1.095 3.235 2.897 3.235zm-.108-39.64c0-3.71 2.79-6.37 6.53-6.37 4.18 0 6.89 3.383 6.89 7.694 0 7.102-5.871 11.086-9.19 11.086-.917 0-1.596-.593-1.596-1.43 0-.742.387-1.242 1.403-1.474 2.4-.587 4.629-2.31 5.53-4.606h-.407c-.823.983-2.108 1.318-3.512 1.318-3.417 0-5.648-2.669-5.648-6.217zm16.387 0c0-3.71 2.77-6.37 6.508-6.37 4.18 0 6.912 3.383 6.912 7.694 0 7.102-5.871 11.086-9.179 11.086-.928 0-1.617-.593-1.617-1.43 0-.742.39-1.242 1.392-1.474 2.436-.587 4.654-2.31 5.551-4.606h-.407c-.823.983-2.108 1.318-3.523 1.318-3.405 0-5.637-2.669-5.637-6.217z',
};
/* 待播清单开关的图标，取自 music.apple.com 的 toggle-button--queue（64×64，遮罩为 20×20） */
const QUEUE_PATH = 'M19.489 16.272h41.284A3.204 3.204 0 0 0 64 13.046a3.203 3.203 0 0 0-3.227-3.222H19.49a3.2 3.2 0 0 0-3.226 3.222 3.2 3.2 0 0 0 3.226 3.226zm0 18.954h41.284A3.207 3.207 0 0 0 64 32a3.206 3.206 0 0 0-3.227-3.226H19.49A3.204 3.204 0 0 0 16.263 32a3.204 3.204 0 0 0 3.226 3.226m0 18.95h41.284A3.203 3.203 0 0 0 64 50.954a3.204 3.204 0 0 0-3.227-3.226H19.49a3.2 3.2 0 0 0-3.226 3.226 3.2 3.2 0 0 0 3.226 3.222zM4.636 17.682c2.54 0 4.632-2.091 4.632-4.636 0-2.54-2.092-4.631-4.632-4.631C2.092 8.415 0 10.506 0 13.046c0 2.545 2.092 4.636 4.636 4.636m0 18.954c2.54 0 4.632-2.091 4.632-4.636s-2.092-4.636-4.632-4.636C2.092 27.364 0 29.455 0 32s2.092 4.636 4.636 4.636m0 18.95c2.54 0 4.632-2.092 4.632-4.632 0-2.545-2.092-4.636-4.632-4.636C2.092 46.318 0 48.409 0 50.954c0 2.54 2.092 4.631 4.636 4.631z';

/**
 * 歌词翻译按钮、歌词开关与待播清单开关的图标，同 music.apple.com 的 invertible-mask：28×28 的方块以 size×size（默认 22）的图标为遮罩，
 * 未开启时只显示图标，开启后反转为实心方块、图标镂空。paths(inverted) 返回图标的路径；
 * 图标加在按钮原有内容之后。返回 setInverted(bool)。
 */
function invertibleMask(button, { viewBox, paths, transform, size = 22 }) {
  const id = `lyrics-mask-${Math.random().toString(36).slice(2)}`;
  const svg = svgNode('svg', { class: 'invertible-mask', viewBox: '0 0 28 28', width: '28', height: '28', role: 'presentation' });
  const mask = svgNode('mask', { id });
  const base = svgNode('rect', { width: '100%', height: '100%' });
  const icon = svgNode('svg', { x: String((28 - size) / 2), y: String((28 - size) / 2), width: String(size), height: String(size), viewBox });
  mask.append(base, icon);
  svg.append(mask, svgNode('rect', { width: '100%', height: '100%', mask: `url(#${id})` }));
  button.append(svg);
  return (inverted) => {
    icon.replaceChildren(...paths(inverted).map((d) => svgNode('path', transform ? { d, transform } : { d })));
    base.setAttribute('fill', inverted ? 'white' : 'black');
    icon.setAttribute('fill', inverted ? 'black' : 'white');
    svg.classList.toggle('invertible-mask--inverted', inverted);
    svg.classList.toggle('invertible-mask--not-inverted', !inverted);
  };
}

/** 一个声部（主唱或和声）转成一行 AMLL 歌词；和声去掉 Apple 写在词里的括号 */
function amllLine(voice, line, { isBG, translation, pronunciation }) {
  const tokens = validTokens(voice);
  const clean = (text) => (isBG ? text.replace(/[()]/g, '') : text);
  const text = plainText(voice);
  // 逐词音译与原文相同（如英文歌）时不显示
  const romanTokens = pronunciation && !tokens.every((t) => t.text === voice.pronunciationTokens[voice.tokens.indexOf(t)]?.text);
  const words = tokens.length
    ? tokens.map((token) => {
      const roman = romanTokens ? voice.pronunciationTokens[voice.tokens.indexOf(token)]?.text : '';
      return {
        startTime: token.begin, endTime: Math.max(token.begin, token.end),
        word: clean(token.text) + (token.spaceAfter ? ' ' : ''),
        ...(roman ? { romanWord: clean(roman) } : {}),
      };
    })
    : [{ startTime: line.begin, endTime: Math.max(line.begin, line.end), word: clean(voice.text) }];
  const begin = Math.min(...words.map((w) => w.startTime));
  const end = Math.max(...words.map((w) => w.endTime));
  return {
    words, startTime: begin, endTime: end, isBG, isDuet: line.agent !== 'v1',
    translatedLyric: translation && voice.translation && !same(voice.translation, text) ? voice.translation : '',
    romanLyric: pronunciation && voice.pronunciation && !same(voice.pronunciation, text) ? voice.pronunciation : '',
  };
}

/** parseTTML 的结果转成 AMLL LyricLine[]，和声紧跟在所属主歌词行后面 */
export function toAmllLines(song, options) {
  return song.lines.flatMap((line) => {
    const main = amllLine(line, line, { ...options, isBG: false });
    if (!line.background.tokens.length && !line.background.text) return [main];
    return [main, amllLine(line.background, line, { ...options, isBG: true })];
  });
}

/** 是否显示歌词（展开界面里的歌词按钮），保存在浏览器中；存储不可用时默认显示 */
const SHOWN_KEY = 'am-hook:lyrics-hidden';
function loadShown() {
  try { return localStorage.getItem(SHOWN_KEY) !== '1'; } catch { return true; }
}
function saveShown(shown) {
  try { if (shown) localStorage.removeItem(SHOWN_KEY); else localStorage.setItem(SHOWN_KEY, '1'); } catch { /* 只在本次会话生效 */ }
}

/** 歌词选项：字号（AMLL 默认字号的倍数）、字重、歌词来源与背景（'amll' 流动背景 | 'classic' 经典背景），保存在浏览器中 */
const PREFS_KEY = 'am-hook:lyrics-prefs';
export const FONT_SCALES = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
export const FONT_WEIGHTS = [300, 400, 500, 600, 700, 800];
export const BACKDROPS = ['amll', 'classic'];
const DEFAULT_PREFS = { scale: 1, weight: 600, source: 'apple', backdrop: 'amll' };
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      scale: FONT_SCALES.includes(saved.scale) ? saved.scale : DEFAULT_PREFS.scale,
      weight: FONT_WEIGHTS.includes(saved.weight) ? saved.weight : DEFAULT_PREFS.weight,
      source: saved.source === 'amll' ? 'amll' : DEFAULT_PREFS.source,
      backdrop: BACKDROPS.includes(saved.backdrop) ? saved.backdrop : DEFAULT_PREFS.backdrop,
    };
  } catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 只在本次会话生效 */ }
}

/** AMLL TTML DB（https://amll.dev/reference/http-api/native）：按 Apple Music 歌曲 ID 取 TTML，未收录时为 null */
const AMLL_API = 'https://api.amll.dev';
async function fetchAmll(adamId) {
  const response = await fetch(`${AMLL_API}/v1/lyrics/get?appleMusicId=${encodeURIComponent(adamId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`AMLL HTTP ${response.status}`);
  const { data } = await response.json();
  return data?.lyrics ? { text: data.lyrics, source: 'amll', authors: data.authorUsernames || [] } : null;
}

/** 文件名里不能用的字符换成 _ */
const safeName = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120);

/**
 * root：#lyrics-overlay；toggle：播放条上的歌词按钮（打开歌词；展开界面里切换是否显示歌词）；bar：播放条，
 * 点击其中非控件区域（封面、标题、空白处）展开界面（没有歌词时也能展开）；歌词界面打开时并入 .lyrics-controls。
 * getMeta() 返回正在播放的歌曲的 { title, artist, artists, artwork, country? }（artists: [{ name, href }]，用于艺人链接；
 * 有 country 时优先作为请求歌词的地区）；t 为界面文案函数；notify 显示提示。
 * navigate(href)：前端路由，点击艺人链接时关闭歌词界面并由它打开页面（播放不中断）；省略时按普通链接跳转。
 * onShow()：界面展开或展开期间切歌时调用（如更新标题旁的喜爱与「更多」按钮）。
 * 返回 { setTrack(id, country), close() }：setTrack 在切歌时调用，歌词界面跟随正在播放的歌曲；close 收起界面。
 */
export function mountLyrics({ root, toggle, bar, player, getMeta, t, notify, onLangChange, navigate, onShow }) {
  const $ = (selector) => root.querySelector(selector);
  const follow = $('.lyrics-follow');
  const titleMarquee = new globalThis.AmHook.Marquee($('.lyrics-title'));
  const artistMarquee = new globalThis.AmHook.Marquee($('.lyrics-artist'));
  // 翻译 / 发音：同 music.apple.com，一个「歌词翻译」按钮弹出菜单切换；开关在切歌后保留。
  // 同一菜单里还有字号、字重、歌词来源与下载 TTML
  const translationMenu = $('.lyrics-translation-menu');
  const translationButton = $('.lyrics-translation-button');
  const menu = $('.lyrics-menu');
  const scrim = $('.lyrics-menu-scrim');
  const setInverted = invertibleMask(translationButton, { viewBox: '0 0 17 16', paths: () => TRANSLATE_PATHS, transform: 'translate(-.51 4.44)scale(.101)' });
  // 展开界面里的歌词开关（播放条上仍显示原来的图标，见 app.css）
  const setToggleInverted = invertibleMask(toggle, { viewBox: '0 0 64 64', paths: (inverted) => [inverted ? LYRICS_PATHS.on : LYRICS_PATHS.off] });
  // 手机上展开界面里的待播清单开关（播放条上的待播清单按钮，见 player.js），清单打开时反转
  const queueButton = bar.querySelector('.player-queue');
  if (queueButton) {
    const setQueueInverted = invertibleMask(queueButton, { viewBox: '0 0 64 64', paths: () => [QUEUE_PATH], size: 20 });
    const syncQueue = () => setQueueInverted(queueButton.getAttribute('aria-expanded') === 'true');
    // 清单打开时歌词开关不反转（两个开关只有当前显示的一个反转）
    new MutationObserver(() => { syncQueue(); syncToggle(); }).observe(queueButton, { attributes: true, attributeFilter: ['aria-expanded'] });
    syncQueue();
  }
  const shown = { translation: false, pronunciation: false };
  const has = { translation: false, pronunciation: false };
  const prefs = loadPrefs();
  const view = new DomLyricPlayer();
  $('.lyric-panel').append(view.getElement());
  const credits = document.createElement('div');
  credits.className = 'lyrics-credits';
  view.getBottomLineElement().append(credits);
  // 按下时底部控件是否已隐藏（.controls-idle）：此时点歌词行只显示控件、不跳转，
  // 控件显示后再点一下（即双击）才跳转；按下时就要记下，抬起时控件已被 wake() 显示
  let pressedWhileIdle = false;
  view.addEventListener('line-click', (event) => {
    if (pressedWhileIdle) return;
    // AMLL 会把行的开始时间提前最多 600ms 用于入场动画；跳转到第一个词的原始时间
    const line = event.line.getLine();
    seek(line.words[0]?.startTime ?? line.startTime);
  });

  let canvas = $('.lyrics-backdrop');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  motion.addEventListener('change', () => backdrop?.setStaticMode(motion.matches));
  let backdrop = createBackdrop();

  /**
   * 按 prefs.backdrop 在 canvas 上创建背景，统一成 { setImage(blob) → 是否已显示, resume, pause, setHasLyric, setStaticMode, dispose }；
   * 流动背景不可用（不支持 WebGL）时改用经典背景，都不可用时为 null（保留纯色背景）
   */
  function createBackdrop() {
    // 只有经典背景叠颗粒层（见 app.css .lyrics-grain）；AMLL 不可用时退回经典背景，也要加上
    root.classList.remove('classic-backdrop');
    if (prefs.backdrop === 'amll') {
      try {
        if (MeshGradientRenderer.isSupported()) {
          const render = new BackgroundRender(new MeshGradientRenderer(canvas), canvas);
          render.setHasLyric(true);
          render.setStaticMode(motion.matches);
          render.pause();
          return {
            async setImage(blob) {
              const url = URL.createObjectURL(blob);
              try { await render.setAlbum(url); } finally { URL.revokeObjectURL(url); }
              return true;
            },
            resume: () => render.resume(),
            pause: () => render.pause(),
            setHasLyric: (has) => render.setHasLyric(has),
            setStaticMode: (on) => render.setStaticMode(on),
            // 会移除自己的画布
            dispose: () => render.dispose(),
          };
        }
      } catch (error) {
        console.warn('[am-hook] AMLL 歌词背景不可用，改用经典背景', error);
      }
    }
    try {
      const classic = new ArtworkBackdrop(canvas);
      root.classList.add('classic-backdrop');
      return {
        setImage: (blob) => classic.setFile(blob),
        resume: () => classic.resume(),
        pause: () => classic.pause(),
        // 经典背景不区分有无歌词，自己跟随「减少动态效果」
        setHasLyric() {},
        setStaticMode() {},
        dispose: () => { classic.destroy(); classic.canvas.remove(); },
      };
    } catch (error) {
      console.warn('[am-hook] 歌词背景不可用', error);
      return null;
    }
  }

  /** 切换背景：画布取过 WebGL 上下文或已交给 worker 后不能换绘制方式，换一块新画布重新创建；界面打开时立即载入封面 */
  function setBackdrop(kind) {
    if (kind === prefs.backdrop) return;
    prefs.backdrop = kind;
    savePrefs(prefs);
    artworkController?.abort();
    artworkController = null;
    artworkSource = '';
    root.classList.remove('has-backdrop');
    const old = canvas;
    // 新建而不是 cloneNode：AMLL 会在画布上写内联样式（如 z-index），不能带给经典背景
    canvas = document.createElement('canvas');
    canvas.className = old.className;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.hidden = true;
    old.after(canvas);
    backdrop?.dispose();
    old.remove();
    backdrop = createBackdrop();
    backdrop?.setHasLyric(lyricsVisible);
    if (open) loadArtwork();
  }

  const barHome = document.createComment('player');
  let adamId = null;
  let country = null;
  let song = null;
  // 正在显示的歌词：TTML 原文（下载用）、来源（'apple' | 'amll'）与 AMLL 歌词库的作者
  let lyricsText = '';
  let lyricsSource = null;
  let amllAuthors = [];
  // 选了 AMLL 歌词库却显示 Apple Music 歌词的原因：'missing'（未收录）或 'failed'（请求失败）
  let amllStatus = null;
  let request = null;
  // 这首歌各来源取到的结果（见 loadLyrics）
  let sources = {};
  // 每次切歌或改歌词来源加一，较早的请求返回时据此忽略
  let generation = 0;
  let unavailable = false;
  let open = false;
  let frame = 0;
  let lastFrame = 0;
  let playing = null;
  let artworkSource = '';
  let artworkController = null;
  let lyricsShown = loadShown();
  let lyricsVisible = false;
  // 手机上播放并显示歌词时，3 秒没有触摸就隐藏底部的播放控件与歌词翻译按钮（.controls-idle，见 app.css）
  const compact = matchMedia('(max-width: 760px)');
  let idleTimer = 0;
  const panel = $('.lyric-panel');
  const controls = $('.lyrics-controls');
  let alignPosition = 0.35;

  function currentTime() {
    return player.current ? player.transport().currentTime * 1000 : 0;
  }

  function seek(ms) {
    if (!player.current) return;
    const transport = player.transport();
    transport.currentTime = ms / 1000;
    view.setCurrentTime(ms, true);
    view.resetScroll();
    if (transport.paused) player.toggle();
  }

  function tick(timestamp) {
    const transport = player.current ? player.transport() : null;
    const now = !!transport && !transport.paused;
    if (now !== playing) {
      playing = now;
      if (now) view.resume(); else view.pause();
      wake();
    }
    // 隐藏歌词时只有背景在动，歌词视图不再排版
    if (lyricsVisible) {
      view.setCurrentTime(transport ? transport.currentTime * 1000 : 0);
      view.update(lastFrame ? timestamp - lastFrame : 0);
    }
    lastFrame = timestamp;
    // AMLL 在用户滚动后暂停自动对齐，下一行进入可视范围时才会自己回来；这里提供立即回到当前行的按钮
    const suspended = lyricsVisible && !!view.scrollState?.isAutoAlignSuspended;
    if (follow.hidden === suspended) follow.hidden = !suspended;
    frame = requestAnimationFrame(tick);
  }

  /**
   * 手机上显示歌词时控件叠在歌词区下部（见 app.css）：把控件高度写到 --lyrics-controls-h，
   * 并让当前行对齐在控件以上区域的 35% 处（AMLL 默认按整个歌词区的 35%）
   */
  function syncControlsHeight() {
    const overlaid = compact.matches && lyricsVisible;
    const height = overlaid ? controls.offsetHeight : 0;
    root.style.setProperty('--lyrics-controls-h', `${height}px`);
    const total = panel.clientHeight;
    const align = total ? 0.35 * Math.max(0, total - height) / total : 0.35;
    if (align === alignPosition) return;
    alignPosition = align;
    view.setAlignPosition(align);
    if (lyricsVisible) view.calcLayout('resize');
  }

  /** 能否隐藏底部控件：手机上、正在播放并显示歌词 */
  function canSleep() {
    return open && playing && lyricsVisible && compact.matches;
  }

  /** 显示底部控件；仍可隐藏时重新计时 */
  function wake() {
    clearTimeout(idleTimer);
    root.classList.remove('controls-idle');
    if (canSleep()) idleTimer = setTimeout(sleep, 3000);
  }

  function sleep() {
    clearTimeout(idleTimer);
    if (!canSleep()) return;
    // 菜单或待播清单打开时保持显示
    if (!menu.hidden || root.classList.contains('queue-open')) { wake(); return; }
    root.classList.add('controls-idle');
  }

  function renderHeader() {
    const meta = getMeta();
    const art = $('.lyrics-art');
    if (meta.artwork) { if (art.getAttribute('src') !== meta.artwork) art.src = meta.artwork; } else art.removeAttribute('src');
    art.hidden = !meta.artwork;
    // 歌名与艺人各占一行，过长时滚动（同 music.apple.com 的 amp-lcd-metadata，见 player.js 的 Marquee）
    titleMarquee.set([document.createTextNode(meta.title || t('player.unknownTitle'))]);
    // 艺人名链接到艺人页（见 player.js 的 artistNodes）
    artistMarquee.set(globalThis.AmHook.artistNodes(meta.artist || '', meta.artists));
  }

  function renderCredits() {
    if (!song) return;
    credits.replaceChildren();
    if (song.credits.length) {
      const label = document.createElement('span');
      label.className = 'credit-label';
      label.textContent = t('lyrics.credits');
      const names = document.createElement('span');
      names.className = 'credit-names';
      names.textContent = song.credits.join(t('lyrics.creditsSeparator'));
      credits.append(label, names);
    }
    if (song.translation.automatic && shown.translation) {
      const note = document.createElement('div');
      note.className = 'translation-note';
      note.textContent = t('lyrics.aiTranslation');
      credits.append(note);
    }
    if (lyricsSource === 'amll') {
      const note = document.createElement('div');
      note.className = 'source-note';
      note.textContent = amllAuthors.length
        ? t('lyrics.amllCredit', { authors: amllAuthors.map((name) => `@${name}`).join(t('lyrics.creditsSeparator')) })
        : t('lyrics.amllCreditAnon');
      credits.append(note);
    }
  }

  /** 字号与字重写在歌词界面的 CSS 变量上（见 app.css 的 .lyric-panel） */
  function applyPrefs() {
    root.style.setProperty('--lyrics-font-scale', String(prefs.scale));
    root.style.setProperty('--lyrics-font-weight', String(prefs.weight));
  }

  /** 改了字号或字重后重新排版：AMLL 只在尺寸变化时读取字号，行高要按新字号重新计算 */
  function relayout() {
    view.onResize();
    if (!lyricsVisible || !song) return;
    view.rebuildLyricView(currentTime());
    view.setCurrentTime(currentTime(), true);
    view.resetScroll();
  }

  /** 选定的来源没有这首歌的歌词、改用另一来源时的说明 */
  function sourceNote() {
    if (!lyricsSource || lyricsSource === prefs.source) return '';
    if (prefs.source === 'apple') return t('lyrics.appleMissing');
    return t(amllStatus === 'failed' ? 'lyrics.amllFailed' : 'lyrics.amllMissing');
  }

  /** 下载正在显示的歌词（Apple Music 或 AMLL 歌词库的 TTML 原文），文件名为「艺人 - 歌名.ttml」 */
  function downloadTTML() {
    if (!lyricsText) return;
    const meta = getMeta();
    const name = safeName([meta.artist, meta.title].filter(Boolean).join(' - ')) || adamId;
    const url = URL.createObjectURL(new Blob([lyricsText], { type: 'application/ttml+xml' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${name}.ttml` });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /** 背景使用页面已有的封面；取不到封面或背景不可用时保留纯色背景 */
  function loadArtwork() {
    const target = backdrop;
    if (!target) return;
    const source = getMeta().artwork || '';
    if (source === artworkSource) { target.resume(); return; }
    artworkSource = source;
    if (artworkController) artworkController.abort();
    artworkController = null;
    if (!source) { canvas.hidden = true; root.classList.remove('has-backdrop'); return; }
    const controller = new AbortController();
    artworkController = controller;
    fetch(source, { signal: controller.signal, cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
        return response.blob();
      })
      .then(async (blob) => {
        if (controller.signal.aborted) return;
        // 切换背景时会中止这次加载（见 setBackdrop），中止后不再碰已销毁的背景
        const shown = await target.setImage(blob);
        if (!shown || controller.signal.aborted) return;
        canvas.hidden = false;
        root.classList.add('has-backdrop');
        if (open) target.resume(); else target.pause();
      })
      .catch((error) => { if (!controller.signal.aborted) console.warn('[am-hook] 歌词背景加载失败', error); });
  }

  function setLines() {
    view.setLyricLines(toAmllLines(song, shown), currentTime());
    renderCredits();
  }

  /** 歌词按钮的文案：播放条上为「歌词」，展开界面里为「显示 / 隐藏歌词」，按下状态表示歌词正在显示 */
  function syncToggle() {
    const label = t(open ? (lyricsVisible ? 'lyrics.hide' : 'lyrics.show') : 'lyrics.open');
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-pressed', String(open && lyricsVisible));
    setToggleInverted(open && lyricsVisible && !root.classList.contains('queue-open'));
  }

  /**
   * 按「是否显示歌词」与歌曲有没有歌词切换布局（加载中按有歌词处理，避免切歌时布局跳动）；
   * 歌词从隐藏变为显示时，视图需要可见时的尺寸来排版，按当前进度重新对齐
   */
  function applyVisibility() {
    const visible = open && lyricsShown && !unavailable;
    const changed = visible !== lyricsVisible;
    lyricsVisible = visible;
    root.classList.toggle('lyrics-hidden', !visible);
    if (!visible) { closeMenu(); follow.hidden = true; }
    backdrop?.setHasLyric(visible);
    syncToggle();
    wake();
    syncControlsHeight();
    if (!visible || !changed || !song) return;
    if (!view.getLyricLines().length) setLines();
    else view.rebuildLyricView(currentTime());
    view.setCurrentTime(currentTime(), true);
    view.resetScroll();
  }

  function setShown(shown) {
    lyricsShown = shown;
    saveShown(shown);
    applyVisibility();
  }

  function show() {
    if (open || !adamId) return;
    open = true;
    // 播放控件并入歌词界面（桌面在封面下方，手机在底部），关闭时放回原处
    player.closeQueue();
    bar.replaceWith(barHome);
    $('.lyrics-controls').append(bar);
    root.hidden = false;
    document.body.classList.add('lyrics-open');
    renderHeader();
    loadArtwork();
    lyricsVisible = false;
    applyVisibility();
    playing = null;
    lastFrame = 0;
    frame = requestAnimationFrame(tick);
    $('.lyrics-close').focus({ preventScroll: true });
    onShow?.();
  }

  function hide() {
    if (!open) return;
    open = false;
    closeMenu();
    player.closeQueue();
    barHome.replaceWith(bar);
    root.hidden = true;
    document.body.classList.remove('lyrics-open');
    lyricsVisible = false;
    syncToggle();
    wake();
    cancelAnimationFrame(frame);
    frame = 0;
    backdrop?.pause();
    toggle.focus({ preventScroll: true });
  }

  /** 有歌词时显示按钮（菜单里还有翻译以外的选项）；开启翻译或发音时图标反转 */
  function syncOptions() {
    translationMenu.hidden = !song;
    setInverted(shown.translation || shown.pronunciation);
    if (!menu.hidden) renderMenu();
  }

  const menuNode = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const menuItem = (child, role = 'none', className = '') => {
    const item = menuNode('li', className);
    item.setAttribute('role', role);
    if (child) item.append(child);
    return item;
  };

  /** 一个菜单项：option 为翻译 / 发音开关，action 为其他操作；checked 不为 undefined 时是单选项 */
  function menuButton({ label, icon, option, action, value, checked, disabled }) {
    const button = menuNode('button');
    button.type = 'button';
    button.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
    if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
    if (option) button.dataset.option = option;
    if (action) button.dataset.action = action;
    if (value) button.dataset.value = value;
    button.disabled = !!disabled;
    button.title = label;
    const iconNode = menuNode('span', 'lyrics-menu-icon');
    if (icon) iconNode.innerHTML = MENU_ICONS[icon];
    button.append(menuNode('span', 'lyrics-menu-text', label), iconNode);
    return button;
  }

  /** 字号 / 字重一行：名称、减小按钮、当前值、增大按钮；到头时对应按钮置灰 */
  function stepper(label, value, [less, canLess], [more, canMore]) {
    const row = menuNode('div', 'lyrics-menu-stepper');
    const step = (action, enabled, icon) => {
      const button = menuNode('button', 'lyrics-menu-step');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.dataset.action = action;
      button.disabled = !enabled;
      button.title = t(`lyrics.${action}`);
      button.setAttribute('aria-label', `${button.title} (${label}: ${value})`);
      button.innerHTML = MENU_ICONS[icon];
      return button;
    };
    row.append(menuNode('span', 'lyrics-menu-text', label), step(less, canLess, 'minus'), menuNode('span', 'lyrics-menu-value', value), step(more, canMore, 'plus'));
    return row;
  }

  /**
   * 菜单分五组：翻译 / 发音（同 music.apple.com：已开启的显示「隐藏…」，否则「显示…」，歌曲没有的一项置灰）、
   * 字号与字重、歌词来源（单选，选定的来源没有这首歌时在下面说明）、背景（单选）、下载 TTML
   */
  function renderMenu() {
    const scale = FONT_SCALES.indexOf(prefs.scale);
    const weight = FONT_WEIGHTS.indexOf(prefs.weight);
    const note = sourceNote();
    const separator = () => menuItem(null, 'separator', 'lyrics-menu-separator');
    const items = [
      ...[
        ['translation', has.translation && shown.translation ? 'hideTranslation' : 'showTranslation'],
        ['pronunciation', has.pronunciation && shown.pronunciation ? 'hidePronunciation' : 'showPronunciation'],
      ].map(([name, action]) => menuItem(menuButton({ label: t(`lyrics.${action}`), icon: action, option: name, disabled: !has[name] }))),
      separator(),
      menuItem(stepper(t('lyrics.fontSize'), `${Math.round(prefs.scale * 100)}%`,
        ['fontSmaller', scale > 0], ['fontLarger', scale < FONT_SCALES.length - 1])),
      menuItem(stepper(t('lyrics.fontWeight'), t(`lyrics.weight${prefs.weight}`),
        ['weightLighter', weight > 0], ['weightBolder', weight < FONT_WEIGHTS.length - 1])),
      separator(),
      menuItem(menuNode('span', '', t('lyrics.source')), 'presentation', 'lyrics-menu-heading'),
      ...['apple', 'amll'].map((source) => menuItem(menuButton({
        label: t(source === 'apple' ? 'lyrics.sourceApple' : 'lyrics.sourceAmll'),
        icon: prefs.source === source ? 'check' : '', action: 'source', value: source, checked: prefs.source === source,
      }))),
      ...(note ? [menuItem(menuNode('span', '', note), 'presentation', 'lyrics-menu-note')] : []),
      separator(),
      menuItem(menuNode('span', '', t('lyrics.backdrop')), 'presentation', 'lyrics-menu-heading'),
      ...BACKDROPS.map((kind) => menuItem(menuButton({
        label: t(kind === 'amll' ? 'lyrics.backdropAmll' : 'lyrics.backdropClassic'),
        icon: prefs.backdrop === kind ? 'check' : '', action: 'backdrop', value: kind, checked: prefs.backdrop === kind,
      }))),
      separator(),
      menuItem(menuButton({ label: t('lyrics.download'), icon: 'download', action: 'download', disabled: !lyricsText })),
    ];
    menu.replaceChildren(...items);
  }

  /** 字号 / 字重按钮：在可选值里前后移一档 */
  const STEPS = {
    fontSmaller: ['scale', FONT_SCALES, -1], fontLarger: ['scale', FONT_SCALES, 1],
    weightLighter: ['weight', FONT_WEIGHTS, -1], weightBolder: ['weight', FONT_WEIGHTS, 1],
  };
  function step(action) {
    const [key, values, delta] = STEPS[action];
    const index = Math.max(0, Math.min(values.length - 1, values.indexOf(prefs[key]) + delta));
    if (values[index] === prefs[key]) return;
    prefs[key] = values[index];
    savePrefs(prefs);
    applyPrefs();
    relayout();
  }

  /** 改歌词来源后重新取这首歌的歌词；结果不是选定的来源时提示原因 */
  function setSource(source) {
    if (source === prefs.source) return;
    prefs.source = source;
    savePrefs(prefs);
    // 还没请求过的歌曲在打开时按新来源请求；正在加载的按新来源重新请求
    if (!adamId || !request || lyricsSource === source) return;
    const id = adamId;
    request = null;
    fetchLyrics().then(() => {
      const note = id === adamId && sourceNote();
      if (note) notify(note);
    });
  }

  /**
   * 在点击处弹出菜单（键盘打开时在按钮中心），同 amp-contextual-menu-button：
   * 右侧放不下时改到左侧，下方放不下（留 40px）时改为向上展开。
   */
  function openMenu(event) {
    renderMenu();
    menu.hidden = false;
    scrim.hidden = false;
    translationButton.setAttribute('aria-expanded', 'true');
    const rect = translationButton.getBoundingClientRect();
    const x = event.clientX || rect.left + rect.width / 2;
    const y = event.clientY || rect.top + rect.height / 2;
    menu.style.cssText = '';
    if (!matchMedia('(max-width: 483px)').matches) {
      const rtl = document.dir === 'rtl';
      const fitsRight = innerWidth - x > menu.offsetWidth;
      const left = (rtl && (x > menu.offsetWidth || !fitsRight)) || (!rtl && !fitsRight) ? x - menu.offsetWidth - 1 : x + 1;
      menu.style.left = `${left}px`;
      if (innerHeight - y > menu.offsetHeight + 40) menu.style.top = `${y}px`;
      else menu.style.bottom = `${innerHeight - y}px`;
    }
    if (!event.detail) menu.querySelector('button:not(:disabled)')?.focus();
  }

  function closeMenu(focusButton) {
    if (menu.hidden) return;
    menu.hidden = true;
    scrim.hidden = true;
    translationButton.setAttribute('aria-expanded', 'false');
    if (focusButton) translationButton.focus({ preventScroll: true });
  }

  /**
   * 按歌词来源取一首歌的歌词：{ song, text, source, authors, amllStatus }，没有歌词时只有 amllStatus。
   * 选了 AMLL 歌词库时先查它，未收录、请求失败或解析不了时记下原因，改用 Apple Music 歌词。
   */
  async function loadLyrics(id) {
    // 这首歌各来源的结果记在 sources 里，来回切换来源时不重复请求；AMLL 歌词库未收录时不记，下次选择时重新查
    const cache = sources;
    const remember = (source, fetcher) => (cache[source] ??= fetcher().then((result) => {
      if (!result && source === 'amll') delete cache[source];
      return result;
    }, (error) => { delete cache[source]; throw error; }));
    const parse = (result) => {
      const parsed = result && parseTTML(result.text);
      return parsed?.lines.length ? { ...result, song: parsed } : null;
    };
    let status = null;
    if (prefs.source === 'amll') {
      try {
        const found = parse(await remember('amll', () => fetchAmll(id)));
        if (found) return { ...found, amllStatus: status };
        status = 'missing';
      } catch (error) {
        console.warn('[am-hook] AMLL 歌词库请求失败', error);
        status = 'failed';
      }
    }
    const apple = await remember('apple', async () => {
      const language = await (async () => globalThis.AmI18n?.catalogLang(getMeta()?.country || country))().catch(() => undefined);
      const text = await globalThis.AmWrapper.lyrics(id, language);
      return text == null ? null : { text, source: 'apple' };
    });
    return { ...parse(apple), amllStatus: status };
  }

  /** 首次打开时获取歌词（改歌词来源后重新获取）；加载中的重复点击被忽略，失败后可重试 */
  function fetchLyrics() {
    if (!request) {
      const id = adamId;
      const current = ++generation;
      const stale = () => current !== generation; // 已切换到另一首歌或改了歌词来源
      toggle.setAttribute('aria-busy', 'true');
      request = loadLyrics(id)
        .then((result) => {
          if (stale()) return;
          if (!result.song) {
            // 改歌词来源后新来源没有歌词：保留正在显示的歌词（菜单里说明）
            if (song) return;
            // 展开界面保持打开，只显示封面与播放控件
            unavailable = true;
            toggle.hidden = true;
            applyVisibility();
            return;
          }
          song = result.song;
          lyricsText = result.text;
          lyricsSource = result.source;
          amllStatus = result.amllStatus;
          amllAuthors = result.source === 'amll' ? (result.authors.length ? result.authors : song.authors) : [];
          view.getElement().lang = song.language;
          const voices = song.lines.flatMap((line) => [line, line.background]);
          has.translation = voices.some((voice) => voice.translation);
          has.pronunciation = voices.some((voice) => voice.pronunciation || voice.pronunciationTokens.length);
          syncOptions();
          // 展开界面里正在等这首歌的歌词时直接排版
          if (lyricsVisible) {
            setLines();
            view.setCurrentTime(currentTime(), true);
            view.resetScroll();
          } else {
            // 改歌词来源时可能已有上一来源的歌词行，清掉后再次显示时按新歌词排版（见 applyVisibility）
            view.setLyricLines([]);
          }
        })
        .catch((error) => {
          if (stale()) return;
          request = null;
          console.warn('[am-hook] 歌词加载失败', error);
          notify(t('lyrics.failed'));
        })
        .finally(() => { if (!stale()) toggle.removeAttribute('aria-busy'); });
    }
    return request;
  }

  /** 切换歌曲（id 为空表示没有歌曲）：歌词界面打开时取回新歌词原地刷新，没有歌词时只显示封面与播放控件 */
  function setTrack(id, cc) {
    id = id || null;
    if (id === adamId) return;
    adamId = id;
    country = cc || null;
    song = null;
    lyricsText = '';
    lyricsSource = amllStatus = null;
    amllAuthors = [];
    request = null;
    sources = {};
    generation++;
    unavailable = false;
    toggle.removeAttribute('aria-busy');
    credits.replaceChildren();
    view.setLyricLines([]);
    closeMenu();
    has.translation = has.pronunciation = false;
    syncOptions();
    toggle.hidden = !id;
    bar.classList.toggle('lyrics-available', !!id);
    if (!open) return;
    if (!id) { hide(); return; }
    renderHeader();
    loadArtwork();
    applyVisibility();
    onShow?.();
    fetchLyrics();
  }

  /** 播放条上的歌词按钮：打开界面并显示歌词（没有歌词时提示，不展开）；展开后切换是否显示歌词 */
  function onToggle() {
    // 手机上待播清单占着歌词的位置：这时点歌词开关是回到歌词
    if (open && root.classList.contains('queue-open')) { player.closeQueue(); if (!lyricsShown) setShown(true); return; }
    if (open) { setShown(!lyricsShown); return; }
    if (song) { setShown(true); show(); return; }
    if (unavailable || toggle.hasAttribute('aria-busy')) return;
    const id = adamId;
    fetchLyrics().then(() => {
      if (id !== adamId || open) return;
      if (song) { setShown(true); show(); } else if (unavailable) notify(t('lyrics.none'));
    });
  }

  toggle.addEventListener('click', onToggle);
  // 点击播放条展开界面，按上次的选择显示或隐藏歌词；歌词随后取回
  bar.addEventListener('click', (event) => {
    if (open || !adamId || event.target.closest('button, input, a, [role="slider"], .player-msg, .player-notice')) return;
    show();
    fetchLyrics();
  });
  $('.lyrics-close').addEventListener('click', hide);
  $('.lyrics-artist').addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link || !navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    hide();
    navigate(link.getAttribute('href'));
  });
  translationButton.addEventListener('click', (event) => {
    if (menu.hidden) openMenu(event); else closeMenu();
  });
  scrim.addEventListener('click', () => closeMenu());
  menu.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const { option, action, value } = button.dataset;
    if (option) {
      shown[option] = !shown[option];
      closeMenu(true);
      syncOptions();
      setLines();
    } else if (action === 'source') {
      closeMenu(true);
      setSource(value);
    } else if (action === 'backdrop') {
      closeMenu(true);
      setBackdrop(value);
    } else if (action === 'download') {
      closeMenu(true);
      downloadTTML();
    } else if (STEPS[action]) {
      // 字号 / 字重：菜单保持打开，可以连续调整；焦点留在同一按钮（到头置灰时移到另一侧）
      const focused = document.activeElement === button;
      step(action);
      renderMenu();
      if (!focused) return;
      const again = menu.querySelector(`[data-action="${action}"]`);
      (again.disabled ? again.parentElement.querySelector('.lyrics-menu-step:not(:disabled)') : again)?.focus();
    }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1);
    buttons[(index + buttons.length) % buttons.length]?.focus();
  });
  follow.addEventListener('click', () => { view.resetScroll(); follow.hidden = true; });
  // 手指上滑立即隐藏底部控件、下滑显示（一次滑动中换向时跟随最新方向），轻点也显示；
  // 用 touch 事件而非 pointer 事件，浏览器接管滚动后仍能收到 touchmove
  let touchY = null;
  let swiped = false;
  root.addEventListener('touchstart', (event) => {
    touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
    swiped = false;
  }, { capture: true, passive: true });
  root.addEventListener('touchmove', (event) => {
    if (touchY === null || event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    if (Math.abs(y - touchY) < 12) return;
    if (y < touchY) sleep(); else wake();
    touchY = y;
    swiped = true;
  }, { capture: true, passive: true });
  root.addEventListener('touchend', () => {
    if (touchY !== null && !swiped) wake();
    touchY = null;
  }, { capture: true, passive: true });
  root.addEventListener('touchcancel', () => { touchY = null; }, { capture: true, passive: true });
  // 鼠标、触控笔点击或键盘焦点进入界面时显示
  root.addEventListener('pointerdown', (event) => {
    pressedWhileIdle = root.classList.contains('controls-idle');
    // 触摸后 :hover 会停留在这一行，不跳转时不显示行的底框（见 app.css），下次按下时恢复
    root.classList.toggle('lyrics-tap-muted', pressedWhileIdle);
    if (event.pointerType !== 'touch') wake();
  }, true);
  root.addEventListener('focusin', wake);
  compact.addEventListener('change', () => { wake(); syncControlsHeight(); });
  const resizeObserver = new ResizeObserver(() => { if (open) syncControlsHeight(); });
  resizeObserver.observe(controls);
  resizeObserver.observe(panel);
  document.addEventListener('keydown', (event) => {
    // 已由其他菜单处理（如标题旁「更多」的菜单）
    if (!open || event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    // 菜单打开时 Esc 只关闭菜单
    if (!menu.hidden) closeMenu(true); else hide();
  });
  onLangChange(() => {
    renderCredits();
    if (!menu.hidden) renderMenu();
    if (open) renderHeader();
    syncToggle();
  });
  applyPrefs();
  syncToggle();

  return { setTrack, close: hide };
}
