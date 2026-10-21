#!/usr/bin/env node
/**
 * dsh-washer 悬浮窗构建脚本：把三套皮肤移植进 debug/float.html。
 *
 * 为什么悬浮窗页面要单独构建：
 * 浮窗是独立 HTML，加载不了 client.js（那份是宿主插件的浏览器半，依赖
 * React 和宿主的 slot 系统）。但用户要的"换肤"就是换三套机器造型，
 * 而这三套的 CSS 和 DOM 结构全在 src/ 里——与其手抄一份迟早跟主界面
 * 变形，不如构建时从同一份源生成。
 *
 * 生成物：debug/float.machines.js（机器造型渲染函数 + 三套皮肤 CSS）
 * float.html 只负责 <script src="./float.machines.js"></script>。
 *
 * 用法：node build-float.mjs   （幂等，不会改 src/）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, 'src', name), 'utf8');

/**
 * 从 client.template.js 里抠出配色表。
 *
 * 直接正则抠源码而不是维护第二份拷贝：这两张表改一次主界面就得跟着改，
 * 拷一份出去必然漂移。抠失败就直接报错——静默降级会让浮窗用旧颜色
 * 而不自知，比构建失败难查得多。
 */
function grabTable(name) {
  const re = new RegExp('const ' + name + ' = (\\{[^}]*\\});');
  const m = src('client.template.js').match(re);
  if (m === null) throw new Error('找不到 ' + name + '，client.template.js 结构变了？');
  return m[1];
}

const PW_WATER = grabTable('PW_WATER');
const AW_WATER = grabTable('AW_WATER');
const SPEED = grabTable('SPEED');
const BUBBLE = grabTable('BUBBLE');
const SCREEN_WORD = (() => {
  const m = src('client.template.js').match(/const SCREEN_WORD = (\{[\s\S]*?\});/);
  if (m === null) throw new Error('找不到 SCREEN_WORD');
  return m[1];
})();
const NATURAL = (() => {
  const m = src('client.template.js').match(/const NATURAL = (\{[\s\S]*?\});/);
  if (m === null) throw new Error('找不到 NATURAL');
  return m[1];
})();

/** 直接从 core.js 抠 VISUAL（浮窗只需要 water/foam/led/blink/spin 四个量） */
function grabVisual() {
  const body = src('core.js');
  const start = body.indexOf('export const VISUAL = {');
  if (start < 0) throw new Error('找不到 VISUAL');
  const end = body.indexOf('};', start);
  if (end < 0) throw new Error('VISUAL 没有闭合');
  return body.slice(start + 'export const VISUAL = '.length, end + 1);
}

const MACHINE_SVG = src('machine.svg').trim();

/**
 * 皮肤 CSS：从 style.css 抽出 --dw-* 变量表，再拼上两套造型的 CSS。
 *
 * 变量表本来是定义在 .dsh-washer 选择器下的，浮窗页面没有那个根节点，
 * 所以套一层 .washerskin 作用域。只抽 :root 那一段——[data-ds-dark-theme]
 * 那份是宿主暗色主题专用的，浮窗自己有背景，不需要。
 */
function skinCss() {
  const style = src('style.css');
  const start = style.indexOf('.dsh-washer {');
  const end = style.indexOf('}', start);
  if (start < 0 || end < 0) throw new Error('style.css 里找不到 .dsh-washer 变量块');
  const vars = style.slice(start + '.dsh-washer {'.length, end);
  return [
    '/** 以下由 build-float.mjs 从 src/ 生成，不要手改 */',
    '.washerskin {',
    vars,
    '}',
    '/* 状态色绑定：和主界面同源，皮肤内部只引用 --dw-sig */',
    ".washerskin[data-state='idle'] { --dw-sig: var(--dw-sig-ok); }",
    '.washerskin[data-state="starting"],',
    '.washerskin[data-state="washing"],',
    '.washerskin[data-state="rinsing"],',
    '.washerskin[data-state="spinning"] { --dw-sig: var(--dw-sig-run); }',
    '.washerskin[data-state="waiting"] { --dw-sig: var(--dw-sig-wait); }',
    '.washerskin[data-state="draining"] { --dw-sig: #1f9aa8; }',
    '.washerskin[data-state="done"] { --dw-sig: var(--dw-sig-ok); }',
    '.washerskin[data-state="error"] { --dw-sig: var(--dw-sig-err); }',
    '',
    '/* dsh-washer · skin-precision.css */',
    src('skin-precision.css'),
    '',
    '/* dsh-washer · skin-anime.css */',
    src('skin-anime.css'),
  ].join('\n');
}

const out = `/**
 * dsh-washer 悬浮窗 · 三套机器造型
 *
 * 由 build-float.mjs 从 src/ 生成，不要手改。
 * 改造型请改 src/client.template.js 或 src/skin-*.css 后重跑构建。
 */
(function () {
  'use strict';

  var VISUAL = ${grabVisual()};
  var PW_WATER = ${PW_WATER};
  var AW_WATER = ${AW_WATER};
  var SPEED = ${SPEED};
  var BUBBLE = ${BUBBLE};
  var SCREEN_WORD = ${SCREEN_WORD};
  var NATURAL = ${NATURAL};
  var MACHINE_SVG = ${JSON.stringify(MACHINE_SVG)};

  var SKIN_CSS = ${JSON.stringify(skinCss())};

  /**
   * 把皮肤的 CSS 注入页面。只注一次。
   * 用 <style> 而不是内联到每个元素，是因为皮肤 CSS 有伪元素和动画，
   * 这些没法用 style 属性表达。
   */
  function ensureSkinCss() {
    if (document.getElementById('dw-skin-css') !== null) return;
    var style = document.createElement('style');
    style.id = 'dw-skin-css';
    style.textContent = SKIN_CSS;
    document.head.appendChild(style);
  }

  function el(tag, cls, children) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (children) {
      for (var i = 0; i < children.length; i++) {
        if (children[i]) node.appendChild(children[i]);
      }
    }
    return node;
  }

  function text(tag, cls, str) {
    var node = el(tag, cls);
    node.textContent = str;
    return node;
  }

  /**
   * 定宽缩放：造型按原始尺寸画，整体 scale 到目标宽度。
   *
   * 为什么不按目标尺寸重写一套小尺寸样式：三套造型的细节（旋钮高光、
   * 玻璃反光、门封圈）都是按像素算的绝对尺寸，重写等于画三套新的。
   * 缩放会糊一点，但 132px 宽下看得清轮廓和颜色就够了——浮窗要的是
   * "一眼认出这是什么机器"，不是看清旋钮上的刻度。
   */
  function frame(skin, state, width, inner) {
    var natural = NATURAL[skin];
    var scale = width / natural.w;
    var box = el('div', 'dw-frame');
    box.style.width = Math.round(natural.w * scale) + 'px';
    box.style.height = Math.round(natural.h * scale) + 'px';
    box.setAttribute('aria-hidden', 'true');
    var innerBox = el('div', 'dw-frame-inner');
    innerBox.style.width = natural.w + 'px';
    innerBox.style.transform = 'scale(' + scale + ')';
    innerBox.appendChild(inner);
    box.appendChild(innerBox);
    return box;
  }

  function pixelMachine(state, width) {
    var host = el('div');
    host.innerHTML = MACHINE_SVG;
    // 像素图靠 --water / --foam / --led / --spin-dur 驱动，主界面和浮窗共用同一套变量名
    host.style.lineHeight = '0';
    return frame('pixel', state, width, host);
  }

  function precisionMachine(state, width, screenTime) {
    var play = SPEED[state] === '0s' ? 'paused' : 'running';
    var water = PW_WATER[state];
    var pw = el('div', 'dw-pw');
    pw.setAttribute('data-state', state);
    pw.style.setProperty('--water-lvl', water + '%');
    pw.style.setProperty('--bubble', String(BUBBLE[state]));
    pw.style.setProperty('--speed', SPEED[state]);
    pw.style.setProperty('--play', play);

    var topbar = el('div', 'topbar', [
      el('div', 'drawer'), el('div', 'knob'), el('div', 'led'),
    ]);
    var glass = el('div', 'glass', [
      el('div', 'drum'),
      el('div', 'clothes', [el('i'), el('i'), el('i'), el('i')]),
      el('div', 'water'),
      el('div', 'bubbles', [el('b'), el('b'), el('b'), el('b'), el('b'), el('b')]),
    ]);
    var door = el('div', 'door', [el('div', 'handle'), el('div', 'lock'), glass]);
    var bar = el('span', 'bar', [el('i')]);
    var panel = el('div', 'panel', [
      el('div', 'row1', [
        text('span', 'state-text', SCREEN_WORD[state] || 'READY'),
        text('span', 'timer', screenTime),
      ]),
      el('div', 'row2', [text('span', 'wl', water + '%'), bar]),
    ]);

    pw.appendChild(topbar);
    pw.appendChild(door);
    pw.appendChild(panel);
    pw.appendChild(el('div', 'feet'));
    return frame('precision', state, width, pw);
  }

  function animeMachine(state, width, screenTime, face) {
    var play = SPEED[state] === '0s' ? 'paused' : 'running';
    var aw = el('div', 'dw-aw');
    aw.setAttribute('data-state', state);
    aw.setAttribute('data-size', 'lg');
    aw.setAttribute('data-face', face ? 'on' : 'off');
    aw.style.setProperty('--w', Math.round(NATURAL.anime.w) + 'px');
    aw.style.setProperty('--speed', SPEED[state]);
    aw.style.setProperty('--play', play);
    aw.style.setProperty('--water', AW_WATER[state] + '%');
    aw.style.setProperty('--bubble', String(BUBBLE[state]));

    var eyes = face ? el('div', 'dw-aw-eyes', [el('i'), el('i')]) : null;
    var glass = el('div', 'dw-aw-glass', [
      el('div', 'dw-aw-drum'),
      el('div', 'dw-aw-clothes', [el('i'), el('i'), el('i'), el('i')]),
      el('div', 'dw-aw-water'),
      el('div', 'dw-aw-foam'),
      eyes,
    ]);

    aw.appendChild(el('div', 'dw-aw-body'));
    aw.appendChild(el('div', 'dw-aw-drawer'));
    aw.appendChild(el('div', 'dw-aw-knob'));
    aw.appendChild(text('div', 'dw-aw-screen', screenTime));
    aw.appendChild(el('div', 'dw-aw-door', [
      el('div', 'dw-aw-ring'), glass, el('div', 'dw-aw-handle'),
    ]));
    aw.appendChild(el('div', 'dw-aw-filter'));
    aw.appendChild(el('div', 'dw-aw-feet', [el('i'), el('i')]));
    aw.appendChild(el('div', 'dw-aw-cord'));
    return frame('anime', state, width, aw);
  }

  /**
   * 造一台机器。三种造型共用同一份状态，只是长得不一样。
   *
   * width 是目标显示宽度（CSS 像素）。窗口固定 132px 时三套造型都缩到
   * 这个宽度以内——方案 B：窗口不跟着皮肤变，代价是精密家电的细节会糊。
   */
  function build(skin, state, width, screenTime, face) {
    ensureSkinCss();
    var s = VISUAL[state] ? state : 'idle';
    var holder;
    if (skin === 'precision') holder = precisionMachine(s, width, screenTime);
    else if (skin === 'anime') holder = animeMachine(s, width, screenTime, face);
    else holder = pixelMachine(s, width);

    // 像素造型靠外层变量驱动，另外两套是自带动画的 DOM 结构
    if (skin === 'pixel' || skin === 'precision' || skin === 'anime') {
      var v = VISUAL[s];
      holder.setAttribute('data-shake', s === 'spinning' ? '2' : (s === 'washing' || s === 'draining' ? '1' : '0'));
      holder.setAttribute('data-blink', v.blink > 0 ? (v.blink < 0.5 ? '2' : '1') : '0');
      holder.style.setProperty('--water', String(v.water));
      holder.style.setProperty('--foam', String(v.foam));
      holder.style.setProperty('--led', String(v.led));
      var spinDur = v.spin > 0 ? (1 / v.spin).toFixed(2) + 's' : '0s';
      holder.style.setProperty('--spin-dur', spinDur);
      holder.style.setProperty('--spin-play', v.spin > 0 ? 'running' : 'paused');
    }
    return holder;
  }

  window.WasherMachines = {
    build: build,
    shapes: ['precision', 'anime', 'pixel'],
    ledColor: function (state) {
      var v = VISUAL[state];
      return v ? v.led : VISUAL.idle.led;
    },
  };
})();
`;

writeFileSync(join(here, 'debug', 'float.machines.js'), out);
console.log('debug/float.machines.js written:', Buffer.byteLength(out, 'utf8'), 'bytes');
