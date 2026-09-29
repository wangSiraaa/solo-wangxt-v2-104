/**
 * 从 JPEG / PNG 字节流中提取嵌入的 ICC 配置。
 * 不依赖浏览器的图像解码（浏览器会在解码阶段做隐式色彩转换，
 * 会破坏 CMYK 等非 sRGB 编码值）。
 */
import { inflate } from 'pako';
import type { EmbeddedProfile } from './types';

const ICC_PROFILE_IDENT = 'ICC_PROFILE'; // 11 字符，后随 seg[11]=NUL 终止符

/**
 * 扫描 JPEG 段，拼接 APP2/ICC_PROFILE 数据块（序号从 1 开始）。
 * 参考 ICC Spec.1, Annex K: APP2 负载 = "ICC_PROFILE\0" + 序号(1B) + 总数(1B) + 数据
 */
export function extractIccFromJpeg(bytes: Uint8Array): EmbeddedProfile | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const chunks: (Uint8Array | null)[] = [];
  let total = 0;
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    // SOS（扫描数据开始）之后是熵编码数据，停止扫描
    if (marker === 0xda) break;
    // 无负载的填充/独立标记
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    const segStart = i + 4;
    const segEnd = i + 2 + segLen;
    if (segEnd > bytes.length) break;

    if (marker === 0xe2) {
      // APP2
      const seg = bytes.subarray(segStart, segEnd);
      if (
        seg.length > 14 &&
        seg[0] === 0x49 && // I
        seg[11] === 0x00 // 标识符后的 NUL
      ) {
        const ident = String.fromCharCode(...seg.subarray(0, 11));
        if (ident === ICC_PROFILE_IDENT) {
          const seqNo = seg[12];
          const seqCount = seg[13];
          if (seqCount > 0 && seqNo >= 1 && seqNo <= 255) {
            chunks[seqNo - 1] = seg.subarray(14);
            total = Math.max(total, seqCount);
          }
        }
      }
    }
    i = segEnd;
  }

  if (total === 0 || chunks.length < total) return null;
  for (let k = 0; k < total; k++) if (!chunks[k]) return null;
  const merged = concat(chunks as Uint8Array[]);
  return merged.length >= 128 ? { data: merged, location: 'jpeg-app2' } : null;
}

/**
 * 解析 PNG 块，提取 iCCP（压缩的 ICC 配置）。
 * iCCP 负载 = 配置名(Latin-1, NUL 结尾) + 压缩方法(1B=0) + zlib 数据
 */
export function extractIccFromPng(bytes: Uint8Array): EmbeddedProfile | null {
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const dataStart = i + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === 'iCCP') {
      const payload = bytes.subarray(dataStart, dataEnd);
      let p = 0;
      while (p < payload.length && payload[p] !== 0x00) p++;
      if (p >= payload.length) return null;
      const compressionMethod = payload[p + 1];
      if (compressionMethod !== 0) return null;
      const compressed = payload.subarray(p + 2);
      try {
        const data = inflate(compressed);
        return data.length >= 128 ? { data, location: 'png-iccp' } : null;
      } catch {
        return null;
      }
    }
    if (type === 'IEND') break;
    i = dataEnd + 4; // 跳过 CRC
  }
  return null;
}

export function extractEmbeddedIcc(bytes: Uint8Array): EmbeddedProfile | null {
  return extractIccFromJpeg(bytes) ?? extractIccFromPng(bytes);
}

/** 判断 PNG 是否带 sRGB 块（提示其标称 sRGB，但仍需用户确认来源假设） */
export function pngHasSrgbChunk(bytes: Uint8Array): boolean {
  if (extractIccFromPng(bytes)) return false;
  return findPngChunk(bytes, 'sRGB') !== null;
}

function findPngChunk(bytes: Uint8Array, wanted: string): Uint8Array | null {
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const start = i + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return null;
    if (type === wanted) return bytes.subarray(start, end);
    if (type === 'IEND') return null;
    i = end + 4;
  }
  return null;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const totalLen = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
