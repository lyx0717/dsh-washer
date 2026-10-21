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
const css = [
  '/* dsh-washer · style.css */',
  src('style.css'),
  '/* dsh-washer · skin-precision.css */',
  src('skin-precision.css'),
  '/* dsh-washer · skin-anime.css */',
  src('skin-anime.css'),
].join('\n');

const out = template
  .replace('/*__CORE__*/', () => inlineCore())
  .replace('__SPRITE__', () => JS_STRING(src('sprite.svg').trim()))
  .replace('__MACHINE__', () => JS_STRING(src('machine.svg').trim()))
  .replace('__CSS__', () => JS_STRING(css));

for (const token of ['/*__CORE__*/', '__SPRITE__', '__MACHINE__', '__CSS__']) {
  if (out.includes(token)) throw new Error('unreplaced build token: ' + token);
}

writeFileSync(join(here, 'client.js'), out);
// out.length 是字符数，中文占 3 字节，直接拿它当文件大小会少报 8%
const bytes = Buffer.byteLength(out, 'utf8');
console.log('client.js written:', bytes, 'bytes');
