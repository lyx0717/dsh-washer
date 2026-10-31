/**
 * 产物新鲜度：client.js / debug/float.machines.js 必须能从 src/ 原样重建出来。
 *
 * 为什么要有这个文件：这两个产物都进了 git（市场按 git 源分发，装了包的人
 * 没有 src/ 也没有构建脚本，只能拿提交好的产物）。于是最隐蔽的 bug 是
 * 「改了 src/ 却忘了 npm run build」——单测跑的是 src 派生的 client.js，
 * 但仓库里躺着旧产物，用户拿到的就是旧行为，而本地怎么测都是绿的。
 *
 * 判据很直接：在临时目录里把 src/ 拷一份、跑两个 build 脚本，产物必须与
 * 仓库里已提交的逐字节一致。不一致就是过期（或有人手改了产物没改源）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 在临时目录重建两个产物，返回内容。构建输入只依赖 src/ + package.json。 */
function buildFresh() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-washer-fresh-'));
  try {
    for (const file of ['build.mjs', 'build-float.mjs', 'package.json']) {
      cpSync(join(ROOT, file), join(dir, file));
    }
    cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'debug'), { recursive: true });
    execFileSync(process.execPath, ['build.mjs'], { cwd: dir, stdio: 'pipe' });
    execFileSync(process.execPath, ['build-float.mjs'], { cwd: dir, stdio: 'pipe' });
    return {
      client: readFileSync(join(dir, 'client.js'), 'utf8'),
      floatMachines: readFileSync(join(dir, 'debug', 'float.machines.js'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let cache = null;
function built() {
  if (cache === null) cache = buildFresh();
  return cache;
}

test('client.js 与 src/ 重建结果一致（未过期）', () => {
  assert.equal(
    readFileSync(join(ROOT, 'client.js'), 'utf8'),
    built().client,
    'client.js 与 src/ 重建结果不一致：改了 src/ 却没 npm run build（或手改了产物没改源）。',
  );
});

test('debug/float.machines.js 与重建结果一致（未过期）', () => {
  assert.equal(
    readFileSync(join(ROOT, 'debug', 'float.machines.js'), 'utf8'),
    built().floatMachines,
    'debug/float.machines.js 与重建结果不一致：请跑 npm run build。',
  );
});
