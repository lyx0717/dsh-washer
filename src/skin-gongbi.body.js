/* 工笔重彩皮肤机身 HTML（构建时内联进 client.js 与 debug/float.machines.js）。
   约定：只依赖入参，禁用模板字符串（反引号）与美元花括号插值，根节点必须是单个 .dw-gb。
   移植自 design-demos/gongbi（熟宣纸底 + 铁线描 + 淡赭石/花青分染）。 */
function gongbiBodyHtml(state, screenTime, counts, ctx) {
  var c = counts || { waiting: 0, running: 0, error: 0 };
  var g = ctx || {};

  var pills = '';
  if (c.waiting > 0) pills += '<span class="gb-cnt" data-k="wait">待' + c.waiting + '</span>';
  if (c.running > 0) pills += '<span class="gb-cnt" data-k="run">动' + c.running + '</span>';
  if (c.error > 0) pills += '<span class="gb-cnt" data-k="err">错' + c.error + '</span>';

  var WORD = {
    off: '关机', idle: '待机', starting: '启动中', washing: '洗涤中', rinsing: '漂洗中',
    spinning: '脱水中', draining: '排水换水', waiting: '等你确认', done: '洗完了', error: '故障'
  };
  var word = WORD[state] || '待机';

  var style = '--water-h:' + (g.water || 0) + '%;--spin:' + (g.speed || '0s') + ';--play:' + (g.play || 'paused') + ';';

  return '<div class="dw-gb" data-state="' + state + '" style="' + style + '">' +
    '<div class="gb-woodtop"></div>' +
    '<div class="gb-ctrl">' +
      '<div class="gb-drawer"></div>' +
      '<div class="gb-grille"><span class="gb-knob"></span></div>' +
      '<div class="gb-display"><span class="gb-win"></span>' +
        '<span class="gb-seg"><i></i><i></i><i></i></span></div>' +
    '</div>' +
    '<div class="gb-doorwrap">' +
      '<div class="gb-handle"></div>' +
      '<div class="gb-hinge"></div>' +
      '<div class="gb-door"><div class="gb-glass">' +
        '<div class="gb-drum"></div>' +
        '<div class="gb-clothes">' + (g.clothes || '') + '</div>' +
        '<div class="gb-water"></div>' +
        '<div class="gb-bubbles"><b></b><b></b><b></b></div>' +
      '</div></div>' +
    '</div>' +
    '<div class="gb-plinth"></div>' +
    '<div class="gb-panel">' +
      '<span class="gb-st">' + word + '</span>' +
      (pills ? '<span class="gb-counts">' + pills + '</span>' : '') +
      '<span class="gb-tm">' + (screenTime || '--:--') + '</span>' +
    '</div>' +
    '<div class="gb-seal"><b>澄</b><b>怀</b></div>' +
    '<div class="gb-feet"></div>' +
  '</div>';
}
