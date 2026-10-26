const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = '/Users/liyongxuan/Downloads/AI/washer/dsh-washer';

const FRAMES = [
  { name: 'float-washing', snap: { state: 'washing', turn: 3, durationText: '01:24', toolCount: 5 } },
  { name: 'float-rinsing', snap: { state: 'rinsing', turn: 5, durationText: '02:07', toolCount: 9 } },
  { name: 'float-waiting', snap: { state: 'waiting', turn: 2, durationText: '00:31' } },
  { name: 'float-done',    snap: { state: 'done',    turn: 6, durationText: '03:12' } },
];

/*
 * 多会话列表那一帧。悬停气泡才展开，所以推完快照要额外派发一次
 * mouseenter —— 截图脚本没有真鼠标，只能自己造。
 */
const SESSIONS_FRAME = {
  name: 'float-sessions',
  snap: {
    state: 'washing', turn: 3, durationText: '01:24', running: true,
    pinnedSessionId: 'b',
    sessions: [
      { sessionId: 'a', state: 'waiting', elapsedMs: 31000 },
      { sessionId: 'b', state: 'washing', elapsedMs: 192000 },
      { sessionId: 'c', state: 'rinsing', elapsedMs: 105000 },
      { sessionId: 'd', state: 'idle', elapsedMs: 0 },
      { sessionId: 'e', state: 'error', elapsedMs: 4000 },
    ],
  },
};

const FAKE_WS = `
  (function(){
    var instances = [];
    window.__fakeWS = instances;
    window.WebSocket = function(u){
      var self = this;
      instances.push(self);
      self.readyState = 1;
      self.onopen = null; self.onmessage = null; self.onclose = null; self.onerror = null;
      setTimeout(function(){ if (typeof self.onopen === 'function') self.onopen({}); }, 0);
      self.close = function(){};
      self.send = function(){};
    };
    return instances.length;
  })()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 132, height: 200, show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-shot.cjs'),
    },
  });

  await win.loadFile(path.join(ROOT, 'debug', 'float.html'));
  /*
   * 页面已经跑完初始化、连过一次真地址了。
   * 这时候注入假 WS，再等页面自己的重连循环（约 2.5s）把它捡起来。
   * 直接推帧没用：页面手上那个 socket 还是旧的真实例。
   */
  await win.webContents.executeJavaScript(FAKE_WS);
  await new Promise(r => setTimeout(r, 3000));

  for (const f of FRAMES) {
    const count = await win.webContents.executeJavaScript(`
      (function(){
        var arr = window.__fakeWS || [];
        var ws = arr[arr.length - 1];
        if (!ws || typeof ws.onmessage !== 'function') return 'no-ws:' + arr.length;
        ws.onmessage({ data: ${JSON.stringify(JSON.stringify(f.snap))} });
        return 'ok:' + arr.length;
      })()
    `);
    await new Promise(r => setTimeout(r, 700));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ROOT, 'docs', f.name + '.png'), img.toPNG());
    console.log(f.name, '->', count, img.getSize());
  }
  /*
   * 多会话列表：推一个带 sessions 的快照，再模拟悬停，让面板展开。
   * 单独一拍是因为它需要额外的事件，混在 FRAMES 循环里会把那段逻辑搅乱。
   */
  {
    const count = await win.webContents.executeJavaScript(`
      (function(){
        var arr = window.__fakeWS || [];
        var ws = arr[arr.length - 1];
        if (!ws || typeof ws.onmessage !== 'function') return 'no-ws:' + arr.length;
        ws.onmessage({ data: ${JSON.stringify(JSON.stringify(SESSIONS_FRAME.snap))} });
        return 'ok:' + arr.length;
      })()
    `);
    await new Promise(r => setTimeout(r, 500));
    await win.webContents.executeJavaScript(`
      document.getElementById('bubble').dispatchEvent(new MouseEvent('mouseenter'));
      true;
    `);
    await new Promise(r => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ROOT, 'docs', SESSIONS_FRAME.name + '.png'), img.toPNG());
    console.log(SESSIONS_FRAME.name, '->', count, img.getSize());
  }
  app.quit();
});
