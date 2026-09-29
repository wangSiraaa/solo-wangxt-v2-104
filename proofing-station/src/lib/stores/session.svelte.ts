/**
 * 全局会话状态（Svelte 5 runes）。
 * 持有：图像原始编码像素、配置库、当前设置、三条管线的预览结果、取样点。
 * 所有计算经 color.worker 完成；像素永远不出本机。
 */
import { decodeImage } from '../codec/decode';
import { extractEmbeddedIcc, pngHasSrgbChunk, sha256Hex } from '../color/iccExtract';
import {
  BUILTIN_PROFILES, DISPLAY_PROFILE_ID, fetchBuiltinProfile, findBuiltin,
} from '../color/builtinProfiles';
import {
  putProfile, getAllProfiles, getProfile, putProject, getAllProjects,
  putBlob, getBlob, deleteProject, deleteBlob,
} from './db';
import type {
  ColorModel, ConversionSettings, DecodedImage, IccProfile, Intent,
  ProfileSummary, ProjectRecord,
} from '../color/types';
import ColorWorker from '../../workers/color.worker.ts?worker';

type SampleResult = {
  source: Record<string, number>;
  target: Record<string, number>;
  display: { R: number; G: number; B: number };
  sourceDisplay: { R: number; G: number; B: number };
  outOfGamut: boolean;
};

interface ConvertedOutputs {
  targetModel: ColorModel;
  targetChannels: 1 | 3 | 4;
  sourceView: Uint8ClampedArray;
  softProof: Uint8ClampedArray;
  outOfGamutMask: Uint8Array;
  convertedPixels: Uint8Array;
  convertedEqualsSource: boolean;
}

interface LoadedImage {
  fileName: string;
  mediaType: string;
  width: number;
  height: number;
  model: ColorModel;
  pixels: Uint8Array;
  alpha: Uint8ClampedArray | null;
  embedded: { data: Uint8Array; location: 'jpeg-app2' | 'png-iccp' } | null;
  pngAssumedSrgb: boolean;
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

class Session {
  // —— 图像 ——
  image = $state<LoadedImage | null>(null);
  loading = $state(false);
  loadError = $state<string | null>(null);

  // —— 配置库 ——
  profiles = $state<IccProfile[]>([]);
  /** 图像嵌入配置入库后的 id（未嵌入为 null） */
  embeddedProfileId = $state<string | null>(null);
  /** 缺配置时用户记录的来源假设 */
  sourceAssumption = $state<string | null>(null);

  // —— 设置 ——
  settings = $state<ConversionSettings>({
    sourceProfileId: '',
    targetProfileId: 'builtin-pso-coated-v3',
    displayProfileId: DISPLAY_PROFILE_ID,
    intent: 1 satisfies Intent.RelativeColorimetric,
    blackPointCompensation: true,
    gamutWarning: false,
  });

  // —— 管线输出 ——
  outputs = $state<ConvertedOutputs | null>(null);
  processing = $state(false);
  processError = $state<string | null>(null);
  showGamutOverlay = $state(true);

  // —— 取样 ——
  sampleX = $state<number | null>(null);
  sampleY = $state<number | null>(null);
  sample = $state<SampleResult | null>(null);

  // —— 工程 ——
  projects = $state<ProjectRecord[]>([]);
  currentProjectId = $state<string | null>(null);
  busyMessage = $state<string | null>(null);

  private worker: Worker | null = null;
  private reqId = 0;
  private pendingResolve = new Map<number, (m: unknown) => void>();
  private pendingReject = new Map<number, (e: Error) => void>();
  private workerDataKeys = new Set<string>();
  private convertTimer: ReturnType<typeof setTimeout> | null = null;

  // —————————————————— 初始化 ——————————————————

  async init(): Promise<void> {
    await this.ensureBuiltin(DISPLAY_PROFILE_ID);
    await this.ensureBuiltin('builtin-pso-coated-v3');
    this.profiles = await getAllProfiles();
    this.projects = await getAllProjects();
    if (!this.settings.sourceProfileId && this.profiles.some((p) => p.id === DISPLAY_PROFILE_ID)) {
      this.settings.sourceProfileId = DISPLAY_PROFILE_ID;
    }
    // 其余内置配置后台加载，使源/目标下拉列表完整（文件均不大；
    // 仅在需要时 fetch，之后存 IndexedDB 复用）
    void this.loadAllBuiltins();
  }

  private async loadAllBuiltins(): Promise<void> {
    const missing = BUILTIN_PROFILES
      .filter((b) => !this.profiles.some((p) => p.id === b.id))
      .map((b) => b.id);
    await Promise.allSettled(missing.map((id) => this.ensureBuiltin(id)));
  }

  private workerInstance(): Worker {
    if (!this.worker) {
      const w = new ColorWorker();
      w.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { id: number; type: string; message?: string };
        const resolve = this.pendingResolve.get(m.id);
        const reject = this.pendingReject.get(m.id);
        this.pendingResolve.delete(m.id);
        this.pendingReject.delete(m.id);
        if (m.type === 'error') reject?.(new Error(m.message ?? 'Worker 错误'));
        else resolve?.(m);
      };
      w.onerror = (e) => {
        for (const [id, reject] of this.pendingReject) reject(new Error(e.message));
        this.pendingResolve.clear();
        this.pendingReject.clear();
      };
      this.worker = w;
    }
    return this.worker;
  }

  private callWorker(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
    const id = ++this.reqId;
    const w = this.workerInstance();
    return new Promise((resolve, reject) => {
      this.pendingResolve.set(id, resolve);
      this.pendingReject.set(id, reject);
      w.postMessage({ ...message, id }, transfer);
    });
  }

  /**
   * 让 Worker 描述一份配置（同时缓存其字节供转换使用）。
   * 注意：必须发送副本——一旦把 data.buffer 列入 transfer，主线程这份
   * 配置的 ArrayBuffer 会被分离，后续再写入 IndexedDB 将抛
   * "An ArrayBuffer is detached"。
   */
  private async describeInWorker(key: string, data: Uint8Array): Promise<ProfileSummary> {
    const copy = data.slice();
    const res = (await this.callWorker(
      { type: 'describe', profiles: [{ key, data: copy }] },
      [copy.buffer],
    )) as { results: Record<string, ProfileSummary> };
    this.workerDataKeys.add(key);
    return res.results[key];
  }

  // —————————————————— 配置管理 ——————————————————

  async ensureBuiltin(id: string): Promise<IccProfile> {
    const existing = this.profiles.find((p) => p.id === id) ?? (await getProfile(id));
    if (existing) {
      if (!this.profiles.includes(existing)) this.profiles = [...this.profiles, existing];
      return existing;
    }
    const entry = findBuiltin(id);
    if (!entry) throw new Error(`未知内置配置 ${id}`);
    const data = await fetchBuiltinProfile(entry);
    const summary = await this.describeInWorker(id, data);
    const profile: IccProfile = {
      id,
      name: `${entry.label}.icc`,
      data,
      summary,
      origin: { kind: 'builtin' },
      sha256: await sha256Hex(data),
      addedAt: Date.now(),
    };
    await putProfile(profile);
    this.profiles = [...this.profiles, profile];
    return profile;
  }

  /** 用户导入自定义 .icc/.icm */
  async importProfileFile(file: File): Promise<IccProfile> {
    const data = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256Hex(data);
    const dup = this.profiles.find((p) => p.sha256 === sha);
    if (dup) return dup;
    const id = `user-${uid()}`;
    const summary = await this.describeInWorker(id, data);
    const profile: IccProfile = {
      id,
      name: file.name,
      data,
      summary,
      origin: { kind: 'assumed', reason: '用户自行导入的配置' },
      sha256: sha,
      addedAt: Date.now(),
    };
    await putProfile(profile);
    this.profiles = [...this.profiles, profile];
    return profile;
  }

  /** 将嵌入配置登记入库（若与现有 sha 相同则复用） */
  private async registerEmbedded(data: Uint8Array, location: 'jpeg-app2' | 'png-iccp'): Promise<IccProfile> {
    const sha = await sha256Hex(data);
    const existing = this.profiles.find((p) => p.sha256 === sha);
    if (existing) return existing;
    const id = `embedded-${uid()}`;
    const summary = await this.describeInWorker(id, data);
    const profile: IccProfile = {
      id,
      name: `图像嵌入配置 (${summary.description || location}).icc`,
      data,
      summary,
      origin: { kind: 'embedded', location },
      sha256: sha,
      addedAt: Date.now(),
    };
    await putProfile(profile);
    this.profiles = [...this.profiles, profile];
    return profile;
  }

  getProfileById(id: string): IccProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  // —————————————————— 导入图像 ——————————————————

  async importImage(file: File): Promise<void> {
    this.loading = true;
    this.loadError = null;
    this.outputs = null;
    this.sample = null;
    this.sampleX = this.sampleY = null;
    this.sourceAssumption = null;
    this.embeddedProfileId = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const decoded: DecodedImage & { format?: string } = decodeImage({
        bytes, mediaType: file.type || '', fileName: file.name,
      });
      const embedded = extractEmbeddedIcc(bytes);
      const pngAssumedSrgb = !embedded && (decoded as { format?: string }).format === 'png' && pngHasSrgbChunk(bytes);

      const img: LoadedImage = {
        fileName: file.name,
        mediaType: file.type || (decoded.format === 'png' ? 'image/png' : 'image/jpeg'),
        width: decoded.width,
        height: decoded.height,
        model: decoded.model,
        pixels: decoded.pixels,
        alpha: decoded.alpha,
        embedded: embedded ? { data: embedded.data, location: embedded.location } : null,
        pngAssumedSrgb,
      };
      this.image = img;

      if (embedded) {
        // ① 嵌入配置：自动登记并设为源；明确告知来源
        const prof = await this.registerEmbedded(embedded.data, embedded.location);
        this.embeddedProfileId = prof.id;
        this.settings.sourceProfileId = prof.id;
        this.sourceAssumption = null;
      } else {
        // ② 缺少配置：必须由用户选择源配置并记录该假设。
        //    默认勾选 sRGB，但在用户确认前不运行转换。
        await this.ensureBuiltin(DISPLAY_PROFILE_ID);
        this.settings.sourceProfileId = DISPLAY_PROFILE_ID;
        const hint = pngAssumedSrgb
          ? 'PNG 内含 sRGB 块但无 ICC：通常确为 sRGB，仍请确认'
          : `文件未嵌入 ICC 配置（${img.model} 编码值）`;
        this.sourceAssumption = hint;
      }
      this.scheduleConvert();
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      this.image = null;
    } finally {
      this.loading = false;
    }
  }

  /** 缺配置时用户确认/改选源配置，并记录假设说明 */
  async chooseAssumedSource(profileId: string, note: string): Promise<void> {
    await this.ensureBuiltinSafe(profileId);
    this.settings.sourceProfileId = profileId;
    const p = this.getProfileById(profileId);
    this.sourceAssumption =
      `来源假设（非嵌入）：${p?.summary.description ?? note} — ${note || '用户在缺少嵌入配置时指定，结果依赖该假设'}`;
    this.scheduleConvert();
  }

  private async ensureBuiltinSafe(id: string): Promise<void> {
    if (findBuiltin(id) && !this.profiles.some((p) => p.id === id)) await this.ensureBuiltin(id);
  }

  setTarget(id: string): void {
    this.settings.targetProfileId = id;
    this.scheduleConvert();
  }
  setIntent(intent: Intent): void {
    this.settings.intent = intent;
    this.scheduleConvert();
  }
  setBpc(v: boolean): void {
    this.settings.blackPointCompensation = v;
    this.scheduleConvert();
  }
  setGamutWarning(v: boolean): void {
    this.settings.gamutWarning = v;
    this.scheduleConvert();
  }
  async setSourceProfile(id: string): Promise<void> {
    await this.ensureBuiltinSafe(id);
    this.settings.sourceProfileId = id;
    this.scheduleConvert();
  }

  get needsSourceAssumption(): boolean {
    return !!this.image && !this.embeddedProfileId;
  }

  get sourceProfile(): IccProfile | undefined {
    return this.getProfileById(this.settings.sourceProfileId);
  }
  get targetProfile(): IccProfile | undefined {
    return this.getProfileById(this.settings.targetProfileId);
  }

  // —————————————————— 执行转换 ——————————————————

  scheduleConvert(): void {
    if (this.convertTimer) clearTimeout(this.convertTimer);
    this.convertTimer = setTimeout(() => {
      void this.convert();
    }, 60);
  }

  async convert(): Promise<void> {
    if (!this.image) return;
    // 缺嵌入配置且用户尚未明确确认假设时，不执行（避免悄悄按 sRGB 处理）
    if (this.needsSourceAssumption && !this.assumptionConfirmed) return;
    const src = this.getProfileById(this.settings.sourceProfileId);
    const tgt = this.getProfileById(this.settings.targetProfileId);
    if (!src || !tgt) return;

    this.processing = true;
    this.processError = null;
    try {
      // 所有大数组传副本：transfer 会移走 ArrayBuffer，主状态必须保留原图
      const pixelsCopy = this.image.pixels.slice();
      const alphaCopy = this.image.alpha ? this.image.alpha.slice() : null;
      const srcData = this.workerDataKeys.has(src.id) ? undefined : src.data.slice();
      const tgtData = this.workerDataKeys.has(tgt.id) ? undefined : tgt.data.slice();

      const payload = {
        type: 'convert',
        pixels: pixelsCopy,
        model: this.image.model,
        alpha: alphaCopy,
        width: this.image.width,
        height: this.image.height,
        source: { key: src.id, data: srcData },
        target: { key: tgt.id, data: tgtData },
        settings: {
          intent: this.settings.intent,
          blackPointCompensation: this.settings.blackPointCompensation,
          gamutWarning: this.settings.gamutWarning,
        },
      };
      if (!this.workerDataKeys.has(src.id)) this.workerDataKeys.add(src.id);
      if (!this.workerDataKeys.has(tgt.id)) this.workerDataKeys.add(tgt.id);

      const transfer: Transferable[] = [pixelsCopy.buffer as ArrayBuffer];
      if (alphaCopy) transfer.push(alphaCopy.buffer as ArrayBuffer);
      if (srcData) transfer.push(srcData.buffer);
      if (tgtData) transfer.push(tgtData.buffer);

      const res = (await this.callWorker(payload, transfer)) as ConvertedOutputs & { type: string };
      this.outputs = {
        targetModel: res.targetModel,
        targetChannels: res.targetChannels,
        sourceView: res.sourceView,
        softProof: res.softProof,
        outOfGamutMask: res.outOfGamutMask,
        convertedPixels: res.convertedPixels,
        convertedEqualsSource: res.convertedEqualsSource,
      };
      if (this.sampleX !== null && this.sampleY !== null) this.updateSample(this.sampleX, this.sampleY);
    } catch (err) {
      this.processError = err instanceof Error ? err.message : String(err);
    } finally {
      this.processing = false;
    }
  }

  /** 用户在缺配置对话框中确认假设 */
  assumptionConfirmed = $state(false);
  confirmAssumption(profileId: string, note: string): void {
    this.assumptionConfirmed = true;
    void this.chooseAssumedSource(profileId, note);
  }
  resetAssumptionConfirm(): void {
    this.assumptionConfirmed = false;
  }

  // —————————————————— 取样 ——————————————————

  setSample(x: number, y: number): void {
    this.sampleX = x;
    this.sampleY = y;
    if (this.outputs && this.image) this.updateSample(x, y);
  }
  clearSample(): void {
    this.sampleX = this.sampleY = null;
    this.sample = null;
  }
  private updateSample(x: number, y: number): void {
    if (!this.outputs || !this.image) return;
    // 直接在主线程索引（数组已在主线程）
    const i = y * this.image.width + x;
    const source: Record<string, number> = {};
    const target: Record<string, number> = {};
    const { model, pixels } = this.image;
    if (model === 'RGB') {
      source.R = pixels[i * 3]; source.G = pixels[i * 3 + 1]; source.B = pixels[i * 3 + 2];
    } else if (model === 'CMYK') {
      source.C = pixels[i * 4]; source.M = pixels[i * 4 + 1]; source.Y = pixels[i * 4 + 2]; source.K = pixels[i * 4 + 3];
    } else source.K = pixels[i];

    const o = this.outputs;
    if (o.targetModel === 'RGB') {
      target.R = o.convertedPixels[i * 3]; target.G = o.convertedPixels[i * 3 + 1]; target.B = o.convertedPixels[i * 3 + 2];
    } else if (o.targetModel === 'CMYK') {
      target.C = o.convertedPixels[i * 4]; target.M = o.convertedPixels[i * 4 + 1];
      target.Y = o.convertedPixels[i * 4 + 2]; target.K = o.convertedPixels[i * 4 + 3];
    } else target.K = o.convertedPixels[i];

    this.sample = {
      source,
      target,
      display: { R: o.softProof[i * 4], G: o.softProof[i * 4 + 1], B: o.softProof[i * 4 + 2] },
      sourceDisplay: { R: o.sourceView[i * 4], G: o.sourceView[i * 4 + 1], B: o.sourceView[i * 4 + 2] },
      outOfGamut: o.outOfGamutMask[i] === 1,
    };
  }

  // —————————————————— 工程持久化 ——————————————————

  async saveProject(name: string): Promise<void> {
    if (!this.image) return;
    const pixelsKey = `pixels-${this.currentProjectId ?? uid()}`;
    const id = this.currentProjectId ?? uid();
    const record: ProjectRecord = {
      id,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      image: {
        fileName: this.image.fileName,
        mediaType: this.image.mediaType,
        width: this.image.width,
        height: this.image.height,
        model: this.image.model,
        sizeBytes: this.image.pixels.length,
        hadEmbedded: !!this.image.embedded,
        pixelsKey,
      },
      settings: { ...this.settings },
      sourceAssumption: this.sourceAssumption,
    };
    await putBlob(pixelsKey, this.image.pixels);
    if (this.image.alpha) await putBlob(`${pixelsKey}-alpha`, this.image.alpha);
    await putProject(record);
    this.currentProjectId = id;
    this.projects = await getAllProjects();
  }

  async loadProject(id: string): Promise<void> {
    const rec = this.projects.find((p) => p.id === id) ?? (await getAllProjects()).find((p) => p.id === id);
    if (!rec) return;
    const pixels = await getBlob(rec.image.pixelsKey);
    if (!pixels) throw new Error('工程像素数据缺失');
    const alpha = await getBlob(`${rec.image.pixelsKey}-alpha`);
    this.busyMessage = `正在打开工程「${rec.name}」…`;
    try {
      // 确保源/目标配置在线
      await this.ensureBuiltinSafe(rec.settings.sourceProfileId);
      await this.ensureBuiltinSafe(rec.settings.targetProfileId);
      this.currentProjectId = id;
      this.settings = { ...rec.settings };
      this.sourceAssumption = rec.sourceAssumption;
      this.embeddedProfileId = rec.image.hadEmbedded ? rec.settings.sourceProfileId : null;
      this.assumptionConfirmed = !rec.image.hadEmbedded; // 工程恢复时假设已被记录
      this.image = {
        fileName: rec.image.fileName,
        mediaType: rec.image.mediaType,
        width: rec.image.width,
        height: rec.image.height,
        model: rec.image.model,
        pixels: new Uint8Array(pixels),
        alpha: alpha ? new Uint8ClampedArray(alpha) : null,
        embedded: null, // 原始嵌入字节不随工程存；源配置已作为 profile 保存
        pngAssumedSrgb: false,
      };
      this.outputs = null;
      this.sample = null;
      this.scheduleConvert();
    } finally {
      this.busyMessage = null;
    }
  }

  async removeProject(id: string): Promise<void> {
    const rec = this.projects.find((p) => p.id === id);
    await deleteProject(id);
    if (rec) {
      await deleteBlob(rec.image.pixelsKey).catch(() => {});
      await deleteBlob(`${rec.image.pixelsKey}-alpha`).catch(() => {});
    }
    this.projects = await getAllProjects();
    if (this.currentProjectId === id) this.currentProjectId = null;
  }

  newProject(): void {
    this.image = null;
    this.outputs = null;
    this.sample = null;
    this.currentProjectId = null;
    this.sourceAssumption = null;
    this.embeddedProfileId = null;
    this.assumptionConfirmed = false;
    this.processError = null;
  }
}

export const builtinList = BUILTIN_PROFILES;

export const session = new Session();
