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
/*
 * 尺寸**不能**用一组常量。窗口会切档（normal 132x200 / tiny 76x96），
 * 曾经这里固定写 SIZES.normal，结果极简态下贴边、详情面板定位全按
 * normal 算：贴边差 56px，详情面板在机身右侧错开一大截。
 * 一律用 winSize() 取当前档位，别再引回常量。
 */
function winSize() {
  return SIZES[sizeMode] || SIZES.normal;
}
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
let clickThrough = false;
/** 当前尺寸档位：'normal' | 'tiny' */
let sizeMode = 'normal';
/** 当前皮肤 */
let skin = 'precision';
/**
 * 当前是否暗色。由 Web 端（主界面）把宿主 GUI 的实际主题 POST 进偏好文件，
 * 这里 watch 到就读出来，推给浮窗切浅/深——做到「浮窗跟随 dock 同款主题」。
 * 默认 true：浮窗原本就是深色版，没收到信号时保持原样。
 */
let themeDark = true;
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
 * 读端点文件，并且**确认那一头的宿主真的在听**。
 *
 * 文件是插件卸载时故意留下的（见 index.js 的注释），所以里面可能是一份
 * 上一代宿主的记录，端口早就不通了。光看文件会把悬浮窗送到死端口上，
 * 表现就是永远"未连接"——这个坑实测踩过一次。
 *
 * 早先这里用 process.kill(pid, 0) 探活：不杀进程，只是问"这个 pid 存在吗"。
 * 那是错的——**pid 会被复用**。宿主崩溃重启后新进程可能拿到同一个 pid，
 * 于是旧端点文件被判成有效，浮窗连到一个没人监听的端口上，症状和"文件过期"
 * 一模一样，却根本查不出来。
 * 现在改成发一次真请求：能回 200 就说明那头有个活着的宿主，pid 对不对不重要。
 *
 * 同步调用（Atomics.wait 睡的是主进程线程）：探活最多等 300ms，可以接受，
 * 换来的是调用方不用改成 async——那条链路上全是同步代码。
 */
const HEALTH_TIMEOUT_MS = 300;

function probeHealth(info) {
  const { spawnSync } = require('node:child_process');
  const script = "const h=require('node:http');"
    + `const r=h.get({host:'127.0.0.1',port:${info.port},path:'/dsh-washer/health',`
    + `headers:{authorization:'Bearer ${info.token}'},timeout:${HEALTH_TIMEOUT_MS}},`
    + 's=>{let b="";s.on("data",c=>{b+=c});s.on("end",()=>{process.exit(s.statusCode===200?0:1)})});'
    + 'r.on("error",()=>process.exit(1));r.on("timeout",()=>{r.destroy();process.exit(1)});';
  const res = spawnSync(process.execPath, ['-e', script], {
    timeout: HEALTH_TIMEOUT_MS + 700,
    stdio: 'ignore',
    // 这里只是探活，不需要 Electron 的运行时
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return res.status === 0;
}

function readEndpoint() {
  let info = null;
  try {
    info = JSON.parse(readFileSync(ENDPOINT_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (info === null || typeof info.port !== 'number' || typeof info.token !== 'string') return null;
  /*
   * pid 只作为**快速排除**：进程明确不存在时不必再花 300ms 探活。
   * 活着也不能直接放行，还得问端口那头是不是同一个宿主（see probeHealth）。
   */
  if (typeof info.pid === 'number') {
    try {
      process.kill(info.pid, 0);
    } catch (err) {
      // ESRCH = 没这个进程；EPERM = 有但没权限（也算活着）
      if (err.code === 'ESRCH') return null;
    }
  }
  return probeHealth(info) ? info : null;
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

/**
 * 读偏好文件。三种结果，区别很重要：
 *   对象       = 正常读到的内容
 *   undefined  = 文件不存在（可以全新创建）
 *   null       = 文件存在但读不出来（坏了 / 正被对面进程替换）
 *
 * 早先这里 catch 里统一回退成 `{}`，于是 watchdog 在文件被非原子写
 * 撕成半截 JSON 的那一瞬间读到空对象，接着 writeFloatPrefs 拿 `{}` 做
 * 合并基底写回去——**一次抹掉全部偏好**。宁可不写也不能抹盘。
 */
function readFloatPrefs() {
  let raw;
  try {
    raw = readFileSync(PREFS_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return undefined;
    return null;
  }
  try {
    const p = JSON.parse(raw);
    return p !== null && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch { return null; }
}

/**
 * 原子写：临时文件 + rename。
 *
 * 宿主编排进程也会写这个文件（设置页改尺寸/皮肤时），而且它是用
 * writeFileSync 直接覆盖的——truncate 之后、写完之前存在一个可被读到的
 * 空窗。两进程并发时读的一方能拿到半截 JSON 或空文件。两边都改成
 * 原子写之后，读的一方永远只会看到完整的旧值或完整的新值。
 *
 * 同目录的临时文件是必须的：跨文件系统 rename 会退化成复制+删除。
 */
function writeFloatPrefs(patch) {
  const base = readFloatPrefs();
  // 读失败就放弃这次写入，别拿空对象当基底把文件清空
  if (base === null) {
    console.warn('[dsh-washer] 偏好文件读不出来，跳过这次写入以免覆盖');
    return null;
  }
  const next = Object.assign({}, base, patch);
  const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
  const fsMod = require('node:fs');
  try {
    fsMod.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fsMod.chmodSync(tmp, 0o600);
    fsMod.renameSync(tmp, PREFS_FILE);
  } catch {
    try { fsMod.rmSync(tmp, { force: true }); } catch { /* noop */ }
    return null;
  }
  return next;
}

/** 只读不问：拿不到就当没有，不触发写入路径 */
function floatPrefsOrEmpty() {
  const p = readFloatPrefs();
  return p === null || p === undefined ? {} : p;
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
  const { width, height } = winSize();
  const display = screen.getDisplayMatching({ x, y, width, height });
  const a = display.workArea;
  const right = a.x + a.width - width;
  const bottom = a.y + a.height - height;
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
  const { width } = winSize();
  return {
    x: Math.round(area.x + area.width - width - 24),
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
  const changed = clickThrough !== (on === true);
  clickThrough = on === true;
  /*
   * 穿透开关在设置页也有镜像，改完必须回传宿主。
   * 不回传的话：菜单里打开穿透 → 设置页开关还停在"关"，用户会以为没生效。
   * （"退出悬浮窗"忘记回传是同一个毛病。）
   */
  if (changed) { writeFloatPrefs({ clickThrough }); notifyHost({ clickThrough }); }
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
 * 穿透是整窗一刀切：开就全穿透，关就全接收。
 * 早期留过"角落里可点的一小块"当退出通道，现在退出改走设置页开关和
 * ⌥⌘W 全局快捷键，那个可点的洞就是穿在机器身上的一块异物，已删掉。
 */
function applyIgnoreRegions() {
  if (win === null || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(clickThrough, { forward: clickThrough });
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
    /*
     * 启动时就该隐着的话别先亮一下再藏（会闪一帧）。
     *
     * 这里必须显式 show()/hide()，不能只写 `if (visible) win.show()` 然后
     * 指望 watchPrefs 兜后路——那正是曾经的坑：
     *   app.whenReady 里 `visible = prefs.show`（true），
     *   setVisible 里第一行 `if (want === visible) return;`，
     *   于是 watchFile 每次读到 show=true 都和 visible 相等、直接 return，
     *   窗口虽然创建了却从来没被 show 过，表现为「设置里开关是开的，
     *   但屏幕上什么都没有」，而窗口句柄一直存在（onscreen=false）。
     * 现在两个方向都落一次，让状态和实际可见性强制对齐。
     */
    if (visible) win.show(); else win.hide();
    /*
     * 启动时恢复上次的穿透状态。
     *
     * 必须在 show 之后、页面加载完之后调：setIgnoreMouseEvents 依赖
     * 窗口已经存在并且有内容，太早调会被 show() 内部重置掉。
     * 不能走 setClickThrough 的完整路径——那条路会写回偏好文件，
     * 触发 watchFile 再反过来调一次，绕圈。这里直接设状态 + 落一次区域规则。
     */
    const p = floatPrefsOrEmpty();
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

  /*
   * 缓动曲线用先慢后快的 ease-in-out，不是纯 ease-out。
   *
   * 纯缓出（1-(1-t)^3）的起点斜率是 3，也就是"第一帧就冲到 21% 进度"。
   * 实测：第一帧在 17ms 处把宽度从 132 直接跳到 120——人手的感觉就是
   * 先顿一下、然后猛动一下，这个"顿"就是用户说的起始卡顿。
   *
   * 换成 smoothstep（3t²-2t³）后起点斜率是 0，起步是慢慢加速的，
   * 和页面 CSS 那边 cubic-bezier(.32,.72,0,1) 的观感一致。
   */
  const ease = (t) => t * t * (3 - 2 * t);
  /*
   * 第一个 setInterval 回调要等一个完整周期（16ms）才来，这段窗口里窗口
   * 一点没动，也贡献了一半的"顿"。所以起步先同步跑一帧 t=0，
   * 让窗口在原位站定，动画时间轴也从这一刻开始算。
   */
  const start = Date.now();
  const step = () => {
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
    if (t >= 1 && boundsTimer !== null) { clearInterval(boundsTimer); boundsTimer = null; }
  };
  // 起步先跑一帧 t=0：让窗口在原位站定，别等 16ms 才第一次 setBounds
  step();
  // 第一帧不可能已经到终点（t=0），所以这里必定要装定时器
  boundsTimer = setInterval(step, 16);
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
  win.webContents.send('washer:prefs', { size: next, skin, dark: themeDark });
  const size = SIZES[next];
  // 宽度变了，贴边的窗口要跟着挪，否则会被屏幕边缘裁掉
  const [x, y] = win.getPosition();
  const display = screen.getDisplayMatching({ x, y, width: size.width, height: size.height });
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
const SKINS = ['precision', 'pixel'];

function setSkin(next) {
  // 老版本存的是 classic/mono/warm/cool 这几套调色皮肤，现在已经换成
  // 三种机器造型，认不出的值一律落到默认造型，别让旧偏好把浮窗卡成空白。
  skin = SKINS.indexOf(next) >= 0 ? next : 'precision';
  writeFloatPrefs({ skin });
  notifyHost({ skin });
  if (win === null || win.isDestroyed()) return;
  win.webContents.send('washer:prefs', { size: sizeMode, skin, dark: themeDark });
}

/**
 * 明暗主题。只把布尔发给页面，具体配色的浅/深由 float.html 的 CSS 决定。
 * 不写回偏好文件（这个值是 Web 端送进来派生的，不是用户在浮窗上改的），
 * 也不 notifyHost（宿主就是它的来源，回推会形成环）。
 */
function setThemeDark(next) {
  const nextDark = next === true;
  if (nextDark === themeDark) return;
  themeDark = nextDark;
  if (win === null || win.isDestroyed()) return;
  win.webContents.send('washer:prefs', { size: sizeMode, skin, dark: themeDark });
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
  const { width, height } = winSize();
  const display = screen.getDisplayMatching({ x: pos.x, y: pos.y, width, height });
  const a = display.workArea;
  const gap = 10;
  let dx = pos.x - DETAIL_WIDTH - gap;
  if (dx < a.x) dx = pos.x + width + gap;
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
    /*
     * 退出前先把 show 关掉再退。
     * 否则：点菜单退出 → 窗口没了，但设置页的「显示悬浮窗」还亮着"开"，
     * 两边状态分叉，用户以为开关失灵。
     * 先 setVisible(false)（它会写偏好文件 + 通知宿主），再退出进程。
     */
    { label: '退出悬浮窗', click: () => { setVisible(false); app.quit(); } },
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
      /*
       * 读不出来（null）就**整段跳过**这次回调，不要用 {} 兜底：
       * 对面进程可能正在原子替换这个文件，此刻读到的是过渡态。
       * 400ms 后下一次轮询会再试，晚一拍远好于拿空对象做判断
       * （空对象会让 nextShow 回落到当前值、nextSize 回落到当前值，
       *  看着无害，但接着若有任何 writeFloatPrefs 就会把盘抹干净）。
       */
      const p = readFloatPrefs();
      if (p === null) return;
      const prefs = p === undefined ? {} : p;
      const nextSize = SIZES[prefs.size] !== undefined ? prefs.size : sizeMode;
      const nextSkin = typeof prefs.skin === 'string' ? prefs.skin : skin;
      /*
       * show 也要跟。宿主在启动时按设置决定拉不拉进程，但进程起来之后
       * 用户在设置页把开关拨掉，这里必须跟着隐藏——早期版本只处理
       * size/skin，show 被整个忽略，于是"关了开关窗口还在"。
       *
       * 只有字段确实是布尔值才动：偏好文件是读-合并-写的，
       * 缺字段时不能让窗口莫名其妙闪一下。
       */
      const nextShow = typeof prefs.show === 'boolean' ? prefs.show : visible;
      /*
       * 穿透同理。它原来是浮窗上双击切换的，但用户要求整机可拖，
       * 而 Chromium 的拖拽区会吞掉 dblclick —— 两个不能共存，于是入口
       * 挪到设置页：设置页 POST → 宿主写偏好文件 → 这里读到就应用。
       */
      const nextThrough = typeof prefs.clickThrough === 'boolean' ? prefs.clickThrough : clickThrough;
      /*
       * 主题：Web 端把宿主 GUI 的明暗 POST 进来。只认布尔值，
       * 缺字段时不动（偏好文件是读-合并-写的，不能让窗口莫名闪一下）。
       */
      const nextDark = typeof prefs.dark === 'boolean' ? prefs.dark : themeDark;
      if (nextSize !== sizeMode) setSizeMode(nextSize);
      if (nextSkin !== skin) setSkin(nextSkin);
      if (nextShow !== visible) setVisible(nextShow);
      if (nextThrough !== clickThrough) setClickThrough(nextThrough);
      if (nextDark !== themeDark) setThemeDark(nextDark);
    });
  } catch { prefWatcher = null; }
}

app.whenReady().then(() => {
  // 宿主用 --size / --skin 把设置页里的偏好带进来（主进程读不到 localStorage）。
  // 命令行优先，其次是上一次在右键菜单里改的值。
  const prefs = floatPrefsOrEmpty();
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
  // 启动时的明暗：沿用上一次 Web 端送进来的值，避免启动瞬间先闪一次默认配色。
  if (typeof prefs.dark === 'boolean') themeDark = prefs.dark;

  /*
   * 单实例：重复点启动只是把已有窗口提到前面。
   *
   * 这一步必须排在 watchPrefs() **之前**。早先 watchPrefs 在前面，
   * 拿不到锁的那个副本在 app.quit() 之前已经挂上了偏好文件的轮询，
   * 一旦这几十毫秒里文件有变动，它会抢着 setSizeMode/setSkin ——
   * 那些函数会把值写回文件并 notifyHost，等于让一个正在退出的副本
   * 去改主人的窗口配置。
   */
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  watchPrefs();
  app.on('second-instance', () => {
    if (win === null || win.isDestroyed()) return;
    win.show();
    win.focus();
  });

  createWindow();

  ipcMain.on('washer:set-click-through', (_event, on) => setClickThrough(on));
  ipcMain.on('washer:reduce-motion', (_event, on) => { reduceMotion = on === true; });
  ipcMain.on('washer:toggle-click-through', () => setClickThrough(!clickThrough));
  ipcMain.handle('washer:state', () => ({
    clickThrough,
    endpoint: readEndpoint(),
    escapeAccelerator: ESCAPE_ACCELERATOR,
    size: sizeMode,
    skin,
    dark: themeDark,
    visible,
  }));
  ipcMain.on('washer:set-size', (_event, mode) => setSizeMode(mode));
  ipcMain.on('washer:set-skin', (_event, name) => setSkin(name));
  ipcMain.on('washer:set-visible', (_event, on) => setVisible(on === true));
  ipcMain.on('washer:show-menu', () => showMenu());
  ipcMain.on('washer:open-detail', () => openDetail());
  ipcMain.on('washer:close-detail', () => closeDetail());
  /*
   * 退出前先关 show：这条路径同样不能只退进程。
   * 用 setVisible(false) 而不是裸 app.quit()，让它走"写偏好 + 通知宿主 + 隐藏"这套。
   */
  ipcMain.on('washer:quit', () => { setVisible(false); app.quit(); });
});

app.on('will-quit', () => {
  /*
   * 兜底：⌘Q / dock 右键退出 / 系统关机等路径不经过菜单，不会调 setVisible。
   * 进程都要没了，此时窗口对用户而言就是"关了"，所以补一次 show:false 回传，
   * 免得设置页留着个"开"的假象。
   */
  if (visible) notifyHost({ show: false });
  if (prefWatcher !== null) { require('node:fs').unwatchFile(PREFS_FILE); prefWatcher = null; }
  globalShortcut.unregisterAll();
  closeDetail();
});
app.on('window-all-closed', () => app.quit());
