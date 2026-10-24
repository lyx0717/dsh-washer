/**
 * 构建产物单测：生成出来的脚本必须是浏览器能跑的。
 *
 * 为什么要有这个文件：这些产物由 build-float.mjs 用字符串拼接生成，
 * 语法错误不会让 `npm test` 挂——它们只在浮窗那个渲染进程里才炸。
 * 出过一次真实事故：build-float.mjs 用非贪婪正则抠 NATURAL 对象，
 * 撞上 getter 的方法体提前截断，生成的 float.machines.js 整体语法错误，
 * 浏览器里 window.WasherMachines 变 undefined，浮窗直接不画洗衣机了。
 * 而当时 98 个测试全绿。
 *
 * 所以这里不看配置文件，直接执行产物本身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FLOAT_JS = join(ROOT, 'debug', 'float.machines.js');

/**
 * 在一个伪造的浏览器环境里跑产物。
 *
 * 只提供 float.machines.js 真正会碰到的东西：window / document / navigator。
 * 不引 jsdom——这个产物的目的是"不报错并能画出机器"，不是模拟整个浏览器。
 */
function runInFakeBrowser(file) {
  const created = [];
  const doc = {
    head: { appendChild(node) { created.push(node); } },
    createElement(tag) {
      return {
        tagName: tag, className: '', textContent: '',
        // 真 DOM 的 style 是 CSSStyleDeclaration，setProperty 是它的一部分；
        // 造型代码用它设 --led / --water 这些自定义属性，缺了就会 TypeError
        style: { setProperty() {}, removeProperty() {} },
        children: [],
        setAttribute() {},
        appendChild(child) { this.children.push(child); return child; },
      };
    },
    getElementById() { return null; },
  };
  const sandbox = {
    window: {},
    document: doc,
    console,
  };
  sandbox.window.document = doc;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { window: sandbox.window, created };
}

test('浮窗产物能在浏览器环境里执行，不抛 ReferenceError', () => {
  const { window } = runInFakeBrowser(FLOAT_JS);
  // 真正的判据：上面没抛异常就说明整段语法是好的。
  // 上一版这里是 undefined —— 语法错误导致文件整体没执行。
  assert.ok(window.WasherMachines !== undefined, 'window.WasherMachines 必须存在');
});

test('浮窗产物不引用主界面模块作用域里的东西', () => {
  /*
   * 这是上一版事故的直接成因：NATURAL 的 getter 读 SKIN_REGISTRY，
   * 而那个注册表在主界面的箭头函数作用域里，浮窗这份独立脚本够不到。
   *
   * 这里用静态检查兜底，因为构造一个 SKIN_REGISTRY 的假实现反而会
   * 掩盖问题——真出问题时浮窗是整块空白，不是抛一行可读的报错。
   */
  const code = readFileSync(FLOAT_JS, 'utf8');
  const leaked = [...code.matchAll(/\b(SKIN_REGISTRY|resolveSkin|defineSkin)\b/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(leaked)], [],
    '浮窗产物不能引用主界面的皮肤注册表，它没有这个作用域',
  );
});

test('每套皮肤都能画出来', () => {
  const { window } = runInFakeBrowser(FLOAT_JS);
  const machines = window.WasherMachines;
  // NATURAL 里声明的皮肤都要能 build，任何一个抛错浮窗就是白框
  for (const skin of ['pixel', 'precision']) {
    const node = machines.build(skin, 'washing', 112, '00:12', false);
    assert.ok(node !== undefined && node !== null, `${skin} 应该画出节点`);
  }
});

test('状态表覆盖所有状态', () => {
  const { window } = runInFakeBrowser(FLOAT_JS);
  const states = ['off', 'idle', 'starting', 'washing', 'rinsing', 'spinning', 'waiting', 'draining', 'done', 'error'];
  for (const state of states) {
    // 每个状态都要能渲染，不能因为查不到配色就崩掉整块
    const node = window.WasherMachines.build('pixel', state, 112, '00:00', state === 'waiting');
    assert.ok(node !== undefined && node !== null, `${state} 状态应该能渲染`);
  }
});
