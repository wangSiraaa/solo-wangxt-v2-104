# 内置 ICC 配置来源与许可

本工具不内置任何盗版或需付费授权的印厂配置。以下配置均可自由再分发，
仅用于让工具开箱即用；生产签样请向印厂索取其**实际使用的具体配置**。

## RGB / 灰度（微型，CC0/MIT 兼容）

- `rgb/sRGB-v2-micro.icc`
- `rgb/AdobeCompat-v2.icc`
- `rgb/DisplayP3Compat-v2-micro.icc`
- `rgb/ProPhoto-v2-micro.icc`
- `gray/sGrey-v2-micro.icc`

来源：[Compact-ICC-Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles)
（saucecontrol），MIT 许可。其内部基于 Argyll CMS 生成、色彩特征由
作者以 CC0 释出的特性数据。

## RGB（行业）

- `rgb/eciRGB_v2.icc` — ECI eciRGB v2，ECI 免费提供、允许随应用再分发。

## CMYK 印厂输出

- `press/PSOcoated_v3.icc` — PSO Coated v3（FOGRA51，ISO 12647-2 欧洲铜版纸）
- `press/PSOuncoated_v3_FOGRA52.icc` — FOGRA52 无涂布纸
- `press/GRACoL2013_CRPC6.icc` — GRACoL 2013（北美 1 类铜版纸，IDEAlliance/ICC）
- `press/SWOP2013C3_CRPC5.icc` — SWOP 2013（北美出版，IDEAlliance/ICC）
- `press/JapanColor2011Coated.icc` — Japan Color 2011 铜版纸

来源：Debian `icc-profiles` 包（non-free 分类仅因 Adobe 商标，配置本身允许
嵌入与交换）；各配置版权归 ECI/bvdm、IDEAlliance(X-Rite)、Japan Color、
ICC 等，许可允许无限制地在图像文件中嵌入、随软件再分发，但不得单独转售或修改。

- `press/Ghostscript-default-CMYK.icc` — Artifex Ghostscript 随附通用 CMYK
  （AGPL Ghostscript 的免费附带组件）。

## 替换为你自己的配置

界面中可随时「导入印厂 .icc」。导入后存入浏览器本地 IndexedDB，
不会上传。导出文件会嵌入所选目标配置，设置记录 JSON 中记录其
描述与 SHA-256 摘要。
