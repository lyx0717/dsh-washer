/**
 * 插件市场索引 `docs/index.json` 的唯一构造与校验入口。
 *
 * 为什么要单独一个模块：索引里的**文案和关键词**原先在 `refresh-market.mjs`
 * 和 `pre-push-market.mjs` 里各写了一份。两份只要有一处对不上，
 * pre-push 就会判定「索引与 HEAD 不一致」并重写索引——而它那份是旧文案、
 * 还没有 `metadata.keywords`，于是每推一次非发版提交，线上市场索引就被降级一次。
 * 现在文案只在这里定义，两个脚本都从这里取。
 *
 * 只读 git / package.json / icon.svg，不联网、不安装。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX_PATH = join(ROOT, 'docs', 'index.json');
export const PKG_PATH = join(ROOT, 'package.json');
const ICON_PATH = join(ROOT, 'icon.svg');

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const HEX40 = /^[0-9a-f]{40}$/;
export const REPO_URL = 'https://github.com/lyx0717/dsh-washer';

/*
 * 市场列表页文案：唯一来源。
 *
 * 只放「列表页能看到的一句话」。早版本写的是「洗涤=出字、漂洗=工具在跑」这类
 * 状态对照——那是详情页该讲的事，塞进列表反而把最该突出的差异点
 * （桌面悬浮窗、多会话、卡住检测、完成后提醒）全挤没了。用户扫一眼列表时的
 * 判断是「这东西能不能解决我的问题」，不是「它的状态机怎么映射」。
 */
export const COPY = {
  title: { en: 'Dogdan plugins', zh: '狗蛋儿的插件' },
  pluginTitle: { en: 'Washer · Agent status machine', zh: '滚筒洗衣机' },
  description: {
    en: 'Watch the Agent work from anywhere: a floating washing machine that pings you when it is done or stuck. Multi-session, pinned view, done/error/stuck alerts.',
    zh: '不用盯着屏幕也知道 Agent 跑到哪了：桌面悬浮窗实时显示，洗完 / 卡住 / 等你确认会主动提醒。支持多会话与钉住。',
  },
  /*
   * keywords 参与模糊搜索，权重仅次于包名和标题（见 dsh-plugin-market 的
   * MiniSearch 配置：boost name/title 3、keywords 2）。一个词都不填，
   * 就等于搜「悬浮窗」「状态」「通知」都找不到这个插件——白丢的曝光。
   *
   * 中英混填是刻意的：用户可能用任何一种语言搜。
   */
  keywords: [
    'washer', 'washing machine', 'status', 'agent status', 'progress',
    'overlay', 'always on top', 'floating window', 'multi-session',
    'notification', 'sound', 'alert', 'stuck', 'eta',
    '洗衣机', '状态', '悬浮窗', '进度', '多会话', '通知', '提醒', '卡住',
  ],
  author: '李永轩',
  homepage: 'https://github.com/lyx0717/dsh-washer#readme',
};

export function readPackage() {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8'));
}

export function headCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
}

export function iconDataUrl() {
  const svg = readFileSync(ICON_PATH, 'utf8').replace(/\s+/g, ' ').trim();
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/** 从零构造一份索引（发版用：文案取 COPY 的当前值）。 */
export function buildIndex({ name, version, commit, publishTimestamp }) {
  return {
    format: 1,
    title: COPY.title,
    plugins: [
      {
        name,
        title: COPY.pluginTitle,
        description: COPY.description,
        metadata: { keywords: COPY.keywords },
        icon: iconDataUrl(),
        author: COPY.author,
        homepage: COPY.homepage,
        repository: { url: REPO_URL },
        versions: [
          {
            version,
            publishTimestamp,
            source: { type: 'git', url: REPO_URL, commit },
          },
        ],
      },
    ],
  };
}

/**
 * 在已有索引上只改「钉版本」的字段，其余（description / metadata / icon 之外的文案）
 * 原样保留。pre-push 重写走这里，避免把线上文案和 keywords 冲掉。
 *
 * version 没变 → 保留原 publishTimestamp（那才是真实的发布时刻）；
 * version 变了 → 用传入的新时间戳。
 */
export function patchIndex(current, { name, version, commit, publishTimestamp }) {
  const next = JSON.parse(JSON.stringify(current));
  const icon = iconDataUrl();
  const list = Array.isArray(next.plugins) ? next.plugins : [];
  let plugin = list.find((p) => p && p.name === name);
  if (!plugin) {
    plugin = buildIndex({ name, version, commit, publishTimestamp }).plugins[0];
    list.push(plugin);
    next.plugins = list;
    return next;
  }

  const prev = (plugin.versions || [])[0];
  const keepTs = prev && prev.version === version ? prev.publishTimestamp : publishTimestamp;
  plugin.name = name;
  plugin.icon = icon;
  plugin.versions = [
    {
      ...(prev || {}),
      version,
      publishTimestamp: keepTs,
      source: { ...((prev && prev.source) || {}), type: 'git', url: REPO_URL, commit },
    },
  ];
  return next;
}

/** 市场加载端会拒掉的索引，这里先拦下来。 */
export function validate(obj) {
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
      if (!SEMVER.test(v.version)) errs.push(`${p.name}: 非法版本 ${v.version}`);
      if (typeof v.publishTimestamp !== 'number' || v.publishTimestamp < 1e9) errs.push(`${p.name}: publishTimestamp 非法`);
      const s = v.source;
      if (!s) errs.push(`${p.name}: source 缺失`);
      else if (s.type === 'git') {
        if (!/^https:/.test(s.url)) errs.push(`${p.name}: git url 必须 https`);
        if (!HEX40.test(s.commit)) errs.push(`${p.name}: commit 必须是 40 位 hex`);
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

/** 比对用：忽略 publishTimestamp（每次刷新都会变，不算实质差异）。 */
export function fingerprint(idx) {
  const clone = JSON.parse(JSON.stringify(idx));
  for (const p of clone.plugins || []) {
    for (const v of p.versions || []) delete v.publishTimestamp;
  }
  return JSON.stringify(clone);
}