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
  /** 切换穿透 */
  toggleClickThrough: () => ipcRenderer.send('washer:toggle-click-through'),
  /** 右键菜单 */
  showMenu: () => ipcRenderer.send('washer:show-menu'),
  /** 退出 */
  quit: () => ipcRenderer.send('washer:quit'),
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
