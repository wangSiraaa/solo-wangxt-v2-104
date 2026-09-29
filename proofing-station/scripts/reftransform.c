/*
 * 独立参考转换器：直接调用系统 LittleCMS 2（C API），
 * 与浏览器内的 lcms-wasm(2.16) 互为独立实现，用于核对像素转换。
 *
 * 用法：reftransform <in.icc> <out.icc> <intent> <bpc 0/1> \
 *        <inmodel rgb|cmyk|gray> <outmodel rgb|cmyk|gray> \
 *        <宽> <高> <输入裸像素> <输出裸像素>
 */
#include <lcms2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static cmsUInt32Number fmt(const char *m) {
  if (!strcmp(m, "rgb")) return TYPE_RGB_8;
  if (!strcmp(m, "cmyk")) return TYPE_CMYK_8;
  return TYPE_GRAY_8;
}

int main(int argc, char **argv) {
  if (argc != 11) { fprintf(stderr, "bad args\n"); return 2; }
  const char *pin = argv[1], *pout = argv[2];
  cmsUInt32Number intent = (cmsUInt32Number)atoi(argv[3]);
  int bpc = atoi(argv[4]);
  const char *min = argv[5], *mout = argv[6];
  cmsUInt32Number w = (cmsUInt32Number)atoi(argv[7]);
  cmsUInt32Number h = (cmsUInt32Number)atoi(argv[8]);

  cmsHPROFILE hin = cmsOpenProfileFromFile(pin, "r");
  cmsHPROFILE hout = cmsOpenProfileFromFile(pout, "r");
  if (!hin || !hout) { fprintf(stderr, "open profile fail\n"); return 3; }

  cmsUInt32Number flags = cmsFLAGS_COPY_ALPHA;
  if (bpc) flags |= cmsFLAGS_BLACKPOINTCOMPENSATION;
  cmsHTRANSFORM t = cmsCreateTransform(hin, fmt(min), hout, fmt(mout), intent, flags);
  if (!t) { fprintf(stderr, "create transform fail\n"); return 4; }

  int chin = !strcmp(min, "cmyk") ? 4 : (!strcmp(min, "gray") ? 1 : 3);
  int chout = !strcmp(mout, "cmyk") ? 4 : (!strcmp(mout, "gray") ? 1 : 3);
  size_t nin = (size_t)w * h * chin, nout = (size_t)w * h * chout;
  unsigned char *in = malloc(nin), *out = malloc(nout);
  FILE *fi = fopen(argv[9], "rb");
  if (fread(in, 1, nin, fi) != nin) { fprintf(stderr, "short input\n"); return 5; }
  fclose(fi);

  cmsDoTransform(t, in, out, w * h);

  FILE *fo = fopen(argv[10], "wb");
  fwrite(out, 1, nout, fo);
  fclose(fo);

  free(in); free(out);
  cmsDeleteTransform(t);
  cmsCloseProfile(hin); cmsCloseProfile(hout);
  return 0;
}
