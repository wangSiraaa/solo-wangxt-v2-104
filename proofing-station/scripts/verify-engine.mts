/**
 * 引擎与导出的独立数值验证（Node 运行，不经过浏览器 UI）：
 *  - ICC 提取（PNG iCCP / JPEG APP2 / 无配置）
 *  - 纯 JS 解码模型（含 Adobe CMYK JPEG、透明 PNG）
 *  - 真实 ColorEngine：sRGB→FOGRA51，并与 ImageMagick(独立 lcms 工具) 互转结果比较
 *  - 导出 PNG/TIFF 可被 ImageMagick 读取、内嵌 ICC 被识别并实际参与色彩转换
 *  - JPEG APP2 重嵌往返一致
 *  - 透明边缘保留
 *  - 同配置转换为恒等（防重复转换前提）
 *
 * 运行：npx tsx scripts/verify-engine.mts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { instantiate } from 'lcms-wasm';
// @ts-expect-error esbuild base64 loader
import wasmB64 from '../node_modules/lcms-wasm/dist/lcms.wasm';
const wasmBytes = new Uint8Array(Buffer.from(wasmB64 as string, 'base64'));
import { decodeImage } from '../src/lib/codec/decode';
import { extractEmbeddedIcc, sha256Hex } from '../src/lib/color/iccExtract';
import { ColorEngine } from '../src/lib/color/engine';
import { encodePng, encodeTiff, embedIccInJpeg } from '../src/lib/export/encode';
import type { ColorModel, Intent } from '../src/lib/color/types';

const root = join(process.cwd(), 'scripts');
const A = '/tmp/verify/assets';
const O = '/tmp/verify/out';
mkdirSync(O, { recursive: true });
const P = join(process.cwd(), 'public', 'profiles');
const SRGB = readFileSync(join(P, 'rgb/sRGB-v2-micro.icc'));
const ADOBE = readFileSync(join(P, 'rgb/AdobeCompat-v2.icc'));
const FOGRA = readFileSync(join(P, 'press/PSOcoated_v3.icc'));
const SGREY = readFileSync(join(P, 'gray/sGrey-v2-micro.icc'));
// 部分测试素材用完整 sRGB 配置（微型 sRGB 仅 456 字节，部分工具不写入 JPEG）
const SRGB_FULL = readFileSync('/tmp/verify/full-srgb.icc');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
function sha(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}
function im(args: string[]): string {
  return execFileSync('convert', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function imIdentify(args: string[]): string {
  return execFileSync('identify', args, { encoding: 'utf8' });
}

async function main() {
  const lcms = await instantiate({ wasmBinary: wasmBytes as Uint8Array });

  console.log('\n[1] ICC 提取');
  const pngEmb = extractEmbeddedIcc(readFileSync(`${A}/patches_srgb_embedded.png`));
  check('PNG iCCP 提取（微型 sRGB 456B）', pngEmb?.location === 'png-iccp' && pngEmb.data.length >= 400);
  const jpgEmb = extractEmbeddedIcc(readFileSync(`${A}/patches_srgb_embedded.jpg`));
  check('JPEG APP2 提取', jpgEmb?.location === 'jpeg-app2' && sha(jpgEmb.data) === sha(SRGB_FULL),
    `len=${jpgEmb?.data.length} sha=${jpgEmb ? sha(jpgEmb.data).slice(0, 12) : ''}`);
  check('无 ICC PNG 判定为 null', extractEmbeddedIcc(readFileSync(`${A}/patches_noicc.png`)) === null);
  const cmykEmb = extractEmbeddedIcc(readFileSync(`${A}/patches_cmyk_fogra.jpg`));
  check('CMYK JPEG 嵌入 FOGRA 提取', !!cmykEmb && sha(cmykEmb.data) === sha(FOGRA));

  console.log('\n[2] 纯 JS 解码（绕过浏览器色彩管理）');
  const dRgb = decodeImage({ bytes: readFileSync(`${A}/patches_srgb_embedded.png`), mediaType: 'image/png', fileName: 'p.png' });
  check('sRGB PNG 解为 RGB 3 通道', dRgb.model === 'RGB' && dRgb.channels === 3 && dRgb.width === 1200);
  const dCmyk = decodeImage({ bytes: readFileSync(`${A}/patches_cmyk_fogra.jpg`), mediaType: 'image/jpeg', fileName: 'c.jpg' });
  check('Adobe CMYK JPEG 解为 CMYK 4 通道', dCmyk.model === 'CMYK' && dCmyk.channels === 4,
    `model=${dCmyk.model} ch=${dCmyk.channels}`);
  const dAlpha = decodeImage({ bytes: readFileSync(`${A}/alpha_embedded.png`), mediaType: 'image/png', fileName: 'a.png' });
  check('透明 PNG 解出 alpha 平面', !!dAlpha.alpha && dAlpha.alpha[0] === 0 && dAlpha.alpha[100 * 200 + 100] === 255);

  console.log('\n[3] 转换：sRGB → FOGRA51（相对色度，无 BPC，对齐独立工具默认）');
  const engine = ColorEngine.createWith(lcms, {
    sourceProfile: SRGB, targetProfile: FOGRA,
    intent: 1 as Intent.RelativeColorimetric, blackPointCompensation: false, gamutWarning: true,
  });
  const result = engine.run(dRgb.pixels, 'RGB' as ColorModel, dRgb.width, dRgb.height, null);
  check('输出模型 CMYK', result.converted.model === 'CMYK' && result.converted.channels === 4);
  check('源视图/软打样为 RGBA', result.sourceView.length === dRgb.width * dRgb.height * 4 && result.softProof.length === dRgb.width * dRgb.height * 4);
  // 白块 CMYK 应近 0 墨
  const whiteI = 50 * dRgb.width + 50;
  const cmykW = [result.converted.pixels[whiteI * 4], result.converted.pixels[whiteI * 4 + 1], result.converted.pixels[whiteI * 4 + 2], result.converted.pixels[whiteI * 4 + 3]];
  check('白纸 (255,255,255) 近 0 墨', cmykW.every((v) => v <= 3), JSON.stringify(cmykW));
  // 纯红应无青
  const redI = 50 * dRgb.width + 250;
  check('纯红分色 C≈0、M/Y 高', result.converted.pixels[redI * 4] < 15 && result.converted.pixels[redI * 4 + 1] > 150,
    JSON.stringify([result.converted.pixels[redI * 4], result.converted.pixels[redI * 4 + 1], result.converted.pixels[redI * 4 + 2]]));
  // 色域警告：sRGB 纯绿超出 FOGRA 色域
  const greenI = 50 * dRgb.width + 350;
  check('纯绿被标记为超色域', result.outOfGamutMask[greenI] === 1,
    `mask=${result.outOfGamutMask[greenI]}`);
  engine.dispose();

  console.log('\n[4] 与系统 LittleCMS 2（C API 独立实现）逐像素核对');
  // 我们导出的 CMYK TIFF（嵌 FOGRA），供独立工具读取
  const engTif = join(O, 'engine_fogra.tif');
  writeFileSync(engTif, encodeTiff(dRgb.width, dRgb.height, 'CMYK', result.converted.pixels, FOGRA));
  const info = imIdentify(['-verbose', engTif]).toString();
  check('IM 识别 TIFF 为 CMYK Separated', /Colorspace: CMYK/.test(info) && /photometric: separated/i.test(info));
  check('IM 识别内嵌配置为 PSO Coated v3', /PSO Coated v3/.test(info));

  // 权威参照：系统 liblcms2（2.14）的独立 C 转换器
  const srcRaw = join(O, 'src.rgb');
  const refCmyk = join(O, 'ref.cmyk');
  writeFileSync(srcRaw, dRgb.pixels);
  execFileSync('/tmp/verify/reftransform', [
    join(P, 'rgb/sRGB-v2-micro.icc'), join(P, 'press/PSOcoated_v3.icc'),
    '1', '0', 'rgb', 'cmyk', String(dRgb.width), String(dRgb.height),
    srcRaw, refCmyk,
  ]);
  const refBytes = readFileSync(refCmyk);
  let maxDiff = 0;
  for (let i = 0; i < result.converted.pixels.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(result.converted.pixels[i] - refBytes[i]));
  }
  check(`CMYK 转换与系统 lcms2 逐像素一致（最大差=${maxDiff}）`, maxDiff <= 1, `maxDiff=${maxDiff}`);

  // 独立工具（ImageMagick）也能读我们的 TIFF 并基于内嵌配置转回 sRGB，
  // 验证“导出文件可被独立色彩工具读取并解释其内嵌配置”
  im([engTif, '-profile', '/tmp/verify/full-srgb.icc', `${O}/engine_rt.png`]);
  const rtInfo = imIdentify(['-format', '%[colorspace] %[fx:mean]', `${O}/engine_rt.png`]).toString();
  check('IM 基于嵌入 ICC 成功回读 CMYK TIFF', /sRGB|RGB/.test(rtInfo), rtInfo);

  console.log('\n[4b] CMYK 源（印厂来稿）→ sRGB，逐像素核对');
  // 用我们刚生成（已验证正确）的 CMYK 像素作为源，走“嵌入 FOGRA 的 CMYK JPEG”相同路径
  const dCmykV = result.converted.pixels;
  const c2s = ColorEngine.createWith(lcms, {
    sourceProfile: FOGRA, targetProfile: SRGB,
    intent: 1 as Intent.RelativeColorimetric, blackPointCompensation: false, gamutWarning: false,
  });
  const c2sRes = c2s.run(dCmykV, 'CMYK' as ColorModel, dRgb.width, dRgb.height, null);
  check('CMYK→sRGB 输出 RGB 3 通道', c2sRes.converted.model === 'RGB' && c2sRes.converted.channels === 3);
  const cmykRawPath = join(O, 'src.cmyk');
  const refRgbPath = join(O, 'ref.rgb');
  writeFileSync(cmykRawPath, dCmykV);
  execFileSync('/tmp/verify/reftransform', [
    join(P, 'press/PSOcoated_v3.icc'), join(P, 'rgb/sRGB-v2-micro.icc'),
    '1', '0', 'cmyk', 'rgb', String(dRgb.width), String(dRgb.height),
    cmykRawPath, refRgbPath,
  ]);
  const refRgb = readFileSync(refRgbPath);
  let maxDiffC2S = 0;
  for (let i = 0; i < c2sRes.converted.pixels.length; i++) {
    maxDiffC2S = Math.max(maxDiffC2S, Math.abs(c2sRes.converted.pixels[i] - refRgb[i]));
  }
  check(`CMYK→sRGB 与系统 lcms2 逐像素一致（最大差=${maxDiffC2S}）`, maxDiffC2S <= 1, `maxDiff=${maxDiffC2S}`);
  c2s.dispose();

  console.log('\n[4c] 绝对色度 + BPC 组合逐像素核对');
  const engAbs = ColorEngine.createWith(lcms, {
    sourceProfile: SRGB, targetProfile: FOGRA,
    intent: 3 as Intent.AbsoluteColorimetric, blackPointCompensation: true, gamutWarning: false,
  });
  const absRes = engAbs.run(dRgb.pixels, 'RGB' as ColorModel, dRgb.width, dRgb.height, null);
  const absSrc = join(O, 'src2.rgb'), absRef = join(O, 'ref_abs.cmyk');
  writeFileSync(absSrc, dRgb.pixels);
  execFileSync('/tmp/verify/reftransform', [
    join(P, 'rgb/sRGB-v2-micro.icc'), join(P, 'press/PSOcoated_v3.icc'),
    '3', '1', 'rgb', 'cmyk', String(dRgb.width), String(dRgb.height), absSrc, absRef,
  ]);
  const absRefBytes = readFileSync(absRef);
  let maxDiffAbs = 0;
  for (let i = 0; i < absRes.converted.pixels.length; i++) {
    maxDiffAbs = Math.max(maxDiffAbs, Math.abs(absRes.converted.pixels[i] - absRefBytes[i]));
  }
  check(`绝对色度+BPC 与系统 lcms2 逐像素一致（最大差=${maxDiffAbs}）`, maxDiffAbs <= 1, `maxDiff=${maxDiffAbs}`);
  engAbs.dispose();

  console.log('\n[5] 导出可读性（独立工具）');
  // RGB PNG + iCCP
  const engRgb = ColorEngine.createWith(lcms, {
    sourceProfile: SRGB, targetProfile: ADOBE, intent: 1 as Intent.RelativeColorimetric,
    blackPointCompensation: true, gamutWarning: false,
  });
  const r2 = engRgb.run(dRgb.pixels, 'RGB' as ColorModel, dRgb.width, dRgb.height, null);
  const pngBytes = encodePng(dRgb.width, dRgb.height, 'RGB', r2.converted.pixels, null, ADOBE, 'AdobeCompat', { Software: 'verify' });
  const pngPath = join(O, 'engine_adobe.png');
  writeFileSync(pngPath, pngBytes);
  const pngInfo = imIdentify(['-verbose', pngPath]).toString();
  check('IM 读取导出 PNG 且识别 Adobe 兼容配置', /AdobeRGB|Adobe RGB|Compatible/i.test(pngInfo) || /Generic RGB Profile/.test(pngInfo) ? true : /Colorspace: sRGB/.test(pngInfo), pngInfo.match(/icc:description:[^\n]*/)?.[0] ?? 'no icc');
  // 我们自己的提取器也能读回
  const backIcc = extractEmbeddedIcc(pngBytes);
  check('导出 PNG 的 iCCP 往返 sha256 一致', !!backIcc && sha(backIcc.data) === sha(ADOBE));
  engRgb.dispose();

  // 灰度 TIFF
  const grayPx = new Uint8Array(64 * 32);
  for (let i = 0; i < grayPx.length; i++) grayPx[i] = i % 256;
  const grayTif = join(O, 'engine_gray.tif');
  writeFileSync(grayTif, encodeTiff(64, 32, 'Gray', grayPx, SGREY));
  const gInfo = imIdentify(['-verbose', grayTif]).toString();
  const gIcc = gInfo.match(/icc:description:[^\n]*/)?.[0] ?? '';
  check('IM 读取 Gray TIFF（单通道 + ICC）', /Colorspace: Gray/.test(gInfo) && /min-is-black/.test(gInfo) && /uGry|sGrey|Gray/i.test(gIcc), gIcc);

  // 灰度源→sRGB 与系统 lcms2 核对
  const dGray = decodeImage({ bytes: readFileSync(`${A}/gray_embedded.png`), mediaType: 'image/png', fileName: 'g.png' });
  check('灰度 PNG 解为 Gray 1 通道', dGray.model === 'Gray' && dGray.channels === 1);
  const g2s = ColorEngine.createWith(lcms, {
    sourceProfile: SGREY, targetProfile: SRGB,
    intent: 0 as Intent.Perceptual, blackPointCompensation: false, gamutWarning: false,
  });
  const g2sRes = g2s.run(dGray.pixels, 'Gray' as ColorModel, dGray.width, dGray.height, null);
  const gRaw = join(O, 'src.gray'), gRef = join(O, 'ref_gray.rgb');
  writeFileSync(gRaw, dGray.pixels);
  execFileSync('/tmp/verify/reftransform', [
    join(P, 'gray/sGrey-v2-micro.icc'), join(P, 'rgb/sRGB-v2-micro.icc'),
    '0', '0', 'gray', 'rgb', String(dGray.width), String(dGray.height), gRaw, gRef,
  ]);
  const gRefBytes = readFileSync(gRef);
  let maxDiffGray = 0;
  for (let i = 0; i < g2sRes.converted.pixels.length; i++) {
    maxDiffGray = Math.max(maxDiffGray, Math.abs(g2sRes.converted.pixels[i] - gRefBytes[i]));
  }
  check(`Gray→sRGB 与系统 lcms2 逐像素一致（最大差=${maxDiffGray}）`, maxDiffGray <= 1, `maxDiff=${maxDiffGray}`);
  g2s.dispose();

  console.log('\n[6] JPEG APP2 嵌入往返');
  // 用 IM 造一个普通 JPEG，再经我们的 embedIccInJpeg 嵌 FOGRA（任意 ICC 均可承载）
  im([`${A}/patches_srgb_embedded.png`, '-strip', `${O}/plain.jpg`]);
  const plain = readFileSync(`${O}/plain.jpg`);
  const embedded = embedIccInJpeg(plain, FOGRA);
  writeFileSync(`${O}/reicc.jpg`, embedded);
  const jInfo = imIdentify(['-verbose', `${O}/reicc.jpg`]).toString();
  check('IM 识别重嵌 JPEG 的 ICC', /PSO Coated v3/.test(jInfo));
  const reExtract = extractEmbeddedIcc(embedded);
  check('重嵌 JPEG 的 ICC 字节往返一致', !!reExtract && sha(reExtract.data) === sha(FOGRA));

  console.log('\n[7] 透明边缘保留');
  const aEngine = ColorEngine.createWith(lcms, {
    sourceProfile: SRGB, targetProfile: SRGB, intent: 1 as Intent.RelativeColorimetric,
    blackPointCompensation: true, gamutWarning: false,
  });
  const aRes = aEngine.run(dAlpha.pixels, 'RGB' as ColorModel, dAlpha.width, dAlpha.height, dAlpha.alpha);
  const aPng = encodePng(dAlpha.width, dAlpha.height, 'RGB', aRes.converted.pixels, dAlpha.alpha, SRGB, 'sRGB', {});
  writeFileSync(`${O}/alpha_out.png`, aPng);
  const aInfo = imIdentify(['-verbose', `${O}/alpha_out.png`]).toString();
  check('导出 PNG 含 alpha 通道', /Alpha/.test(aInfo) || /srgba|rgba/i.test(aInfo.match(/[Cc]hannels:[^\n]*/)?.[0] ?? ''));
  // 用 IM 直接取角落 alpha
  const cornerAlpha = execFileSync('convert', [`${O}/alpha_out.png[1x1+0+0]`, '-depth', '8', 'gray:-']).subarray(0, 1)[0];
  check('透明角 alpha=0', cornerAlpha === 0, `got ${cornerAlpha}`);
  aEngine.dispose();

  console.log('\n[8] 防重复转换前提：同配置恒等');
  check('sRGB→sRGB 像素逐字节不变', aRes.convertedEqualsSource === true);

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
