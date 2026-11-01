/* 复古奶油皮肤机身 HTML（构建时内联进 client.js 与 debug/float.machines.js）。
 *
 * 约定：只依赖入参；禁用反引号/模板字符串；根节点必须是单个 .dw-cr。
 * 原来 React 侧（_creamBody）与浮窗侧（creamMachine）各写一份，收成一份。
 */
function creamBodyHtml(state, screenTime, counts, ctx) {
  var g = ctx || {};
  var c = counts || null;

  /* 琥珀屏直接说中文状态词；浮窗会从外面传带错误码的中文标签 */
  var WORD = {
    off: '关机', idle: '待机', starting: '启动中', washing: '洗涤中', rinsing: '漂洗中',
    spinning: '脱水中', waiting: '等你确认', draining: '排水换水', done: '洗完了', error: '故障'
  };
  var word = g.stateText || WORD[state] || '';

  /* 计数胶囊顺序沿用奶油屏：动 → 待 → 错 */
  var pills = '';
  if (c && c.running > 0) pills += '<i class="run">动' + c.running + '</i>';
  if (c && c.waiting > 0) pills += '<i class="wait">待' + c.waiting + '</i>';
  if (c && c.error > 0) pills += '<i class="err">错' + c.error + '</i>';
  var countsHtml = pills ? '<span class="cnt">' + pills + '</span>' : '';

  var style = '--water-h:' + (typeof g.water === 'number' ? g.water : 0) + '%;' +
    '--spin:' + (g.speed || '0s') + ';' +
    '--play:' + (g.play === 'paused' ? 'paused' : 'running') + ';';

  return '<div class="dw-cr" data-state="' + state + '" style="' + style + '">' +
    '<div class="woodtop"></div>' +
    '<div class="ctrl">' +
      '<span class="brand">Walnut · 洗衣机</span>' +
      '<span class="led"></span>' +
      '<span class="knobs"><span class="knob"></span><span class="knob"></span></span>' +
    '</div>' +
    '<div class="doorwrap"><div class="dispenser"></div><div class="handle"></div><div class="hinge"></div>' +
      '<div class="door"><div class="glass"><div class="drum"></div>' +
        '<div class="clothes-c">' + (g.clothes || '') + '</div>' +
        '<div class="water"></div>' +
        '<div class="bubbles"><b></b><b></b><b></b></div>' +
      '</div></div>' +
    '</div>' +
    '<div class="plinth"></div>' +
    '<div class="panel">' +
      '<span class="st">' + word + '</span>' + countsHtml +
      '<span class="tm">' + (screenTime || '') + '</span>' +
    '</div>' +
    '<div class="feet"></div>' +
  '</div>';
}
