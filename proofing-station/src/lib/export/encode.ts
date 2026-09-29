/**
 * 导出：转换结果像素 → 独立色彩工具可读的图像文件，并嵌入/标识所用配置。
 *
 * - RGB 目标：PNG（iCCP 嵌入目标配置 + tEXt 溯源标记），保留 alpha
 * - CMYK 目标：TIFF（Photometric=Separated，ICC profile tag 34675），
 *   这是 Photoshop/ImageMagick/Argyll 等工具读取 CMYK+ICC 的通用容器
 * - Gray 目标：PNG 灰度（iCCP）
 * - 另可导出 sRGB JPEG（APP2 ICC_PROFILE 段嵌入）
 * - 设置记录 JSON：分别列出源/目标配置的描述、sha256 与“假设”标记，
 *   并显式警告该文件已是转换产物、禁止再次作为原图转换
 */
import { deflate } from 'pako';
import type {
  ColorModel, ExportManifest, IccProfile, ManifestProfileRef,
} from '../color/types';

export const TOOL_NAME = 'Browser Soft-Proofing Station';
export const TOOL_VERSION = '1.0.0';

// ———————————————————— PNG（含 iCCP / tEXt） ————————————————————

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function textChunk(keyword: string, text: string): Uint8Array {
  const k = Uint8Array.from([...keyword].map((ch) => ch.charCodeAt(0)));
  const t = Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));
  const out = new Uint8Array(k.length + 1 + t.length);
  out.set(k, 0);
  out[k.length] = 0;
  out.set(t, k.length + 1);
  return out;
}

/** iCCP: 配置名 \0 压缩方法(0) zlib(icc) */
function iccpChunk(profileName: string, icc: Uint8Array): Uint8Array {
  const name = Uint8Array.from([...profileName].map((ch) => Math.min(ch.charCodeAt(0), 255)));
  const comp = deflate(icc, { level: 9 });
  const out = new Uint8Array(name.length + 2 + comp.length);
  out.set(name, 0);
  out[name.length] = 0;
  out[name.length + 1] = 0;
  out.set(comp, name.length + 2);
  return chunk('iCCP', out);
}

export type PngModel = 'RGB' | 'Gray';

export function encodePng(
  width: number,
  height: number,
  model: PngModel,
  pixels: Uint8Array | Uint8ClampedArray,
  alpha: Uint8ClampedArray | null,
  icc: Uint8Array,
  iccName: string,
  text: Record<string, string>,
): Uint8Array {
  const channels = model === 'Gray' ? 1 : 3;
  const colorType = model === 'Gray' ? (alpha ? 4 : 0) : alpha ? 6 : 2;
  const outCh = channels + (alpha ? 1 : 0);

  // 加 PNG 滤波器字节（每行 filter=0）
  const raw = new Uint8Array(height * (1 + width * outCh));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * outCh);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * channels;
      const di = rowStart + 1 + x * outCh;
      for (let c = 0; c < channels; c++) raw[di + c] = pixels[si + c];
      if (alpha) raw[di + channels] = alpha[y * width + x];
    }
  }
  const idat = deflate(raw, { level: 6 });

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const parts: Uint8Array[] = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    iccpChunk(iccName.slice(0, 60), icc),
  ];
  for (const [k, v] of Object.entries(text)) parts.push(chunk('tEXt', textChunk(k, v)));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return concatBytes(parts);
}

// ———————————————————— JPEG（APP2 嵌入 ICC） ————————————————————

export async function encodeJpegWithIcc(
  width: number,
  height: number,
  rgb: Uint8Array | Uint8ClampedArray,
  icc: Uint8Array,
  quality = 0.92,
): Promise<Uint8Array> {
  // 浏览器 Canvas 原生编码（像素已是目标 RGB 编码值，不经浏览器色彩转换：
  // canvas 使用逐字节 putImageData 后再 toBlob，不读取显示配置）
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
  if (!blob) throw new Error('浏览器无法编码 JPEG');
  const jpgBytes = new Uint8Array(await blob.arrayBuffer());
  return embedIccInJpeg(jpgBytes, icc);
}

/** 在 SOI 后插入 APP2/ICC_PROFILE 段（每段负载上限 65519-14） */
export function embedIccInJpeg(jpegBytes: Uint8Array, icc: Uint8Array): Uint8Array {
  const ident = Uint8Array.from([...'ICC_PROFILE'].map((c) => c.charCodeAt(0)));
  const MAX_CHUNK = 65519 - 14;
  const segments: Uint8Array[] = [];
  const count = Math.max(1, Math.ceil(icc.length / MAX_CHUNK));
  for (let i = 0; i < count; i++) {
    const piece = icc.subarray(i * MAX_CHUNK, Math.min(icc.length, (i + 1) * MAX_CHUNK));
    const seg = new Uint8Array(2 + 2 + ident.length + 1 + 2 + piece.length);
    seg[0] = 0xff; seg[1] = 0xe2;
    const segLen = ident.length + 1 + 2 + piece.length + 2;
    seg[2] = (segLen >> 8) & 0xff; seg[3] = segLen & 0xff;
    seg.set(ident, 4);
    seg[4 + ident.length] = 0;
    seg[4 + ident.length + 1] = i + 1;
    seg[4 + ident.length + 2] = count;
    seg.set(piece, 4 + ident.length + 3);
    segments.push(seg);
  }
  return concatBytes([jpegBytes.subarray(0, 2), ...segments, jpegBytes.subarray(2)]);
}

// ———————————————————— TIFF（Gray / RGB / CMYK + ICC） ————————————————————

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_UNDEFINED = 7;

interface IfdEntry {
  tag: number;
  type: number;
  values: number[] | Uint8Array;
}

/**
 * 未压缩单条带 TIFF，little-endian。CMYK 用 Photometric=5（Separated），
 * 像素为标准 ICC 编码（0=无墨，255=满墨），并附 tag 34675 的 ICC 配置。
 */
export function encodeTiff(
  width: number,
  height: number,
  model: Exclude<ColorModel, 'CMYK'> | 'CMYK',
  pixels: Uint8Array,
  icc: Uint8Array,
): Uint8Array {
  const channels = model === 'Gray' ? 1 : model === 'CMYK' ? 4 : 3;
  const photometric = model === 'Gray' ? 1 : model === 'CMYK' ? 5 : 2;
  const stripBytes = width * height * channels;

  const entries: IfdEntry[] = [
    { tag: 256, type: TYPE_LONG, values: [width] },
    { tag: 257, type: TYPE_LONG, values: [height] },
    { tag: 258, type: TYPE_SHORT, values: Array(channels).fill(8) },
    { tag: 259, type: TYPE_SHORT, values: [1] }, // 无压缩
    { tag: 262, type: TYPE_SHORT, values: [photometric] },
    { tag: 273, type: TYPE_LONG, values: [0] }, // StripOffsets 占位
    { tag: 277, type: TYPE_SHORT, values: [channels] },
    { tag: 278, type: TYPE_LONG, values: [height] },
    { tag: 279, type: TYPE_LONG, values: [stripBytes] },
    { tag: 284, type: TYPE_SHORT, values: [1] }, // PlanarConfiguration chunky
  ];
  if (model === 'CMYK') {
    entries.push({ tag: 332, type: TYPE_SHORT, values: [1] }); // InkSet=CMYK
  }
  entries.push({ tag: 34675, type: TYPE_UNDEFINED, values: icc });
  entries.sort((a, b) => a.tag - b.tag);

  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let cursor = ifdOffset + ifdSize;
  const extra: { bytes: Uint8Array; align?: number }[] = [];

  const stripOffsetPos = cursor;
  cursor += stripBytes;
  const pixelData = pixels;

  // 序列化每个 entry，超出 4 字节的值放到 IFD 之后
  const entryBytes = entries.map((e, idx) => {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, e.tag, true);
    dv.setUint16(2, e.type, true);
    let count: number;
    if (e.type === TYPE_UNDEFINED && e.values instanceof Uint8Array) {
      count = e.values.length;
    } else {
      count = (e.values as number[]).length;
    }
    dv.setUint32(4, count, true);
    const typeSize = e.type === TYPE_SHORT ? 2 : e.type === TYPE_LONG ? 4 : 1;
    const total = count * typeSize;

    if (e.tag === 273) {
      dv.setUint32(8, stripOffsetPos, true);
    } else if (total <= 4) {
      const arr = e.values instanceof Uint8Array ? e.values : (e.values as number[]);
      for (let i = 0; i < count; i++) {
        if (typeSize === 2) dv.setUint16(8 + i * 2, arr[i], true);
        else if (typeSize === 4) dv.setUint32(8 + i * 4, arr[i], true);
        else buf[8 + i] = arr[i];
      }
    } else {
      const align = typeSize === 2 ? 2 : typeSize === 4 ? 4 : 1;
      if (align > 1 && cursor % align !== 0) cursor += align - (cursor % align);
      const offset = cursor;
      dv.setUint32(8, offset, true);
      const eb = new Uint8Array(total);
      const arr = e.values instanceof Uint8Array ? e.values : (e.values as number[]);
      for (let i = 0; i < count; i++) {
        if (typeSize === 2) new DataView(eb.buffer).setUint16(i * 2, arr[i], true);
        else if (typeSize === 4) new DataView(eb.buffer).setUint32(i * 4, arr[i], true);
        else eb[i] = arr[i];
      }
      extra.push({ bytes: eb, align });
      cursor += total;
    }
    void idx;
    return buf;
  });

  // 组装：header + IFD + 像素（stripOffsetPos 处）+ 外部值
  const total = cursor;
  const out = new Uint8Array(total);
  out.set([0x49, 0x49, 0x2a, 0x00], 0); // II*\0
  new DataView(out.buffer).setUint32(4, ifdOffset, true);
  const dv = new DataView(out.buffer);
  dv.setUint16(ifdOffset, entries.length, true);
  let p = ifdOffset + 2;
  for (const eb of entryBytes) { out.set(eb, p); p += 12; }
  dv.setUint32(p, 0, true); // next IFD = 0

  out.set(pixelData, stripOffsetPos);
  // 外部值需要按偏移放（重建：依据 entryBytes 中记录的 offset）
  for (const e of entries) {
    const count = e.values instanceof Uint8Array ? e.values.length : (e.values as number[]).length;
    const typeSize = e.type === TYPE_SHORT ? 2 : e.type === TYPE_LONG ? 4 : 1;
    if (count * typeSize > 4 && e.tag !== 273) {
      // 从 entryBytes 中取 offset：重新定位
      const idx = entries.indexOf(e);
      const off = new DataView(entryBytes[idx].buffer).getUint32(8, true);
      const arr = e.values instanceof Uint8Array ? e.values : (e.values as number[]);
      for (let i = 0; i < count; i++) {
        if (typeSize === 2) new DataView(out.buffer).setUint16(off + i * 2, arr[i], true);
        else if (typeSize === 4) new DataView(out.buffer).setUint32(off + i * 4, arr[i], true);
        else out[off + i] = arr[i];
      }
    }
  }
  void extra;
  return out;
}

// ———————————————————— 设置记录 ————————————————————

export function buildManifest(opts: {
  sourceFileName: string;
  width: number;
  height: number;
  model: ColorModel;
  hadEmbedded: boolean;
  assumptionReason: string | null;
  source: IccProfile;
  target: IccProfile;
  display: { name: string; description: string };
  intentName: string;
  intentCode: number;
  bpc: boolean;
}): ExportManifest {
  const ref = (p: IccProfile, embedded: boolean, assumed = false, reason: string | null = null): ManifestProfileRef => ({
    name: p.name,
    description: p.summary.description,
    colorSpace: p.summary.colorSpace,
    deviceClass: p.summary.deviceClass,
    iccVersion: p.summary.version,
    sha256: p.sha256,
    embeddedInExport: embedded,
    ...(assumed ? { assumed: true, assumptionReason: reason ?? undefined } : {}),
  });
  return {
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    exportedAt: new Date().toISOString(),
    sourceImage: {
      fileName: opts.sourceFileName,
      width: opts.width,
      height: opts.height,
      encodedColorModel: opts.model,
      hadEmbeddedProfile: opts.hadEmbedded,
      note: '源像素按下方“源配置”解释；若 hadEmbeddedProfile=false，则该配置为人工记录的假设。',
    },
    sourceProfile: ref(opts.source, false, !opts.hadEmbedded, opts.assumptionReason),
    targetProfile: ref(opts.target, true),
    displayProfile: {
      name: opts.display.name,
      description: opts.display.description,
      colorSpace: 'RGB',
      deviceClass: '内置',
      iccVersion: 'lcms 内置',
      sha256: 'lcms-cmsCreate_sRGBProfile',
      embeddedInExport: false,
    },
    transform: {
      renderingIntent: opts.intentName,
      renderingIntentCode: opts.intentCode,
      blackPointCompensation: opts.bpc,
      engine: 'LittleCMS (lcms-wasm, WebAssembly)',
      engineVersion: 'lcms 2.16',
    },
    warning:
      '本记录对应的导出图像已经过一次 ICC 转换，其像素处于“目标配置”定义的颜色空间（且图像内已嵌入该配置）。' +
      '请勿将导出图像重新作为原图、再按原“源配置”转换，否则属于重复转换。再次处理时应以图像内嵌入的目标配置为源。',
  };
}

export function download(name: string, bytes: Uint8Array, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
