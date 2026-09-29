<script lang="ts">
  import { session, builtinList } from '../stores/session.svelte';
  import { INTENT_LABELS, Intent, type IccProfile } from '../color/types';
  import ProfileCard from './ProfileCard.svelte';

  let targetFileEl = $state<HTMLInputElement>();
  let sourceFileEl = $state<HTMLInputElement>();

  const sourceProfiles = $derived(
    session.profiles.filter((p) => {
      if (p.origin.kind === 'builtin') {
        return builtinList.find((b) => b.id === p.id)?.usableAs.includes('source');
      }
      return true;
    }),
  );
  const targetProfiles = $derived(session.profiles);

  const intents = [
    Intent.Perceptual,
    Intent.RelativeColorimetric,
    Intent.Saturation,
    Intent.AbsoluteColorimetric,
  ];

  const src = $derived(session.sourceProfile);
  const tgt = $derived(session.targetProfile);

  async function addTargetFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const p = await session.importProfileFile(f);
    session.setTarget(p.id);
  }
  async function addSourceFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const p = await session.importProfileFile(f);
    await session.setSourceProfile(p.id);
  }

  function csTag(p?: IccProfile) {
    if (!p) return '';
    return p.summary.colorSpace === 'CMYK' ? 'cmyk' : p.summary.colorSpace === 'GRAY' ? 'gray' : 'rgb';
  }
</script>

<div class="panel">
  <section class="block">
    <h3>① 图像来源（先明确色彩空间）</h3>
    {#if session.image}
      <div class="meta">
        <div class="mono fname" title={session.image.fileName}>{session.image.fileName}</div>
        <div class="muted">
          {session.image.width}×{session.image.height} ·
          编码 {session.image.model}
          {#if session.image.alpha}· 含透明{/if}
        </div>
      </div>

      {#if session.embeddedProfileId}
        <div class="row origin">
          <span class="tag embedded">嵌入配置</span>
          <span class="muted small">取自图像 {session.image.embedded?.location === 'jpeg-app2' ? 'JPEG APP2' : 'PNG iCCP'}</span>
        </div>
      {:else}
        <div class="row origin">
          <span class="tag assumed">来源假设</span>
          <span class="muted small">图像未嵌入 ICC，用户指定</span>
        </div>
        {#if session.sourceAssumption}
          <div class="assumption">{session.sourceAssumption}</div>
        {/if}
        <button class="small" onclick={() => session.resetAssumptionConfirm()}>重新指定来源假设</button>
      {/if}

      <label class="field">
        <span>源配置</span>
        <select value={session.settings.sourceProfileId} onchange={(e) => session.setSourceProfile(e.currentTarget.value)}>
          {#each sourceProfiles as p (p.id)}
            <option value={p.id}>{p.summary.description || p.name}（{p.summary.colorSpace}）</option>
          {/each}
        </select>
      </label>
      <button class="small ghost" onclick={() => sourceFileEl?.click()}>导入源 .icc…</button>
      <input hidden type="file" accept=".icc,.icm" bind:this={sourceFileEl} onchange={(e) => addSourceFile(e)} />
      {#if src}
        <ProfileCard p={src} tag={csTag(src)} />
      {/if}
    {:else}
      <p class="muted small">尚未导入图像。</p>
    {/if}
  </section>

  <section class="block">
    <h3>② 印厂目标配置</h3>
    <label class="field">
      <span>目标 ICC（输出/打样设备）</span>
      <select value={session.settings.targetProfileId} onchange={(e) => session.setTarget(e.currentTarget.value)}>
        {#each targetProfiles as p (p.id)}
          <option value={p.id}>{p.summary.description || p.name}（{p.summary.colorSpace}）</option>
        {/each}
      </select>
    </label>
    <button class="small ghost" onclick={() => targetFileEl?.click()}>导入印厂 .icc…</button>
    <input hidden type="file" accept=".icc,.icm" bind:this={targetFileEl} onchange={(e) => addTargetFile(e)} />
    {#if tgt}
      <ProfileCard p={tgt} tag={csTag(tgt)} />
    {/if}
  </section>

  <section class="block">
    <h3>③ 转换参数</h3>
    <label class="field">
      <span>渲染意图（Rendering Intent）</span>
      <select value={session.settings.intent} onchange={(e) => session.setIntent(Number(e.currentTarget.value))}>
        {#each intents as i (i)}
          <option value={i}>{INTENT_LABELS[i]}</option>
        {/each}
      </select>
    </label>
    <label class="check">
      <input type="checkbox" checked={session.settings.blackPointCompensation} onchange={(e) => session.setBpc(e.currentTarget.checked)} />
      <span>黑点补偿（Black Point Compensation）</span>
    </label>
    <label class="check">
      <input type="checkbox" checked={session.settings.gamutWarning} onchange={(e) => session.setGamutWarning(e.currentTarget.checked)} />
      <span>色域警告（标记超出印厂色域的像素）</span>
    </label>
    {#if session.settings.gamutWarning}
    <label class="check">
      <input type="checkbox" bind:checked={session.showGamutOverlay} />
      <span>在预览上叠加品红蒙版</span>
    </label>
    {/if}
    <p class="muted small">
      软打样固定在 sRGB 显示器空间模拟目标设备；本机显示器未经校色，结果不构成合同打样。
    </p>
  </section>
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: 18px; }
  .block { display: flex; flex-direction: column; gap: 8px; }
  h3 { font-size: 13px; letter-spacing: .02em; color: #cdd4e2; }
  .small { font-size: 12px; }
  .meta { display: flex; flex-direction: column; gap: 2px; }
  .fname { font-size: 12px; word-break: break-all; }
  .origin { margin: 2px 0; }
  .assumption { font-size: 12px; color: var(--warn); background: rgba(255,176,32,.08); border: 1px solid rgba(255,176,32,.3); padding: 6px 8px; border-radius: 6px; }
  .check { display: flex; gap: 8px; align-items: center; font-size: 13px; }
</style>
