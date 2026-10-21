/**
 * dsh-washer · 悬浮窗 preload
 *
 * 只暴露窗口操作，不暴露任何 Node 能力。
 * 页面要的数据自己从宿主服务拿（127.0.0.1 + token），
 * 走的是和浏览器调试端完全一样的路径 —— 少一条通道就少一处会撒谎的地方。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('washerHost', {
  /** 当前是否穿透 */
  state: () => ipcRenderer.invoke('washer:state'),
  /*
   * 注意这里没有"切换穿透"：开关在设置页和 ⌥⌘W，浮窗自己不再是入口。
   * 同理也没有 setCornerRect / pointer —— 穿透不再留"可点的角落"。
   */
  /**
   * 上报系统是否要求减弱动态效果。
   * 主进程要拿它决定窗口尺寸切换是插值还是直接跳到位——
   * 媒体查询在主进程里读不到，只能由页面量一次再送过去。
   */
  setReduceMotion: (on) => ipcRenderer.send('washer:reduce-motion', on === true),
  /** 右键菜单 */
  showMenu: () => ipcRenderer.send('washer:show-menu'),
  /** 退出 */
  quit: () => ipcRenderer.send('washer:quit'),
  /** 切换尺寸档位：'normal' | 'tiny' */
  setSize: (mode) => ipcRenderer.send('washer:set-size', mode),
  /** 换肤 */
  setSkin: (name) => ipcRenderer.send('washer:set-skin', name),
  /** 订阅偏好变化（尺寸 / 皮肤） */
  onPrefs: (fn) => {
    const handler = (_event, prefs) => fn(prefs);
    ipcRenderer.on('washer:prefs', handler);
    return () => ipcRenderer.removeListener('washer:prefs', handler);
  },
  /** 打开/关闭详情面板 */
  openDetail: () => ipcRenderer.send('washer:open-detail'),
  closeDetail: () => ipcRenderer.send('washer:close-detail'),
  /** 订阅"快捷键注册失败"的通知 */
  onEscapeUnavailable: (fn) => {
    const handler = (_event, accel) => fn(accel);
    ipcRenderer.on('washer:escape-unavailable', handler);
    return () => ipcRenderer.removeListener('washer:escape-unavailable', handler);
  },
  /** 订阅穿透状态变化，返回取消订阅函数 */
  onClickThroughChange: (fn) => {
    const handler = (_event, on) => fn(on);
    ipcRenderer.on('washer:click-through', handler);
    return () => ipcRenderer.removeListener('washer:click-through', handler);
  },
});
