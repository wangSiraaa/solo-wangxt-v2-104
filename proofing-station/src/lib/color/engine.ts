/**
 * 色彩管线：所有像素转换的唯一入口，全部在 Worker 内通过 LittleCMS 完成。
 *
 * 三条独立管线（严格区分，防止把转换结果当原图再次转换）：
 *
 *  A. 原图显示（sourceView）：源配置 ──► sRGB 显示器
 *     “这张图按它自己的来源定义，在屏幕上应该长什么样”。
 *
 *  B. 软打样（softProof）：源配置 ──► 印厂配置(PCS) ──► sRGB 显示器
 *     用 cmsCreateProofingTransform + cmsFLAGS_SOFTPROOFING，
 *     “在屏幕上模拟印厂配置 + 纸张/油墨的结果”。可叠加 GAMUTCHECK 色域警告。
 *
 *  C. 实际转换（converted）：源配置 ──► 印厂配置
 *     输出目标颜色空间的编码像素（如 CMYK），用于导出并嵌入目标配置。
 *     该结果不再回送任何转换管线。
 *
 * 对源/目标都是 RGB 的情形，C 输出 RGB 像素；目标为 CMYK 时输出 4 通道。
 */
import {
  getLcms, openProfile, createSRGBProfile, LcmsTransform,
  TYPE_RGB_8, TYPE_RGBA_8, TYPE_CMYK_8, TYPE_GRAY_8,
  FLAGS, type LcmsProfile, type LcmsModule,
} from './lcms';
import type { ColorModel, Intent } from './types';

export interface EngineParams {
  sourceProfile: Uint8Array;
  targetProfile: Uint8Array;
  intent: Intent;
  blackPointCompensation: boolean;
  gamutWarning: boolean;
}

export interface PipelineResult {
  width: number;
  height: number;
  model: ColorModel;
  /** A 管线：源→sRGB，RGBA，用于左屏 */
  sourceView: Uint8ClampedArray;
  /** B 管线：软打样→sRGB，RGBA，用于右屏 */
  softProof: Uint8ClampedArray;
  /** B 管线色域蒙版：每个像素 1 字节，0/1（目标色域之外为 1） */
  outOfGamutMask: Uint8Array;
  /** C 管线：源→目标配置的编码像素 */
  converted: {
    model: ColorModel;
    channels: 1 | 3 | 4;
    pixels: Uint8Array;
  };
  /** 转换管线是否在像素级实际改变了数值（供 UI 提示“同配置无变化”） */
  convertedEqualsSource: boolean;
}

function formatFor(model: ColorModel, withAlpha: boolean): number {
  switch (model) {
    case 'RGB': return withAlpha ? TYPE_RGBA_8 : TYPE_RGB_8;
    case 'CMYK': return TYPE_CMYK_8; // alpha 不经过 LittleCMS，单独合成
    case 'Gray': return TYPE_GRAY_8;
  }
}

function channelsOf(model: ColorModel): 1 | 3 | 4 {
  return model === 'Gray' ? 1 : model === 'CMYK' ? 4 : 3;
}

function modelFromColorSpace(cs: string): ColorModel {
  if (cs === 'CMYK') return 'CMYK';
  if (cs === 'GRAY') return 'Gray';
  return 'RGB';
}

/** 判断两份 ICC 是否实质相同（比较字节） */
export function profilesSame(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class ColorEngine {
  private lcms: LcmsModule;
  private srgb: LcmsProfile;
  private source: LcmsProfile;
  private target: LcmsProfile;
  readonly targetModel: ColorModel;
  readonly params: EngineParams;
  readonly sameProfile: boolean;

  private constructor(lcms: LcmsModule, params: EngineParams) {
    this.lcms = lcms;
    this.params = params;
    this.srgb = createSRGBProfile(lcms);
    this.source = openProfile(lcms, params.sourceProfile);
    this.target = openProfile(lcms, params.targetProfile);
    this.sameProfile = profilesSame(params.sourceProfile, params.targetProfile);
    this.targetModel = modelFromColorSpace(lcms.cmsGetColorSpaceASCII(this.target.handle) ?? 'RGB');
  }

  static async create(params: EngineParams): Promise<ColorEngine> {
    const lcms = await getLcms();
    return new ColorEngine(lcms, params);
  }

  /** 注入已实例化的 lcms（测试/Node 验证用，业务代码走 create） */
  static createWith(lcms: LcmsModule, params: EngineParams): ColorEngine {
    return new ColorEngine(lcms, params);
  }

  dispose(): void {
    this.lcms.cmsCloseProfile(this.source.handle);
    this.lcms.cmsCloseProfile(this.target.handle);
    this.lcms.cmsCloseProfile(this.srgb.handle);
  }

  /**
   * 执行全部管线。
   * @param pixels 解码得到的源编码像素（紧凑，无 alpha）
   * @param model 源颜色模型
   * @param alpha 可选 alpha 平面
   */
  run(
    pixels: Uint8Array,
    model: ColorModel,
    width: number,
    height: number,
    alpha: Uint8ClampedArray | null,
  ): PipelineResult {
    const n = width * height;
    const intent = this.params.intent;
    const bpc = this.params.blackPointCompensation ? FLAGS.blackPointCompensation : 0;
    const srcCh = channelsOf(model);
    const srcFmt = formatFor(model, false);

    // —— A. 源 → sRGB 显示器 ——
    const viewATransform = new LcmsTransform(this.lcms, this.source, this.srgb, {
      inputFormat: srcFmt,
      outputFormat: TYPE_RGB_8,
      intent,
      flags: bpc,
    });
    let viewA: Uint8Array;
    try {
      viewA = viewATransform.apply(pixels, n, srcCh, 3);
    } finally {
      viewATransform.dispose();
    }

    // —— B. 软打样：源 → (打样=目标) → sRGB ——
    // lcms 的打样模型：input→output 是屏幕方向，proof profile 是被模拟的设备。
    let softProof: Uint8Array;
    let gamutMask: Uint8Array;
    if (this.sameProfile) {
      // 源目标同配置：打样结果等于源显示，全部在色域内
      softProof = viewA;
      gamutMask = new Uint8Array(n);
    } else {
      const proofTransform = new LcmsTransform(this.lcms, this.source, this.srgb, {
        inputFormat: srcFmt,
        outputFormat: TYPE_RGB_8,
        intent,
        flags: bpc | FLAGS.softProofing,
        proof: { profile: this.target, intent },
      });
      try {
        softProof = proofTransform.apply(pixels, n, srcCh, 3);
      } finally {
        proofTransform.dispose();
      }

      // 色域蒙版：再跑一次 GAMUTCHECK——超色域像素会被整体替换为报警色。
      // wasm 未导出 cmsSetAlarmCodes，无法自定义报警色；故不依赖具体颜色，
      // 而是判定“GAMUTCHECK 输出与正常软打样输出不同”的像素（报警替换会改变三通道）。
      if (this.params.gamutWarning) {
        const gc = new LcmsTransform(this.lcms, this.source, this.srgb, {
          inputFormat: srcFmt,
          outputFormat: TYPE_RGB_8,
          intent,
          flags: bpc | FLAGS.softProofing | FLAGS.gamutCheck,
          proof: { profile: this.target, intent },
        });
        let alarm: Uint8Array;
        try {
          alarm = gc.apply(pixels, n, srcCh, 3);
        } finally {
          gc.dispose();
        }
        gamutMask = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const j = i * 3;
          // 报警色为常量、与软打样结果存在差异；容差 2 防止 8bit 抖动误判
          const d = Math.abs(alarm[j] - softProof[j])
            + Math.abs(alarm[j + 1] - softProof[j + 1])
            + Math.abs(alarm[j + 2] - softProof[j + 2]);
          if (d > 24) gamutMask[i] = 1;
        }
      } else {
        gamutMask = new Uint8Array(n);
      }
    }

    const sourceView = toRgba(viewA, alpha);
    const softProofRgba = toRgba(softProof, alpha);

    // —— C. 源 → 目标配置（导出用编码像素）——
    const outModel = this.targetModel;
    const outCh = channelsOf(outModel);
    let convertedPixels: Uint8Array;
    if (this.sameProfile && outModel === model) {
      convertedPixels = pixels.slice();
    } else {
      const conv = new LcmsTransform(this.lcms, this.source, this.target, {
        inputFormat: srcFmt,
        outputFormat: formatFor(outModel, false),
        intent,
        flags: bpc,
      });
      try {
        convertedPixels = conv.apply(pixels, n, srcCh, outCh);
      } finally {
        conv.dispose();
      }
    }

    const convertedEqualsSource =
      outModel === model && bytesEqual(convertedPixels, pixels);

    return {
      width, height, model,
      sourceView,
      softProof: softProofRgba,
      outOfGamutMask: gamutMask,
      converted: { model: outModel, channels: outCh, pixels: convertedPixels },
      convertedEqualsSource,
    };
  }

  /** 取样在 UI 层直接索引输出数组完成（见 session.updateSample） */
}

function toRgba(rgb: Uint8Array, alpha: Uint8ClampedArray | null): Uint8ClampedArray {
  const n = rgb.length / 3;
  const out = new Uint8ClampedArray(n * 4);
  if (alpha) {
    for (let i = 0; i < n; i++) {
      out[i * 4] = rgb[i * 3];
      out[i * 4 + 1] = rgb[i * 3 + 1];
      out[i * 4 + 2] = rgb[i * 3 + 2];
      out[i * 4 + 3] = alpha[i];
    }
  } else {
    for (let i = 0; i < n; i++) {
      out[i * 4] = rgb[i * 3];
      out[i * 4 + 1] = rgb[i * 3 + 1];
      out[i * 4 + 2] = rgb[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
