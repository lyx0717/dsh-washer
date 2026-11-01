/**
 * 生成托盘图标 electron/tray.png（32×32，白线透明底）。
 *
 * 为什么不用手绘位图或引第三方图标库：这个仓库零运行时依赖，
 * 图标只需要"一眼看出是台洗衣机"，32px 手写 PNG 足够。
 * 生成脚本留在 tools/ 下：以后想改样子重新跑一次就行，不用另存设计文件。
 *
 * 用法：node tools/gen-tray-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 32;
const SS = 4; // 每像素 4×4 超采样，边缘不出锯齿

/** 圆角矩形有向距离：中心 (cx,cy)，半宽半高 (hw,hh)，圆角 r。内部为负。 */
function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** 点到圆环的距离（环中线半径 r，线宽 w） */
function ring(px, py, cx, cy, r, w) {
  return Math.abs(Math.hypot(px - cx, py - cy) - r) - w / 2;
}

/**
 * 造型：
 *   - 机身：圆角矩形描边（22×24，线宽 2.4）
 *   - 舱门：圆环（半径 7，线宽 2.2）
 *   - 旋钮：左上角一个小实心圆（半径 1.6）
 */
function coverage(x, y) {
  let best = 0;
  const body = Math.abs(sdRoundBox(x, y, 16, 17, 11, 12, 4.5)) - 1.2;
  if (body < 0) best = 1;
  const door = ring(x, y, 16, 18, 7, 2.2);
  if (door < 0) best = 1;
  const knob = Math.hypot(x - 10.2, y - 8.4) - 1.7;
  if (knob < 0) best = 1;
  // 舱门内部留一点水色：实心浅蓝，缩到 16px 时正好是一点蓝
  return best;
}

/** 内舱门：淡淡的水蓝填充（0.35 透明度），让图标在任务栏上不至于全白 */
function innerWater(x, y) {
  const d = Math.hypot(x - 16, y - 18);
  if (d > 5.6) return 0;
  return 0.55;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let strokeHits = 0;
    let waterHits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS;
        const y = py + (sy + 0.5) / SS;
        const c = coverage(x, y);
        if (c > 0) strokeHits++;
        const w = innerWater(x, y);
        if (w > 0) waterHits++;
      }
    }
    const total = SS * SS;
    const a = strokeHits / total;
    const wa = waterHits / total;
    const i = (py * SIZE + px) * 4;
    if (a > 0) {
      rgba[i] = 245; rgba[i + 1] = 248; rgba[i + 2] = 252; rgba[i + 3] = Math.round(a * 255);
    } else if (wa > 0) {
      // 水：偏青的浅蓝，透明度低一点，避免和白色描边抢
      rgba[i] = 122; rgba[i + 1] = 196; rgba[i + 2] = 255; rgba[i + 3] = Math.round(wa * 140);
    }
  }
}

// ---- PNG 编码（零依赖：IHDR + IDAT + IEND）----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
ihdr[10] = 0;  // deflate
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // no interlace

// 每行前加 filter byte 0（None）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'electron', 'tray.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);