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
const WIN_WIDTH = 132;
const WIN_HEIGHT = 196;
/** 位置记忆；写在这里省一个持久化模块 */
const POS_FILE = join(homedir(), '.dsh', 'dsh-washer-window.json');

let win = null;
/** 鼠标穿透状态：true 时点击直接穿到底下的应用 */
/** 角落按钮的矩形（窗口内 CSS 像素）；穿透模式下只有这块接收鼠标 */
let cornerRect = null;
let clickThrough = false;

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

function readPosition() {
  try {
    const p = JSON.parse(readFileSync(POS_FILE, 'utf8'));
    if (typeof p.x === 'number' && typeof p.y === 'number') return p;
  } catch { /* 首次运行没有文件，用默认位置 */ }
  return null;
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
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
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
    win.show();
  });

  win.on('moved', savePosition);
  win.on('closed', () => { win = null; });

  // 拖窗外链用系统浏览器打开，不在悬浮窗里导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(join(__dirname, '..', 'debug', 'float.html'));
}

function showMenu() {
  const menu = Menu.buildFromTemplate([
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

app.whenReady().then(() => {
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
  ipcMain.on('washer:toggle-click-through', () => setClickThrough(!clickThrough));
  ipcMain.handle('washer:state', () => ({
    clickThrough,
    endpoint: readEndpoint(),
    escapeAccelerator: ESCAPE_ACCELERATOR,
  }));
  ipcMain.on('washer:show-menu', () => showMenu());
  ipcMain.on('washer:quit', () => app.quit());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
