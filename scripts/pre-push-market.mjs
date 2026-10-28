#!/usr/bin/env node
/**
 * pre-push 钩子：保证推出去的 `docs/index.json` 和当前要推的 HEAD 对得上。
 *
 * 背景：市场索引钉的是 40 位 commit + version。改了代码却忘了刷新索引，
 * 线上市场就会指向旧版本——这是最容易漏的一步。这里在 push 前拦一道。
 *
 * 做法（保守，不偷偷改提交）：
 *   1. 以已提交的索引为底，只把 version / commit 改成「现在应该长的样子」；
 *   2. 和已提交的 docs/index.json 比对，一致 → 放行；
 *   3. 版本**没变**但代码改过（没发版的改动）→ 只拦不改，提示升版本或 --no-verify；
 *      索引仍钉已发布的那个提交，因为它说的是「线上这版是从哪份代码出的」；
 *   4. 版本变了（真发版）→ 自动把它重写到工作区，并**中止本次 push**，
 *      提示你 review + commit。
 *
 * 为什么是「打补丁」而不是「重新生成」：重新生成会用自己的文案覆盖已发布的
 * 市场文案，旧版本还少了 metadata.keywords，结果每推一次非发版提交，
 * 线上索引就被降级一次。文案与 keywords 的唯一来源在 scripts/market-index.mjs，
 * 这里不再各写一份。
 *
 * 只读 git / package.json，重写仅限 docs/index.json，绝不自动 commit。
 * 逃生：git push --no-verify
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  INDEX_PATH, ROOT, buildIndex, fingerprint, headCommit, patchIndex, readPackage,
} from './market-index.mjs';

// 只在推送 main 时检查索引（推别的分支无所谓）
const refs = readFileSync(0).toString().trim().split('\n').filter(Boolean);
const pushesMain = refs.some((line) => {
  const parts = line.split(' '); // <local ref> <local sha> <remote ref> <remote sha>
  const remoteRef = parts[2] || '';
  return remoteRef === 'refs/heads/main';
});
if (!pushesMain) process.exit(0);

const pkg = readPackage();
const commit = headCommit();
const version = pkg.version;

let current = null;
if (existsSync(INDEX_PATH)) {
  try {
    current = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    current = null;
  }
}

const nowSec = Math.floor(Date.now() / 1000);
const want = current
  ? patchIndex(current, { name: pkg.name, version, commit, publishTimestamp: nowSec })
  : buildIndex({ name: pkg.name, version, commit, publishTimestamp: nowSec });

// 索引可以钉在 HEAD 本身，也可以钉在 HEAD 之前的某个「代码提交」上——
// 因为刷新索引那次提交只改 docs/index.json，不该逼着索引再指回它自己（会死循环）。
// 判定「索引没落后」需要同时满足：
//   1. version 相符；
//   2. 索引 commit 是 HEAD 的祖先（存在）；
//   3. 自索引 commit 以来，**代码相关文件**没有任何改动。
// 第 3 条是关键：否则「改了代码忘了升版本」会被误放行（而这正是要拦的场景）。
function isCommitAncestor(sha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

// 会改变用户装到的东西 / 需要刷新索引的路径。
// docs/ 和 scripts/ 不在此列：改它们不改变包内容。
const CODE_PATHS = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale',
  'src',
  'build.mjs',
  'build-float.mjs',
  'electron',
];

function codeChangedSince(sha) {
  try {
    execFileSync('git', ['diff', '--quiet', sha, 'HEAD', '--', ...CODE_PATHS], { cwd: ROOT });
    return false; // 无差异
  } catch {
    return true; // 有差异（或 sha 无效）
  }
}

if (current && fingerprint(current) === fingerprint(want)) {
  process.exit(0);
}

const curVer = current?.plugins?.[0]?.versions?.[0];
const idxCommit = curVer?.source?.commit;
const idxVer = curVer?.version;
const idxOk = Boolean(
  idxVer === version && idxCommit && /^[0-9a-f]{40}$/.test(idxCommit) && isCommitAncestor(idxCommit),
);

// 放行：索引钉的 commit 在当前历史里，且自那以后代码没动过。
// （常见于「只提交了 docs/index.json 刷新」之后的这次 push）
if (idxOk && !codeChangedSince(idxCommit)) process.exit(0);

/*
 * 版本没变、但代码在索引 commit 之后改过：这次是**没发版的改动**（重构、修文档夹带的代码）。
 *
 * 这种情况下索引不该跟着动——它钉的是「已发布的 0.7.3 是从哪份代码出的」，
 * 现在 npm 上那份 tarball 就是 commit 3ff3ae1 的内容，把它改指到后面的重构提交
 * 是在谎报来源。所以这里只拦不改：要发新版本就升版本号 + 刷索引；
 * 纯重构就显式跳过这道检查。
 */
if (idxOk && codeChangedSince(idxCommit)) {
  console.error('');
  console.error('✗ 代码在索引 commit 之后改过，但版本还是 ' + version + '（没有发版）。');
  console.error(`   索引钉的发布提交 : ${String(idxCommit).slice(0, 7)} / ${idxVer}`);
  console.error(`   当前 HEAD        : ${commit.slice(0, 7)} / ${version}`);
  console.error('');
  console.error('   索引保持不动是对的（线上 ' + version + ' 就是从那个提交发出去的）。');
  console.error('   · 要发新版本：升 package.json 版本 + node scripts/refresh-market.mjs，提交后再推；');
  console.error('   · 只是重构/修文档：git push --no-verify');
  console.error('');
  process.exit(1);
}

// 版本对不上（或索引缺失/commit 不在历史里）：重写到工作区，并中止 push
writeFileSync(INDEX_PATH, JSON.stringify(want, null, 2) + '\n');

console.error('');
console.error('✗ 市场索引与当前 HEAD 不一致，已自动重写 docs/index.json 并中止 push。');
console.error(`   索引版本/commit : ${idxVer || '(无)'} / ${String(idxCommit || '(无)').slice(0, 7)}`);
console.error(`   当前 HEAD/版本  : ${commit.slice(0, 7)} / ${version}`);
console.error('');
console.error('   请检查后提交再推：');
console.error('     git add docs/index.json && git commit -m "docs: 刷新市场索引" && git push');
console.error('   （确实不想更新索引可跳过本检查：git push --no-verify）');
console.error('');
process.exit(1);