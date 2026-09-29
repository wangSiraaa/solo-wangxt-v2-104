<script lang="ts">
  import { session } from '../stores/session.svelte';
  import { builtinList } from '../stores/session.svelte';
  import type { IccProfile } from '../color/types';

  let open = $derived(session.needsSourceAssumption && !session.assumptionConfirmed && !!session.image);
  let selectedId = $state('');
  let note = $state('');
  let userFileEl = $state<HTMLInputElement>();

  // 每次打开时按图像颜色模型预选
  $effect(() => {
    if (open && session.image) {
      const want = session.image.model;
      const match = builtinList.find(
        (b) => b.usableAs.includes('source') &&
        (want === 'Gray' ? b.expectedColorSpace === 'Gray' : b.expectedColorSpace === 'RGB'),
      );
      selectedId = session.image.pngAssumedSrgb ? 'builtin-srgb' : (match?.id ?? 'builtin-srgb');
      note = '';
    }
  });

  const compatibleProfiles = $derived.by(() => {
    const want = session.image?.model;
    return session.profiles.filter((p) => {
      if (p.origin.kind === 'builtin') {
        const b = builtinList.find((x) => x.id === p.id);
        if (!b) return false;
        if (want === 'Gray') return b.expectedColorSpace === 'Gray';
        if (want === 'CMYK') return b.expectedColorSpace === 'CMYK';
        return b.expectedColorSpace === 'RGB';
      }
      // 用户/嵌入配置：按摘要颜色空间匹配
      return want === 'Gray' ? p.summary.colorSpace === 'GRAY'
        : want === 'CMYK' ? p.summary.colorSpace === 'CMYK'
        : p.summary.colorSpace === 'RGB';
    });
  });

  async function onPickUserIcc(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const p = await session.importProfileFile(f);
    selectedId = p.id;
  }

  function confirm() {
    session.confirmAssumption(selectedId, note.trim());
  }

  function tagOf(p: IccProfile): string {
    return p.summary.colorSpace === 'CMYK' ? 'cmyk' : p.summary.colorSpace === 'GRAY' ? 'gray' : 'rgb';
  }
</script>

{#if open}
  <div class="backdrop" role="dialog" aria-modal="true" aria-label="指定源色彩配置">
    <div class="modal">
      <h2>该图像没有嵌入 ICC 配置</h2>
      <p class="muted">
        文件 <strong class="mono">{session.image?.fileName}</strong>
        （{session.image?.model}，{session.image?.width}×{session.image?.height}）中找不到 ICC 配置。
        像素本身不携带颜色空间信息，必须先明确“这些编码值来自哪个色彩空间”，
        才能正确地转换到印厂配置。
      </p>
      {#if session.image?.pngAssumedSrgb}
        <p class="warnbox">PNG 含有 sRGB 提示块但没有嵌入 ICC。多数情况下确为 sRGB，但仍需你确认这一假设。</p>
      {:else}
        <p class="warnbox">所选配置将作为<strong>来源假设</strong>被记录到工程与导出设置记录中；选错源配置会导致整体偏色。</p>
      {/if}

      <label class="field">
        <span>源配置（解释当前像素的色彩空间）</span>
        <select bind:value={selectedId}>
          {#each compatibleProfiles as p (p.id)}
            <option value={p.id}>
              {p.summary.description || p.name}
              ({p.summary.colorSpace})
            </option>
          {/each}
        </select>
      </label>

      <div class="row" style="justify-content: space-between">
        <span class="muted small" style="font-size:12px">
          {#if selectedId}
            {@const p = session.getProfileById(selectedId)}
            <span class="tag {tagOf(p!)}">{p?.summary.deviceClass}</span>
            {p?.summary.description} · ICC v{p?.summary.version}
          {/if}
        </span>
        <button class="small ghost" onclick={() => userFileEl?.click()}>导入我的 .icc…</button>
        <input hidden type="file" accept=".icc,.icm" bind:this={userFileEl} onchange={(e) => onPickUserIcc(e)} />
      </div>

      <label class="field">
        <span>假设说明（可选，将写入导出记录）</span>
        <input type="text" bind:value={note} placeholder="例如：客户口头确认按 sRGB；或摄影师工作空间 Adobe RGB" />
      </label>

      <div class="actions">
        <button class="primary" disabled={!selectedId} onclick={confirm}>确认该来源假设并继续</button>
      </div>
      <p class="muted foot">确认前不会执行任何转换。本工具不读取 EXIF 之外的信息，也不会上传该图像。</p>
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(8,10,14,.72); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 22px; max-width: 560px; width: 100%; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
  .warnbox { margin: 0; padding: 10px 12px; border: 1px solid rgba(255,176,32,.4); background: rgba(255,176,32,.08); border-radius: 6px; color: var(--warn); font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; }
  .foot { font-size: 12px; margin: 0; }
</style>
