<script lang="ts">
  import { onMount } from 'svelte';
  import { session } from './lib/stores/session.svelte';
  import SettingsPanel from './lib/components/SettingsPanel.svelte';
  import PreviewCanvas from './lib/components/PreviewCanvas.svelte';
  import SamplePanel from './lib/components/SamplePanel.svelte';
  import ExportBar from './lib/components/ExportBar.svelte';
  import ProjectsPanel from './lib/components/ProjectsPanel.svelte';
  import SourceAssumptionModal from './lib/components/SourceAssumptionModal.svelte';

  let fileEl: HTMLInputElement;
  let dragOver = $state(false);
  let initError = $state<string | null>(null);

  onMount(() => {
    session.init().catch((e) => {
      initError = e instanceof Error ? e.message : String(e);
    });
  });

  async function pickFile(f: File | undefined) {
    if (!f) return;
    if (!/image\/(jpeg|png)/.test(f.type) && !/\.(jpe?g|png)$/i.test(f.name)) {
      session.loadError = '仅支持 JPEG / PNG（其他格式请先用图像软件另存）';
      return;
    }
    await session.importImage(f);
  }

  function onDrop(e: DragEvent) {
    dragOver = false;
    void pickFile(e.dataTransfer?.files?.[0]);
  }

  const w = $derived(session.image?.width ?? 0);
  const h = $derived(session.image?.height ?? 0);
</script>

<div class="app" class:dragover={dragOver}>
  <header class="topbar">
    <div class="brand">
      <span class="logo">◐</span>
      <div>
        <h1>浏览器软打样台</h1>
        <span class="muted small">LittleCMS (WebAssembly) · 图像全程本机处理，不上传</span>
      </div>
    </div>
    <div class="row">
      <button class="small ghost" onclick={() => session.newProject()}>新工程</button>
      <button class="small primary" onclick={() => fileEl.click()}>导入 JPEG / PNG</button>
      <input hidden type="file" accept="image/jpeg,image/png" bind:this={fileEl}
             onchange={(e) => pickFile(e.currentTarget.files?.[0])} />
    </div>
  </header>

  {#if initError}
    <div class="banner error">初始化失败：{initError}（请确认通过 HTTP 打开而非 file://）</div>
  {/if}
  {#if session.loadError}
    <div class="banner error" role="button" tabindex="0" onclick={() => (session.loadError = null)}
         onkeydown={(e) => e.key === 'Enter' && (session.loadError = null)}>{session.loadError}（点击关闭）</div>
  {/if}
  {#if session.processError}
    <div class="banner error" role="button" tabindex="0" onclick={() => (session.processError = null)}
         onkeydown={(e) => e.key === 'Enter' && (session.processError = null)}>转换失败：{session.processError}（点击关闭）</div>
  {/if}

  <div class="body">
    <div class="sidebar scroll">
      <SettingsPanel />
      <ProjectsPanel />
    </div>

    <main class="main">
      {#if !session.image}
        <div class="dropzone"
             role="button"
             tabindex="0"
             aria-label="导入图像"
             onclick={() => fileEl.click()}
             onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileEl.click(); } }}
             ondragover={(e) => { e.preventDefault(); dragOver = true; }}
             ondragleave={() => (dragOver = false)}
             ondrop={(e) => { e.preventDefault(); onDrop(e); }}>
          <div class="dz-inner">
            <div class="dz-icon">⤓</div>
            <h2>拖入 JPEG / PNG，或点击选择</h2>
            <p class="muted">系统读取图像嵌入的 ICC 配置；若缺失，将要求你先指定一个源配置并记录该假设。</p>
            <p class="muted small">支持含嵌入 ICC 的 RGB/CMYK JPEG、带 iCCP 的 PNG、透明边缘 PNG。</p>
          </div>
        </div>
      {/if}

      <div class="previews">
        <PreviewCanvas
          title="原图（按源配置显示）"
          subtitle={session.image ? `${session.sourceProfile?.summary.description ?? ''} → sRGB` : undefined}
          pixels={session.outputs?.sourceView ?? null}
          width={w}
          height={h}
          sampleX={session.sampleX}
          sampleY={session.sampleY}
          onSample={(x, y) => session.setSample(x, y)}
        />
        <PreviewCanvas
          title="转换预览 / 软打样（模拟印厂配置）"
          subtitle={session.outputs
            ? `${session.sourceProfile?.summary.description ?? ''} → ${session.targetProfile?.summary.description ?? ''}（sRGB 屏模拟）`
            : undefined}
          pixels={session.outputs?.softProof ?? null}
          width={w}
          height={h}
          gamutMask={session.outputs?.outOfGamutMask ?? null}
          gamutOverlay={session.settings.gamutWarning && session.showGamutOverlay}
          sampleX={session.sampleX}
          sampleY={session.sampleY}
          onSample={(x, y) => session.setSample(x, y)}
        />
      </div>
      {#if session.processing}
        <div class="status">正在执行 LittleCMS 转换…</div>
      {/if}
      <SamplePanel />
      <ExportBar />
      <div class="disclaimer">
        本机显示器未经色度计校准，也未补偿环境光；屏幕软打样仅用于预检颜色趋势、色域裁剪与分色，
        <strong>不承诺与实物打样/印刷品一致</strong>。签样请以经校准的打样系统或物理合同打样为准。
      </div>
    </main>
  </div>

  <SourceAssumptionModal />
</div>

<style>
  .app { display: flex; flex-direction: column; height: 100%; position: relative; }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .brand { display: flex; gap: 10px; align-items: center; }
  .logo { font-size: 26px; color: var(--accent); }
  h1 { font-size: 16px; }
  .small { font-size: 12px; }
  .body { flex: 1; min-height: 0; display: flex; }
  .sidebar { width: 320px; flex: 0 0 320px; background: var(--panel); border-right: 1px solid var(--border); padding: 14px; display: flex; flex-direction: column; gap: 18px; overflow-y: auto; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
  .previews { flex: 1; min-height: 0; display: flex; gap: 10px; padding: 10px; }
  .status { padding: 3px 14px; font-size: 12px; color: var(--accent-2); }
  .disclaimer { padding: 7px 14px 9px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); background: var(--panel); }
  .banner { padding: 7px 14px; font-size: 13px; cursor: pointer; }
  .banner.error { background: rgba(255,93,93,.15); color: #ffb4b4; border-bottom: 1px solid rgba(255,93,93,.4); }
  .dropzone { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(20,22,26,.92); z-index: 10; padding: 30px; }
  .dz-inner { max-width: 520px; text-align: center; border: 2px dashed var(--border); border-radius: 14px; padding: 48px 30px; background: var(--panel); }
  .dz-icon { font-size: 42px; color: var(--accent); margin-bottom: 8px; }
  .app.dragover .dropzone { border-color: var(--accent); }
</style>
