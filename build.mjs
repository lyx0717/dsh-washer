#!/usr/bin/env node
/**
 * dsh-washer 构建脚本：把 src/ 下的素材与状态核心拼成单文件 client.js。
 *
 * 为什么要构建而不是直接写 client.js：
 * - 浏览器半必须是纯 JS（无 import / 无 JSX），而状态核心要能在 node 下跑单测，
 *   所以 core.js 保持 ESM，构建时把 export 去掉内联进来。
 * - sprite.svg / machine.svg / *.css 内联，省掉运行时的额外请求（插件包只有一份 client.js）。
 *
 * 用法：node build.mjs   （幂等，不会改 src/）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, 'src', name), 'utf8');

/** core.js 是 ESM，内联前去掉 `export ` 前缀（client.js 是普通脚本作用域） */
function inlineCore() {
  return src('core.js')
    .replace(/^export\s+(const|function|class)\s/gm, '$1 ')
    .replace(/^export\s*\{[^}]*\}\s*;?$/gm, '')
    .trim();
}

const JS_STRING = (value) => JSON.stringify(value);

const template = src('client.template.js');
/* 皮肤清单是唯一事实源：加一套皮肤只改 src/skins.json */
const MANIFEST = JSON.parse(src('skins.json')).skins;
/* body 文件只负责定义 `<name>BodyHtml`，登记到查表这件事由构建统一做：
 * 少一处手工同步，加皮肤就不会漏注册。 */
const SKIN_BODIES = MANIFEST.map(
  (s) => src(s.body).trimEnd() + '\nSKIN_BODY_FNS.' + s.name + ' = ' + s.name + 'BodyHtml;',
).join('\n');
const css = [
  '/* dsh-washer · style.css */',
  src('style.css'),
  ...MANIFEST.flatMap((s) => ['/* dsh-washer · ' + s.css + ' */', src(s.css)]),
].join('\n');

/* 清单和界面文案必须对得上：漏了一条 label，设置页就会显示裸 key。 */
for (const s of MANIFEST) {
  if (!template.includes("'skin." + s.name + "':")) {
    throw new Error('skins.json 有 ' + s.name + '，但 client.template.js 的 ZH/EN 里没有 skin.' + s.name);
  }
}

const out = template
  .replace('/*__CORE__*/', () => inlineCore())
  .replace('__SPRITE__', () => JS_STRING(src('sprite.svg').trim()))
  .replace('__MACHINE__', () => JS_STRING(src('machine.svg').trim()))
  .replace('__CLOTHES__', () => JS_STRING(src('clothes-precision.svg').trim()))
  .replace('__SKINS_JSON__', () => JSON.stringify(MANIFEST))
  .replace('/*__SKIN_BODIES__*/', () => SKIN_BODIES)
  .replace('__CSS__', () => JS_STRING(css));

for (const token of ['/*__CORE__*/', '__SPRITE__', '__MACHINE__', '__CSS__', '__CLOTHES__', '/*__SKIN_BODIES__*/', '__SKINS_JSON__']) {
  if (out.includes(token)) throw new Error('unreplaced build token: ' + token);
}

/*
 * 模块 id 必须等于 package.json 的 name —— 构建期硬断言。
 *
 * 宿主按 insert.name（就是包名）去 __ModuleLoader__ 的注册表里查客户端模块。
 * 两者不一致时，查不到的那一边**不会报错**：插件服务端半照常工作，
 * 只是 dock 座位不出现、settings.section 也不注册，用户在 UI 上看到的是
 * "插件装了但设置页里连入口都没有"。
 *
 * 这个坑真实踩过：0.3.0 把包名改成 @lyx0717/dsh-washer，漏了模板里的
 * `id: 'dsh-washer'`，结果整套 UI 消失且日志一片干净，排查绕了一大圈。
 * 放在构建期断言，改包名时要么改对、要么构建直接失败。
 */
const pkgName = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).name;
const idMatch = out.match(/__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*'([^']+)'/);
if (idMatch === null) throw new Error('client.js 里找不到 __ModuleLoader__.load 的 id');
if (idMatch[1] !== pkgName) {
  throw new Error(
    `模块 id 与包名不一致：client.js 里是 '${idMatch[1]}'，package.json 是 '${pkgName}'。\n`
    + '宿主要按包名查这个模块，不一致会导致客户端半完全不加载（且不报错）。'
    + '改 src/client.template.js 第 2 行的 id。',
  );
}

writeFileSync(join(here, 'client.js'), out);
// out.length 是字符数，中文占 3 字节，直接拿它当文件大小会少报 8%
const bytes = Buffer.byteLength(out, 'utf8');
console.log('client.js written:', bytes, 'bytes');
console.log('module id:', idMatch[1], '(== package.json name)');
