/**
 * 纯 JS 图像解码：绕过浏览器 <img>/createImageBitmap 的隐式色彩管理。
 *
 * 关键原因：浏览器把 JPEG/PNG 交给其内置图像管线解码时，会依据嵌入配置
 * 直接输出 sRGB 像素；对 CMYK JPEG 还会自行做 CMYK→RGB。那样我们拿到的
 * 就不再是“配置定义的编码值”，无法再用 LittleCMS 做正确的 ICC 转换。
 *
 * - JPEG：vendored jpeg-js（见 jpeg-decoder.js，Apache-2.0），使用其新增的
 *   rawChannels 选项取得未转换的通道；Adobe CMYK JPEG 的 YCCK 解码与
 *   反转由该库完成，输出标准油墨量 0=无墨..255=满墨（LittleCMS 约定）。
 * - PNG：UPNG.toRGBA8 得到 RGBA，再按 colortype 区分 Gray/RGB 与 alpha。
 */
import { decode as jpegDecode } from './jpeg-decoder.js';
import UPNG from 'upng-js';
import type { ColorModel, DecodedImage } from '../color/types';

export interface RawFile {
  bytes: Uint8Array;
  mediaType: string;
  fileName: string;
}

function isJpeg(b: Uint8Array): boolean {
  return b[0] === 0xff && b[1] === 0xd8;
}
function isPng(b: Uint8Array): boolean {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

export function detectFormat(b: Uint8Array): 'jpeg' | 'png' | null {
  if (isJpeg(b)) return 'jpeg';
  if (isPng(b)) return 'png';
  return null;
}

/**
 * 读取 PNG 头部 colortype（IHDR 第 9 字节）：
 * 0 Gray, 2 RGB, 3 Palette, 4 Gray+Alpha, 6 RGBA
 */
function pngColorType(b: Uint8Array): number {
  return b[25];
}

export function decodeImage(file: RawFile): DecodedImage & { format: 'jpeg' | 'png' } {
  const fmt = detectFormat(file.bytes) ?? (file.mediaType.includes('jpeg') ? 'jpeg' : file.mediaType.includes('png') ? 'png' : null);
  if (fmt === 'jpeg') return decodeJpeg(file.bytes);
  if (fmt === 'png') return decodePng(file.bytes);
  throw new Error('目前仅支持 JPEG 与 PNG（像素在本地解码，不上传）');
}

function decodeJpeg(bytes: Uint8Array): DecodedImage & { format: 'jpeg' } {
  // rawChannels：取得未经 CMYK→RGB / Gray→RGB 转换的编码分量；
  // maxMemoryUsageInMB 给一个足够大的上限（库默认仅 512MB）
  const dec = jpegDecode(bytes, { maxMemoryUsageInMB: 4096, useTArray: true, rawChannels: true }) as {
    width: number; height: number; components: number; data: Uint8Array;
  };
  const width = dec.width;
  const height = dec.height;
  const data: Uint8Array = dec.data;
  const components = dec.components;

  if (components === 4) {
    // Adobe CMYK：getData 已做 YCCK→CMYK 与反转，输出标准油墨量 0=无墨..255=满墨
    const pixels = new Uint8Array(width * height * 4);
    pixels.set(data.subarray(0, pixels.length));
    return { width, height, pixels, alpha: null, model: 'CMYK', channels: 4, format: 'jpeg' };
  }
  if (components === 1) {
    const pixels = new Uint8Array(width * height);
    pixels.set(data.subarray(0, pixels.length));
    return { width, height, pixels, alpha: null, model: 'Gray', channels: 1, format: 'jpeg' };
  }
  const pixels = new Uint8Array(width * height * 3);
  pixels.set(data.subarray(0, pixels.length));
  return { width, height, pixels, alpha: null, model: 'RGB', channels: 3, format: 'jpeg' };
}

function decodePng(bytes: Uint8Array): DecodedImage & { format: 'png' } {
  const ct = pngColorType(bytes);
  const img = UPNG.decode(bytes);
  const width = img.width;
  const height = img.height;
  // toRGBA8 返回每帧一个 ArrayBuffer；静态图只有一帧
  const frames = UPNG.toRGBA8(img);
  const frame0: ArrayBuffer = Array.isArray(frames) ? frames[0] : frames;
  const rgba = new Uint8Array(frame0);

  const hasAlpha = ct === 4 || ct === 6 || ct === 3; // 调色板也可能有 tRNS
  let realAlpha: Uint8ClampedArray | null = null;
  if (hasAlpha) {
    let transparent = false;
    const a = new Uint8ClampedArray(width * height);
    for (let i = 0; i < width * height; i++) {
      a[i] = rgba[i * 4 + 3];
      if (a[i] !== 255) transparent = true;
    }
    if (transparent) realAlpha = a;
  }

  if (ct === 0 || ct === 4) {
    // 灰度（+α）
    const pixels = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) pixels[i] = rgba[i * 4];
    return { width, height, pixels, alpha: realAlpha, model: 'Gray', channels: 1, format: 'png' };
  }

  // RGB/RGBA/调色板均按 RGB 编码值处理
  const model: ColorModel = 'RGB';
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = rgba[i * 4];
    pixels[i * 3 + 1] = rgba[i * 4 + 1];
    pixels[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { width, height, pixels, alpha: realAlpha, model, channels: 3, format: 'png' };
}
