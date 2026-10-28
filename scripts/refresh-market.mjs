#!/usr/bin/env node
/**
 * 重新生成插件市场索引 docs/index.json。
 *
 * 市场索引里钉的是「某个 40 位 commit」，代码一变就得同步更新 commit 和 version，
 * 手改容易漏。这个脚本从当前 git HEAD 读 commit、从 package.json 读 version，
 * 重新生成索引并就地校验；只读文件、不安装、不联网。
 *
 * 索引长什么样、文案和 keywords 是什么，全在 scripts/market-index.mjs（唯一来源）；
 * 这里只管命令行参数和落盘。
 *
 * 用法：
 *   node scripts/refresh-market.mjs            # 用当前 HEAD
 *   node scripts/refresh-market.mjs --commit <sha> --version <x.y.z>   # 覆盖
 *   node scripts/refresh-market.mjs --check    # 只校验已存在的索引，不重写
 *
 * 重写后请 git add docs/index.json && commit && push；
 * GitHub Pages 构建完成后线上即生效。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  INDEX_PATH, SEMVER, HEX40, buildIndex, headCommit, readPackage, validate,
} from './market-index.mjs';

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const pkg = readPackage();
const version = flag('--version') || pkg.version;
const commit = flag('--commit') || headCommit();

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

if (!SEMVER.test(version)) fail(`version 不是合法 SemVer：${version}`);
if (!HEX40.test(commit)) fail(`commit 不是 40 位十六进制 SHA：${commit}`);

if (checkOnly) {
  if (!existsSync(INDEX_PATH)) fail('docs/index.json 不存在，先用不带 --check 的方式生成');
  const errs = validate(JSON.parse(readFileSync(INDEX_PATH, 'utf8')));
  if (errs.length) fail('索引校验失败：\n' + errs.join('\n'));
  console.log('✓ docs/index.json 校验通过');
} else {
  const index = buildIndex({
    name: pkg.name,
    version,
    commit,
    publishTimestamp: Math.floor(Date.now() / 1000),
  });
  const errs = validate(index);
  if (errs.length) fail('生成的索引校验失败：\n' + errs.join('\n'));
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
  console.log(`✓ 已写 docs/index.json：${pkg.name}@${version} ← commit ${commit.slice(0, 7)}`);
  console.log('  下一步：git add docs/index.json && git commit && git push（等 Pages 构建）');
}