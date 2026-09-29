// 色彩相关的共享类型定义

/** LittleCMS 渲染意图 */
export enum Intent {
  Perceptual = 0, // 感知
  RelativeColorimetric = 1, // 相对色度
  Saturation = 2, // 饱和度
  AbsoluteColorimetric = 3, // 绝对色度
}

export const INTENT_LABELS: Record<Intent, string> = {
  [Intent.Perceptual]: '感知 (Perceptual)',
  [Intent.RelativeColorimetric]: '相对色度 (Relative Colorimetric)',
  [Intent.Saturation]: '饱和度 (Saturation)',
  [Intent.AbsoluteColorimetric]: '绝对色度 (Absolute Colorimetric)',
};

/** 解码图像的像素颜色模型（未做任何色彩管理的“编码值”） */
export type ColorModel = 'RGB' | 'CMYK' | 'Gray';

export interface DecodedImage {
  width: number;
  height: number;
  /** 紧凑排列像素数据；RGB=3通道, Gray=1通道, CMYK=4通道；不含 alpha */
  pixels: Uint8Array;
  /** 与像素同尺寸的 alpha 平面，不存在时为 null（即全部不透明） */
  alpha: Uint8ClampedArray | null;
  model: ColorModel;
  /** 每像素通道数（不含 alpha） */
  channels: 1 | 3 | 4;
}

/** 图像内嵌入的 ICC 配置原始字节及来源 */
export interface EmbeddedProfile {
  data: Uint8Array;
  /** JPEG APP2 / PNG iCCP */
  location: 'jpeg-app2' | 'png-iccp';
}

export interface ProfileSummary {
  /** LittleCMS 内部描述（cmsInfoDescription） */
  description: string;
  /** 数据颜色空间，如 RGB / CMYK / GRAY / Lab */
  colorSpace: string;
  /** 配置文件类别: 'input'输入/显示, 'output'输出/印厂, 'link', 'abstract' 等 */
  deviceClass: string;
  /** 配置版本（头部） */
  version: string;
  /** 嵌入配置的默认渲染意图（头部） */
  headerIntent: Intent | null;
  /** 文件字节数 */
  size: number;
}

/** 配置来源：图像嵌入 / 缺省时用户指定 / 内置库 */
export type ProfileOrigin =
  | { kind: 'embedded'; location: 'jpeg-app2' | 'png-iccp' }
  | { kind: 'assumed'; reason: string } // 图像未嵌入配置，用户选择并记录的假设
  | { kind: 'builtin' };

/** 已注册的 ICC 配置（库 / 嵌入 / 用户导入） */
export interface IccProfile {
  /** 应用内稳定 id */
  id: string;
  /** 原始文件名或内置名 */
  name: string;
  data: Uint8Array;
  summary: ProfileSummary;
  origin: ProfileOrigin;
  /** SHA-256 摘要，用于导出记录与去重 */
  sha256: string;
  addedAt: number;
}

/** 一次转换所使用的完整参数（随工程持久化、随导出记录输出） */
export interface ConversionSettings {
  sourceProfileId: string;
  targetProfileId: string;
  /** 模拟用显示器配置，固定 sRGB（本工具不做显示器校准） */
  displayProfileId: string;
  intent: Intent;
  /** 黑点补偿（BPC），仅对感知/相对色度有意义，lcms 按标志处理 */
  blackPointCompensation: boolean;
  /** 色域警告：标出目标色域之外的源像素 */
  gamutWarning: boolean;
}

export interface PixelSample {
  x: number;
  y: number;
  /** 源配置下的编码像素值，键名随颜色模型 */
  source: Record<string, number>;
  /** 转换后（目标配置颜色空间）的像素值，0–255 或 0–100% */
  target: Record<string, number>;
  /** sRGB 显示器模拟值 0–255（实际在屏幕上看到的） */
  display: { R: number; G: number; B: number };
  /** 该点是否超出目标色域 */
  outOfGamut: boolean;
}

/** IndexedDB 持久化的工程记录 */
export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 原图解码参数快照（不含像素，像素另存） */
  image: {
    fileName: string;
    mediaType: string;
    width: number;
    height: number;
    model: ColorModel;
    sizeBytes: number;
    /** 原图是否嵌入配置 */
    hadEmbedded: boolean;
    /** 像素与 alpha 的 Blob 存储 key */
    pixelsKey: string;
  };
  settings: ConversionSettings;
  /** 源配置 id；若为假设来源，保留说明 */
  sourceAssumption: string | null;
}

/** 随导出图像一同输出的设置记录 JSON */
export interface ExportManifest {
  tool: string;
  toolVersion: string;
  exportedAt: string;
  sourceImage: {
    fileName: string;
    width: number;
    height: number;
    encodedColorModel: ColorModel;
    hadEmbeddedProfile: boolean;
    /** 关键防错：该图像的像素已经处于下列源配置定义的颜色空间 */
    note: string;
  };
  sourceProfile: ManifestProfileRef;
  targetProfile: ManifestProfileRef;
  displayProfile: ManifestProfileRef;
  transform: {
    renderingIntent: string;
    renderingIntentCode: number;
    blackPointCompensation: boolean;
    engine: string;
    engineVersion: string;
  };
  /** 防止把导出结果当原图再次转换的醒目提示 */
  warning: string;
}

export interface ManifestProfileRef {
  name: string;
  description: string;
  colorSpace: string;
  deviceClass: string;
  iccVersion: string;
  sha256: string;
  embeddedInExport: boolean;
  /** 图像没有嵌入配置时，记录这是人工假设 */
  assumed?: boolean;
  assumptionReason?: string;
}
