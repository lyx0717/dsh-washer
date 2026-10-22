#!/usr/bin/env node
/**
 * pre-push 钩子：保证推出去的 `docs/index.json` 和当前要推的 HEAD 对得上。
 *
 * 背景：市场索引钉的是 40 位 commit + version。改了代码却忘了刷新索引，
 * 线上市场就会指向旧版本——这是最容易漏的一步。这里在 push 前拦一道。
 *
 * 做法（保守，不偷偷改提交）：
 *   1. 用当前 HEAD / package.json 版本在内存里算出一份「应该长什么样」的索引；
 *   2. 和已提交的 docs/index.json 比对；
 *   3. 不一致 → 自动把它重写到工作区，并**中止本次 push**，提示你 review + commit；
 *   4. 一致 → 放行。
 *
 * 只读 git / package.json，重写仅限 docs/index.json，绝不自动 commit。
 * 逃生：git push --no-verify
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'docs', 'index.json');
const PKG_PATH = join(ROOT, 'package.json');
const ICON_PATH = join(ROOT, 'icon.svg');

// 只在推送 main 时检查索引（推别的分支无所谓）
const refs = readFileSync(0).toString().trim().split('\n').filter(Boolean);
const pushesMain = refs.some((line) => {
  const parts = line.split(' '); // <local ref> <local sha> <remote ref> <remote sha>
  const remoteRef = parts[2] || '';
  return remoteRef === 'refs/heads/main';
});
if (!pushesMain) process.exit(0);

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
const version = pkg.version;

function buildIndex(publishTimestamp) {
  const svg = readFileSync(ICON_PATH, 'utf8').replace(/\s+/g, ' ').trim();
  const icon = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return {
    format: 1,
    title: { en: 'Dogdan plugins', zh: '狗蛋儿的插件' },
    plugins: [
      {
        name: pkg.name,
        title: { en: 'Washer · Agent status machine', zh: '滚筒洗衣机' },
        description: {
          en: 'Show what the Agent is doing as a front-loading washing machine: wash = streaming, rinse = tool running, spin = wrapping up, pause = waiting for your approval.',
          zh: '用一台滚筒洗衣机的运转状态实时显示 Agent 在干什么：洗涤=出字、漂洗=工具在跑、脱水=收尾、暂停=等你批准。',
        },
        icon,
        author: '李永轩',
        homepage: 'https://github.com/lyx0717/dsh-washer#readme',
        repository: { url: 'https://github.com/lyx0717/dsh-washer' },
        versions: [
          {
            version,
            publishTimestamp: 0, // 比对时忽略
            source: { type: 'git', url: 'https://github.com/lyx0717/dsh-washer', commit, path: '.' },
          },
        ],
      },
    ],
  };
}

// 与 docs/index.json 做「实质相等」比较：忽略 publishTimestamp（时间戳每次都变）
function fingerprint(idx) {
  const clone = JSON.parse(JSON.stringify(idx));
  for (const p of clone.plugins || []) {
    for (const v of p.versions || []) delete v.publishTimestamp;
  }
  return JSON.stringify(clone);
}

const want = buildIndex(0);
let current = null;
if (existsSync(INDEX_PATH)) {
  try {
    current = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    current = null;
  }
}

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

if (current) {
  const v = current?.plugins?.[0]?.versions?.[0];
  const idxCommit = v?.source?.commit;
  const idxVer = v?.version;
  if (
    idxVer === version &&
    idxCommit &&
    /^[0-9a-f]{40}$/.test(idxCommit) &&
    isCommitAncestor(idxCommit) &&
    !codeChangedSince(idxCommit)
  ) {
    // 版本对、索引 commit 在当前历史里、且自那以后代码没变：放行。
    // （常见于「只提交了 docs/index.json 刷新」之后的这次 push）
    process.exit(0);
  }
}

// 不一致：重写到工作区（保留一个真实时间戳），并中止 push
const next = buildIndex(Math.floor(Date.now() / 1000));
writeFileSync(INDEX_PATH, JSON.stringify(next, null, 2) + '\n');

const curVer = current?.plugins?.[0]?.versions?.[0];
const curCommit = curVer?.source?.commit || '(无)';
console.error('');
console.error('✗ 市场索引与当前 HEAD 不一致，已自动重写 docs/index.json 并中止 push。');
console.error(`   索引版本/commit : ${curVer?.version || '(无)'} / ${String(curCommit).slice(0, 7)}`);
console.error(`   当前 HEAD/版本  : ${commit.slice(0, 7)} / ${version}`);
console.error('');
console.error('   请检查后提交再推：');
console.error('     git add docs/index.json && git commit -m "docs: 刷新市场索引" && git push');
console.error('   （确实不想更新索引可跳过本检查：git push --no-verify）');
console.error('');
process.exit(1);
