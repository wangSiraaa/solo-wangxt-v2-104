<script lang="ts">
  import type { IccProfile } from '../color/types';

  let { p, tag }: { p: IccProfile; tag: string } = $props();
</script>

<div class="profile-card">
  <div class="row" style="justify-content: space-between; gap: 6px">
    <span class="tag {tag}">{p.summary.colorSpace}</span>
    <span class="muted mono sha" title={p.sha256}>{p.sha256.slice(0, 12)}…</span>
  </div>
  <div class="small">{p.summary.deviceClass}</div>
  <div class="muted small">ICC v{p.summary.version} · {(p.summary.size / 1024).toFixed(0)} KB</div>
</div>

<style>
  .profile-card { border: 1px solid var(--border); border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 3px; background: var(--panel-2); }
  .sha { font-size: 10px; }
  .small { font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; }
</style>
