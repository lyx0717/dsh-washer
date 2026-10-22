#!/usr/bin/env node
/**
 * 重新生成插件市场索引 docs/index.json。
 *
 * 市场索引里钉的是「某个 40 位 commit」，代码一变就得同步更新 commit 和 version，
 * 手改容易漏。这个脚本从当前 git HEAD 读 commit、从 package.json 读 version，
 * 重新生成索引并就地校验；只读文件、不安装、不联网。
 *
 * 用法：
 *   node scripts/refresh-market.mjs            # 用当前 HEAD
 *   node scripts/refresh-market.mjs --commit <sha> --version <x.y.z>   # 覆盖
 *   node scripts/refresh-market.mjs --check    # 只校验已存在的索引，不重写
 *
 * 重写后请 git add docs/index.json && commit && push；
 * GitHub Pages 构建完成后线上即生效。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'docs', 'index.json');
const PKG_PATH = join(ROOT, 'package.json');
const ICON_PATH = join(ROOT, 'icon.svg');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const version = flag('--version') || pkg.version;
const commit = flag('--commit') || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const hex40 = /^[0-9a-f]{40}$/;

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

if (!semver.test(version)) fail(`version 不是合法 SemVer：${version}`);
if (!hex40.test(commit)) fail(`commit 不是 40 位十六进制 SHA：${commit}`);

function iconDataUrl() {
  const svg = readFileSync(ICON_PATH, 'utf8').replace(/\s+/g, ' ').trim();
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const index = {
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
      icon: iconDataUrl(),
      author: '李永轩',
      homepage: 'https://github.com/lyx0717/dsh-washer#readme',
      repository: { url: 'https://github.com/lyx0717/dsh-washer' },
      versions: [
        {
          version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: {
            type: 'git',
            url: 'https://github.com/lyx0717/dsh-washer',
            commit,
            // 插件在仓库根目录：省略 path（市场不接受 "."，缺省即根）
          },
        },
      ],
    },
  ],
};

function validate(obj) {
  const errs = [];
  if (obj.format !== 1) errs.push('format 必须为 1');
  if (!obj.title || !obj.title.en) errs.push('title.en 缺失');
  if (!Array.isArray(obj.plugins) || !obj.plugins.length) errs.push('plugins 为空');
  for (const p of obj.plugins || []) {
    if (!p.name) errs.push('插件 name 缺失');
    if (!p.title || !p.title.en) errs.push(`${p.name}: title.en 缺失`);
    if (p.icon && !p.icon.startsWith('data:') && !/^https?:/.test(p.icon)) errs.push(`${p.name}: icon 非法`);
    if (!Array.isArray(p.versions) || !p.versions.length) errs.push(`${p.name}: versions 为空`);
    for (const v of p.versions || []) {
      if (!semver.test(v.version)) errs.push(`${p.name}: 非法版本 ${v.version}`);
      if (typeof v.publishTimestamp !== 'number' || v.publishTimestamp < 1e9) errs.push(`${p.name}: publishTimestamp 非法`);
      const s = v.source;
      if (!s) errs.push(`${p.name}: source 缺失`);
      else if (s.type === 'git') {
        if (!/^https:/.test(s.url)) errs.push(`${p.name}: git url 必须 https`);
        if (!hex40.test(s.commit)) errs.push(`${p.name}: commit 必须是 40 位 hex`);
        // path 必须是相对目录，且每段只允许 字母/数字/._@+-，不许 . 或 .. 段；
        // 插件在仓库根目录时应省略 path（不能写 "."）。
        if (s.path !== undefined) {
          const segs = String(s.path).split('/');
          const bad = s.path === '' || s.path.startsWith('/') ||
            segs.some((seg) => seg === '.' || seg === '..' || !/^[A-Za-z0-9._@+-]+$/.test(seg));
          if (bad) errs.push(`${p.name}: source.path 非法（相对目录，段只允许 字母/数字/._@+-，不能含 . 或 ..）: ${JSON.stringify(s.path)}`);
        }
      } else if (s.type !== 'npm') errs.push(`${p.name}: 非法 source.type`);
    }
  }
  return errs;
}

if (checkOnly) {
  if (!existsSync(INDEX_PATH)) fail('docs/index.json 不存在，先用不带 --check 的方式生成');
  const errs = validate(JSON.parse(readFileSync(INDEX_PATH, 'utf8')));
  if (errs.length) fail('索引校验失败：\n' + errs.join('\n'));
  console.log('✓ docs/index.json 校验通过');
} else {
  const errs = validate(index);
  if (errs.length) fail('生成的索引校验失败：\n' + errs.join('\n'));
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
  console.log(`✓ 已写 docs/index.json：${pkg.name}@${version} ← commit ${commit.slice(0, 7)}`);
  console.log('  下一步：git add docs/index.json && git commit && git push（等 Pages 构建）');
}
