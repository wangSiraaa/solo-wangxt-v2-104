/// <reference lib="webworker" />
/**
 * 色彩计算 Worker：LittleCMS WASM 与整图像素转换都在此运行，
 * 不阻塞 UI。配置字节通过 transfer 发送，转换结果（多份大数组）
 * 通过 Transferable 零拷贝传回。
 */
import { getLcms, describeProfile, type LcmsModule } from '../lib/color/lcms';
import { ColorEngine } from '../lib/color/engine';
import type { ColorModel, ConversionSettings, ProfileSummary } from '../lib/color/types';
import { Intent } from '../lib/color/types';

export interface WorkerRequestProfiles {
  type: 'describe';
  id: number;
  profiles: { key: string; data: Uint8Array }[];
}
export interface WorkerRequestConvert {
  type: 'convert';
  id: number;
  pixels: Uint8Array;
  model: ColorModel;
  alpha: Uint8ClampedArray | null;
  width: number;
  height: number;
  /** 当前 Worker 已缓存的配置无需重发；首次必须全部发送 */
  source: { key: string; data?: Uint8Array };
  target: { key: string; data?: Uint8Array };
  settings: Omit<ConversionSettings, 'sourceProfileId' | 'targetProfileId' | 'displayProfileId'>;
}

export type WorkerRequest = WorkerRequestProfiles | WorkerRequestConvert;

const profileCache = new Map<string, Uint8Array>();
let lcmsPromise: Promise<LcmsModule> | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (!lcmsPromise) lcmsPromise = getLcms();
    const lcms = await lcmsPromise;

    if (msg.type === 'describe') {
      const results: Record<string, ProfileSummary> = {};
      for (const { key, data } of msg.profiles) {
        profileCache.set(key, data);
        const d = describeProfile(lcms, data);
        results[key] = {
          description: d.description,
          colorSpace: d.colorSpace,
          deviceClass: d.deviceClass,
          version: d.version,
          headerIntent: d.headerIntent as Intent | null,
          size: data.length,
        };
      }
      ctx.postMessage({ type: 'described', id: msg.id, results });
      return;
    }

    if (msg.type === 'convert') {
      if (msg.source.data) profileCache.set(msg.source.key, msg.source.data);
      if (msg.target.data) profileCache.set(msg.target.key, msg.target.data);
      const src = profileCache.get(msg.source.key);
      const tgt = profileCache.get(msg.target.key);
      if (!src || !tgt) throw new Error('Worker 缺少源/目标配置字节');

      const engine = await ColorEngine.create({
        sourceProfile: src,
        targetProfile: tgt,
        intent: msg.settings.intent,
        blackPointCompensation: msg.settings.blackPointCompensation,
        gamutWarning: msg.settings.gamutWarning,
      });
      let result;
      try {
        result = engine.run(msg.pixels, msg.model, msg.width, msg.height, msg.alpha);
      } finally {
        engine.dispose();
      }
      const transfers: Transferable[] = [
        result.sourceView.buffer as ArrayBuffer,
        result.softProof.buffer as ArrayBuffer,
        result.outOfGamutMask.buffer as ArrayBuffer,
        result.converted.pixels.buffer as ArrayBuffer,
      ];
      ctx.postMessage(
        {
          type: 'converted',
          id: msg.id,
          targetModel: result.converted.model,
          targetChannels: result.converted.channels,
          sourceView: result.sourceView,
          softProof: result.softProof,
          outOfGamutMask: result.outOfGamutMask,
          convertedPixels: result.converted.pixels,
          convertedEqualsSource: result.convertedEqualsSource,
        },
        transfers,
      );
      return;
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
