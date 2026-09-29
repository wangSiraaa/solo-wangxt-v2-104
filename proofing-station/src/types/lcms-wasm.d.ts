/** lcms-wasm 未附带类型声明，这里描述本应用实际用到的接口 */
declare module 'lcms-wasm' {
  export interface LcmsInstance {
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAPU8: Uint8Array;
    _cmsDoTransform(transform: number, input: number, output: number, size: number): void;
    cmsOpenProfileFromMem(data: Uint8Array, len: number): number;
    cmsCloseProfile(handle: number): number;
    cmsCreate_sRGBProfile(): number;
    cmsCreateTransform(
      input: number, inputFormat: number,
      output: number, outputFormat: number,
      intent: number, flags: number,
    ): number;
    cmsCreateProofingTransform(
      input: number, inputFormat: number,
      output: number, outputFormat: number,
      proof: number, intent: number, proofIntent: number, flags: number,
    ): number;
    cmsDeleteTransform(transform: number): void;
    cmsGetProfileInfoASCII(
      handle: number, info: number, language: string, country: string,
    ): string;
    cmsGetColorSpaceASCII(handle: number): string | null;
    cmsGetHeaderRenderingIntent(handle: number): number;
    getExceptionMessage?(): string;
  }

  export function instantiate(opts?: {
    locateFile?: (name: string) => string;
  }): Promise<LcmsInstance>;

  export const LCMS_VERSION: number;
  export const cmsInfoDescription: number;
  export const cmsInfoManufacturer: number;
  export const cmsInfoModel: number;
  export const cmsInfoCopyright: number;

  export const INTENT_PERCEPTUAL: number;
  export const INTENT_RELATIVE_COLORIMETRIC: number;
  export const INTENT_SATURATION: number;
  export const INTENT_ABSOLUTE_COLORIMETRIC: number;

  export const cmsFLAGS_NOCACHE: number;
  export const cmsFLAGS_NOOPTIMIZE: number;
  export const cmsFLAGS_NULLTRANSFORM: number;
  export const cmsFLAGS_GAMUTCHECK: number;
  export const cmsFLAGS_SOFTPROOFING: number;
  export const cmsFLAGS_BLACKPOINTCOMPENSATION: number;
  export const cmsFLAGS_COPY_ALPHA: number;

  export const TYPE_RGB_8: number;
  export const TYPE_RGBA_8: number;
  export const TYPE_BGR_8: number;
  export const TYPE_CMYK_8: number;
  export const TYPE_CMYKA_8: number;
  export const TYPE_GRAY_8: number;
  export const TYPE_GRAYA_8: number;
  export const TYPE_XYZ_16: number;
  export const TYPE_Lab_8: number;
  export const TYPE_Lab_DBL: number;
  export const TYPE_RGB_DBL: number;
  export const TYPE_CMYK_DBL: number;

  export const cmsSigRgbData: number;
  export const cmsSigCmykData: number;
  export const cmsSigGrayData: number;
}
