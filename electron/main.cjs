/**
 * dsh-washer · 悬浮窗主进程
 *
 * 职责很小：开一个透明、无边框、置顶的窗口，把 float.html 放进去。
 * 业务状态一概不在这里 —— 页面自己连宿主服务拿快照，
 * 主进程只负责「窗口」这件事：位置、穿透、显隐。
 *
 * 用 .cjs 后缀：插件本体是 ESM（package.json 里 type: module），
 * 但 Electron 主进程入口必须是 CommonJS。改后缀是让两者共存最省事的办法。
 */
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, shell } = require('electron');
const { readFileSync, existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, dirname } = require('node:path');

const ENDPOINT_FILE = process.env.DSH_WASHER_ENDPOINT_FILE
  || join(homedir(), '.dsh', 'dsh-washer-overlay.json');

/**
 * 窗口尺寸要和 float.html 的卡片一致，否则透明区会挡住鼠标。
 * 注意 macOS 的「额度」：窗口比卡片大太多时透明部分虽然看得见，
 * 但拖拽区（-webkit-app-region）会连带变大——所以宁可按内容收紧。
 */
/*
 * 尺寸档位。窗口必须和 float.html 里的内容严丝合缝：透明窗口里
 * 看得见的部分之外，还藏着一整块透明但吃鼠标的区域，比内容大一点
 * 就会挡住底下应用的点击。所以每个档位的数字都要和页面 CSS 对上。
 *
 * tiny 是「极简态」：只剩指示灯和一个角标，气泡整个不渲染。
 */
const SIZES = {
  normal: { width: 132, height: 200 },
  tiny: { width: 76, height: 96 },
};
const WIN_WIDTH = SIZES.normal.width;
const WIN_HEIGHT = SIZES.normal.height;
/** 详情面板尺寸 */
const DETAIL_WIDTH = 260;
const DETAIL_HEIGHT = 380;
/** 位置记忆；写在这里省一个持久化模块 */
const POS_FILE = join(homedir(), '.dsh', 'dsh-washer-window.json');

let win = null;
/** 详情面板窗口；null 表示没打开 */
let detailWin = null;
/** 鼠标穿透状态：true 时点击直接穿到底下的应用 */
/** 角落按钮的矩形（窗口内 CSS 像素）；穿透模式下只有这块接收鼠标 */
let cornerRect = null;
let clickThrough = false;
/** 当前尺寸档位：'normal' | 'tiny' */
let sizeMode = 'normal';
/** 当前皮肤 */
let skin = 'precision';
/**
 * 窗口是否可见。
 *
 * 和"进程是否活着"是两件事：宿主启动时会按设置决定要不要拉起进程，
 * 拉起之后用户还能在设置页把它关掉——那种情况该做的是 hide() 而不是退出，
 * 否则每拨一次开关都要 fork 一个 Electron。
 */
let visible = true;
/**
 * 系统是否要求减弱动态效果。
 *
 * 页面那边读 prefers-reduced-motion 直接控制 CSS，但窗口尺寸动画在**主进程**
 * 里插值，主进程拿不到 CSS 媒体查询，只能让渲染进程量一次再同步过来
 * （preload 暴露 host.setReduceMotion，float.html 启动时上报）。
 * 默认 false：拿不到就按"要动画"处理，比默认关掉更不容易让人以为卡住。
 */
let reduceMotion = false;

/**
 * 读端点文件，并且**确认写它的进程还活着**。
 *
 * 文件是插件卸载时故意留下的（见 index.js 的注释），所以里面可能是一份
 * 上一代宿主的记录，端口早就不通了。光看文件会把悬浮窗送到死端口上，
 * 表现就是永远"未连接"——这个坑实测踩过一次。
 * 用 process.kill(pid, 0) 探活：不杀进程，只是问"这个 pid 存在吗"。
 */
function readEndpoint() {
  let info = null;
  try {
    info = JSON.parse(readFileSync(ENDPOINT_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (info === null || typeof info.port !== 'number' || typeof info.token !== 'string') return null;
  if (typeof info.pid === 'number') {
    try {
      process.kill(info.pid, 0);
    } catch (err) {
      // ESRCH = 没这个进程；EPERM = 有但没权限（也算活着）
      if (err.code === 'ESRCH') return null;
    }
  }
  return info;
}

/**
 * 把本地改的偏好告诉宿主，让设置页跟着变。
 *
 * 这是**反向同步**的唯一通道。此前主进程只写偏好文件就完事，而设置页
 * 读的是 localStorage、由宿主注入——文件写完没人通知它，于是"右键菜单
 * 换了造型，设置页还显示旧的"。偏好文件是单向出口，得有一条回来的路。
 *
 * 走的是宿主那个带 token 的 HTTP 服务（POST /dsh-washer/prefs），
 * 不用 WebSocket：这里只要发一个几十字节的通知，不值得建长连接。
 *
 * 失败一律吞掉：宿主可能没起、可能退了，此时窗口本身还能用，
 * 下次宿主起来读到文件里的值也能补上。为一条同步失败弹错误框是添乱。
 */
function notifyHost(patch) {
  const ep = readEndpoint();
  if (ep === null || !ep.port || !ep.token) return;
  const body = JSON.stringify(patch);
  try {
    const req = require('node:http').request({
      host: '127.0.0.1',
      port: ep.port,
      path: '/dsh-washer/prefs',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${ep.token}`,
      },
      timeout: 2000,
    }, (res) => { res.resume(); });
    req.on('error', () => { /* 宿主没起或已退出，忽略 */ });
    req.on('timeout', () => { req.destroy(); });
    req.end(body);
  } catch { /* 同上 */ }
}

/**
 * 悬浮窗自己的偏好（尺寸档位 / 皮肤）存一份，和设置页的 localStorage 分开。
 *
 * 为什么不在主进程读 localStorage：那是渲染进程的东西，主进程开窗前
 * 拿不到。而开窗的第一步就要知道窗口多大 —— 鸡生蛋问题。
 * 所以启动参数带一份当前值（宿主读设置页的偏好后以 --size / --skin 传入），
 * 之后用户在右键菜单里改的写进这个文件，下次启动时作为参数缺省。
 */
const PREFS_FILE = join(homedir(), '.dsh', 'dsh-washer-float-prefs.json');

function readFloatPrefs() {
  try {
    const p = JSON.parse(readFileSync(PREFS_FILE, 'utf8'));
    return p !== null && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

function writeFloatPrefs(patch) {
  const next = Object.assign({}, readFloatPrefs(), patch);
  try {
    require('node:fs').writeFileSync(PREFS_FILE, JSON.stringify(next), { mode: 0o600 });
  } catch { /* 记不住不是致命问题 */ }
  return next;
}

/** 启动参数优先，其次本地记的，最后默认 */
function argValue(name) {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
  }
  return null;
}

function readPosition() {
  try {
    const p = JSON.parse(readFileSync(POS_FILE, 'utf8'));
    if (typeof p.x === 'number' && typeof p.y === 'number') return p;
  } catch { /* 首次运行没有文件，用默认位置 */ }
  return null;
}

/**
 * 拖动结束后把窗口贴到最近的屏幕边缘。
 *
 * 阈值 24pt：小于这个距离手感上是"我想贴边"，大于它则是"我就想放这儿"。
 * 用 getDisplayMatching 而不是主屏，多显示器时贴着的那块屏才是参照物。
 */
const SNAP_DISTANCE = 24;

let snapping = false;
function snapToEdges() {
  if (win === null || win.isDestroyed()) return;
  // 防重入：setPosition 会再次触发 'moved'，不拦住就会无限自我推动，
  // 实测窗口会被一路推到屏幕外。
  if (snapping) return;
  const [x, y] = win.getPosition();
  const display = screen.getDisplayMatching({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
  const a = display.workArea;
  const right = a.x + a.width - WIN_WIDTH;
  const bottom = a.y + a.height - WIN_HEIGHT;
  let nx = x;
  let ny = y;
  if (Math.abs(x - a.x) < SNAP_DISTANCE) nx = a.x;
  else if (Math.abs(x - right) < SNAP_DISTANCE) nx = right;
  if (Math.abs(y - a.y) < SNAP_DISTANCE) ny = a.y;
  else if (Math.abs(y - bottom) < SNAP_DISTANCE) ny = bottom;
  if (nx !== x || ny !== y) {
    snapping = true;
    try { win.setPosition(nx, ny); } finally {
      // 等这一轮 moved 事件派发完再放开，否则同步 setPosition 后的 moved
      // 会在 finally 里被漏放行
      setTimeout(() => { snapping = false; }, 0);
    }
  }
}

function savePosition() {
  if (win === null || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  try {
    require('node:fs').writeFileSync(POS_FILE, JSON.stringify({ x, y }), { mode: 0o600 });
  } catch { /* 记不住位置不是致命问题，下次用默认位置 */ }
}

/**
 * 默认落在主屏右上角。
 * 用屏幕工作区而不是屏幕尺寸，避免压在菜单栏或 Dock 底下。
 */
function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - WIN_WIDTH - 24),
    y: Math.round(area.y + 24),
  };
}

/**
 * 穿透 = 窗口收不到任何鼠标事件，包括双击和右键。
 * 所以一旦开了，靠窗口自己关不回来——必须有一条窗口外的通道。
 * 这里用全局快捷键做救命绳，不依赖任何鼠标操作。
 *
 * 选键原则：绝对不用系统已占用的组合。
 * ⌘W / ⌘⇧W 会关窗口或标签页，⌘Q 会退出应用 —— 这些组合会被系统
 * 抢先拦下，globalShortcut.register() 还不报错，等于静默失效。
 * ⌥⌘W 在 macOS 上没有系统含义，且和"W"（washer / window）好记。
 */
const ESCAPE_ACCELERATOR = 'Alt+CommandOrControl+W';

function setClickThrough(on) {
  clickThrough = on === true;
  if (win === null || win.isDestroyed()) return;
  win.webContents.send('washer:click-through', clickThrough);
  updateEscapeShortcut();
  /*
   * 切换完必须立刻按一次区域规则。
   * 之前漏了这行：applyIgnoreRegions 只在 mousemove 里被调，而双击进入穿透
   * 的那一瞬间光标是静止的 —— 没有 mousemove，setIgnoreMouseEvents 就没被调用，
   * 于是"双击没反应"。点角落退出同理。切态之后立刻同步一次，不依赖鼠标移动。
   */
  applyIgnoreRegions();
}

/**
 * 真正的穿透控制。
 *
 * 关键点：不能简单地 setIgnoreMouseEvents(true, {forward:true}) 一关了事——
 * 那样窗口收不到任何鼠标事件，页面上再放什么按钮都点不到，等于单向门。
 * 正确做法是每次鼠标移动后告诉系统"这块要穿透、那块不要"：
 * 只有光标落在角落按钮上时才恢复接收事件。
 *
 * 页面通过 IPC 把角落的矩形（相对窗口的 CSS 像素）传上来，
 * 主进程按 1:1 记着（窗口不可缩放，所以不用换算缩放比）。
 */
function applyIgnoreRegions() {
  if (win === null || win.isDestroyed()) return;
  if (!clickThrough) {
    win.setIgnoreMouseEvents(false);
    return;
  }
  const c = cornerRect;
  const { x, y } = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  const px = x - wx;
  const py = y - wy;
  const overCorner = c !== null && px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h;
  // forward:true 让页面仍能收到 mousemove，靠它得知光标有没有滑到角落
  win.setIgnoreMouseEvents(!overCorner, { forward: true });
}

/** 只在穿透状态下注册全局快捷键，其余时候不占用系统键位 */
function updateEscapeShortcut() {
  if (clickThrough) {
    if (!globalShortcut.isRegistered(ESCAPE_ACCELERATOR)) {
      const ok = globalShortcut.register(ESCAPE_ACCELERATOR, () => setClickThrough(false));
      if (!ok) {
        // 注册失败说明键位被占了。这是致命情况：穿透开出去就关不回来了，
        // 所以干脆不进入穿透状态，把问题暴露在开的那一刻，而不是关的时候。
        clickThrough = false;
        if (win !== null && !win.isDestroyed()) {
          win.setIgnoreMouseEvents(false, { forward: true });
          win.setFocusable(true);
          win.webContents.send('washer:escape-unavailable', ESCAPE_ACCELERATOR);
        }
      }
    }
  } else {
    globalShortcut.unregister(ESCAPE_ACCELERATOR);
  }
}

function createWindow() {
  const pos = readPosition() || defaultPosition();
  const size = SIZES[sizeMode] || SIZES.normal;
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 置顶但不抢焦点：悬浮窗抢焦点会打断用户正在打的字
    alwaysOnTop: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'floating' 比 'normal' 高，但低于系统弹窗，不会盖住密码框之类
  win.setAlwaysOnTop(true, 'floating');
  // 切到别的 Space / 全屏应用时也能看到
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.once('ready-to-show', () => {
    // 启动时就该隐着的话别先亮一下再藏（会闪一帧）
    if (visible) win.show();
    /*
     * 启动时恢复上次的穿透状态。
     *
     * 必须在 show 之后、页面加载完之后调：setIgnoreMouseEvents 依赖
     * 窗口已经存在并且有内容，太早调会被 show() 内部重置掉。
     * 不能走 setClickThrough 的完整路径——那条路会写回偏好文件，
     * 触发 watchFile 再反过来调一次，绕圈。这里直接设状态 + 落一次区域规则。
     */
    const p = readFloatPrefs();
    if (p.clickThrough === true) {
      clickThrough = true;
      win.setIgnoreMouseEvents(true, { forward: true });
      updateEscapeShortcut();
      win.webContents.send('washer:click-through', true);
      applyIgnoreRegions();
    }
  });

  // 'moved' 在拖动结束时才稳定触发，正好是磁吸的时机
  win.on('moved', () => {
    snapToEdges();
    savePosition();
  });
  win.on('closed', () => { win = null; });

  // 拖窗外链用系统浏览器打开，不在悬浮窗里导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(join(__dirname, '..', 'debug', 'float.html'));
}

/**
 * 显示 / 隐藏悬浮窗。
 *
 * 为什么是 hide() 不是退出进程：设置页那个开关会来回拨，
 * 每拨一次就 fork 一个 Electron 太贵（冷启动几百毫秒，还要重连 WebSocket），
 * 而且退出后窗口位置、端口都得重建。hide/show 即时，重新打开时窗口还在原地。
 *
 * 进程真退出由宿主负责，这里只管窗口可见性。
 */
function setVisible(next) {
  const want = next === true;
  if (want === visible) return;
  visible = want;
  writeFloatPrefs({ show: want });
  notifyHost({ show: want });
  if (win === null || win.isDestroyed()) return;
  if (want) {
    win.show();
    // 隐藏期间显示器可能换过分辨率，重新贴一下边
    snapToEdges();
  } else {
    win.hide();
  }
}

/**
 * 窗口尺寸/位置过渡。
 *
 * 原来直接 setBounds —— 窗口在一帧之内从 132x200 跳到 76x96，
 * 用户看到的是一次硬切，主观感受就是"卡了一下"。
 * macOS 的原生窗口动画 API 只支持最大/最小化，改不了尺寸，
 * 所以这里自己按帧插值：每 16ms 走一步，用缓出曲线。
 *
 * 为什么不是 CSS 动画就够了：窗口大小是**系统层**的，页面 CSS 只能
 * 让内容慢慢缩，窗口本身还是会瞬间跳小，多出来的那块透明区域会闪一下。
 * 两边必须同频，所以窗口这里也要动。
 *
 * 时长和 float.html 里的 --size-dur 保持一致（220ms）。
 */
const SIZE_ANIM_MS = 220;
let boundsTimer = null;

function animateBounds(target) {
  if (win === null || win.isDestroyed()) return;
  if (boundsTimer !== null) { clearInterval(boundsTimer); boundsTimer = null; }
  const from = win.getBounds();
  const to = target;
  // 位置和尺寸都没变就别动，省得白跑一圈动画
  if (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height) return;

  /*
   * prefers-reduced-motion 由渲染进程的判断同步过来（见 washer:reduced-motion）。
   * 系统开了"减弱动态效果"就直接跳到位，不做插值。
   */
  if (reduceMotion) {
    win.setBounds(to);
    return;
  }

  const start = Date.now();
  // 缓出：和页面 CSS 的 cubic-bezier(.32,.72,0,1) 手感和频率接近
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  boundsTimer = setInterval(() => {
    if (win === null || win.isDestroyed()) {
      if (boundsTimer !== null) { clearInterval(boundsTimer); boundsTimer = null; }
      return;
    }
    const t = Math.min(1, (Date.now() - start) / SIZE_ANIM_MS);
    const k = ease(t);
    win.setBounds({
      x: Math.round(from.x + (to.x - from.x) * k),
      y: Math.round(from.y + (to.y - from.y) * k),
      width: Math.round(from.width + (to.width - from.width) * k),
      height: Math.round(from.height + (to.height - from.height) * k),
    });
    if (t >= 1) { clearInterval(boundsTimer); boundsTimer = null; }
  }, 16);
  // 别让这个定时器拖住进程退出
  if (boundsTimer !== null && typeof boundsTimer.unref === 'function') boundsTimer.unref();
}

/**
 * 切换窗口尺寸档位。
 *
 * 只改窗口，不动页面：页面通过 data-size 自己收放内容。
 * 但窗口会先变、内容后变，中间那一帧会露出透明边或者裁掉一角，
 * 所以先通知页面、下一帧再调 setSize —— 实测直接调会闪一下。
 */
function setSizeMode(mode) {
  const next = SIZES[mode] === undefined ? 'normal' : mode;
  if (next === sizeMode && win !== null && !win.isDestroyed()) {
    const [w, h] = win.getSize();
    if (w === SIZES[next].width && h === SIZES[next].height) return;
  }
  sizeMode = next;
  writeFloatPrefs({ size: next });
  notifyHost({ size: next });
  if (win === null || win.isDestroyed()) return;
  win.webContents.send('washer:prefs', { size: next, skin });
  const size = SIZES[next];
  // 宽度变了，贴边的窗口要跟着挪，否则会被屏幕边缘裁掉
  const [x, y] = win.getPosition();
  const display = screen.getDisplayMatching({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
  const a = display.workArea;
  let nx = x;
  if (x + size.width > a.x + a.width) nx = a.x + a.width - size.width;
  if (nx < a.x) nx = a.x;
  let ny = y;
  if (y + size.height > a.y + a.height) ny = a.y + a.height - size.height;
  if (ny < a.y) ny = a.y;
  animateBounds({ x: Math.round(nx), y: Math.round(ny), width: size.width, height: size.height });
}

/** 换肤：只把 skin 名发给页面，具体颜色由页面 CSS 决定 */
const SKINS = ['precision', 'anime', 'pixel'];

function setSkin(next) {
  // 老版本存的是 classic/mono/warm/cool 这几套调色皮肤，现在已经换成
  // 三种机器造型，认不出的值一律落到默认造型，别让旧偏好把浮窗卡成空白。
  skin = SKINS.indexOf(next) >= 0 ? next : 'precision';
  writeFloatPrefs({ skin });
  notifyHost({ skin });
  if (win === null || win.isDestroyed()) return;
  win.webContents.send('washer:prefs', { size: sizeMode, skin });
}

/**
 * 打开详情面板。
 *
 * 放在洗衣机旁边而不是盖在它上面：面板高度远大于洗衣机，
 * 覆盖会遮住本体。优先放左侧，左边装不下就放右侧；
 * 两边都装不下就贴着屏幕边缘压过去，此时允许被裁一点。
 */
function openDetail() {
  if (detailWin !== null && !detailWin.isDestroyed()) {
    detailWin.show();
    detailWin.focus();
    return;
  }
  const pos = readPosition() || defaultPosition();
  const display = screen.getDisplayMatching({ x: pos.x, y: pos.y, width: WIN_WIDTH, height: WIN_HEIGHT });
  const a = display.workArea;
  const gap = 10;
  let dx = pos.x - DETAIL_WIDTH - gap;
  if (dx < a.x) dx = pos.x + WIN_WIDTH + gap;
  if (dx + DETAIL_WIDTH > a.x + a.width) dx = Math.max(a.x, a.x + a.width - DETAIL_WIDTH);
  // 底边对齐洗衣机，但不许超出工作区
  let dy = pos.y;
  if (dy + DETAIL_HEIGHT > a.y + a.height) dy = Math.max(a.y, a.y + a.height - DETAIL_HEIGHT);

  detailWin = new BrowserWindow({
    width: DETAIL_WIDTH,
    height: DETAIL_HEIGHT,
    x: Math.round(dx),
    y: Math.round(dy),
    frame: false,
    transparent: false,
    backgroundColor: '#16181e',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 不占任务栏：它是洗衣机的附属窗，不是独立应用
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  detailWin.setAlwaysOnTop(true, 'floating');
  detailWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  detailWin.loadFile(join(__dirname, '..', 'debug', 'detail.html'));
  detailWin.once('ready-to-show', () => detailWin.show());
  detailWin.on('closed', () => { detailWin = null; });
  detailWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function closeDetail() {
  if (detailWin !== null && !detailWin.isDestroyed()) detailWin.close();
  detailWin = null;
}

function showMenu() {
  const detailOpen = detailWin !== null && !detailWin.isDestroyed();
  const menu = Menu.buildFromTemplate([
    {
      label: detailOpen ? '✓ 查看详情' : '查看详情',
      click: () => (detailOpen ? closeDetail() : openDetail()),
    },
    { type: 'separator' },
    {
      label: sizeMode === 'tiny' ? '✓ 极简' : '极简',
      click: () => setSizeMode(sizeMode === 'tiny' ? 'normal' : 'tiny'),
    },
    {
      label: '造型',
      submenu: [
        { label: skin === 'precision' ? '✓ 精密家电' : '精密家电', click: () => setSkin('precision') },
        { label: skin === 'anime' ? '✓ 动漫' : '动漫', click: () => setSkin('anime') },
        { label: skin === 'pixel' ? '✓ 像素' : '像素', click: () => setSkin('pixel') },
      ],
    },
    { type: 'separator' },
    {
      label: clickThrough ? `✓ 鼠标穿透（${ESCAPE_ACCELERATOR} 关闭）` : '鼠标穿透',
      click: () => setClickThrough(!clickThrough),
    },
    {
      label: '重连并刷新',
      click: () => win !== null && win.webContents.reload(),
    },
    { type: 'separator' },
    {
      label: '打开调试端',
      click: () => {
        const ep = readEndpoint();
        if (ep === null || !ep.port || !ep.token) return;
        const page = `file://${join(__dirname, '..', 'debug', 'overlay.html')}`
          + `?port=${ep.port}&token=${encodeURIComponent(ep.token)}`;
        shell.openExternal(page);
      },
    },
    { type: 'separator' },
    { label: '退出悬浮窗', click: () => app.quit() },
  ]);
  menu.popup({ window: win });
}

/*
 * 监听偏好文件，让设置页的改动即时生效。
 *
 * 设置页在渲染进程里改 localStorage，主进程根本读不到；宿主把值中转到
 * 这个文件，主进程 watch 它——这是唯一不用重启宿主就能改窗口的办法。
 *
 * 用 fs.watch 而不是轮询：轮询要一直有个定时器跑着，为一个偶尔才变的
 * 文件不值得。fs.watch 在 macOS 上对单文件的可靠性够用。
 */
let prefWatcher = null;

function watchPrefs() {
  if (prefWatcher !== null) return;
  try {
    // 文件可能还不存在，watch 不存在的路径会抛 ENOENT。
    // 用 watchFile 的轮询代替：只在文件确实存在后才 watch 简单可靠。
    prefWatcher = require('node:fs').watchFile(PREFS_FILE, { interval: 400 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
      const p = readFloatPrefs();
      const nextSize = SIZES[p.size] !== undefined ? p.size : sizeMode;
      const nextSkin = typeof p.skin === 'string' ? p.skin : skin;
      /*
       * show 也要跟。宿主在启动时按设置决定拉不拉进程，但进程起来之后
       * 用户在设置页把开关拨掉，这里必须跟着隐藏——早期版本只处理
       * size/skin，show 被整个忽略，于是"关了开关窗口还在"。
       *
       * 只有字段确实是布尔值才动：偏好文件是读-合并-写的，
       * 缺字段时不能让窗口莫名其妙闪一下。
       */
      const nextShow = typeof p.show === 'boolean' ? p.show : visible;
      /*
       * 穿透同理。它原来是浮窗上双击切换的，但用户要求整机可拖，
       * 而 Chromium 的拖拽区会吞掉 dblclick —— 两个不能共存，于是入口
       * 挪到设置页：设置页 POST → 宿主写偏好文件 → 这里读到就应用。
       */
      const nextThrough = typeof p.clickThrough === 'boolean' ? p.clickThrough : clickThrough;
      if (nextSize !== sizeMode) setSizeMode(nextSize);
      if (nextSkin !== skin) setSkin(nextSkin);
      if (nextShow !== visible) setVisible(nextShow);
      if (nextThrough !== clickThrough) setClickThrough(nextThrough);
    });
  } catch { prefWatcher = null; }
}

app.whenReady().then(() => {
  // 宿主用 --size / --skin 把设置页里的偏好带进来（主进程读不到 localStorage）。
  // 命令行优先，其次是上一次在右键菜单里改的值。
  const prefs = readFloatPrefs();
  const argSize = argValue('--size');
  const argSkin = argValue('--skin');
  sizeMode = SIZES[argSize] !== undefined
    ? argSize
    : (SIZES[prefs.size] !== undefined ? prefs.size : 'normal');
  skin = SKINS.indexOf(prefs.skin) >= 0 ? prefs.skin : 'precision';
  if (typeof argSkin === 'string' && argSkin !== '') {
    skin = SKINS.indexOf(argSkin) >= 0 ? argSkin : skin;
  }
  /*
   * 启动时的可见性。宿主只在 show 为真时才拉起进程，所以走到这里通常是 true；
   * 但进程可能被单独启动（调试、崩溃后手动重开），这时得尊重上次存的偏好，
   * 否则用户明明关了开关，手动一起就冒出来。
   *
   * 注意不能直接 setVisible(prefs.show)：那个函数会写回偏好文件，
   * 启动阶段写一次会改 mtime，把随后的 watchFile 回调白白触发一遍。
   */
  if (typeof prefs.show === 'boolean') visible = prefs.show;

  watchPrefs();

  // 单实例：重复点启动只是把已有窗口提到前面
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (win === null || win.isDestroyed()) return;
    win.show();
    win.focus();
  });

  createWindow();

  ipcMain.on('washer:set-click-through', (_event, on) => setClickThrough(on));
  ipcMain.on('washer:corner-rect', (_event, rect) => {
    if (rect === null) { cornerRect = null; }
    else if (typeof rect.x === 'number' && typeof rect.y === 'number'
      && typeof rect.w === 'number' && typeof rect.h === 'number') {
      cornerRect = rect;
    }
    applyIgnoreRegions();
  });
  // 页面每次 mousemove 调一次，配合 forward:true 判断光标是否进了角落
  ipcMain.on('washer:pointer', () => applyIgnoreRegions());
  ipcMain.on('washer:reduce-motion', (_event, on) => { reduceMotion = on === true; });
  ipcMain.on('washer:toggle-click-through', () => setClickThrough(!clickThrough));
  ipcMain.handle('washer:state', () => ({
    clickThrough,
    endpoint: readEndpoint(),
    escapeAccelerator: ESCAPE_ACCELERATOR,
    size: sizeMode,
    skin,
    visible,
  }));
  ipcMain.on('washer:set-size', (_event, mode) => setSizeMode(mode));
  ipcMain.on('washer:set-skin', (_event, name) => setSkin(name));
  ipcMain.on('washer:set-visible', (_event, on) => setVisible(on === true));
  ipcMain.on('washer:show-menu', () => showMenu());
  ipcMain.on('washer:open-detail', () => openDetail());
  ipcMain.on('washer:close-detail', () => closeDetail());
  ipcMain.on('washer:quit', () => app.quit());
});

app.on('will-quit', () => {
  if (prefWatcher !== null) { require('node:fs').unwatchFile(PREFS_FILE); prefWatcher = null; }
  globalShortcut.unregisterAll();
  closeDetail();
});
app.on('window-all-closed', () => app.quit());
