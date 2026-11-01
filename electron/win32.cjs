/**
 * dsh-washer · 悬浮窗的 Windows 专属实现
 *
 * macOS 和 Windows 的差别不在"窗口怎么开"，而在**没有窗口之后**：
 *
 *   macOS 上悬浮窗是常驻进程，用户点的"关闭"其实就是退出；
 *   菜单栏应用 / Dock 退出由系统提供入口。
 *
 *   Windows 上任务栏图标被 skipTaskbar 藏掉、Alt+Tab 也被 type:'toolbar'
 *   排除，用户一旦把窗口关掉就再也找不回来了——所以关闭必须是"藏进托盘"，
 *   托盘提供显隐、详情、退出三个入口。
 *
 * 另外两处系统集成也归这里，不进 main.cjs：
 *   - 打开 Harness 客户端：macOS 用 `open -a`，Windows 要直接起宿主 exe。
 *     宿主启动悬浮窗时会把 process.execPath 通过 DSH_WASHER_HOST_EXE 传进来，
 *     那就是用户此刻正在用的那个客户端，比按路径去猜可靠。
 *   - 通知的应用身份（AppUserModelID）：Windows 10 的系统通知靠 AUMID 归组，
 *     不设的话 toast 可能不弹，或弹出来没有落点。
 *
 * 不引入任何依赖：托盘图标是本目录下的 tray.png，由 tools/gen-tray-icon.mjs 生成。
 */
const { app, Menu, Tray, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');

/** 通知归组用的应用身份；和 electron/package.json 的 name 保持同一命名空间 */
const APP_USER_MODEL_ID = 'com.dsh.washer.float';

let tray = null;
let trayVisible = true;
let trayHandlers = null;

/**
 * 在任何窗口/通知创建之前调用：Windows 10 上 Notification 需要 AUMID 才能可靠弹出。
 */
function prepareApp() {
  if (typeof app.setAppUserModelId === 'function') app.setAppUserModelId(APP_USER_MODEL_ID);
}

function trayIcon() {
  const icon = nativeImage.createFromPath(join(__dirname, 'tray.png'));
  // 图标读不出来时别让托盘变成空图（空图在某些系统上是"不可见但可点"的白点）
  if (icon.isEmpty()) return null;
  return icon.resize({ width: 16, height: 16 });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: trayVisible ? '隐藏悬浮窗' : '显示悬浮窗',
      click: () => (trayHandlers && trayHandlers.toggle()),
    },
    { label: '查看详情', click: () => (trayHandlers && trayHandlers.openDetail()) },
    /*
     * 鼠标穿透也给托盘一个入口：穿透开着时窗口收不到任何鼠标事件，
     * 用户只能靠快捷键 ⌥⌘W / Ctrl+Alt+W 关掉；快捷键被别的程序占了
     * 就彻底没有鼠标出路了。托盘右键菜单是独立的系统弹层，永远点得到。
     */
    {
      label: '鼠标穿透',
      type: 'checkbox',
      checked: Boolean(trayHandlers && trayHandlers.throughEnabled && trayHandlers.throughEnabled() === true),
      click: () => (trayHandlers && trayHandlers.toggleThrough && trayHandlers.toggleThrough()),
    },
    { label: '打开 Harness 客户端', click: () => openHarnessClient() },
    { type: 'separator' },
    {
      label: '退出悬浮窗',
      // 托盘退出是**用户意图**：落盘 show=false，下次宿主启动不再拉起。
      click: () => (trayHandlers && trayHandlers.quit()),
    },
  ]);
}

function refreshTray() {
  if (tray === null || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
}

/**
 * 建托盘。handlers: { toggle, openDetail, quit, toggleThrough, throughEnabled }
 */
function createTray(handlers) {
  if (tray !== null) return tray;
  trayHandlers = handlers;
  const icon = trayIcon();
  /*
   * 没有图标就不建托盘：没有可见入口的托盘等于没有，
   * 而一个空图标托盘只会让用户对着任务栏角落发懵。
   */
  if (icon === null) return null;
  tray = new Tray(icon);
  tray.setToolTip('DSH 洗衣机');
  refreshTray();
  /*
   * 左键单击切换显隐：Windows 用户对托盘图标的默认期待就是"点一下把窗口叫出来"，
   * 右键才是菜单。macOS 菜单栏应用是反过来的，所以这条只在 win32 分支里。
   */
  tray.on('click', () => (trayHandlers && trayHandlers.toggle()));
  return tray;
}

/** 窗口显隐变化后同步托盘文案（"显示/隐藏悬浮窗"） */
function setTrayVisible(visibleNow) {
  const next = visibleNow === true;
  if (next === trayVisible) return;
  trayVisible = next;
  refreshTray();
}

function destroyTray() {
  if (tray === null) return;
  if (!tray.isDestroyed()) tray.destroy();
  tray = null;
}

/**
 * 打开用户此刻正在用的 Harness 客户端。
 *
 * 不猜安装路径：宿主拉起悬浮窗时把 process.execPath 塞进环境变量，
 * 那个 exe 一定是用户正在用的（绿色版、自定义安装目录都对）。
 * 拿不到就静默——这只是一个便利入口，失败不该影响别的任何东西。
 */
function openHarnessClient() {
  const exe = process.env.DSH_WASHER_HOST_EXE;
  if (typeof exe !== 'string' || exe === '') return false;
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  APP_USER_MODEL_ID,
  prepareApp,
  createTray,
  /** 穿透勾选态或窗口显隐变了之后，重建一遍菜单 */
  refreshTrayMenu: refreshTray,
  setTrayVisible,
  destroyTray,
  openHarnessClient,
};