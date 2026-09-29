<script lang="ts">
  import { session } from '../stores/session.svelte';

  const srcModel = $derived(session.image?.model ?? 'RGB');
  const tgtModel = $derived(session.outputs?.targetModel ?? 'RGB');

  function entries(model: string, vals: Record<string, number>): [string, number][] {
    const order = model === 'CMYK' ? ['C', 'M', 'Y', 'K'] : model === 'Gray' ? ['K'] : ['R', 'G', 'B'];
    return order.map((k) => [k, vals[k] ?? 0]);
  }

  function inkPercent(v: number): string {
    return `${(v / 255 * 100).toFixed(1)}%`;
  }
</script>

<div class="sample">
  <div class="row" style="justify-content: space-between">
    <h3>取样点</h3>
    {#if session.sampleX !== null}
      <button class="small ghost" onclick={() => session.clearSample()}>清除</button>
    {/if}
  </div>

  {#if session.sample && session.sampleX !== null && session.sampleY !== null}
    <div class="muted small">坐标 x={session.sampleX}, y={session.sampleY}
      {#if session.sample.outOfGamut}<span class="oog">· 超色域</span>{/if}
    </div>

    <table>
      <thead>
        <tr><th></th>{#each entries(srcModel, session.sample.source) as [k]}<th>{k === 'K' && srcModel === 'Gray' ? '灰' : k}</th>{/each}</tr>
      </thead>
      <tbody>
        <tr>
          <td class="lbl">源编码值</td>
          {#each entries(srcModel, session.sample.source) as [k, v]}
            <td class="mono">{v}</td>
          {/each}
        </tr>
        {#if srcModel === 'CMYK'}
          <tr>
            <td class="lbl muted">油墨</td>
            {#each entries(srcModel, session.sample.source) as [, v]}
              <td class="mono muted small">{inkPercent(v)}</td>
            {/each}
          </tr>
        {/if}
        <tr>
          <td class="lbl">目标值</td>
          {#each entries(tgtModel, session.sample.target) as [k, v]}
            <td class="mono {tgtModel === 'CMYK' ? 'ink' : ''}">{v}</td>
          {/each}
        </tr>
        {#if tgtModel === 'CMYK'}
          <tr>
            <td class="lbl muted">油墨</td>
            {#each entries(tgtModel, session.sample.target) as [, v]}
              <td class="mono muted small">{inkPercent(v)}</td>
          {/each}
          </tr>
        {/if}
        <tr>
          <td class="lbl">屏幕模拟</td>
          <td class="mono" colspan="3">
            <span class="swatch" style={`background:rgb(${session.sample.display.R},${session.sample.display.G},${session.sample.display.B})`}></span>
            R{session.sample.display.R} G{session.sample.display.G} B{session.sample.display.B}
          </td>
        </tr>
        <tr>
          <td class="lbl muted">原图显示</td>
          <td class="mono muted small" colspan="3">
            R{session.sample.sourceDisplay.R} G{session.sample.sourceDisplay.G} B{session.sample.sourceDisplay.B}
          </td>
        </tr>
      </tbody>
    </table>
    <p class="muted small">
      “源编码值”是文件中未经色彩管理的数值；“目标值”处于目标配置的颜色空间（如 CMYK 油墨量）；
      “屏幕模拟”才是该点在 sRGB 显示器上软打样所见。
    </p>
  {:else}
    <p class="muted small">在左/右预览图上点击任意像素取样。</p>
  {/if}
</div>

<style>
  .sample { background: var(--panel); border-top: 1px solid var(--border); padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }
  h3 { font-size: 13px; }
  table { border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 2px 10px 2px 0; min-width: 44px; }
  th:first-child, td:first-child { text-align: left; }
  .lbl { color: var(--text); white-space: nowrap; }
  .small { font-size: 11px; }
  .ink { color: #d3a4ff; }
  .oog { color: var(--gamut); font-weight: 600; }
  .swatch { display: inline-block; width: 12px; height: 12px; border: 1px solid #000; outline: 1px solid #555; vertical-align: -2px; margin-right: 4px; }
</style>
