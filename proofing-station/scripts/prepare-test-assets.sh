#!/usr/bin/env bash
# 生成引擎验证所需素材（色块图、CMYK、无 ICC、透明边缘、灰度），
# 并编译系统 LittleCMS 2 的 C 参考转换器。
# 依赖：ImageMagick 6/7（带 lcms delegate）、gcc、liblcms2-dev。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TESTDIR="${TESTDIR:-/tmp/verify}"
A="$TESTDIR/assets"
mkdir -p "$A" "$TESTDIR/out"

P="$ROOT/public/profiles"
SRGB="$P/rgb/sRGB-v2-micro.icc"
FOGRA="$P/press/PSOcoated_v3.icc"
SGREY="$P/gray/sGrey-v2-micro.icc"

# 完整 sRGB（微型 sRGB 太小，部分工具不写入 JPEG APP2）
FULL_SRGB="$TESTDIR/full-srgb.icc"
if [ ! -f "$FULL_SRGB" ]; then
  if [ -f /usr/share/color/icc/sRGB.icc ]; then
    cp /usr/share/color/icc/sRGB.icc "$FULL_SRGB"
  else
    echo "需要完整 sRGB 配置：请放置于 $FULL_SRGB" >&2; exit 1
  fi
fi

CONVERT="$(command -v magick || command -v convert)"

cd "$A"

# 1) 12 色色块图（sRGB 编码值，未嵌入）
$CONVERT -size 100x100 \
  xc:white xc:black xc:red xc:lime xc:blue xc:cyan \
  xc:magenta xc:yellow xc:'rgb(128,128,128)' xc:'rgb(255,128,0)' \
  xc:'rgb(128,0,255)' xc:'rgb(0,128,64)' +append patches_srgb.png

# 嵌入 ICC 的 PNG（iCCP，微型 sRGB）
$CONVERT patches_srgb.png -profile "$SRGB" patches_srgb_embedded.png
# 嵌入完整 sRGB 的 JPEG（APP2）
$CONVERT patches_srgb.png -profile "$FULL_SRGB" -quality 95 patches_srgb_embedded.jpg
# 无 ICC 版本
$CONVERT patches_srgb.png -strip patches_noicc.png
$CONVERT patches_srgb.png -strip patches_noicc.jpg
# sRGB → FOGRA51 的 Adobe CMYK JPEG（嵌入目标配置）
$CONVERT patches_srgb.png -profile "$SRGB" -profile "$FOGRA" -quality 95 patches_cmyk_fogra.jpg

# 2) 透明边缘图（圆形/矩形内容 + 透明边）
$CONVERT -size 200x200 xc:none -fill 'rgb(200,30,160)' \
  -draw "circle 100,100 100,12" -fill 'rgb(20,120,220)' \
  -draw "rectangle 60,60 140,140" alpha_src.png
$CONVERT alpha_src.png -profile "$SRGB" alpha_embedded.png

# 3) 灰度阶梯（嵌 sGrey）
$CONVERT -size 100x100 gradient: -depth 8 gray_grad.png
$CONVERT gray_grad.png -profile "$SGREY" gray_embedded.png

# 4) 编译独立 C 参考转换器（系统 liblcms2）
gcc "$HERE/reftransform.c" -llcms2 -o "$TESTDIR/reftransform"

echo "素材已生成于 $A，参考转换器：$TESTDIR/reftransform"
