/**
 * LittleCMS (lcms 2.16) WebAssembly 封装。
 *
 * 不使用 lcms-wasm 自带的 cmsDoTransform：其 JS 封装在计算输出通道数时
 * 误用了输入格式的 EXTRA 字段（lib/api.js outputChannels 一行），
 * CMYK→RGBA 等转换会越界拷贝。这里直接调用 Emscripten 导出的
 * _malloc/_free/_cmsDoTransform，并按固定行块处理，控制 WASM 堆占用。
 */
import { instantiate } from 'lcms-wasm';
import wasmUrl from 'lcms-wasm/dist/lcms.wasm?url';
import {
  TYPE_RGB_8,
  TYPE_RGBA_8,
  TYPE_CMYK_8,
  TYPE_GRAY_8,
  INTENT_PERCEPTUAL,
  INTENT_RELATIVE_COLORIMETRIC,
  INTENT_SATURATION,
  INTENT_ABSOLUTE_COLORIMETRIC,
  cmsFLAGS_BLACKPOINTCOMPENSATION,
  cmsFLAGS_SOFTPROOFING,
  cmsFLAGS_GAMUTCHECK,
  cmsFLAGS_COPY_ALPHA,
  cmsInfoDescription,
} from 'lcms-wasm';

export {
  TYPE_RGB_8,
  TYPE_RGBA_8,
  TYPE_CMYK_8,
  TYPE_GRAY_8,
  cmsFLAGS_COPY_ALPHA,
};

export const FLAGS = {
  blackPointCompensation: cmsFLAGS_BLACKPOINTCOMPENSATION,
  softProofing: cmsFLAGS_SOFTPROOFING,
  gamutCheck: cmsFLAGS_GAMUTCHECK,
};

export const LCMS_INTENTS = {
  perceptual: INTENT_PERCEPTUAL,
  relativeColorimetric: INTENT_RELATIVE_COLORIMETRIC,
  saturation: INTENT_SATURATION,
  absoluteColorimetric: INTENT_ABSOLUTE_COLORIMETRIC,
} as const;

export interface LcmsProfile {
  handle: number;
}

export interface LcmsModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  cmsOpenProfileFromMem(data: Uint8Array, len: number): number;
  cmsCloseProfile(h: number): number;
  cmsCreate_sRGBProfile(): number;
  cmsCreateTransform(
    inProf: number, inFmt: number, outProf: number, outFmt: number,
    intent: number, flags: number,
  ): number;
  cmsCreateProofingTransform(
    inProf: number, inFmt: number, outProf: number, outFmt: number,
    proofProf: number, intent: number, proofIntent: number, flags: number,
  ): number;
  cmsDeleteTransform(t: number): void;
  cmsGetProfileInfoASCII(h: number, info: number, lang: string, country: string): string;
  cmsGetColorSpaceASCII(h: number): string | null;
  cmsGetHeaderRenderingIntent(h: number): number;
  getExceptionMessage?(): string;
}

let modulePromise: Promise<LcmsModule> | null = null;

export function getLcms(): Promise<LcmsModule> {
  if (!modulePromise) {
    modulePromise = instantiate({
      locateFile: (name: string) => (name.endsWith('.wasm') ? wasmUrl : name),
    }) as Promise<LcmsModule>;
  }
  return modulePromise;
}

export function openProfile(lcms: LcmsModule, data: Uint8Array): LcmsProfile {
  const handle = lcms.cmsOpenProfileFromMem(data, data.length);
  if (!handle) {
    throw new Error('LittleCMS 无法打开该 ICC 配置（文件可能损坏或版本不支持）');
  }
  return { handle };
}

export function createSRGBProfile(lcms: LcmsModule): LcmsProfile {
  const handle = lcms.cmsCreate_sRGBProfile();
  if (!handle) throw new Error('无法创建内置 sRGB 配置');
  return { handle };
}

/** 读取配置头部描述、颜色空间与设备类别（设备类别直接解析头部字节 12..16） */
export function describeProfile(
  lcms: LcmsModule,
  data: Uint8Array,
): { description: string; colorSpace: string; deviceClass: string; version: string; headerIntent: number | null } {
  const p = openProfile(lcms, data);
  let description = '';
  try {
    description = lcms.cmsGetProfileInfoASCII(p.handle, cmsInfoDescription, 'en', 'US').replace(/\0+$/, '').trim();
  } catch {
    description = '';
  }
  if (!description) {
    try {
      description = lcms.cmsGetProfileInfoASCII(p.handle, cmsInfoDescription, 'en', '').replace(/\0+$/, '').trim();
    } catch {
      description = '(未命名配置)';
    }
  }
  const colorSpace = lcms.cmsGetColorSpaceASCII(p.handle) ?? '未知';
  let headerIntent: number | null = null;
  try {
    headerIntent = lcms.cmsGetHeaderRenderingIntent(p.handle);
  } catch {
    headerIntent = null;
  }
  lcms.cmsCloseProfile(p.handle);

  const deviceClassSig = String.fromCharCode(data[12], data[13], data[14], data[15]);
  const deviceClass = {
    scnr: '输入/扫描仪 (scnr)',
    mntr: '显示器 (mntr)',
    prtr: '输出/印厂 (prtr)',
    link: '设备链接 (link)',
    spac: '色彩空间 (spac)',
    abst: '抽象 (abst)',
    nmcl: '命名色 (nmcl)',
  }[deviceClassSig] ?? `其他 (${deviceClassSig})`;
  const major = data[8];
  const minor = (data[9] >> 4) & 0x0f;
  const bugfix = data[9] & 0x0f;
  const version = `${major}.${minor}.${bugfix}`;
  return { description, colorSpace, deviceClass, version, headerIntent };
}

export interface TransformOptions {
  inputFormat: number;
  outputFormat: number;
  intent: number;
  flags: number;
  /** 软打样时：显示器配置→输出配置的打样方向 */
  proof?: { profile: LcmsProfile; intent: number };
}

export class LcmsTransform {
  private t: number;
  constructor(
    private lcms: LcmsModule,
    private input: LcmsProfile,
    private output: LcmsProfile,
    private opts: TransformOptions,
  ) {
    this.t = opts.proof
      ? lcms.cmsCreateProofingTransform(
          input.handle, opts.inputFormat,
          output.handle, opts.outputFormat,
          opts.proof.profile.handle,
          opts.intent, opts.proof.intent, opts.flags,
        )
      : lcms.cmsCreateTransform(
          input.handle, opts.inputFormat,
          output.handle, opts.outputFormat,
          opts.intent, opts.flags,
        );
    if (!this.t) {
      throw new Error(`LittleCMS 无法创建转换（${lcms.getExceptionMessage?.() ?? '配置组合不受支持'}）`);
    }
  }

  /**
   * 对一批像素执行转换。
   * @param inData 紧凑像素（通道数 = 输入格式 channels[+extra]）
   * @param pixelCount 像素数
   * @param inChannels / outChannels 每像素字节分量数（含 alpha extra）
   */
  apply(inData: Uint8Array, pixelCount: number, inChannels: number, outChannels: number, chunk = 1 << 16): Uint8Array {
    const lcms = this.lcms;
    const out = new Uint8Array(pixelCount * outChannels);
    const inPtr = lcms._malloc(chunk * inChannels);
    const outPtr = lcms._malloc(chunk * outChannels);
    try {
      let done = 0;
      while (done < pixelCount) {
        const n = Math.min(chunk, pixelCount - done);
        const inOff = done * inChannels;
        lcms.HEAPU8.set(inData.subarray(inOff, inOff + n * inChannels), inPtr);
        // 直接调用底层 cmsDoTransform(handle, inBuf, outBuf, size)
        const mod = lcms as unknown as { _cmsDoTransform(t: number, i: number, o: number, n: number): void };
        mod._cmsDoTransform(this.t, inPtr, outPtr, n);
        out.set(lcms.HEAPU8.subarray(outPtr, outPtr + n * outChannels), done * outChannels);
        done += n;
      }
    } finally {
      lcms._free(inPtr);
      lcms._free(outPtr);
    }
    return out;
  }

  dispose(): void {
    this.lcms.cmsDeleteTransform(this.t);
  }
}
