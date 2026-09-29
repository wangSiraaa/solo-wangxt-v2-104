<script lang="ts">
  import { session } from '../stores/session.svelte';
  import { INTENT_LABELS } from '../color/types';
  import {
    encodePng, encodeTiff, encodeJpegWithIcc, buildManifest, download, TOOL_NAME,
  } from '../export/encode';

  let exporting = $state(false);
  let lastMessage = $state('');

  const hasOutput = $derived(!!(session.outputs && session.image));
  const tgtModel = $derived(session.outputs?.targetModel ?? 'RGB');

  function baseName(): string {
    const n = session.image?.fileName ?? 'image';
    return n.replace(/\.(jpe?g|png|tiff?)$/i, '');
  }
  function safeName(s: string): string {
    return s.replace(/[^\w一-鿿.-]+/g, '_').slice(0, 60);
  }

  async function doExport(kind: 'png' | 'tiff' | 'jpeg' | 'json') {
    if (!session.outputs || !session.image) return;
    const src = session.sourceProfile;
    const tgt = session.targetProfile;
    if (!src || !tgt) return;
    exporting = true;
    lastMessage = '';
    try {
      const o = session.outputs;
      const img = session.image;
      const tgtBase = safeName(tgt.summary.description || 'target');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const manifest = buildManifest({
        sourceFileName: img.fileName,
        width: img.width,
        height: img.height,
        model: img.model,
        hadEmbedded: !!img.embedded,
        assumptionReason: session.sourceAssumption,
        source: src,
        target: tgt,
        display: { name: 'sRGB (lcms 内置)', description: 'IEC 61966-2.1 sRGB' },
        intentName: INTENT_LABELS[session.settings.intent],
        intentCode: session.settings.intent,
        bpc: session.settings.blackPointCompensation,
      });

      if (kind === 'json') {
        const json = JSON.stringify(manifest, null, 2);
        download(`${baseName()}__设置记录__${tgtBase}__${stamp}.json`, new TextEncoder().encode(json), 'application/json');
        lastMessage = '已导出设置记录 JSON';
        return;
      }

      const provenance: Record<string, string> = {
        Software: TOOL_NAME,
        SourceProfile: `src=${src.summary.description || src.name} | sha256=${src.sha256}${img.embedded ? '' : ' [ASSUMED]'}`,
        TargetProfile: `dst=${tgt.summary.description || tgt.name} | sha256=${tgt.sha256}`,
        Intent: `${INTENT_LABELS[session.settings.intent]} BPC=${session.settings.blackPointCompensation}`,
        Warning: 'CONVERTED OUTPUT - embedded ICC is the TARGET profile; do not re-convert from original source profile',
      };

      if (kind === 'png') {
        if (o.targetModel === 'CMYK') {
          lastMessage = '目标为 CMYK，已改用 TIFF（PNG 不支持 CMYK 印刷分色）';
          const tif = encodeTiff(img.width, img.height, 'CMYK', o.convertedPixels, tgt.data);
          download(`${baseName()}__转换至_${tgtBase}__${stamp}.tif`, tif, 'image/tiff');
          return;
        }
        const png = encodePng(
          img.width, img.height, o.targetModel === 'Gray' ? 'Gray' : 'RGB',
          o.convertedPixels,
          img.alpha && o.targetModel === 'RGB' ? img.alpha : null,
          tgt.data, tgtBase, provenance,
        );
        download(`${baseName()}__转换至_${tgtBase}__${stamp}.png`, png, 'image/png');
        lastMessage = `PNG 已导出并嵌入目标配置（${tgt.summary.description}）`;
      } else if (kind === 'tiff') {
        const model = o.targetModel as 'RGB' | 'Gray' | 'CMYK';
        const tif = encodeTiff(img.width, img.height, model, o.convertedPixels, tgt.data);
        download(`${baseName()}__转换至_${tgtBase}__${stamp}.tif`, tif, 'image/tiff');
        lastMessage = `TIFF 已导出并嵌入目标配置（${model}，可被 ImageMagick/Photoshop 读取）`;
      } else if (kind === 'jpeg') {
        if (o.targetModel !== 'RGB') {
          lastMessage = 'JPEG 仅支持 RGB 输出；请先选择 RGB 目标，或改用 TIFF 导出 CMYK';
          return;
        }
        const jpg = await encodeJpegWithIcc(img.width, img.height, o.convertedPixels, tgt.data);
        download(`${baseName()}__转换至_${tgtBase}__${stamp}.jpg`, jpg, 'image/jpeg');
        lastMessage = 'JPEG 已导出，APP2 段内嵌目标配置';
      }
    } finally {
      exporting = false;
    }
  }
</script>

<div class="exportbar">
  <div class="row" style="flex-wrap: wrap; gap: 6px">
    <span class="muted small">导出（目标：{tgtModel}）：</span>
    <button class="small primary" disabled={!hasOutput || exporting} onclick={() => doExport(tgtModel === 'CMYK' ? 'tiff' : 'png')}>
      {tgtModel === 'CMYK' ? '导出 CMYK TIFF（嵌 ICC）' : '导出 PNG（嵌目标 ICC）'}
    </button>
    <button class="small" disabled={!hasOutput || exporting} onclick={() => doExport('tiff')}>导出 TIFF</button>
    <button class="small" disabled={!hasOutput || exporting || tgtModel !== 'RGB'} title={tgtModel !== 'RGB' ? '仅 RGB 目标可导出 JPEG' : ''} onclick={() => doExport('jpeg')}>导出 JPEG</button>
    <button class="small ghost" disabled={!hasOutput || exporting} onclick={() => doExport('json')}>导出设置记录 JSON</button>
  </div>
  {#if lastMessage}<span class="muted small">{lastMessage}</span>{/if}
  <span class="muted small warn-note">
    导出像素已处于目标配置空间且文件内嵌该配置；请勿再把它按原源配置转换一次。
  </span>
</div>

<style>
  .exportbar { background: var(--panel); border-top: 1px solid var(--border); padding: 8px 14px; display: flex; flex-direction: column; gap: 4px; }
  .warn-note { font-size: 11px; color: var(--warn); }
</style>
