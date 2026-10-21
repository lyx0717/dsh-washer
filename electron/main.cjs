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
const WIN_WIDTH = 268;
const WIN_HEIGHT = 96;
/** 位置记忆；写在这里省一个持久化模块 */
const POS_FILE = join(homedir(), '.dsh', 'dsh-washer-window.json');

let win = null;
/** 鼠标穿透状态：true 时点击直接穿到底下的应用 */
let clickThrough = false;

function readEndpoint() {
  try {
    return JSON.parse(readFileSync(ENDPOINT_FILE, 'utf8'));
  } catch {
    return null;
  }
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
 */
const ESCAPE_ACCELERATOR = 'CommandOrControl+Shift+W';

function setClickThrough(on) {
  clickThrough = on === true;
  if (win === null || win.isDestroyed()) return;
  // forwarding 让窗口仍然收到鼠标移动事件，页面的 hover 才能工作，
  // 但点击会穿过窗口落到下面的应用上。
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  // 穿透时窗口不该再抢焦点，否则点到的地方会被它截胡
  win.setFocusable(!clickThrough);
  win.webContents.send('washer:click-through', clickThrough);
  updateEscapeShortcut();
}

/** 只在穿透状态下注册全局快捷键，其余时候不占用系统键位 */
function updateEscapeShortcut() {
  if (clickThrough) {
    if (!globalShortcut.isRegistered(ESCAPE_ACCELERATOR)) {
      const ok = globalShortcut.register(ESCAPE_ACCELERATOR, () => setClickThrough(false));
      if (!ok && win !== null && !win.isDestroyed()) {
        // 注册失败（被别的应用占了）就通知页面，让它提示用户改用右键菜单
        win.webContents.send('washer:escape-unavailable', ESCAPE_ACCELERATOR);
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
