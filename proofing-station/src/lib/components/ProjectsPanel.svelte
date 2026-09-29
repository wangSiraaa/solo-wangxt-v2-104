<script lang="ts">
  import { session } from '../stores/session.svelte';

  let name = $state('');
  let saving = $state(false);

  async function save() {
    saving = true;
    try {
      await session.saveProject(name.trim() || session.image?.fileName || '未命名工程');
      name = '';
    } finally {
      saving = false;
    }
  }

  function fmt(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  }
</script>

<div class="projects">
  <h3>本机工程（IndexedDB）</h3>
  <div class="row">
    <input type="text" placeholder="工程名称" bind:value={name} onkeydown={(e) => e.key === 'Enter' && save()} />
    <button class="small" disabled={!session.image || saving} onclick={save}>保存</button>
  </div>
  <p class="muted small">像素与配置仅保存在本浏览器，不产生任何上传。</p>
  {#if session.projects.length}
    <ul class="list">
      {#each session.projects as p (p.id)}
        <li class="item">
          <button class="ghost open" onclick={() => session.loadProject(p.id)} title="打开">
            <span class="pname">{p.name}</span>
            <span class="muted small">{p.image.width}×{p.image.height} · {p.image.model}{p.image.hadEmbedded ? ' · 嵌入ICC' : ' · 假设源'}</span>
            <span class="muted small">{fmt(p.updatedAt)}</span>
          </button>
          <button class="small ghost del" onclick={() => session.removeProject(p.id)} title="删除">✕</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted small">暂无已保存工程。</p>
  {/if}
</div>

<style>
  .projects { display: flex; flex-direction: column; gap: 6px; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--border); }
  h3 { font-size: 13px; }
  .list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
  .item { display: flex; gap: 4px; align-items: stretch; }
  .open { flex: 1; display: flex; flex-direction: column; align-items: flex-start; text-align: left; padding: 5px 8px; }
  .pname { font-size: 12px; word-break: break-all; }
  .del { color: var(--danger); align-self: stretch; }
</style>
