/**
 * 真实浏览器端到端验证（Playwright + Chromium）：
 *  - 页面加载、LittleCMS WASM 初始化、内置配置按需加载
 *  - 导入嵌入 ICC 的 sRGB PNG → 自动识别源，不弹假设框
 *  - 并排预览生成、取样读数
 *  - 切换目标到 FOGRA51 CMYK → 右屏出现颜色变化、色域警告
 *  - 缺 ICC 图像 → 强制弹源配置假设对话框，取消前无预览
 *  - 导出 PNG/JSON（验证下载文件内容含目标配置与防重复转换提示）
 *  - IndexedDB 保存/恢复工程
 *  - 透明边缘图：alpha 通道保留
 *
 * 运行：先 npm run build && npm run preview，再 npx playwright test / 本脚本
 * （本脚本为独立 node 脚本，便于直接观察断言）
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 受限环境中 headless-shell 可能缺系统库；允许通过 CHROME_PATH 指定完整版
const CHROME_PATH = process.env.CHROME_PATH || join(
  homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
);

const A = '/tmp/verify/assets';
const O = '/tmp/verify/e2e';
mkdirSync(O, { recursive: true });

let pass = 0, fail = 0;
const ok = (name: boolean, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const BASE = 'http://localhost:4173';

const launchOpts: Record<string, unknown> = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (existsSync(CHROME_PATH)) launchOpts.executablePath = CHROME_PATH;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// 监听下载
const downloads: { name: string; path: string }[] = [];
page.on('download', async (d) => {
  const p = `${O}/${d.suggestedFilename()}`;
  await d.saveAs(p);
  downloads.push({ name: d.suggestedFilename(), path: p });
});

async function upload(filePath: string) {
  await page.setInputFiles('input[type=file][accept*="jpeg"]', filePath);
  await page.waitForTimeout(900);
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  ok('页面标题正确', (await page.title()).includes('软打样'));

  // —— 场景 A：嵌入 sRGB 的 PNG，不弹假设框 ——
  await upload(`${A}/patches_srgb_embedded.png`);
  await page.waitForTimeout(800);
  const modalHidden = await page.locator('.backdrop').count();
  ok('嵌入配置图像不弹来源假设框', modalHidden === 0, `backdrops=${modalHidden}`);
  const embeddedTag = await page.locator('.tag.embedded').count();
  ok('显示“嵌入配置”标记', embeddedTag >= 1);
  await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 2 &&
    Array.from(document.querySelectorAll('canvas')).every(c => c.width > 0), null, { timeout: 8000 });
  ok('两块预览画布均渲染', true);

  // 切换目标到 CMYK 印厂配置（目标选择器是侧栏第 2 个 select）
  const selects = page.locator('.panel select');
  const targetOptions = await selects.nth(1).locator('option').allInnerTexts();
  const fograOpt = targetOptions.find((t) => /PSO Coated v3/.test(t));
  await selects.nth(1).selectOption({ label: fograOpt });
  await page.waitForTimeout(1200);
  // 默认导出按钮应变 CMYK TIFF
  const cmykBtn = await page.getByRole('button', { name: /导出 CMYK TIFF/ }).count();
  ok('选择 CMYK 目标后主导出按钮变为 CMYK TIFF', cmykBtn === 1);

  // 取样：点击右画布一个像素
  const right = page.locator('canvas').nth(1);
  const box = await right.boundingBox();
  if (box) await page.mouse.click(box.x + box.width * 0.22, box.y + box.height * 0.5);
  await page.waitForTimeout(300);
  const sampleText = await page.locator('.sample').innerText();
  ok('取样面板显示源 RGB / 目标 CMYK / 屏幕模拟',
    /源编码值/.test(sampleText) && /目标值/.test(sampleText) && /屏幕模拟/.test(sampleText),
    sampleText.slice(0, 200));
  ok('目标值出现 4 列（CMYK）', /C/i.test(sampleText) && sampleText.includes('油墨'), sampleText.slice(0, 300));

  // 色域警告
  const gw = page.locator('.panel label.check', { hasText: '色域警告' }).locator('input');
  await gw.check();
  await page.waitForTimeout(1200);
  const overlayBox = page.locator('.panel label.check', { hasText: '叠加品红' }).locator('input');
  ok('色域警告开启后出现叠加开关', await overlayBox.count() === 1);

  // 导出 JSON 记录
  await page.getByRole('button', { name: /设置记录/ }).click();
  await page.waitForTimeout(600);
  const jsonDl = downloads.find(d => d.name.endsWith('.json'));
  ok('设置记录 JSON 已下载', !!jsonDl);
  if (jsonDl) {
    const j = JSON.parse(readFileSync(jsonDl.path, 'utf8'));
    ok('记录含源配置与目标配置引用', !!j.sourceProfile?.sha256 && !!j.targetProfile?.sha256);
    ok('目标配置标记为嵌入导出', j.targetProfile.embeddedInExport === true);
    ok('记录含防重复转换警告', /再次|重复转换/.test(j.warning));
    ok('记录标明引擎为 LittleCMS', /LittleCMS/.test(j.transform.engine));
  }

  // 导出 CMYK TIFF
  await page.getByRole('button', { name: /导出 CMYK TIFF/ }).click();
  await page.waitForTimeout(700);
  const tifDl = downloads.find(d => d.name.endsWith('.tif'));
  ok('CMYK TIFF 已下载', !!tifDl);
  if (tifDl) {
    writeFileSync(`${O}/e2e_cmyk.tif`, readFileSync(tifDl.path));
  }

  // —— IndexedDB 保存/恢复 ——
  await page.locator('.projects input[type=text]').fill('E2E测试工程');
  await page.getByRole('button', { name: '保存', exact: true }).first().click();
  await page.waitForTimeout(600);
  const projItem = await page.locator('.projects .pname', { hasText: 'E2E测试工程' }).count();
  ok('工程出现在本机工程列表', projItem >= 1);

  // 刷新页面，恢复工程
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('.projects .open', { hasText: 'E2E测试工程' }).click();
  await page.waitForTimeout(1800);
  await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 2 &&
    Array.from(document.querySelectorAll('canvas')).every(c => c.width > 0), null, { timeout: 8000 });
  ok('刷新后从 IndexedDB 恢复图像与预览', true);
  const assumedTag = await page.locator('.tag.assumed').count();
  ok('恢复嵌入源图像不显示假设标记', assumedTag === 0);

  // —— 场景 B：无 ICC 图像必须指定假设 ——
  await page.getByRole('button', { name: '新工程' }).click();
  await page.waitForTimeout(300);
  await upload(`${A}/patches_noicc.png`);
  await page.waitForTimeout(800);
  const modalOpen = await page.locator('.backdrop').count();
  ok('无 ICC 图像弹出强制来源假设对话框', modalOpen >= 1);
  const modalText = await page.locator('.modal').innerText();
  ok('对话框要求先明确源色彩空间', /没有嵌入 ICC|源配置/.test(modalText));
  // 对话框打开期间不应有转换预览
  const canvasesBefore = await page.evaluate(() =>
    Array.from(document.querySelectorAll('canvas')).filter(c => c.width > 0).length);
  ok('确认假设前不生成预览', canvasesBefore === 0, `active canvases=${canvasesBefore}`);
  await page.getByRole('button', { name: /确认该来源假设/ }).click();
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('canvas')).filter(c => c.width > 0).length >= 2,
    null, { timeout: 8000 });
  ok('确认假设后生成预览并记录假设', true);
  const assumedTag2 = await page.locator('.tag.assumed').count();
  ok('显示“来源假设”标记', assumedTag2 >= 1);

  // 导出此假设源的 JSON，检查 assumed=true
  downloads.length = 0;
  // 目标改回 RGB（Adobe），以导出 PNG 路径
  const tgtSel = page.locator('.panel select').nth(1);
  const adobeOpt = (await tgtSel.locator('option').allInnerTexts()).find((t) => /Adobe RGB/.test(t));
  await tgtSel.selectOption({ label: adobeOpt });
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /设置记录/ }).click();
  await page.waitForTimeout(500);
  const json2 = downloads.find(d => d.name.endsWith('.json'));
  if (json2) {
    const j = JSON.parse(readFileSync(json2.path, 'utf8'));
    ok('假设源在记录中标记 assumed=true', j.sourceProfile.assumed === true);
    ok('记录写明未嵌入配置', j.sourceImage.hadEmbeddedProfile === false);
  } else {
    ok('假设源 JSON 下载', false, 'no json');
  }

  // 导出 RGB PNG（嵌 Adobe ICC）
  await page.getByRole('button', { name: /导出 PNG（嵌目标 ICC）/ }).click().catch(async () => {
    await page.getByRole('button', { name: /导出 PNG/ }).click();
  });
  await page.waitForTimeout(700);
  const pngDl = downloads.find(d => d.name.endsWith('.png'));
  ok('转换后 RGB PNG 已下载', !!pngDl);
  if (pngDl) writeFileSync(`${O}/e2e_rgb.png`, readFileSync(pngDl.path));

  // —— 场景 C：透明边缘图 ——
  await page.getByRole('button', { name: '新工程' }).click();
  await page.waitForTimeout(300);
  await upload(`${A}/alpha_embedded.png`);
  await page.waitForTimeout(1200);
  // alpha 图嵌了 sRGB iCCP，不弹框；若弹框（取决于 IM 是否写 iCCP），确认之
  if (await page.locator('.backdrop').count()) {
    await page.getByRole('button', { name: /确认该来源假设/ }).click();
    await page.waitForTimeout(1000);
  }
  // 直接读取画布角像素应为透明
  const cornerAlpha = await page.evaluate(() => {
    const c = document.querySelectorAll('canvas')[0] as HTMLCanvasElement;
    return c.getContext('2d')!.getImageData(0, 0, 1, 1).data[3];
  });
  ok('原图预览左上角透明（alpha=0）', cornerAlpha === 0, `alpha=${cornerAlpha}`);

  ok('浏览器无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.error('E2E 异常:', e);
} finally {
  await page.screenshot({ path: `${O}/final.png` });
  await browser.close();
}

console.log(`\nE2E 结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
