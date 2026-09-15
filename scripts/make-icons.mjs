/**
 * 生成 PWA 图标。
 *
 * 不引入 canvas/sharp 这类重依赖：自己写一个带 4x 超采样的矩形光栅化器就够了。
 * 标志是衬线体的「T」加一枚暮色圆点 —— 与 twilightcafe.cn 的 Fraunces 衬线
 * 和「Twilight」主题同源，且完全由矩形与圆构成，可被精确绘制。
 *
 * 用法：node scripts/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'web', 'public', 'icons');

const INK = [0x15, 0x15, 0x15];
const PAPER = [0xff, 0xff, 0xff];
const DUSK = [0xa8, 0x49, 0x2c];

// ───────────────────────── PNG 编码 ─────────────────────────

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** rgba 像素数组 → PNG buffer。8 位真彩带 alpha。 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filter
  ihdr[12] = 0; // no interlace

  // 每行前加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy
      ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ───────────────────────── 绘图 ─────────────────────────

/** 归一化坐标系 [0,1]² 下的矩形。 */
const rect = (x, y, w, h) => ({ kind: 'rect', x, y, w, h });
const circle = (cx, cy, r) => ({ kind: 'circle', cx, cy, r });

/**
 * 序列化的标志几何。所有数值都是相对画布边长的比例。
 *
 * 比例关系是刻意调过的：底脚总宽约为横梁的 62%。更窄会显得头重脚轻，
 * 更宽则失去衬线体「横梁为主、底脚为辅」的层次。
 */
function markShapes() {
  return [
    // 衬线 T —— 横梁
    rect(0.238, 0.283, 0.524, 0.078),
    // 主竖笔（顶端略微探入横梁，避免出现发丝缝）
    rect(0.4435, 0.352, 0.113, 0.348),
    // 底脚衬线：左右各一，与竖笔交叠 2% 以融为一体
    rect(0.3365, 0.692, 0.1185, 0.058),
    rect(0.545, 0.692, 0.1185, 0.058),
    // 暮色圆点：像个句点，也是"时间上的一个点"
    circle(0.7235, 0.7225, 0.0435),
  ];
}

const isInside = (s, x, y) => {
  if (s.kind === 'rect') {
    return x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h;
  }
  const dx = x - s.cx;
  const dy = y - s.cy;
  return dx * dx + dy * dy <= s.r * s.r;
};

/**
 * 渲染一个图标。
 * @param {number} size
 * @param {{scale:number, background:number[]|null}} opts scale 用于 maskable 安全区收缩
 */
function render(size, { scale = 1, background = INK } = {}) {
  const SS = 4; // 超采样倍率
  const shapes = markShapes();
  const rgba = Buffer.alloc(size * size * 4);
  const inv = 1 / (SS * SS);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // 归一化到 [0,1]，并按 scale 围绕中心收缩
          const nx = (px + (sx + 0.5) / SS) / size;
          const ny = (py + (sy + 0.5) / SS) / size;
          const x = (nx - 0.5) / scale + 0.5;
          const y = (ny - 0.5) / scale + 0.5;

          let color = background;
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            let onMark = false;
            let isDot = false;
            for (let i = 0; i < shapes.length; i++) {
              if (isInside(shapes[i], x, y)) {
                onMark = true;
                if (shapes[i].kind === 'circle') isDot = true;
              }
            }
            if (onMark) color = isDot ? DUSK : PAPER;
          }
          if (!color) {
            // 透明背景（用于 any 图标留出圆角由系统裁剪的场景）
            continue;
          }
          r += color[0];
          g += color[1];
          b += color[2];
          a += 255;
        }
      }

      const idx = (py * size + px) * 4;
      rgba[idx] = Math.round(r * inv);
      rgba[idx + 1] = Math.round(g * inv);
      rgba[idx + 2] = Math.round(b * inv);
      rgba[idx + 3] = Math.round(a * inv);
    }
  }

  return encodePng(size, size, rgba);
}

// ───────────────────────── 输出 ─────────────────────────

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targets = [
    // 常规图标：标志撑满，背景铺满
    { file: 'icon-192.png', size: 192, opts: { scale: 1 } },
    { file: 'icon-512.png', size: 512, opts: { scale: 1 } },
    // maskable：留出安全区，避免被圆形/水滴形裁掉笔画
    { file: 'maskable-192.png', size: 192, opts: { scale: 0.68 } },
    { file: 'maskable-512.png', size: 512, opts: { scale: 0.68 } },
    // iOS 主屏图标：系统会自己加圆角，不需要透明边距
    { file: 'apple-touch-icon.png', size: 180, opts: { scale: 1 } },
    // favicon 兜底（部分浏览器在 <link> 失效时会去找它）
    { file: 'favicon-32.png', size: 32, opts: { scale: 1 } },
  ];

  const written = [];
  for (const t of targets) {
    const png = render(t.size, t.opts);
    fs.writeFileSync(path.join(OUT_DIR, t.file), png);
    written.push(`${t.file} (${t.size}×${t.size}, ${(png.length / 1024).toFixed(1)} KB)`);
  }

  console.log('已生成图标：');
  for (const w of written) console.log('  ' + w);
}

main();
