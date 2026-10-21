#!/usr/bin/env node
/**
 * dsh-washer 的两类离线验证，都在 node 里跑真正的 client.js：
 *
 * 1) 行为测试：给 client.js 一个最小 React 运行时（useState/useEffect/useRef 真跑、
 *    真重渲染、真定时器），驱动 props 变化，断言状态机在时间轴上的行为
 *    （200ms 内 starting、工具调用期间 rinsing、结束后 done 保持再回 idle…）。
 * 2) 截图素材：把每个状态 / 档位 / 明暗主题的 DOM 序列化成静态 HTML，
 *    交给 headless Chrome 出图，人眼验收视觉。
 *
 * 用法：node test/render.mjs [outDir] [--no-shots]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const noShots = args.includes('--no-shots');
const outDir = args.find((a) => !a.startsWith('--')) || '/tmp/washer-render';
if (!noShots) mkdirSync(outDir, { recursive: true });

/* ================================================================== *
 * 最小 React 运行时
 * ================================================================== */
const Fragment = Symbol('Fragment');

/* ---- hooks：单根组件，按调用顺序存槽 ---- */
let slots = [];
let cursor = 0;
let dirty = false;
let pendingEffects = [];

function useState(init) {
  const i = cursor;
  cursor += 1;
  if (!(i in slots)) slots[i] = { kind: 'state', value: typeof init === 'function' ? init() : init };
  const slot = slots[i];
  const set = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next;
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    dirty = true;
  };
  return [slot.value, set];
}
function useReducer(reducer, init, initArg) { return useState(initArg === undefined ? init : init); }
function useMemo(fn) { cursor += 1; return fn(); }
function useCallback(fn) { cursor += 1; return fn; }
function useRef(init) {
  const i = cursor;
  cursor += 1;
  if (!(i in slots)) slots[i] = { kind: 'ref', current: init };
  return slots[i];
}
function useEffect(fn, deps) {
  const i = cursor;
  cursor += 1;
  const prev = slots[i];
  const changed = prev === undefined || deps === undefined || !sameDeps(prev.deps, deps);
  if (changed) {
    slots[i] = { kind: 'effect', deps, cleanup: prev ? prev.cleanup : undefined };
    pendingEffects.push({ index: i, fn });
  }
}
function useLayoutEffect(fn, deps) { return useEffect(fn, deps); }
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function createElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  const flat = [];
  const push = (c) => {
    if (c === null || c === undefined || typeof c === 'boolean') return;
    if (Array.isArray(c)) { c.forEach(push); return; }
    flat.push(c);
  };
  push(children.length === 1 ? children[0] : children);
  if (merged.children !== undefined) { push(merged.children); delete merged.children; }
  if (flat.length > 0) merged.children = flat;
  return { type, props: merged };
}

const React = {
  Fragment, createElement, useState, useReducer, useEffect, useLayoutEffect,
  useMemo, useCallback, useRef, memo: (c) => c,
};

/* ================================================================== *
 * 序列化
 * ================================================================== */
const VOID = new Set(['br', 'hr', 'img', 'input']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function styleAttr(style) {
  const parts = [];
  for (const key of Object.keys(style)) {
    const value = style[key];
    if (value === undefined || value === null) continue;
    const name = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    parts.push(name + ':' + value);
  }
  return parts.length === 0 ? '' : ' style="' + esc(parts.join(';')) + '"';
}
const ATTR_ALIAS = { className: 'class', htmlFor: 'for' };
let BUTTON_HANDLERS = [];
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (Array.isArray(node)) return node.map(render).join('');
  const { type, props } = node;
  if (typeof type === 'function') return render(type(props));
  if (type === Fragment) return render(props.children);
  let attrs = '';
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'dangerouslySetInnerHTML') continue;
    // ref 不是 DOM 属性：真实 React 会把它写进 ref.current，这里模拟成同样的语义
    if (key === 'ref') continue;
    const value = props[key];
    if (value === undefined || value === null || value === false) continue;
    if (key === 'style') { attrs += styleAttr(value); continue; }
    attrs += ' ' + (ATTR_ALIAS[key] || key) + '="' + esc(value === true ? '' : value) + '"';
  }
  const inner = props.dangerouslySetInnerHTML ? props.dangerouslySetInnerHTML.__html : render(props.children);
  if (props.ref && typeof props.ref === 'object') {
    // 最小可用的「节点」：contains 用于焦点判断，isConnected 用于存活判断
    const node = {
      className: props.className || '',
      isConnected: true,
      // 测试里的「焦点是否在洗衣机内」只用到 contains：同一对象即视为命中
      contains: (other) => other === node,
    };
    props.ref.current = node;
    if (String(props.className || '').includes('dsh-washer')) ROOT_REFS.push(node);
  }
  if (VOID.has(type)) return '<' + type + attrs + '>';
  // 序列化时登记 click handler：测试靠它模拟真实点击（key 不进 DOM）
  if (typeof props.onClick === 'function') {
    const idx = BUTTON_HANDLERS.length;
    BUTTON_HANDLERS.push({ handler: props.onClick, className: props.className, text: '' });
    attrs += ' data-click-idx="' + idx + '"';
  }
  return '<' + type + attrs + '>' + inner + '</' + type + '>';
}

/* ================================================================== *
 * 装载 client.js
 * ================================================================== */
let plugin = null;
const cssTags = [];
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      plugin = def.factory((spec) => {
        if (spec === 'react') return React;
        throw new Error('unexpected require: ' + spec);
      });
    },
  },
};
/* 带 ref 的洗衣机根节点登记表（模拟 React ref.current） */
const ROOT_REFS = [];

/* 供 document mock 与 Esc 测试共用 */
const docListeners = [];
let activeElement = null;
globalThis.__setActiveElement = (el) => { activeElement = el; };

globalThis.document = {
  querySelector: () => null,
  createElement: () => {
    const tag = { dataset: {}, textContent: '' };
    cssTags.push(tag);
    return tag;
  },
  head: { appendChild: () => {} },
  // Esc 走 document 捕获阶段监听（见 client.template.js「Esc 逐级退回」），
  // 这里给出最小实现，并允许测试直接派发键盘事件。
  addEventListener: (type, fn) => { docListeners.push({ type, fn }); },
  removeEventListener: (type, fn) => {
    const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) docListeners.splice(i, 1);
  },
  get activeElement() { return activeElement; },
};
globalThis.__docListeners = docListeners;
new Function(readFileSync(join(root, 'client.js'), 'utf8'))();

assert.equal(typeof plugin, 'object', 'client.js 必须 return 插件对象');
assert.ok(plugin.inject.includes('slots'), 'inject 必须含 slots');
assert.ok(plugin.inject.includes('locale'), 'inject 必须含 locale');

/* ---- 捕获注册 ---- */
const registrations = [];
const dictionaries = [];
const ctx = {
  effect(fn, label) {
    const off = fn();
    assert.equal(typeof off, 'function', 'effect 必须返回 disposer: ' + label);
    return off;
  },
  locale: {
    register(ns, locale, dict) { dictionaries.push({ ns, locale, dict }); return () => {}; },
    bind: () => (key) => key,
    getSnapshot: () => ({ active: 'zh', revision: 1 }),
  },
  slots: {
    inject(name, run) { run(); },
    register(entry, Component) { registrations.push({ entry, Component }); return () => {}; },
  },
};
plugin.apply(ctx, {});
plugin.apply(ctx, {}); // 重复 apply（HMR / 双挂载）不得抛错

assert.equal(dictionaries.length, 4, '两次 apply 各注册 zh+en');
// 每次 apply 注册 3 个 occupant：设置页 + dock 座位 + waiting 替补
assert.equal(registrations.length, 6, '两次 apply 各注册三个 occupant（settings + dock + header）');
assert.deepEqual(
  registrations.filter((r) => r.entry.name === 'settings.section').map((r) => r.entry.id),
  ['washer', 'washer'],
  '设置页座位 id 稳定，重复 apply 不换 id',
);

/* ---- overlay 模式：独立收集一次 ---- */
const overlayRegistrations = [];
const overlayCtx = Object.assign({}, ctx, {
  slots: {
    inject(name, run) { run(); },
    register(entry, Component) { overlayRegistrations.push({ entry, Component }); return () => {}; },
  },
});
plugin.apply(overlayCtx, { mode: 'overlay' });
// 设置页与 mode 无关，两种模式都要有；浮层座位只在 overlay 下出现
const overlaySlots = overlayRegistrations.filter((r) => r.entry.name === 'shell.overlay');
assert.equal(overlaySlots.length, 1, 'overlay 模式只注册一个浮层 occupant');
assert.equal(
  overlayRegistrations.filter((r) => r.entry.name === 'settings.section').length, 1,
  'overlay 模式下设置页入口依然存在',
);
assert.equal(
  overlayRegistrations.filter((r) => r.entry.name.startsWith('conversation.')).length, 0,
  'overlay 模式不再占用输入区座位',
);
const OverlayComponent = overlaySlots[0].Component;
const sessionEntries = registrations.filter((r) => r.entry.name.startsWith('conversation.'));
const entry = sessionEntries[0].entry;
assert.equal(entry.name, 'conversation.composer.dock', '默认挂 conversation.composer.dock（AC20）');
const headerEntry = sessionEntries[1].entry;
assert.equal(headerEntry.name, 'conversation.session.header.utilities', 'waiting 替补挂在会话标题栏');
assert.equal(entry.locale, 'washer', 'locale 命名空间要传给渲染器，否则组件拿不到 t');
assert.ok(cssTags.length >= 1, 'CSS 必须注入');
assert.ok(cssTags[0].textContent.length > 20000, 'CSS 内容像是空的');

// 第一个注册项现在是设置页，会话座位要单独取
const Component = sessionEntries[0].Component;
const zh = dictionaries.find((d) => d.locale === 'zh').dict;
const t = (key, params) => {
  const template = zh[key];
  if (template === undefined) return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
};

/* ================================================================== *
 * 挂载器：真跑 hooks + effects。props 每遍从 world 现算，这样 setWorld 能驱动重渲染。
 * ================================================================== */
const NOW = Date.now();
const T0 = NOW - 70000;

const baseConfig = (over) => Object.assign({
  enabled: true, mode: 'dock', size: 'S', expandedByDefault: false, skin: 'auto',
  skinBySize: { xs: 'pixel', sm: 'precision', md: 'precision', lg: 'anime' },
  face: false, reduceMotion: 'auto', showCost: false, costPerKToken: 0, costCurrency: 'CNY',
  hideWhenIdle: false, overlayOnlyWhenBusy: true, doneHoldMs: 300, toolHistoryLimit: 6,
}, over || {});

function makeWorld(over) {
  return {
    sessionId: 'sess-1',
    running: false, pending: undefined, runningCalls: [], partial: null,
    nodes: [], outline: [], turnTimings: new Map(), requests: [],
    config: baseConfig(),
    ...over,
  };
}

/* 从 world 现算 slot props（宿主在真实环境里是快照订阅，这里是等价的最简实现） */
function propsFrom(world) {
  const w = world;
  return {
    // 配置回写通道：apply 里由 ctx.configForms 提供，测试用 world.prefSink 替身
    washerSetPref: (key, value) => { if (typeof w.prefSink === 'function') w.prefSink(key, value); },
    washerConfig: w.config,
    sessionId: w.sessionId,
    useSession: (sel) => sel({ running: w.running === true, removed: false, subagent: null, blank: false }),
    useSessionStatus: (sel) => sel(new Map([[w.sessionId, { running: w.running === true, pendingInteraction: w.pending, completionUnread: false }]])),
    useChat: (sel) => sel({ legacy: { nodes: w.nodes, runningCalls: w.runningCalls, partial: w.partial, turnTimings: w.turnTimings, turnEnds: new Map() } }),
    useTrajectory: (sel) => sel({ requests: w.requests || [], eventNodes: [], partial: null, runningCalls: [] }),
    useProjection: (key) => {
      if (key === 'turnOutline') return w.outline;
      if (key === 'tokenUsage') return { uncachedInputTokens: 8200, cacheReadTokens: 42000, cacheWriteTokens: 1200, outputTokens: 3100 };
      if (key === 'sessionStats') return { turns: 2, steps: 6, llmMs: 12000, toolMs: 30000, ttftMs: 900, ttftSteps: 3, decodeMs: 8000, decodeTokens: 2600 };
      return undefined;
    },
    t,
    washerVariant: w.variant || 'dock',
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tools = (n) => Array.from({ length: n }, (_, i) => ({
  kind: 'tool-result', turn: 1, name: i === 2 ? 'apply_patch' : 'shell', isError: false,
  callTime: NOW - (n - i) * 1500, time: NOW - (n - i) * 1500 + 700,
}));
const streaming = (over) => makeWorld(Object.assign({
  running: true, partial: { turn: 1, step: 2, blocks: [] },
  outline: [{ turn: 1, seq: 1, prompt: 'hi', response: '' }],
  nodes: tools(2), turnTimings: new Map([[1, { startTime: T0 }]]),
}, over || {}));

function mount(world, variant, configOver) {
  if (variant !== undefined) world.variant = variant;
  if (configOver !== undefined) world.config = baseConfig(configOver);
  let tree = '';
  ROOT_REFS.length = 0; // 每次 mount 重新登记，避免跨用例串味
  function flushEffects() {
    const batch = pendingEffects;
    pendingEffects = [];
    for (const { index, fn } of batch) {
      const slot = slots[index];
      if (!slot) continue;
      if (typeof slot.cleanup === 'function') slot.cleanup();
      const cleanup = fn();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }
  function pass() {
    let guard = 0;
    do {
      dirty = false;
      cursor = 0;
      pendingEffects = [];
      BUTTON_HANDLERS = [];
      tree = render(Component(propsFrom(world)));
      flushEffects();
      guard += 1;
      if (guard > 50) throw new Error('render loop did not settle (>50 passes)');
    } while (dirty);
  }
  pass();
  return {
    get html() { return tree; },
    get state() { const m = /data-state="([^"]+)"/.exec(tree); return m ? m[1] : undefined; },
    get level() { const m = /data-level="([^"]+)"/.exec(tree); return m ? m[1] : undefined; },
    /** 洗衣机根节点的 ref 目标（真实 React 里由 ref.current 给出） */
    get rootNode() { return ROOT_REFS.length > 0 ? ROOT_REFS[ROOT_REFS.length - 1] : null; },
    text() { return tree.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); },
    set(over) { Object.assign(world, over); pass(); },
    /** 触发一次渲染（键盘事件直接改 state，不经过 click 的 pass()） */
    render() { pass(); },
    setConfig(over) { world.config = baseConfig(over); pass(); },
    setPrefSink(fn) { world.prefSink = fn; pass(); },
    /** 按按钮文字点击（找不到或命中多个都报错，避免测试悄悄点错） */
    clickText(text) {
      const re = /<button[^>]*data-click-idx="(\d+)"[^>]*>([\s\S]*?)<\/button>/g;
      let match;
      const hits = [];
      while ((match = re.exec(tree)) !== null) {
        const label = match[2].replace(/<[^>]+>/g, '').trim();
        if (label === text) hits.push(Number(match[1]));
      }
      if (hits.length === 0) throw new Error('找不到按钮「' + text + '」');
      if (hits.length > 1) throw new Error('按钮「' + text + '」命中 ' + hits.length + ' 个，无法确定点哪个');
      const handler = BUTTON_HANDLERS[hits[0]];
      if (!handler || typeof handler.handler !== 'function') throw new Error('「' + text + '」没有 click handler');
      handler.handler({ stopPropagation() {} });
      pass();
    },
    /** 按 class 点击：给只有图标、没有文字的按钮用（卡片的折叠键） */
    clickClass(cls) {
      const hits = [];
      const tagRe = /<button\b[^>]*>/g;
      let tag;
      while ((tag = tagRe.exec(tree)) !== null) {
        const attrs = tag[0];
        const clsMatch = /class="([^"]*)"/.exec(attrs);
        const idxMatch = /data-click-idx="(\d+)"/.exec(attrs);
        if (!clsMatch || !idxMatch) continue;
        if (clsMatch[1].split(/\s+/).includes(cls)) hits.push(Number(idxMatch[1]));
      }
      if (hits.length === 0) throw new Error('找不到 class 含「' + cls + '」的按钮');
      if (hits.length > 1) throw new Error('class「' + cls + '」命中 ' + hits.length + ' 个');
      const handler = BUTTON_HANDLERS[hits[0]];
      if (!handler || typeof handler.handler !== 'function') throw new Error(cls + ' 没有 click handler');
      handler.handler({ stopPropagation() {} });
      pass();
    },
    async settle(ms) { await wait(ms); pass(); },
    unmount() {
      for (const slot of slots) if (slot && typeof slot.cleanup === 'function') { slot.cleanup(); slot.cleanup = undefined; }
    },
  };
}

/* ================================================================== *
 * 行为测试
 * ================================================================== */
const results = [];
async function test(name, fn) {
  slots = []; cursor = 0; dirty = false; pendingEffects = [];
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ✓ ' + name);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log('  ✗ ' + name + '\n      ' + (error && error.message));
  } finally {
    slots = []; cursor = 0; dirty = false; pendingEffects = [];
  }
}

console.log('\ndsh-washer client behavior');

await test('空会话 / 无 sessionId → 不渲染', () => {
  const m = mount(makeWorld({}));
  m.set({ sessionId: undefined });
  assert.equal(m.html, '', '无 sessionId 时不占位');
  m.unmount();
});

await test('idle → 条状 S 档，不出展开卡（AC21 默认 S）', () => {
  const m = mount(makeWorld({}));
  assert.equal(m.state, 'idle');
  assert.equal(m.level, 'S');
  assert.ok(!m.html.includes('dw-card'), 'S 档不应有卡片节点');
  assert.ok(m.html.includes('dw-strip'), '必须有停靠条');
  assert.ok(m.text().includes('待机'), '主行应是状态词');
  m.unmount();
});

await test('running 起轮未产出 → starting；开始流式输出 → washing（AC3）', async () => {
  const m = mount(makeWorld({}));
  m.set({ running: true, outline: [{ turn: 1, seq: 1, prompt: '', response: '' }] });
  assert.equal(m.state, 'starting', '刚起轮还没产出 → starting');
  await m.settle(120);
  m.set({ outline: [{ turn: 1, seq: 1, prompt: 'hi', response: '' }] });
  assert.equal(m.state, 'starting');
  m.set({ partial: { turn: 1, step: 1, blocks: [] } });
  await m.settle(450);
  assert.equal(m.state, 'washing', '开始流式输出 → washing');
  m.unmount();
});

await test('工具调用期间 → rinsing，副行显示工具名，结束后回 washing（AC4）', async () => {
  const m = mount(streaming({ nodes: tools(2) }));
  await m.settle(450);
  assert.equal(m.state, 'washing');
  m.set({ runningCalls: [{ phase: 'start', callId: 'c1', name: 'apply_patch', turn: 1, step: 3 }], partial: null });
  await m.settle(20);
  assert.equal(m.state, 'rinsing');
  assert.ok(m.html.includes('apply_patch'), '副行要能看见工具名');
  m.set({ runningCalls: [], nodes: tools(3) });
  await m.settle(450);
  assert.equal(m.state, 'washing', '工具结束后回 washing');
  m.unmount();
});

await test('等审批 → waiting 时 dock 座位让位（AC5）', async () => {
  const m = mount(streaming({}), 'dock');
  await m.settle(450);
  assert.equal(m.state, 'washing', 'dock 座位平时渲染');
  m.set({ pending: { kind: 'approval', requestId: 'r1' } });
  await m.settle(20);
  assert.equal(m.state, undefined, 'dock 座位在 waiting 时让位（宿主会隐藏整个 composer）');
  m.set({ pending: undefined });
  await m.settle(450);
  assert.equal(m.state, 'washing', '审批完继续洗涤');
  m.unmount();
});

await test('等审批 → header 座位顶上，黄色（AC5）', async () => {
  const m = mount(streaming({}), 'header');
  await m.settle(450);
  assert.equal(m.state, undefined, 'header 座位平时不渲染');
  m.set({ pending: { kind: 'approval', requestId: 'r1' } });
  await m.settle(20);
  assert.equal(m.state, 'waiting', 'header 座位在 waiting 时顶上');
  assert.ok(m.html.includes('data-tone="warn"'), '等待态要用 warn 色');
  m.set({ pending: undefined });
  await m.settle(450);
  assert.equal(m.state, undefined, '审批完 header 座位退回');
  m.unmount();
});

await test('正常结束 → done 保持，窗口过后回 idle（AC6）', async () => {
  const m = mount(streaming({}));
  await m.settle(450);
  m.set({
    running: false, partial: null,
    outline: [{ turn: 1, seq: 1, prompt: 'hi', response: 'ok' }],
    turnTimings: new Map([[1, { startTime: T0, endTime: Date.now() }]]),
  });
  await m.settle(20);
  assert.equal(m.state, 'done', '结束后进入 done 保持窗口');
  assert.ok(m.text().includes('洗完了'), 'done 要有完成文案');
  await m.settle(380);
  assert.equal(m.state, 'idle', '保持窗口过后回 idle');
  m.unmount();
});

await test('失败 → error + E 码（AC7）', async () => {
  const m = mount(streaming({}));
  await m.settle(450);
  m.set({
    running: false, partial: null,
    nodes: [...tools(3), { kind: 'turn-error', turn: 1, message: 'max_tokens exceeded', code: 'MAX_TOKENS' }],
  });
  await m.settle(20);
  assert.equal(m.state, 'error');
  assert.ok(m.html.includes('E-30'), '输出截断应对应 E-30，实际：' + m.text());
  assert.ok(m.html.includes('data-tone="error"'));
  m.unmount();
});

await test('模型失败 → E-10；工具失败 → E-20', async () => {
  const a = mount(streaming({}));
  await a.settle(450);
  a.set({ running: false, partial: null, nodes: [{ kind: 'turn-error', turn: 1, message: 'upstream 500', code: 'SERVER' }] });
  await a.settle(20);
  assert.ok(a.text().includes('E-10'), '模型失败应是 E-10，实际：' + a.text());
  a.unmount();

  const b = mount(streaming({}));
  await b.settle(450);
  b.set({ running: false, partial: null, nodes: [{ kind: 'tool-result', turn: 1, name: 'shell', isError: true, error: { code: 'EXIT_1' } }] });
  await b.settle(20);
  assert.ok(b.text().includes('E-20'), '工具失败应是 E-20，实际：' + b.text());
  b.unmount();
});

await test('上下文压缩 → draining（AC8）', async () => {
  const m = mount(streaming({}));
  await m.settle(450);
  assert.equal(m.state, 'washing', '前置：正在洗');

  m.set({ requests: [{ purpose: 'compaction', status: 'running' }] });
  await m.settle(600);
  assert.equal(m.state, 'draining', '压缩中应是 draining，实际：' + m.state);

  // 压缩结束 → 回到正常判定（这里工具还在跑，所以是 rinsing）
  m.set({ requests: [{ purpose: 'compaction', status: 'complete' }], runningCalls: [{ name: 'bash', callId: 'c1' }] });
  await m.settle(600);
  assert.notEqual(m.state, 'draining', '压缩结束后不该停在 draining');
  m.unmount();
});

await test('expandedByDefault:true → 挂载即展开到 M 档（AC21）', async () => {
  const m = mount(streaming({ config: baseConfig({ expandedByDefault: true }) }));
  await m.settle(450);
  assert.equal(m.level, 'M', 'expandedByDefault 展开到 M');
  assert.ok(m.html.includes('dw-card'), 'M 档必须有卡片');
  m.unmount();
});

await test('展开后能用卡片上的折叠键收起 / 再展开（用户报障 1）', async () => {
  const m = mount(streaming({ config: baseConfig({ expandedByDefault: true }) }));
  await m.settle(450);
  assert.equal(m.level, 'M');

  // 折叠键的语义是「收起」，任何档位点它都直接回 S。
  // （之前 M 档点它是展开到 L，导致 M 档根本没有收起入口——用户以为按钮坏了。）
  m.clickClass('dw-fold');
  assert.equal(m.level, 'S', 'M 档点折叠键应收起回 S');
  assert.ok(m.html.includes('dw-strip'), 'S 档应回到停靠条');
  assert.ok(!m.html.includes('dw-card'), 'S 档不该残留卡片');

  // S → M：点停靠条（只有 S 档渲染 .dw-strip，三档是互斥的）
  m.clickClass('dw-strip');
  assert.equal(m.level, 'M', '点停靠条应从 S 到 M');

  // 再展开到 L 只能靠「挂载即 L」或 Esc 反推；这里直接验证 M 档卡片结构完好
  assert.ok(m.html.includes('dw-card'), 'M 档应渲染卡片');
  assert.ok(m.html.includes('dw-fold'), 'M 档必须有收起键');

  m.unmount();
});

await test('Esc 逐级退回：焦点在洗衣机里 → L/M 回 S（AC 键盘）', async () => {
  const m = mount(streaming({ config: baseConfig({ size: 'L' }) }));
  await m.settle(400);
  assert.equal(m.level, 'L', '挂载即 L');

  // 让焦点落进洗衣机子树：模拟用户点了卡片里的按钮
  const root = m.rootNode;
  assert.ok(root, '应能拿到洗衣机根节点');
  __setActiveElement(root);

  const fireEsc = () => {
    let prevented = false;
    const event = {
      key: 'Escape', isComposing: false, defaultPrevented: false,
      preventDefault() { prevented = true; this.defaultPrevented = true; },
      stopPropagation() {},
    };
    for (const l of docListeners.filter((x) => x.type === 'keydown')) l.fn(event);
    return prevented;
  };

  assert.ok(fireEsc(), '焦点在洗衣机里时 Esc 必须被消费（否则会漏给宿主）');
  m.render();
  assert.equal(m.level, 'M', 'L 档按 Esc 应退回 M（逐级退，不是一步到 S）');

  // 重渲染后 root 是新的对象，焦点得重新落回新 root 上
  __setActiveElement(m.rootNode);
  // 再按一次 Esc：M → S
  assert.ok(fireEsc(), 'M 档 Esc 也要被消费');
  m.render();
  assert.equal(m.level, 'S', 'M 档按 Esc 应收回 S');

  // 焦点不在洗衣机里：Esc 不能拦，要留给输入框
  __setActiveElement(null);
  const consumed = fireEsc();
  assert.equal(consumed, false, '焦点不在洗衣机里时不该吞掉 Esc');

  __setActiveElement(null);
  m.unmount();
});

await test('M 档卡片里必须有可点的折叠入口（不能只能进不能出）', async () => {
  const m = mount(streaming({ config: baseConfig({ expandedByDefault: true }) }));
  await m.settle(450);
  assert.equal(m.level, 'M');
  assert.ok(/class="[^"]*dw-fold[^"]*"/.test(m.html), 'M 档卡片必须有 .dw-fold 按钮');
  m.unmount();
});

await test('皮肤分段/设置页选项是真按钮（有 class dw-seg-btn，不是纯文字）', async () => {
  const m = mount(streaming({ config: baseConfig({ size: 'L' }) }));
  await m.settle(450);
  const segCount = (m.html.match(/class="[^"]*dw-seg-btn/g) || []).length;
  assert.ok(segCount >= 6, 'L 档应有至少 6 个分段按钮（4 皮肤 + 2 表情），实际 ' + segCount);
  // 每个选项都必须是 <button>，而不是套了一层 span
  const segBlock = m.html.slice(m.html.indexOf('dw-skinrow'));
  assert.ok(segBlock.includes('<button'), '分段控件里必须有 <button> 元素');
  m.unmount();
});

await test('skin=pixel / precision / anime 都能渲染出机型 DOM', async () => {
  for (const skin of ['pixel', 'precision', 'anime']) {
    const m = mount(streaming({ config: baseConfig({ expandedByDefault: true, skin }) }));
    await m.settle(450);
    assert.ok(m.html.includes('dw-card'), skin + ' 应渲染卡片');
    if (skin === 'pixel') assert.ok(m.html.includes('px-svg'), 'pixel 用整机 sprite');
    if (skin === 'precision') assert.ok(m.html.includes('dw-pw'), 'precision 用精密家电 DOM');
    if (skin === 'anime') assert.ok(m.html.includes('dw-aw'), 'anime 用动漫 DOM');
    m.unmount();
  }
});

await test('face:false 时 DOM 里没有眼睛节点（AC16）', async () => {
  const off = mount(streaming({ config: baseConfig({ expandedByDefault: true, skin: 'anime', face: false }) }));
  await off.settle(450);
  assert.ok(!off.html.includes('dw-aw-eyes'), 'face:false 不应有眼睛节点（不是 opacity:0）');
  off.unmount();

  const on = mount(streaming({ config: baseConfig({ expandedByDefault: true, skin: 'anime', face: true }) }));
  await on.settle(450);
  assert.ok(on.html.includes('dw-aw-eyes'), 'face:true 要有眼睛节点');
  on.unmount();
});

await test('hideWhenIdle:true 时 idle 完全隐藏（AC 无声打扰）', () => {
  const m = mount(makeWorld({}));
  m.setConfig({ hideWhenIdle: true });
  assert.equal(m.html, '', 'hideWhenIdle 时 idle 应完全隐藏');
  m.setConfig({ hideWhenIdle: false });
  assert.equal(m.state, 'idle');
  m.unmount();
});

await test('enabled:false → 不注册 slot', () => {
  const before = registrations.length;
  const guard = {
    locale: { register() { return () => {}; }, bind: () => (k) => k, getSnapshot: () => ({ active: 'zh', revision: 1 }) },
    effect(fn) { const off = fn(); assert.equal(typeof off, 'function'); return off; },
    slots: { inject() { throw new Error('enabled:false 不应注册 slot'); }, register() { throw new Error('enabled:false 不应注册 slot'); } },
  };
  plugin.apply(guard, { enabled: false });
  assert.equal(registrations.length, before);
});

await test('成本默认不显示；费率为 0 时即使 showCost 也不显示（AC23）', async () => {
  const a = mount(streaming({ config: baseConfig({ size: 'L', skin: 'precision', showCost: false, costPerKToken: 0.004 }) }));
  await a.settle(450);
  assert.ok(!a.text().includes('成本'), '默认不显示成本');
  a.unmount();

  const b = mount(streaming({ config: baseConfig({ size: 'L', skin: 'precision', showCost: true, costPerKToken: 0 }) }));
  await b.settle(450);
  assert.ok(!b.text().includes('成本'), '费率为 0 视为不显示');
  b.unmount();

  const c = mount(streaming({ config: baseConfig({ size: 'L', skin: 'precision', showCost: true, costPerKToken: 0.004 }) }));
  await c.settle(450);
  assert.ok(c.text().includes('成本'), '开了且费率 > 0 才显示，实际：' + c.text());
  c.unmount();
});

await test('文案里没有漏翻的 key / 未替换的占位符', async () => {
  const m = mount(streaming({ nodes: tools(3) }));
  await m.settle(450);
  const text = m.text();
  m.unmount();
  assert.ok(!/state\.|sub\.|label\./.test(text), '不许把 key 直接渲染出来：' + text);
  assert.ok(!/[{}]/.test(text), '不许留未替换的占位符：' + text);
});

await test('B2 卸载干净：CSS 归属标记与模块 id 一致（AC12）', async () => {
  // 宿主卸载时调 removeOwnedStyles(ownerId)，按 style[data-plugin] 精确匹配回收。
  // 我们必须在标签上写和模块 id 一模一样的名字，否则卸载后 style 会永久留在 <head>。
  const cl = readFileSync(join(root, 'client.js'), 'utf8');
  const idMatch = cl.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/);
  assert.ok(idMatch, 'client.js 必须通过 __ModuleLoader__.load 注册且带字符串 id');
  const moduleId = idMatch[1];

  // stripClientSuffix: 宿主会把尾部的 "/client" 去掉当 ownerId
  const ownerId = moduleId.endsWith('/client') ? moduleId.slice(0, -7) : moduleId;

  const pluginTag = cl.match(/dataset\.plugin\s*=\s*'([^']+)'/);
  assert.ok(pluginTag, '必须给注入的 <style> 打 data-plugin 归属标记');
  assert.equal(
    pluginTag[1], ownerId,
    'style 的 data-plugin 必须等于宿主算出的 ownerId（否则卸载后 CSS 残留）',
  );

  // data-plugin-css 用作去重 id，也必须在
  assert.ok(/dataset\.pluginCss\s*=/.test(cl), 'style 必须有 data-plugin-css 去重标记');

  // 不该有自建的第二份 head 注入（会导致重复注入/无法回收）
  const styleInserts = (cl.match(/head\.appendChild\(/g) || []).length;
  assert.ok(styleInserts <= 1, '只应有一处 head.appendChild 注入 CSS，实际 ' + styleInserts);
});

await test('A4 减弱动效：只停装饰运动，不停指示灯和水位（AC11）', async () => {
  // checklist A4 要求「滚筒不转，但状态文字仍变、指示灯/水位变化仍在」。
  // 曾经用 `.dsh-washer *` 通配一把梭，把指示灯闪烁和水位过渡也一起停掉了，
  // 等于同时抹掉「洗衣机在转」和「Agent 在干活」两个信号。
  const cl = readFileSync(join(root, 'client.js'), 'utf8');
  const m = cl.match(/const CSS = ("(?:[^"\\]|\\.)*");/);
  assert.ok(m, 'client.js 里应有内联 CSS 常量');
  const css = JSON.parse(m[1]);

  // ① 不得再用通配选择器停掉整个子树
  assert.ok(
    !/\.dsh-washer\s+\*\s*[,\{]/.test(css),
    '减弱动效不许用 `.dsh-washer *` 通配——会误伤指示灯和水位',
  );

  // ② 系统媒体查询块必须存在，且覆盖滚筒
  const media = css.match(/@media \(prefers-reduced-motion: ?reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(media, '必须有 @media (prefers-reduced-motion: reduce)');
  const mediaBody = media[1];
  assert.ok(/\.dw-pw \.drum/.test(mediaBody), '减弱时必须停掉精密家电滚筒');
  assert.ok(/\.dw-aw-drum/.test(mediaBody), '减弱时必须停掉动漫滚筒');

  // ③ 配置态兜底（data-reduce-motion='1'）同样只停装饰运动
  const flagRule = css.match(/\.dsh-washer\[data-reduce-motion='1'\][\s\S]*?\{[^}]*\}/);
  assert.ok(flagRule, '必须有 data-reduce-motion=1 的兜底规则');
  assert.ok(/\.dw-pw \.drum/.test(flagRule[0]), 'always 档也要停滚筒');

  // ④ 指示灯与水位必须**不在**停用名单里
  for (const keep of ['led', 'dw-dot', 'px-led', '.water', 'bar']) {
    const mentioned = new RegExp('\\.' + keep.replace('.', '\\.') + '\\b');
    assert.ok(!mentioned.test(mediaBody), '减弱动效不该停掉表示状态的 ' + keep + '（信息不该被关掉）');
  }
});

await test('所有 animation 名都能找到 @keyframes（滚筒真的会转）', async () => {
  // 回归保护：skin-precision.css / skin-anime.css 曾整段丢失 @keyframes，
  // 浏览器对未定义的动画名静默忽略，测试全绿但滚筒是静止的。
  const cl = readFileSync(join(root, 'client.js'), 'utf8');
  const m = cl.match(/const CSS = ("(?:[^"\\]|\\.)*");/);
  assert.ok(m, 'client.js 里应有内联 CSS 常量');
  const css = JSON.parse(m[1]);
  const used = [...new Set([...css.matchAll(/animation:\s*([a-zA-Z][\w-]*)/g)].map((m) => m[1]))]
    .filter((n) => !['none', 'inherit', 'initial'].includes(n));
  assert.ok(used.length >= 8, '应从 client.js 里解析出多个动画名，实际 ' + used.length);
  const missing = used.filter((n) => !new RegExp('@keyframes\\s+' + n + '\\s*\\{').test(css));
  assert.deepStrictEqual(missing, [], '这些动画没有 @keyframes 定义（会静默不动）：' + missing.join(', '));
});

await test('故障态把 E 码翻译成「发生了什么 + 怎么办」', async () => {
  // size 只在挂载时读一次（组件内 useState 初值），所以档位必须在 mount 时给定
  const m = mount(streaming({}), 'dock', { size: 'M' });
  await m.settle(450);
  m.set({
    running: false, partial: null,
    nodes: [{ kind: 'turn-error', turn: 1, step: 1, message: 'Context length exceeded', code: 'CONTEXT_LENGTH' }],
  });
  await m.settle(60);
  assert.equal(m.state, 'error');
  assert.equal(m.level, 'M');
  assert.ok(m.html.includes('E-30'), '要显示错误码本身');
  assert.ok(m.html.includes('上下文塞满了'), '码要翻译成人话');
  assert.ok(m.html.includes('开新会话'), '要给可执行的建议');
  m.unmount();
});

await test('不同错误码给不同的解释（不是一句通用「出错了」）', async () => {
  const cases = [
    { node: { kind: 'turn-error', turn: 1, step: 1, code: 'ACCOUNT_SIGNED_OUT', message: '' }, code: 'E-10', title: '账号或服务不可用' },
    { node: { kind: 'turn-error', turn: 1, step: 1, code: 'INTERRUPTED', message: 'aborted' }, code: 'E-40', title: '被中断了' },
  ];
  for (const item of cases) {
    const m = mount(streaming({}), 'dock', { size: 'M' });
    await m.settle(450);
    m.set({ running: false, partial: null, nodes: [item.node] });
    await m.settle(60);
    assert.equal(m.state, 'error');
    assert.ok(m.html.includes(item.code), '要显示 ' + item.code);
    assert.ok(m.html.includes(item.title), item.code + ' 要显示「' + item.title + '」');
    m.unmount();
  }
});

await test('overlay 模式只在忙时浮出来（mode:overlay）', async () => {
  const world = {
    sessionId: 's1', running: false, pending: undefined,
    runningCalls: [], partial: null, nodes: [], outline: [], turnTimings: new Map(),
    // 注意：浮层空闲默认隐藏是从**默认配置**来的，这里必须给完整默认（含 hideWhenIdle:false）
    config: baseConfig({ mode: 'overlay' }),
  };
  // overlay 座位拿不到 useChat，用一个只认 useSessions/useSessionStatus 的 props 构造
  const sessionsState = { byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } };
  // 组件内部有 useState/useEffect，裸调用会复用上一次的 hook 槽（状态粘住），
  // 所以每次渲染前显式重置游标与待执行副作用。
  const renderOverlay = () => {
    cursor = 0;
    pendingEffects = [];
    const out = render(OverlayComponent({
      useSessions: (sel) => sel(sessionsState),
      useSessionStatus: () => undefined,
      washerConfig: world.config,   // 必须传，否则组件退回 DEFAULT_CONFIG
      t,
    }));
    pendingEffects = [];
    return out;
  };
  const idle = renderOverlay();
  assert.ok(!idle.includes('dsh-washer'), '空闲时不浮出来，实际: ' + idle.slice(0, 120));
  world.running = true;
  sessionsState.byId.s1.running = true;
  const busy = renderOverlay();
  assert.ok(busy.includes('dsh-washer'), '忙时要浮出来');
  assert.ok(busy.includes('浮窗模式'), '要点明自己是浮窗模式');
});

await test('L 档能切换皮肤，且立刻生效（skin 切换 UI）', async () => {
  const written = [];
  const m = mount(streaming({}), 'dock', { size: 'L', skin: 'auto' });
  m.setPrefSink((key, value) => written.push([key, value]));
  await m.settle(450);
  assert.equal(m.level, 'L');
  assert.ok(m.html.includes('dw-skinrow'), 'L 档要有外观切换行');
  assert.ok(m.html.includes('动漫'), '要能选动漫风');
  assert.ok(m.html.includes('像素'), '要能选像素风');
  // 切到 anime：机器应当换成动漫风 DOM
  m.clickText('动漫');
  await m.settle(20);
  assert.deepEqual(written[written.length - 1], ['skin', 'anime'], '要回写 skin');
  assert.ok(m.html.includes('dw-aw'), '皮肤立刻变成动漫风');
  // 关表情
  m.clickText('关');
  await m.settle(20);
  assert.deepEqual(written[written.length - 1], ['face', false], '要回写 face');
  m.unmount();
});

await test('设置页：每项配置都能改，且回写到宿主配置', () => {
  const writes = [];
  const world = makeWorld({ sessionId: 's1' });
  world.prefSink = (k, v) => writes.push([k, v]);
  // 设置页的 Component 单独取
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const html = render(Settings(Object.assign(propsFrom(world), { washerSetPref: world.prefSink })));
  assert.ok(html.includes('dw-settings'), '要有设置页容器');
  assert.ok(html.includes('外观'), '外观一行');
  assert.ok(html.includes('表情'), '表情一行');
  assert.ok(html.includes('默认档位'), '档位一行');
  // 点「动漫」
  const re = /<button[^>]*data-click-idx="(\d+)"[^>]*>([\s\S]*?)<\/button>/g;
  let m; const hits = [];
  while ((m = re.exec(html)) !== null) {
    const label = m[2].replace(/<[^>]+>/g, '').trim();
    if (label === '动漫') hits.push(Number(m[1]));
  }
  assert.equal(hits.length, 1, '设置页里「动漫」按钮唯一');
  BUTTON_HANDLERS[hits[0]].handler({ stopPropagation() {} });
  assert.deepEqual(writes, [['skin', 'anime']], '点一下就把 skin 写回宿主配置');
});

await test('设置页的开关是 role=switch 且带内联样式（不靠 class 命中）', () => {
  const world = makeWorld({ sessionId: 's1', config: baseConfig({ face: true, showCost: false, hideWhenIdle: true }) });
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const html = render(Settings(propsFrom(world)));

  const switches = html.match(/role="switch"/g) || [];
  assert.equal(switches.length, 3, '三个布尔项各一个开关（表情/成本/空闲隐藏）');
  assert.ok(/aria-checked="true"/.test(html), '开着的开关 aria-checked=true');
  assert.ok(/aria-checked="false"/.test(html), '关着的开关 aria-checked=false');

  // 轨道必须自带内联背景色——宿主设置页容器会覆盖 button 的 border/background
  const track = /<button[^>]*role="switch"[^>]*style="([^"]*)"/.exec(html);
  assert.ok(track, '开关要带 style 属性');
  assert.ok(/background/.test(track[1]), '轨道背景必须内联给出，否则被宿主样式吃掉变透明');
  assert.ok(/border-radius/.test(track[1]), '轨道圆角内联');
  // 设置页不在 .dsh-washer 范围内，拿不到 --dw-* 变量（实测空串），必须直接用宿主 token
  assert.ok(/dsw-alias-state-business-primary/.test(track[1]), '开启态必须用宿主 token，不能引用 --dw-run（在设置页里算空串）');
  assert.ok(!/--dw-run/.test(track[1]), '不能引用 --dw-run');
  // 滑块
  assert.ok(/box-shadow/.test(html), '滑块要有阴影才看得出是个圆点');
});

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
if (failed.length > 0) {
  for (const f of failed) console.error('\n[' + f.name + ']\n' + (f.error && f.error.stack));
  process.exitCode = 1;
}

/* ================================================================== *
 * 截图素材
 * ================================================================== */
if (noShots) process.exit(process.exitCode || 0);

const css = readFileSync(join(root, 'client.js'), 'utf8').match(/const CSS = ("(?:[^"\\]|\\.)*");/);
assert.ok(css, 'client.js 里应有内联 CSS 常量');
const CSS_TEXT = JSON.parse(css[1]);
writeFileSync(join(outDir, 'washer.css'), CSS_TEXT);

const THEME = `
:root{
  --dsw-alias-bg-base:#f7f9fb; --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-border-l1:#e2e8ef;
  --dsw-alias-label-primary:#1b2430; --dsw-alias-label-secondary:#7a8794; --dsw-alias-label-tertiary:#9aa6b2;
  --dsw-alias-interactive-bg-hover:rgba(40,60,84,.05);
  --dsw-shadow-lv2:0 1px 3px rgba(40,60,84,.10);
  --dsw-alias-state-business-primary:#2f86d6;
  --dsw-alias-state-warn-primary:#d99a1f;
  --dsw-alias-state-error-primary:#d94a4f;
  --dsw-alias-state-success-primary:#2f9e63;
}
body.dark{
  --dsw-alias-bg-base:#141a20; --dsw-alias-bg-layer-1:#28313a; --dsw-alias-border-l1:#3a444f;
  --dsw-alias-label-primary:#e8eef4; --dsw-alias-label-secondary:#94a1ae; --dsw-alias-label-tertiary:#6b7885;
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.06);
  --dsw-shadow-lv2:0 1px 3px rgba(0,0,0,.4);
  --dsw-alias-state-business-primary:#4aa3f0;
  --dsw-alias-state-warn-primary:#f0b73a;
  --dsw-alias-state-error-primary:#f26064;
  --dsw-alias-state-success-primary:#3fbf7a;
}
body{margin:0;padding:22px;background:var(--dsw-alias-bg-base);font-family:-apple-system,"PingFang SC",sans-serif;color:var(--dsw-alias-label-primary)}
.composer{width:400px;padding:0 0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.dockbar{display:flex;justify-content:center;padding:12px 12px 0}
.grid{display:flex;flex-wrap:wrap;gap:22px;align-items:flex-start}
h3{font-size:11px;font-weight:600;margin:0 0 6px;color:var(--dsw-alias-label-secondary)}
`;

/* 单遍渲染（不跑 effects）——只为了出静态图 */
function staticRender(world) {
  slots = []; cursor = 0; dirty = false; pendingEffects = [];
  return render(Component(propsFrom(world)));
}

const CASES = {
  idle: {},
  starting: { running: true, outline: [{ turn: 1, seq: 1, prompt: '', response: '' }] },
  washing: { running: true, partial: { turn: 1, step: 2, blocks: [] }, outline: [{ turn: 1, seq: 1, prompt: 'hi', response: '' }], nodes: tools(2) },
  rinsing: { running: true, partial: null, runningCalls: [{ phase: 'start', callId: 'c1', name: 'apply_patch', turn: 1, step: 3 }], outline: [{ turn: 1, seq: 1, prompt: 'hi', response: '' }], nodes: tools(3) },
  spinning: { running: true, partial: null, outline: [{ turn: 1, seq: 1, prompt: 'hi', response: '' }], nodes: tools(4) },
  waiting: { running: true, pending: { kind: 'approval' }, partial: null, outline: [{ turn: 1, seq: 1, prompt: 'hi', response: '' }], nodes: tools(4) },
  draining: { running: true, partial: null, outline: [{ turn: 1, seq: 1, prompt: 'hi', response: '' }], nodes: tools(4) },
  error: { running: false, nodes: [...tools(3), { kind: 'turn-error', turn: 1, message: 'max_tokens exceeded', code: 'MAX_TOKENS' }], outline: [{ turn: 1, seq: 1, prompt: 'hi', response: 'trunc' }], turnTimings: new Map([[1, { startTime: T0, endTime: NOW - 8000 }]]) },
};

const levelCfg = (level) => ({
  size: level, expandedByDefault: false, skin: 'auto',
  skinBySize: { xs: 'pixel', sm: 'precision', md: 'precision', lg: 'anime' },
  face: false, reduceMotion: 'auto', showCost: false, costPerKToken: 0, costCurrency: 'CNY',
  hideWhenIdle: false, doneHoldMs: 6000, toolHistoryLimit: 6,
});

const cells = [];
for (const [name, over] of Object.entries(CASES)) {
  for (const level of ['S', 'M', 'L']) {
    const world = makeWorld(over);
    world.config = baseConfig(levelCfg(level));
    cells.push({ name, level, html: staticRender(world) });
  }
}
/* done 态单独造：sticky 由组件内部推导，静态渲染拿不到，直接用 idle+上次完成时间近似 */
{
  const world = makeWorld({ turnTimings: new Map([[1, { startTime: T0, endTime: NOW - 11000 }]]), nodes: tools(4), outline: [{ turn: 1, seq: 1, prompt: 'p', response: 'r' }] });
  world.config = baseConfig(levelCfg('M'));
  cells.push({ name: 'idle-last', level: 'M', html: staticRender(world) });
}

const page = (dark) => `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>dsh-washer</title>
<style>${THEME}</style><style>${CSS_TEXT}</style></head>
<body${dark ? ' class="dark"' : ''}><div class="grid">
${cells.map(({ name, level, html }) => `<div><h3>${name} · ${level}</h3><div class="composer"><div class="dockbar">${html}</div></div></div>`).join('\n')}
</div></body></html>`;
writeFileSync(join(outDir, 'all.html'), page(false));
writeFileSync(join(outDir, 'all-dark.html'), page(true));

for (const { name, level, html } of cells) {
  for (const dark of [false, true]) {
    const suffix = dark ? '-dark' : '';
    writeFileSync(join(outDir, `${name}-${level}${suffix}.html`), `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<style>${THEME}</style><style>${CSS_TEXT}</style></head>
<body${dark ? ' class="dark"' : ''}><div class="composer"><div class="dockbar">${html}</div></div></body></html>`);
  }
}

console.log('shots →', outDir, '(' + cells.length + ' cells × light/dark)');
console.log('CSS bytes:', CSS_TEXT.length);

/* 组件里有 1s 心跳 setInterval（模拟真机计时），拍完图显式退出，避免 node 挂着不退 */
process.exit(process.exitCode || 0);
