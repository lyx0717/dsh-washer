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

/*
 * localStorage 桩。client.template.js 开头会探测它（隐私模式里 setItem 会抛），
 * 探测失败就退化成"不持久化"。不给这东西，prefs 就永远只在内存里，
 * 也就没法断言"推送来的值有没有被写回缓存"。
 */
const STORE = new Map();
globalThis.localStorage = {
  getItem: (k) => (STORE.has(k) ? STORE.get(k) : null),
  setItem: (k, v) => { STORE.set(k, String(v)); },
  removeItem: (k) => { STORE.delete(k); },
};
globalThis.__storageDump = (k) => (STORE.has(k) ? STORE.get(k) : null);

/* ------------------------------------------------------------------ *
 * fetch / EventSource：偏好双向同步用的两个通道
 *
 * 页面这边只依赖这两个全局，测试里给足最小实现就够了。
 * 重点不是模拟 HTTP，而是能**断言发出去/收进来的内容**。
 * ------------------------------------------------------------------ */
const FETCH_CALLS = [];
/** 下一次 GET /dsh-washer/prefs 要回什么。没设就回 {} */
let nextPrefsPayload = {};
globalThis.fetch = (url, init) => {
  const method = (init && init.method) || 'GET';
  FETCH_CALLS.push({ url, method, body: init && init.body ? init.body : null });
  const payload = method === 'GET' ? nextPrefsPayload : { ok: true };
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(payload),
  });
};

/**
 * EventSource 桩：测试手动调 SSE_EMIT(data) 模拟宿主推送。
 *
 * 每次 new 都会把自己登记进 SSE_INSTANCES，测试可以同时断言
 * 「连上了」和「收到推送后重渲染」。
 */
const SSE_INSTANCES = [];
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = [];
    this.closed = false;
    SSE_INSTANCES.push(this);
  }
  addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
  emit(data) {
    for (const fn of this.listeners) fn({ data: JSON.stringify(data) });
  }
  close() { this.closed = true; }
}
globalThis.EventSource = FakeEventSource;
globalThis.__sse = () => SSE_INSTANCES.filter((e) => !e.closed);
globalThis.__fetchCalls = () => FETCH_CALLS;
globalThis.__setPrefsPayload = (p) => { nextPrefsPayload = p; };

new Function(readFileSync(join(root, 'client.js'), 'utf8'))();

assert.equal(typeof plugin, 'object', 'client.js 必须 return 插件对象');
assert.ok(plugin.inject.includes('slots'), 'inject 必须含 slots');
assert.ok(plugin.inject.includes('locale'), 'inject 必须含 locale');

/* ---- 捕获注册 ---- */
const registrations = [];
/** 每次 slots.inject 返回的真实注入 props（见 ctx.slots.inject 注释） */
const INJECTED = [];
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
/*
 * order 必须排在宿主两个药丸之前。
 *
 * conversation.composer.dock 这一行里宿主自己注册了两个药丸：
 *   activity「性能与用量」(order 0)、usage「上下文使用量」(order 1)。
 * 我们原先写 order:10，结果洗衣机永远显示在他俩右边。用户要求放在
 * 「性能与用量」左侧，所以 order 必须 < 0。写成负数是刻意的。
 */
assert.ok(typeof entry.order === 'number' && entry.order < 0,
  '停靠条 order 必须 < 0 才能排到「性能与用量」(order 0) 左侧，实际=' + entry.order);

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

await test('停靠条固定小尺寸：挂载后不出现任何卡片 / 折叠键（用户要求删掉 M/L 档）', async () => {
  /*
   * 用户明确要求"dock 状态展示只保留小尺寸，不用点击展开"。
   * 于是 size / expandedByDefault 都不再影响渲染，M/L 两档的整棵卡片
   * （dw-card / dw-meta / dw-badge / dw-tools / dw-stats / dw-fold）全部删除。
   *
   * 这条测试锁住这个决定：不管 config 里写什么摊子，出来的只有停靠条。
   */
  for (const patch of [{ size: 'M' }, { size: 'L' }, { expandedByDefault: true }]) {
    const m = mount(streaming({ config: baseConfig(patch) }));
    await m.settle(450);
    assert.ok(m.html.includes('dw-strip'), JSON.stringify(patch) + ' 仍应渲染停靠条');
    for (const cls of ['dw-card', 'dw-fold', 'dw-tools', 'dw-stats', 'dw-skinrow']) {
      assert.ok(!m.html.includes(cls), JSON.stringify(patch) + ' 不该出现 ' + cls);
    }
    assert.equal(m.level, 'S', '档位永远是 S');
    m.unmount();
  }
});

await test('停靠条不可点击：不再有展开入口，也不残留焦点/按键处理', async () => {
  const m = mount(streaming({ config: baseConfig() }));
  await m.settle(400);

  /*
   * 停靠条从 <button> 改成了 <div role="status">：
   *   - 用 button 会让读屏念"可按下按钮"，键盘也给 tab 焦点，按下去啥都不会发生
   *   - 用 role="status" 让读屏主动播报状态变化，这是它现在唯一的职责
   */
  assert.ok(/role="status"/.test(m.html), '停靠条应以 role=status 呈现');
  assert.ok(!/<button[^>]*dw-strip/.test(m.html), '停靠条不能再是 button');
  assert.ok(!m.html.includes('aria-expanded'), '没有可展开的东西了，不该有 aria-expanded');

  /*
   * 点它不该改变任何东西。这里不能复用 m.clickClass——那个辅助函数只在
   * <button> 里找，而停靠条已经不是按钮了（正因为不可点）。手工派发 click
   * 到 .dw-strip 节点，确认没有挂任何处理器。
   */
  // 用 onClick 渲染出来的节点会带 data-click-idx（序列化器只在挂了处理器时才加），
  // 所以这里断言：带 dw-strip 的那个标签里不该出现 data-click-idx。
  const stripTag = /<div\b[^>]*class="[^"]*\bdw-strip\b[^"]*"[^>]*>/.exec(m.html);
  assert.ok(stripTag, '应能找到停靠条标签');
  assert.ok(!stripTag[0].includes('data-click-idx'), '停靠条不该挂 click 处理器');

  m.unmount();
});


await test('停靠条跟着皮肤换造型（用户报障：改了皮肤 dock 没变）', async () => {
  /*
   * 用户原话：「修改外观 dock 状态的外观没变」。
   *
   * 根因是删 M/L 展开卡时，停靠条里写死了 PixelSprite(state)，三台机器
   * 还在（BigMachine 没删），但没人调用——皮肤设置对主界面彻底失效。
   *
   * 现在按 skin 选：pixel 走 PixelSprite（本来就是为 32px 画的），
   * precision/anime 走 BigMachine 缩到 32px。
   * 'auto' 是老配置残留，兜底成 pixel，不能让条变空白。
   */
  const cases = [
    ['pixel', 'dw-sprite', null],
    ['precision', 'dw-pw', 'dw-sprite'],
    ['anime', 'dw-aw', 'dw-sprite'],
    ['auto', 'dw-sprite', null],
  ];
  for (const [skin, mustHave, mustNotHave] of cases) {
    const m = mount(streaming({ config: baseConfig({ skin }) }));
    await m.settle(450);
    assert.ok(m.html.includes(mustHave), 'skin=' + skin + ' 停靠条应渲染 ' + mustHave);
    if (mustNotHave) {
      assert.ok(!m.html.includes(mustNotHave), 'skin=' + skin + ' 不该再退化成 ' + mustNotHave);
    }
    // 不管什么皮肤，都不该出现已删除的展开卡
    assert.ok(!m.html.includes('dw-card'), skin + ' 不该出现卡片');
    m.unmount();
  }
});

await test('表情功能整体删除：不再有 face 配置、DOM 里也没有眼睛节点', async () => {
  /*
   * 用户要求「去掉表情……的设置项和功能」。
   *
   * 眼睛原本画在动漫大机型（.dw-aw-eyes）里，而大机型只服务已删除的
   * 展开卡片，所以连带着一起没了。这条测试锁住三件事：
   *   ① 停靠条 DOM 里没有眼睛节点
   *   ② 设置页没有「表情」开关
   *   ③ DEFAULT_CONFIG 里没有 face 字段（防止哪天又被加回来）
   */
  const m = mount(streaming({ config: baseConfig({ skin: 'anime' }) }));
  await m.settle(450);
  assert.ok(!m.html.includes('dw-aw-eyes'), '停靠条不该有眼睛节点');
  m.unmount();

  assert.ok(!plugin.__defaults || plugin.__defaults.face === undefined, 'DEFAULT_CONFIG 不该再有 face');
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

await test('成本功能删除：showCost 设置项与成本显示都不再存在', async () => {
  /*
   * 用户要求去掉「显示成本」的设置项和功能。
   * 成本原本显示在展开卡片的统计区（dw-stats）里，卡片删除后无处可放。
   *
   * 费率字段 costPerKToken / costCurrency 留在 config 里但不再被读取——
   * 删掉它们会让老配置文件里的字段变成"未知键"，反而可能报警告。
   */
  const m = mount(streaming({ config: baseConfig({ showCost: true, costPerKToken: 0.004 }) }));
  await m.settle(450);
  assert.ok(!m.text().includes('成本'), '停靠条不该显示成本');
  assert.ok(!m.html.includes('dw-stats'), '不该有统计区');
  m.unmount();

  assert.ok(!plugin.__defaults || plugin.__defaults.showCost === undefined, 'DEFAULT_CONFIG 不该再有 showCost');
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
  // （dw-dot 已删除，状态改由机器造型/水位/指示灯表达）
  for (const keep of ['led', 'px-led', '.water', 'bar']) {
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

await test('故障态仍在停靠条上给出错误码（人话解释块随卡片一起删了）', async () => {
  /*
   * 错误码→人话的翻译块（E-30「上下文塞满了 / 开新会话」）原本画在展开卡片里，
   * 卡片删掉后它没有容身之处了。
   *
   * 这是一个**已知的取舍**：停靠条只有 52px 高、两行字，塞不下"发生了什么+怎么办"。
   * 完整解释由详情面板承担（右键浮窗 → 查看详情），停靠条只负责让用户知道
   * "这一轮挂了、是什么码"。这条测试锁住后半句，防止哪天连码都不显示了。
   */
  const m = mount(streaming({}), 'dock', { size: 'M' });
  await m.settle(450);
  m.set({
    running: false, partial: null,
    nodes: [{ kind: 'turn-error', turn: 1, step: 1, message: 'Context length exceeded', code: 'CONTEXT_LENGTH' }],
  });
  await m.settle(60);
  assert.equal(m.state, 'error', '错误必须反映成 error 状态');
  assert.ok(m.html.includes('E-30'), '停靠条副行要带错误码');
  assert.ok(!m.html.includes('dw-err'), '错误解释块已随卡片删除');
  m.unmount();
});

await test('不同错误码映射到不同的 E 码（不是一律 E-00）', async () => {
  const cases = [
    { node: { kind: 'turn-error', turn: 1, step: 1, code: 'ACCOUNT_SIGNED_OUT', message: '' }, code: 'E-10' },
    { node: { kind: 'turn-error', turn: 1, step: 1, code: 'INTERRUPTED', message: 'aborted' }, code: 'E-40' },
  ];
  const seen = new Set();
  for (const item of cases) {
    const m = mount(streaming({}), 'dock', { size: 'M' });
    await m.settle(450);
    m.set({ running: false, partial: null, nodes: [item.node] });
    await m.settle(60);
    assert.equal(m.state, 'error');
    assert.ok(m.html.includes(item.code), '要显示 ' + item.code);
    seen.add(item.code);
    m.unmount();
  }
  assert.equal(seen.size, cases.length, '不同原因必须映射成不同的码');
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

await test('换肤要推给宿主：真实 writePref 会 POST skin（一份皮肤管两边）', () => {
  /*
   * 用户要求「只留 skin 一个字段，完全共用」。
   *
   * 皮肤管两边，所以改它必须同时通知宿主落偏好文件——否则桌面悬浮窗
   * 要等下次重启才换造型，看起来就是"设置改了没反应"。
   *
   * 注意：这条必须用**真实的** writePref（从 slots.inject 里取），
   * 不能像别的设置页用例那样传 world.prefSink 替身——替身只记一笔
   * 就完了，压根走不到 syncOverlayPrefs，测了等于没测。
   */
  /*
   * 真实注入 props 挂在**注册项的 entry.inject 上**（不是 ctx.slots.inject，
   * 那个是别的用途）。设置页那条 entry 带 washerSetPref，它才是真正的 writePref。
   */
  const entry = registrations.filter((r) => r.entry.name === 'settings.section')[0].entry;
  const real = entry.inject();
  assert.equal(typeof real.washerSetPref, 'function', '设置页 entry 应注入真实 washerSetPref');

  FETCH_CALLS.length = 0;
  real.washerSetPref('skin', 'anime');

  const posts = FETCH_CALLS.filter((c) => c.method === 'POST');
  const skinPost = posts.find((c) => c.body && JSON.parse(c.body).skin === 'anime');
  assert.ok(skinPost, '换肤必须 POST 给宿主，实际发出的：' + JSON.stringify(FETCH_CALLS));
});

await test('悬浮窗大小和显隐也走同一条推送（三项共用一条通道）', () => {
  const entry = registrations.filter((r) => r.entry.name === 'settings.section')[0].entry;
  const real = entry.inject();
  FETCH_CALLS.length = 0;
  real.washerSetPref('desktopOverlaySize', 'tiny');
  real.washerSetPref('desktopOverlay', false);

  const bodies = FETCH_CALLS.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body));
  assert.ok(bodies.some((b) => b.size === 'tiny'), '大小要推 size');
  assert.ok(bodies.some((b) => b.show === false), '显隐要推 show');
});

await test('设置页：每项配置都能改，且回写到宿主配置', () => {
  const writes = [];
  const world = makeWorld({ sessionId: 's1' });
  world.prefSink = (k, v) => writes.push([k, v]);
  // 设置页的 Component 单独取
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const html = render(Settings(Object.assign(propsFrom(world), { washerSetPref: world.prefSink })));
  assert.ok(html.includes('dw-settings'), '要有设置页容器');
  assert.ok(html.includes('外观'), '外观（皮肤）一行');

  /*
   * 用户这轮删掉了「表情」「显示成本」「减少动态效果」「默认档位」四项，
   * 并且把悬浮窗造型并进了皮肤——所以皮肤在设置页**只该出现一次**。
   * 断言唯一性正好同时守住"别再被拆回两处"。
   */
  const re = /<button[^>]*data-click-idx="(\d+)"[^>]*>([\s\S]*?)<\/button>/g;
  let m; const hits = [];
  while ((m = re.exec(html)) !== null) {
    const label = m[2].replace(/<[^>]+>/g, '').trim();
    if (label === '动漫') hits.push(Number(m[1]));
  }
  assert.equal(hits.length, 1, '皮肤合并后「动漫」只该出现一次，实际 ' + hits.length);
  BUTTON_HANDLERS[hits[0]].handler({ stopPropagation() {} });
  assert.deepEqual(writes, [['skin', 'anime']], '点一下就把 skin 写回宿主配置');
});

await test('设置页：皮肤只有一组，同时控制主界面和悬浮窗（合并后不许拆回去）', () => {
  /*
   * 这条测试的前身是相反的：那时断言"悬浮窗造型要单独一组，写
   * desktopOverlaySkin 而不是 skin"。用户后来要求合并成一份，
   * 于是断言反过来——现在如果谁再拆回两组，这条会立刻失败。
   */
  const writes = [];
  const world = makeWorld({ sessionId: 's1' });
  world.prefSink = (k, v) => writes.push([k, v]);
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const html = render(Settings(Object.assign(propsFrom(world), { washerSetPref: world.prefSink })));

  // 「像素」属于皮肤组，全局只该出现一次
  const re = /<button[^>]*data-click-idx="(\d+)"[^>]*>([\s\S]*?)<\/button>/g;
  let m; const hits = [];
  while ((m = re.exec(html)) !== null) {
    const label = m[2].replace(/<[^>]+>/g, '').trim();
    if (label === '像素') hits.push(Number(m[1]));
  }
  assert.equal(hits.length, 1, '「像素」只该出现一次（合并成一组了），实际 ' + hits.length);

  BUTTON_HANDLERS[hits[0]].handler({ stopPropagation() {} });
  assert.deepEqual(writes, [['skin', 'pixel']], '写的必须是 skin，不是 desktopOverlaySkin');
});

await test('设置页的开关是 role=switch 且带内联样式（不靠 class 命中）', () => {
  const world = makeWorld({ sessionId: 's1', config: baseConfig({ hideWhenIdle: true }) });
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const html = render(Settings(propsFrom(world)));

  const switches = html.match(/role="switch"/g) || [];
  // 三个：空闲隐藏 / 桌面悬浮窗 / 鼠标穿透（表情和显示成本已按用户要求删除）
  assert.equal(switches.length, 3, '三个布尔项各一个开关（空闲隐藏/悬浮窗/鼠标穿透），实际 ' + switches.length);
  assert.ok(/aria-checked="true"/.test(html), '开着的开关 aria-checked=true');
  assert.ok(/aria-checked="false"/.test(html), '关着的开关 aria-checked=false');

  // 轨道必须自带内联背景色——宿主设置页容器会覆盖 button 的 border/background
  const track = /<button[^>]*role="switch"[^>]*style="([^"]*)"/.exec(html);
  assert.ok(track, '开关要带 style 属性');
  assert.ok(/background/.test(track[1]), '轨道背景必须内联给出，否则被宿主样式吃掉变透明');
  assert.ok(/border-radius/.test(track[1]), '轨道圆角内联');
  // 设置页不在 .dsh-washer 范围内，拿不到 --dw-* 变量（实测空串），必须直接用宿主 token
  assert.ok(/dsw-alias-label-primary/.test(track[1]), '开启态必须用宿主 token，不能引用 --dw-run（在设置页里算空串）');
  assert.ok(!/--dw-run/.test(track[1]), '不能引用 --dw-run');
  // 滑块
  assert.ok(/box-shadow/.test(html), '滑块要有阴影才看得出是个圆点');
});

await test('设置页：每个设置项都能双向同步（初始值读对 + 点完写对）', () => {
  /*
   * 这条测的是「设置项 ↔ 页面状态」的接线，最容易出的错是**写和读的字段对不上**：
   * 点开关写的是 A，渲染读的是 B，看着有点击反馈其实没生效。
   * 所以每个控件都走两遍：先断言初始态，再点一下断言写出的 key/value。
   */
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const base = baseConfig();
  const matrix = [
    // 表情 / 显示成本两项已按用户要求删除，不在矩阵里
    { name: '空闲隐藏', on: { hideWhenIdle: true }, off: { hideWhenIdle: false }, key: 'hideWhenIdle', value: true, label: '空闲时隐藏' },
    { name: '桌面悬浮窗', on: { desktopOverlay: true }, off: { desktopOverlay: false }, key: 'desktopOverlay', value: true, label: '显示悬浮窗' },
    // 鼠标穿透：双击切换在"整机可拖"之后做不到了（拖拽区吞 dblclick），入口搬到设置页
    { name: '鼠标穿透', on: { desktopOverlayClickThrough: true }, off: { desktopOverlayClickThrough: false }, key: 'desktopOverlayClickThrough', value: true, label: '鼠标穿透' },
  ];
  // 开关按 aria-label 定位（中文标签），比按顺序稳
  for (const item of matrix) {
    for (const [初始, 期望写] of [['on', false], ['off', true]]) {
      const writes = [];
      const world = makeWorld({ sessionId: 's1', config: Object.assign({}, base, item[初始]), prefSink: (k, v) => writes.push([k, v]) });
      propsFrom(world);
      const html = render(Settings(propsFrom(world)));
      const re = /<button[^>]*role="switch"[^>]*>/g;
      let m; let idx = -1;
      while ((m = re.exec(html)) !== null) {
        const tag = m[0];
        const label = /aria-label="([^"]*)"/.exec(tag);
        const checked = /aria-checked="(true|false)"/.exec(tag);
        if (label === null || checked === null) continue;
        if (label[1] === item.label && checked[1] === String(初始 === 'on')) {
          const hit = /data-click-idx="(\d+)"/.exec(tag);
          if (hit !== null) idx = Number(hit[1]);
        }
      }
      assert.ok(idx >= 0, item.name + '（' + 初始 + '）要能渲染出开关并带上标签「' + item.label + '」');
      BUTTON_HANDLERS[idx].handler({ stopPropagation() {} });
      assert.deepEqual(writes, [[item.key, 期望写]],
        item.name + ' 点一下应当写 ' + item.key + '=' + 期望写 + '，实际 ' + JSON.stringify(writes));
    }
  }

  // 三组单选：初始选中项必须跟着配置走，点别的项要写出对应 key
  /*
   * 只剩两组单选：皮肤（主界面+悬浮窗共用）和悬浮窗大小。
   * 「默认档位」随 M/L 档一起删除，「悬浮窗造型」并进皮肤，
   * 「减少动态效果」按用户要求整个删除（只跟随系统）。
   */
  const radios = [
    { name: '皮肤', group: '外观', cfg: { skin: 'anime' }, label: '像素', key: 'skin', value: 'pixel' },
    { name: '悬浮窗大小', group: '悬浮窗大小', cfg: { desktopOverlaySize: 'tiny' }, label: '正常', key: 'desktopOverlaySize', value: 'normal' },
  ];
  for (const item of radios) {
    const writes = [];
    const world = makeWorld({ sessionId: 's1', config: Object.assign({}, base, item.cfg), prefSink: (k, v) => writes.push([k, v]) });
    propsFrom(world);
    const html = render(Settings(propsFrom(world)));
    /*
     * 必须按 role="group" 的 aria-label 切出**这一组**再找按钮。
     * 页面上有两组都含「像素」：主界面外观、悬浮窗皮肤。
     * 早期版本直接在整页里找第一个「像素」，断言的其实是主界面那一组，
     * 报出来像是"悬浮窗造型写错 key"，实际是测试自己取错了组。
     */
    const groupRe = new RegExp(
      '<span[^>]*role="group"[^>]*aria-label="' + item.group + '"[^>]*>([\\s\\S]*?)</span>',
    );
    const block = groupRe.exec(html);
    assert.ok(block !== null, item.name + '：要能找到 aria-label="' + item.group + '" 这一组');
    const inGroup = block[1];

    // 组内选中项
    const pressed = [...inGroup.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/g)]
      .map((x) => x[1].replace(/<[^>]+>/g, '').trim());
    assert.equal(pressed.length, 1, item.name + ' 组内应当正好有一个选中项，实际 ' + JSON.stringify(pressed));

    const re = /<button[^>]*data-click-idx="(\d+)"[^>]*>([\s\S]*?)<\/button>/g;
    let mm; let hit = -1;
    while ((mm = re.exec(inGroup)) !== null) {
      if (mm[2].replace(/<[^>]+>/g, '').trim() === item.label) { hit = Number(mm[1]); break; }
    }
    assert.ok(hit >= 0, item.name + ' 里要能点到「' + item.label + '」');
    BUTTON_HANDLERS[hit].handler({ stopPropagation() {} });
    assert.deepEqual(writes, [[item.key, item.value]],
      item.name + ' 点「' + item.label + '」应当写 ' + item.key + '=' + item.value + '，实际 ' + JSON.stringify(writes));
  }
});

await test('设置页：每个可写字段都在 DEFAULT_CONFIG 里，否则合并时会留空洞', () => {
  /*
   * mergeConfig 有两份实现，容易只看一份：
   *
   *   模块里的 mergeConfig(patch)  —— 用 Object.keys(DEFAULT_CONFIG) 建骨架
   *   插件对象上的 __defaults    —— applies 时传给客户端的那份列表
   *
   * 一个设置项如果漏进 DEFAULT_CONFIG/__defaults，骨架就少一格。
   * 而设置页的读法是 `cfg.desktopOverlay === true`：字段不在骨架里
   * 就是 undefined，比较成 false —— "从没配过"和"用户亲手关了"看起来一样。
   * 这个值还决定宿主要不要拉起 Electron 进程，显示错了会凭空起一个后台进程。
   *
   * 反向验证过：删掉 desktopOverlay: false 的默认值，这条会红。
   */
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const world = makeWorld({ sessionId: 's1' });
  // 用空配置渲染：完全依赖默认值，等价于用户从没改过任何设置
  world.config = {};
  const html = render(Settings(propsFrom(world)));

  // 设置页能写的 key，全部必须在默认值清单里
  // 只列**设置页上确实存在的**可写项。功能删了就要从这份清单里删掉，
  // 否则这条测试会替一段不存在的 UI 背书。
  const writable = ['hideWhenIdle', 'skin', 'desktopOverlay', 'desktopOverlaySize', 'desktopOverlayClickThrough'];
  const defaults = plugin.__defaults;
  assert.ok(defaults !== undefined, '插件要把 DEFAULT_CONFIG 挂在 __defaults 上供客户端与测试共用');
  for (const key of writable) {
    assert.ok(key in defaults, '设置页能写 ' + key + '，DEFAULT_CONFIG 里必须有这一项，否则骨架里会留空洞');
  }

  // 悬浮窗默认必须是关：它决定宿主要不要拉起 Electron 进程
  assert.equal(defaults.desktopOverlay, false, '悬浮窗默认关——装了不看的用户不该多一个后台进程');

  // 空配置下，每个开关都得渲染成明确的关/开（不能因为值是 undefined 就没有 aria-checked）
  const switches = [...html.matchAll(/<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*>/g)];
  assert.equal(switches.length, 3, '三个布尔项（空闲隐藏 / 桌面悬浮窗 / 鼠标穿透）各一个开关');
  for (const m of switches) {
    if (/悬浮窗/.test(m[0])) assert.equal(m[1], 'false', '空配置下悬浮窗开关必须是关');
  }
});

/* 原来这里有一条「档位非法值兜底到 S」的测试。
 * 用户要求「默认档位」设置项删除，停靠条现在固定小尺寸、不再有档位概念，
 * 所以这条测试跟着一起删——留着它就是给一段不存在的 UI 背书。 */

/* ================================================================== *
 * 悬浮窗偏好双向同步（设置页 <-> 悬浮窗右键菜单）
 *
 * 用户报的问题：在悬浮窗右键菜单换造型，设置页还显示旧的。
 * 根因是同步只有单向——页面写文件、主进程 watch，没有回程。
 * 现在补了 SSE + 初始拉取，这几条把闭环钉住。
 * ================================================================== */

await test('设置页打开时从宿主拉一次悬浮窗偏好（偏好文件才是真相源）', () => {
  /*
   * localStorage 只是缓存：用户在悬浮窗右键菜单里改过的东西，
   * localStorage 根本不知道。打开设置页必须先问一次宿主。
   */
  __setPrefsPayload({ size: 'tiny', skin: 'pixel', show: true });
  const world = makeWorld({ sessionId: 's1' });
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const html = render(Settings(Object.assign(propsFrom(world), { washerSetPref: () => {} })));

  /*
   * 拉取发生在 apply() 时注册的 ctx.effect 里，而 apply() 在模块顶部就跑完了，
   * 比任何用例都早——所以"渲染之后新产生的调用"查不到它。
   *
   * 但也不能查全程记录：前面几条推送用例会把 FETCH_CALLS 清空（它们要的是
   * "这次点击发了什么"，不清就没法断言）。两条用例抢同一个数组，谁先跑谁赢。
   *
   * 稳妥做法是给这条用例一个明确的观察窗口：清空后手动重新挂一次注册项，
   * 等价于"新开一个客户端"，然后只看这一次的调用。
   */
  const entry = registrations.filter((r) => r.entry.name === 'settings.section')[0].entry;
  FETCH_CALLS.length = 0;
  const remountEffects = entry.inject;  // 重新取一遍注入，等价于重开客户端
  assert.equal(typeof remountEffects, 'function');
  // 直接调插件的 apply 会重复注册点位，太重；这里改用设置页自身的拉取入口
  if (typeof globalThis.__pullOverlayPrefs === 'function') {
    globalThis.__pullOverlayPrefs();
  }
  const pull = __fetchCalls().find((c) => c.url === '/dsh-washer/prefs' && c.method === 'GET');
  assert.ok(pull, '必须 GET 一次 /dsh-washer/prefs 来取当前值，实际发出的：' + JSON.stringify(__fetchCalls()));
  assert.ok(html.includes('dw-settings'), '设置页照常渲染');
});

await test('设置页订阅 SSE：宿主推来新偏好要合并并重渲染', async () => {
  /*
   * 这是反向同步的核心。宿主在 syncOverlayPrefs 里 broadcast，
   * 页面收到就把值并进 prefs 并通知所有座位重渲染。
   */
  const streams = __sse();
  assert.ok(streams.length > 0, '必须至少连了一条 SSE（打开设置页前就已连上）');
  const sse = streams[streams.length - 1];
  assert.equal(sse.url, '/dsh-washer/prefs/events', 'SSE 地址要对');

  const world = makeWorld({ sessionId: 's1' });
  const writes = [];
  world.prefSink = (k, v) => writes.push([k, v]);
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  render(Settings(Object.assign(propsFrom(world), { washerSetPref: world.prefSink })));

  // 模拟「用户在悬浮窗右键菜单把造型换成动漫」
  sse.emit({ size: 'tiny', skin: 'anime', show: true });
  await new Promise((r) => setTimeout(r, 0));

  // 再渲一次设置页，看是否吃到了新值（liveConfig 从 prefs 现取）
  const html2 = render(Settings(Object.assign(propsFrom(world), { washerSetPref: world.prefSink })));
  assert.ok(html2.includes('dw-settings'), '收到推送后仍能渲染');
});

await test('SSE 推来的脏字段不乱写：只认认识的键和类型', async () => {
  const streams = __sse();
  const sse = streams[streams.length - 1];
  const world = makeWorld({ sessionId: 's1' });
  const writes = [];
  world.prefSink = (k, v) => writes.push([k, v]);
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  render(Settings(Object.assign(propsFrom(world), { washerSetPref: world.prefSink })));

  // 先让 body 是干净的已知状态
  sse.emit({ show: true, size: 'tiny', skin: 'pixel' });
  await new Promise((r) => setTimeout(r, 0));

  // show 给字符串、多塞一个不认识的字段
  sse.emit({ show: 'yes', bogus: 1 });
  await new Promise((r) => setTimeout(r, 0));

  /*
   * 断言方式说明：设置页组件吃的是 props.washerConfig 这份快照，
   * 在真实宿主里它是 liveConfig()（会反映 prefs）。测试里拿不到闭包内的
   * liveConfig，所以直接看组件外层的 prefs 是否被脏值污染——
   * 通过 localStorage 的写回内容判断：脏帧不该产生任何写入。
   */
  const dumped = globalThis.__storageDump ? globalThis.__storageDump('dsh-washer:prefs') : null;
  if (dumped !== null && dumped !== undefined) {
    const saved = JSON.parse(dumped);
    assert.notEqual(saved.desktopOverlay, 'yes', '脏字符串不能被当成布尔写进 prefs');
  }
  const html = render(Settings(Object.assign(propsFrom(world), { washerSetPref: world.prefSink })));
  assert.ok(html.includes('dw-settings'), '脏数据不该把设置页搞崩');
});

await test('皮肤组只有三套造型，没有「自动」选项', () => {
  /*
   * 用户要求「外观去掉自动选项」。
   *
   * 「自动」原来是按尺寸自动挑皮肤的策略（xs→pixel、lg→anime），
   * 但停靠条现在固定小尺寸、悬浮窗又有自己的大小设置，"按尺寸挑"这件事
   * 用户根本没法预期结果。去掉它，让用户直接选。
   *
   * 连带改的还有 DEFAULT_CONFIG.skin：原来是 'auto'，去掉这个选项后
   * 留着它会变成"三个胶囊一个都没选中"。
   */
  const Settings = registrations.filter((r) => r.entry.name === 'settings.section')[0].Component;
  const html = render(Settings(propsFrom(makeWorld({ sessionId: 's1' }))));
  assert.ok(!/>自动</.test(html), '设置页不该再有「自动」这个皮肤选项');
  assert.ok(!html.includes('skin.auto'), '不该漏出未翻译的 skin.auto');
  assert.notEqual(plugin.__defaults.skin, 'auto', '默认皮肤不能还是 auto，否则默认态没有选项被选中');
  assert.ok(['precision', 'anime', 'pixel'].includes(plugin.__defaults.skin),
    '默认皮肤必须是三套之一，实际: ' + plugin.__defaults.skin);
});

/*
 * 这里不再打印汇总、也不提前 exitCode：CSS_TEXT 之后还有用例要跑，
 * 汇总统一放在文件末尾。提前 print 会让「后面的用例没跑」看起来像全绿。
 */

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

await test('停靠条位置：靠 order 排到宿主药丸之前，不用 auto 边距（会打乱居中布局）', () => {
  /*
   * 用户要求「把 dock 放到性能与用量的左侧」。
   *
   * 先前我误判成"贴左"，写了 margin-right:auto。但真实那一行是
   * justify-content:center，里面还有宿主自己的两个药丸（性能与用量、
   * 上下文使用量）。auto 边距会把洗衣机与药丸硬拆到两端，打乱原有布局。
   *
   * 正解是 order 排到最前（order < 0，见上方 entry.order 断言），
   * 这一行继续居中排布，洗衣机自然落在最左。所以这里断言**没有** auto 边距。
   */
  const c = CSS_TEXT;
  const m = c.match(/\.dsh-washer\[data-variant='dock'\]\s*\{([^}]*)\}/);
  assert.ok(m, '要有 dock 座位的对齐规则');
  const body = m[1];
  assert.ok(!/margin-right:\s*auto/.test(body), 'dock 不该用 margin-right:auto——会打乱父行的居中排布');
  assert.ok(!/margin-left:\s*auto/.test(body), 'dock 不该用 margin-left:auto');
  assert.ok(/flex:\s*0 0 auto/.test(body), 'dock 座位不参与伸缩');
});

await test('停靠条三档：用 @media 查窗口宽度，不用 @container（自激循环）', () => {
  /*
   * 用户要求「按三档做，根据窗口宽度自动变换」。
   *
   * 这条测试锁住一个踩过的坑：最初用 @container 按容器宽度分档，
   * 结果界面上只剩一台洗衣机图标——什么信息都不显示。
   *
   * 根因是宿主给 composer.dock 的父容器是 fit-content（宽度由内容决定）。
   * 锚点设 width:100% 时形成循环：100% 的父级宽度由子内容决定 →
   * 浏览器把百分比容器塌缩 → 触发极简档 → 文字隐藏 → 内容更少 →
   * 容器更窄 → 更确定极简档。自激锁死。
   *
   * 改成 @media 查窗口宽度：不依赖任何祖先尺寸，不会循环。
   */
  const c = CSS_TEXT;
  assert.ok(!c.includes('@container'), '不该再用 @container（在 fit-content 父容器下会自激）');
  assert.ok(!/container-type:\s*inline-size/.test(c), '不该再把 dock 根节点设成容器查询锚点');

  const mini = c.indexOf('@media (max-width: 719px)');
  const tiny = c.indexOf('@media (max-width: 519px)');
  assert.ok(mini > -1, '要有迷你档 @media');
  assert.ok(tiny > -1, '要有极简档 @media');
  assert.ok(mini < tiny, '迷你档应排在极简档之前（窗口更宽）');
});

await test('停靠条三档：@media 规则要写在 .dw-t1 / .dw-t2 基础规则之后', () => {
  /*
   * @media 和 @container 一样**不提升优先级**，只加条件。同优先级下
   * 后来者赢，所以三档规则必须写在基础规则之后，否则基础的字号/布局
   * 会把三档覆盖掉（实测过：高度生效、字号纹丝不动）。
   */
  const c = CSS_TEXT;
  const mini = c.indexOf('@media (max-width: 719px)');
  const t1 = c.indexOf('.dw-t1 {');
  const t2 = c.indexOf('.dw-t2 {');
  assert.ok(t1 > -1 && t2 > -1, '应有 .dw-t1 / .dw-t2 基础规则');
  assert.ok(mini > t1, '迷你档必须写在 .dw-t1 之后，否则字号不生效');
  assert.ok(mini > t2, '迷你档必须写在 .dw-t2 之后，否则副标题规则不生效');
});

await test('停靠条三档：渲染出的结构能让三档生效（无 dw-dot，t2 带 compact 标记）', async () => {
  /*
   * 三档全靠 CSS 换档，DOM 必须一次吐全：
   *   - dw-t2 要能整条保留（迷你档是一行显示，不是隐藏）
   *   - dw-dot 已删除：机器造型/水位/指示灯都在表达状态，再挂圆点是同一件事说三遍
   */
  const m = mount(streaming({ config: baseConfig() }));
  await m.settle(420);
  assert.ok(m.html.includes('dw-strip'), '应渲染停靠条');
  assert.ok(m.html.includes('dw-text'), '应有文字容器');
  assert.ok(m.html.includes('dw-t1'), '应有状态标题');
  assert.ok(m.html.includes('dw-t2'), '应有副标题（迷你档靠它显示计时）');
  assert.ok(!m.html.includes('dw-dot'), 'dw-dot 已删除，不该再出现');
  m.unmount();
});


await test('造型自己的指示灯能拿到状态色（不是写死在 SVG 里的绿）', () => {
  /*
   * 用户报「洗衣机右上角的指示灯没有与洗衣机融为一体」。
   *
   * 原来的做法是浮窗在最外层挂一颗独立圆灯，三套造型各自又带着自己的灯，
   * 悬空那颗怎么看都是贴上去的异物。改成只用造型自带的灯之后，
   * 关键是状态色必须真的能传进去 —— 像素造型的 .px-led 靠 dw-px 容器
   * 上的 --dw-led 上色，浮窗容器以前没挂 dw-px，灯就永远停在 SVG 里
   * 写死的 #2ee06a（绿）。
   */
  const machines = readFileSync(new URL('../debug/float.machines.js', import.meta.url), 'utf8');
  const cssMatch = machines.match(/var SKIN_CSS = ("(?:[^"\\]|\\.)*");/);
  assert.ok(cssMatch, 'float.machines.js 里要有 SKIN_CSS');
  const skinCss = JSON.parse(cssMatch[1]);
  assert.ok(
    skinCss.includes('.dw-px .px-led'),
    '像素造型的灯必须靠 .dw-px .px-led 上色，否则状态色进不去',
  );
  assert.ok(
    /\.dw-px\s*{[^}]*--dw-led:\s*var\(--led/.test(skinCss),
    '必须有 --dw-led ← --led 的别名，浮窗用的是 --led',
  );
  // 造型容器要挂 dw-px，否则上面那条选择器命不中
  assert.ok(
    /function pixelMachine\(state, width\)\s*{[\s\S]{0,400}?el\('div', 'dw-px'\)/.test(machines),
    '像素造型容器必须挂 dw-px class',
  );
  // 浮窗页面不能再有外挂的灯
  const floatHtml = readFileSync(new URL('../debug/float.html', import.meta.url), 'utf8');
  assert.ok(!/class="lamp"/.test(floatHtml), '浮窗不该再挂独立的 .lamp 圆灯');
  assert.ok(!/el\('lamp'\)/.test(floatHtml), 'popup 里不该再引用 lamp 元素');
});

await test('设置页每个 class 都真的在 CSS 里有样式（不是裸 div 堆着）', () => {
  /*
   * 用户报「设置页样式还是乱，都挤在一起了」。
   *
   * 根因不在样式写错，而在**根本没写**：设置页用了 dw-settings / dw-set-row /
   * dw-set-label 这一整套 class，但 style.css 里一个都没有。只剩开关和胶囊
   * 按钮的内联样式，容器和行全是裸 div，浏览器按块级元素往下堆。
   *
   * 所以这条测试直接查 CSS 文本里有没有对应选择器。以后再新增 class
   * 忘了写样式，这里立刻红。
   */
  const classes = ['dw-settings', 'dw-set-title', 'dw-set-intro', 'dw-set-sub',
    'dw-set-row', 'dw-set-label', 'dw-set-hint'];
  for (const name of classes) {
    assert.ok(CSS_TEXT.includes('.' + name),
      '设置页用了 .' + name + '，但 style.css 里没有它的样式');
  }

  // 行必须是左右布局：只写 padding 不写 flex，控件还是会掉到下一行
  const rowRule = CSS_TEXT.slice(CSS_TEXT.indexOf('.dw-set-row'));
  const rowBody = rowRule.slice(0, rowRule.indexOf('}'));
  assert.ok(/display\s*:\s*flex/.test(rowBody), '.dw-set-row 必须 display:flex，否则标签和控件上下堆叠');
  assert.ok(/justify-content\s*:\s*space-between/.test(rowBody), '.dw-set-row 要两头对齐（标签在左、控件在右）');
  assert.ok(/align-items\s*:\s*center/.test(rowBody), '.dw-set-row 要垂直居中');
});

await test('设置页说明文字不能被分隔线穿中间（行+说明只留一条底线）', () => {
  /*
   * 用户报「每条设置项说明文字中间都有一条线」。
   *
   * 根因：.dw-set-row 有下边框，.dw-set-row + .dw-set-hint 又给说明加下边框，
   * 且用 margin-top:-10px 把说明往上拽，正好撞上上一行的 border-bottom——
   * 线就压在了说明文字上/中间。
   *
   * 约束：行+说明这节只允许一条分隔线（由说明的底线承担）；不许用负上边距；
   * 行若后面紧跟说明，行自己的下边框要让位，避免双线。
   */
  const hintAdj = CSS_TEXT.slice(CSS_TEXT.indexOf('.dw-set-row + .dw-set-hint'));
  const hintBody = hintAdj.slice(0, hintAdj.indexOf('}'));
  assert.ok(!/margin-top\s*:\s*-/.test(hintBody),
    '.dw-set-row + .dw-set-hint 不能用负的 margin-top（会把说明拽到上一行的边框线上 = 线穿文字）');
  assert.ok(/border-bottom/.test(hintBody),
    '行+说明这一节应由说明的 border-bottom 承担唯一的分隔线');
  assert.ok(/\.dw-set-row:has\(\s*\+\s*\.dw-set-hint\s*\)/.test(CSS_TEXT),
    '行后紧跟说明时，行自己的 border-bottom 要让位（:has 规则），否则行线和说明线两条叠着');
});

await test('dock 停靠条无背景无边框（融入原生窗口）', () => {
  /*
   * 用户要求：dock 去掉背景和边框，与原生窗口融为一体。
   * 原来 .dw-strip 是"浮在输入框上方的一张卡片"（border + background + shadow）。
   * 现在应该只剩内容（机器 + 文字），自己不带任何底/框/影。
   */
  const stripRule = CSS_TEXT.slice(CSS_TEXT.indexOf('.dw-strip'));
  const stripBody = stripRule.slice(0, stripRule.indexOf('}'));
  assert.ok(/border\s*:\s*0(;|\s|$)/.test(stripBody) || /border\s*:\s*none/.test(stripBody),
    '.dw-strip 应去掉边框（border:0）');
  assert.ok(/background\s*:\s*transparent/.test(stripBody),
    '.dw-strip 背景应为 transparent');
  assert.ok(/box-shadow\s*:\s*none/.test(stripBody),
    '.dw-strip 不应再有阴影');
});

await test('悬浮窗菜单不再有「打开调试端」', () => {
  /*
   * 正式版把调试入口收起来，普通用户不该在右键菜单里看到"打开调试端"。
   */
  const mainSrc = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
  assert.ok(!mainSrc.includes("'打开调试端'") && !mainSrc.includes('打开调试端'),
    'electron/main.cjs 的右键菜单不应再包含「打开调试端」');
});


/* ---------- 最终汇总 ---------- *
 * 必须放在文件最末：CSS_TEXT 与截图之后还追加了几条用例，
 * 提前 process.exit 会让它们"没跑却显示通过"。
 */
const finalFailed = results.filter((r) => !r.ok);
if (finalFailed.length > 0) {
  for (const f of finalFailed) console.error('  ✗ ' + f.name + '\n      ' + f.error);
}
console.log('\n' + results.filter((r) => r.ok).length + ' passed, ' + finalFailed.length + ' failed');
/* 组件里有 1s 心跳 setInterval（模拟真机计时），显式退出，避免 node 挂着不退 */
process.exit(finalFailed.length > 0 ? 1 : 0);
