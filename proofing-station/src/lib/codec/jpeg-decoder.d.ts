/** vendored jpeg-js 解码器的本地类型声明（见 jpeg-decoder.js） */
export interface RawJpegDecodeResult {
  width: number;
  height: number;
  exifBuffer?: Uint8Array;
  components: number;
  data: Uint8Array;
}

export function decode(
  data: Uint8Array,
  opts?: {
    colorTransform?: boolean;
    useTArray?: boolean;
    formatAsRGBA?: boolean;
    tolerantDecoding?: boolean;
    maxResolutionInMP?: number;
    maxMemoryUsageInMB?: number;
    /** 本应用补丁：输出未转换的原始通道（1/3/4） */
    rawChannels?: boolean;
  },
): RawJpegDecodeResult;
