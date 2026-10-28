/**
 * 市场索引脚本的护栏测试。
 *
 * 这两条脚本原先各自硬编码过一份列表页文案，其中一份是旧文案且没有
 * metadata.keywords——结果 pre-push 每次重写索引都会把线上文案降级，
 * 而这事儿在本地看不出来（pull 下来的索引是对的，被 hook 改脏的是工作区）。
 * 所以这里钉住两条：文案只有一份、重写只动版本号。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INDEX_PATH, buildIndex, fingerprint, patchIndex, readPackage, validate,
} from '../scripts/market-index.mjs';

const pkg = readPackage();
const current = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
const curVer = current.plugins[0].versions[0];

test('docs/index.json 与 market-index.mjs 的文案一致（防两份文案再次分叉）', () => {
  const built = buildIndex({
    name: pkg.name,
    version: curVer.version,
    commit: curVer.source.commit,
    publishTimestamp: curVer.publishTimestamp,
  });
  assert.deepEqual(
    fingerprint(built),
    fingerprint(current),
    'docs/index.json 和 scripts/market-index.mjs 已经不一致：改文案请只改 market-index.mjs，'
    + '然后 node scripts/refresh-market.mjs 重新生成',
  );
});

test('patchIndex 只改版本/commit，metadata 与文案原样保留', () => {
  const head = 'b'.repeat(40);
  const patched = patchIndex(current, {
    name: pkg.name, version: '9.9.9', commit: head, publishTimestamp: 2_000_000_000,
  });
  const p = patched.plugins[0];
  assert.deepEqual(p.metadata, current.plugins[0].metadata, 'keywords 不能丢');
  assert.deepEqual(p.description, current.plugins[0].description, '文案不能退回旧版本');
  assert.equal(p.versions[0].version, '9.9.9');
  assert.equal(p.versions[0].source.commit, head);
  // 版本变了 → 发布时刻换成新的
  assert.equal(p.versions[0].publishTimestamp, 2_000_000_000);
  assert.deepEqual(validate(patched), []);
});

test('patchIndex 版本没变时保留原 publishTimestamp', () => {
  const patched = patchIndex(current, {
    name: pkg.name, version: curVer.version, commit: 'c'.repeat(40), publishTimestamp: 2_000_000_000,
  });
  assert.equal(patched.plugins[0].versions[0].publishTimestamp, curVer.publishTimestamp);
});

test('validate 拒绝 publishTimestamp 为 0 的索引', () => {
  const bad = JSON.parse(JSON.stringify(current));
  bad.plugins[0].versions[0].publishTimestamp = 0;
  assert.ok(validate(bad).some((e) => e.includes('publishTimestamp')));
});