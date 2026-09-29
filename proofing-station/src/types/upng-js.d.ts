declare module 'upng-js' {
  export interface UpngImage {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    frames: unknown[];
    tabs: Record<string, unknown>;
    data: ArrayBuffer;
  }
  export function decode(buffer: ArrayBuffer | Uint8Array): UpngImage;
  /** 返回 RGBA8 的 ArrayBuffer（尺寸取自传入的 decode 结果） */
  /** 返回每帧一个 RGBA8 ArrayBuffer（静态图取 [0]） */
  export function toRGBA8(img: UpngImage): ArrayBuffer[];
  export function encode(
    imgs: ArrayBuffer[],
    w: number,
    h: number,
    cnum: number,
    dels?: number[],
    tabs?: Record<string, unknown>,
  ): ArrayBuffer;
  const UPNG: {
    decode: typeof decode;
    toRGBA8: typeof toRGBA8;
    encode: typeof encode;
  };
  export default UPNG;
}
