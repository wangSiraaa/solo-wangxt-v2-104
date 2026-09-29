<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    title: string;
    subtitle?: string;
    pixels: Uint8ClampedArray | null;
    width: number;
    height: number;
    gamutMask?: Uint8Array | null;
    gamutOverlay?: boolean;
    sampleX?: number | null;
    sampleY?: number | null;
    onSample?: (x: number, y: number) => void;
  }

  let {
    title, subtitle, pixels, width, height,
    gamutMask = null, gamutOverlay = false,
    sampleX = null, sampleY = null, onSample,
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement>();
  const base = document.createElement('canvas'); // 原始分辨率
  const overlay = document.createElement('canvas');

  function paint() {
    if (!canvas || !pixels || !width) return;
    canvas.width = width;
    canvas.height = height;
    base.width = width;
    base.height = height;
    const bctx = base.getContext('2d')!;
    bctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(base, 0, 0);

    if (gamutMask && gamutOverlay) {
      // 色域外像素叠加品红
      const id = ctx.getImageData(0, 0, width, height);
      const d = id.data;
      for (let i = 0; i < gamutMask.length; i++) {
        if (gamutMask[i]) {
          d[i * 4] = 255;
          d[i * 4 + 1] = Math.round(d[i * 4 + 1] * 0.15);
          d[i * 4 + 2] = 214;
        }
      }
      ctx.putImageData(id, 0, 0);
    }

    if (sampleX !== null && sampleY !== null) {
      const x = sampleX + 0.5;
      const y = sampleY + 0.5;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, width / 600);
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(width, y);
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
      ctx.stroke();
      ctx.strokeStyle = '#000';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(width, y);
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  $effect(() => {
    // 依赖变化时重绘
    void pixels; void width; void height; void gamutOverlay; void sampleX; void sampleY; void gamutMask;
    paint();
  });

  function onClick(e: MouseEvent) {
    if (!onSample || !width) return;
    const rect = canvas!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * height);
    onSample(
      Math.min(width - 1, Math.max(0, x)),
      Math.min(height - 1, Math.max(0, y)),
    );
  }

  onMount(paint);
</script>

<div class="pane">
  <header>
    <strong>{title}</strong>
    {#if subtitle}<span class="muted sub">{subtitle}</span>{/if}
  </header>
  <div class="stage checkerboard">
    {#if pixels}
      <canvas
        bind:this={canvas}
        role="button"
        tabindex="0"
        onclick={onClick}
        title="点击取样"
      ></canvas>
    {:else}
      <div class="placeholder muted">导入图像后显示</div>
    {/if}
  </div>
</div>

<style>
  .pane { display: flex; flex-direction: column; min-height: 0; flex: 1; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  header { padding: 8px 12px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: baseline; }
  .sub { font-size: 12px; }
  .stage { flex: 1; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 10px; }
  canvas { max-width: 100%; max-height: 100%; image-rendering: auto; cursor: crosshair; box-shadow: 0 4px 24px rgba(0,0,0,.45); }
  .placeholder { font-size: 13px; }
</style>
