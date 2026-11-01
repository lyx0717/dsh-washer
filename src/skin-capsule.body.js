/* 太空舱 HUD 皮肤机身 HTML（构建时内联进 client.js 与 float.machines.js）。
   约定：只依赖入参，禁用模板字符串与反引号，根节点必须是 .dw-cp。
   造型照 design-demos/capsule/：拉丝钛灰机身 + 冷黑舷窗 + 青色 HUD。 */
function capsuleBodyHtml(state, screenTime, counts, ctx) {
  var WORD = {
    off: '关机', idle: '待机', starting: '启动中', washing: '洗涤中', rinsing: '漂洗中',
    spinning: '脱水中', waiting: '等你确认', draining: '排水换水', done: '洗完了', error: '故障'
  };
  var c = counts || {};
  var pills = '';
  if (c.waiting > 0) pills += '<span class="cp-cnt" data-k="wait">待' + c.waiting + '</span>';
  if (c.running > 0) pills += '<span class="cp-cnt" data-k="run">动' + c.running + '</span>';
  if (c.error > 0) pills += '<span class="cp-cnt" data-k="err">错' + c.error + '</span>';

  var water = typeof ctx.water === 'number' ? ctx.water : 0;
  var spin = ctx.speed || '0s';
  var play = ctx.play === 'paused' ? 'paused' : 'running';
  var clothes = ctx.clothes || '';
  var tm = screenTime || '--:--';
  /* HUD 三段落：状态 → 计数（0 项不输出）→ 计时。计时永远在最后，不换行 */
  var screen = '<span class="cp-st">' + (WORD[state] || WORD.idle) + '</span>' +
    (pills ? '<span class="cp-cnts">' + pills + '</span>' : '') +
    '<span class="cp-tm">' + tm + '</span>';

  return '<div class="dw-cp" data-state="' + state + '"' +
      ' style="--water-h:' + water + '%;--spin:' + spin + ';--play:' + play + '">' +
    '<div class="cp-rail"></div>' +
    '<div class="cp-ctrl">' +
      '<span class="cp-brand"><b>DSH</b><small>ORBITAL WASHER // 07</small></span>' +
      '<span class="cp-led"></span>' +
      '<span class="cp-knobs"><span class="cp-knob"></span><span class="cp-knob"></span></span>' +
    '</div>' +
    '<div class="cp-doorwrap">' +
      '<div class="cp-pod"></div>' +
      '<div class="cp-handle"></div>' +
      '<div class="cp-hinge"></div>' +
      '<div class="cp-door"><div class="cp-glass">' +
        '<div class="cp-drum"></div>' +
        '<div class="cp-clothes cp-ghost" aria-hidden="true">' + clothes + '</div>' +
        '<div class="cp-clothes">' + clothes + '</div>' +
        '<div class="cp-water"></div>' +
        '<div class="cp-bubbles"><b></b><b></b><b></b><b></b></div>' +
      '</div></div>' +
    '</div>' +
    '<div class="cp-plinth"></div>' +
    '<div class="cp-panel">' + screen + '</div>' +
    '<div class="cp-feet"></div>' +
    '</div>';
}
