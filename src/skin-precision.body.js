/* 精密家电皮肤机身 HTML（构建时内联进 client.js 与 debug/float.machines.js）。
 *
 * 约定：只依赖入参；禁用反引号/模板字符串；根节点必须是单个 .dw-pw。
 *
 * 这里以前是「React 一份 + 浮窗一份」手写两套 DOM，两边已经漂移：
 * React 用 .clothes-c + SVG，而 CSS 只写了 .clothes i，浮窗则按运行会话
 * 数生成 <i data-id>。收成一份后：衣物统一走 .clothes i（件数=运行会话
 * 数，1~6，缺省 4），两个运行时共用同一套结构。
 */
function precisionBodyHtml(state, screenTime, counts, ctx) {
  var c = counts || null;
  var g = ctx || {};

  /* 机身小屏只说机器自己的话（WASH / SPIN / ERR…）；浮窗会从外面传中文状态词 */
  var SCREEN_WORD = {
    off: 'OFF', idle: 'READY', starting: 'START', washing: 'WASH', rinsing: 'RINSE',
    spinning: 'SPIN', waiting: 'HOLD', draining: 'DRAIN', done: 'DONE', error: 'ERR'
  };
  var word = g.stateText || SCREEN_WORD[state] || 'READY';

  /* 计数区：待/动/错 三枚胶囊，0 项不渲染 */
  var pills = '';
  if (c && c.waiting > 0) pills += '<span class="cnt" data-k="wait">待' + c.waiting + '</span>';
  if (c && c.running > 0) pills += '<span class="cnt" data-k="run">动' + c.running + '</span>';
  if (c && c.error > 0) pills += '<span class="cnt" data-k="err">错' + c.error + '</span>';
  var countsHtml = pills ? '<span class="counts">' + pills + '</span>' : '';

  /* 衣服件数 = 运行会话数（封顶 6）；拿不到时退回 4 件，别让滚筒空着 */
  var n = (typeof g.clothesCount === 'number') ? g.clothesCount : 4;
  n = Math.max(1, Math.min(6, n | 0));
  var clothes = '';
  for (var i = 0; i < n; i += 1) clothes += '<i></i>';
  var bubbles = '';
  for (var bi = 0; bi < 6; bi += 1) bubbles += '<b></b>';

  var style = '--water-lvl:' + (typeof g.water === 'number' ? g.water : 0) + '%;' +
    '--bubble:' + (g.bubble === undefined ? 0 : g.bubble) + ';' +
    '--speed:' + (g.speed || '0s') + ';' +
    '--play:' + (g.play === 'paused' ? 'paused' : 'running') + ';';

  return '<div class="dw-pw" data-state="' + state + '" style="' + style + '">' +
    '<div class="topbar"><div class="drawer"></div><div class="knob"></div><div class="led"></div></div>' +
    '<div class="door"><div class="handle"></div><div class="lock"></div>' +
      '<div class="glass"><div class="drum"></div>' +
        '<div class="clothes">' + clothes + '</div>' +
        '<div class="water"></div>' +
        '<div class="bubbles">' + bubbles + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="panel"><div class="row1">' +
      '<span class="state-text">' + word + '</span>' + countsHtml +
      '<span class="timer">' + (screenTime || '') + '</span>' +
    '</div></div>' +
    '<div class="feet"></div>' +
  '</div>';
}
