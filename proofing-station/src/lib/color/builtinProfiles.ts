/**
 * 内置开放 ICC 配置注册表。文件放在 public/profiles，仅在用户选用时
 * 才 fetch（保持首屏轻量），随后存入 IndexedDB 复用。
 *
 * 配置来源与许可：
 *  - Compact-ICC (saucecontrol)：MIT，sRGB/Display P3/ProPhoto 的微型实现
 *  - Ghostscript default_cmyk：Artifex，AGPL/免费，CMYK 通用输出
 *  - Debian icc-profiles / icc-profiles-free：ECI、IDEAlliance(GRACoL/SWOP/CRPC)、
 *    Japan Color 等可自由再分发的行业配置
 * 详见 public/profiles/PROFILES_LICENSES.md
 */
export interface BuiltinProfileEntry {
  id: string;
  /** public 下的相对路径 */
  path: string;
  /** 选择器中展示的名称 */
  label: string;
  /** 适用类别（源可选 / 仅目标） */
  usableAs: ('source' | 'target')[];
  expectedColorSpace: 'RGB' | 'CMYK' | 'Gray';
  description: string;
  origin: string;
}

export const BUILTIN_PROFILES: BuiltinProfileEntry[] = [
  {
    id: 'builtin-srgb',
    path: 'profiles/rgb/sRGB-v2-micro.icc',
    label: 'sRGB IEC 61966-2.1（v2 微型）',
    usableAs: ['source', 'target'],
    expectedColorSpace: 'RGB',
    description: '标准 sRGB 显示器/网络空间，缺省来源假设的常见选择',
    origin: 'Compact-ICC-Profiles (MIT)',
  },
  {
    id: 'builtin-adobe-rgb',
    path: 'profiles/rgb/AdobeCompat-v2.icc',
    label: 'Adobe RGB (1998) 兼容',
    usableAs: ['source', 'target'],
    expectedColorSpace: 'RGB',
    description: '印前常用宽色域 RGB',
    origin: 'Compact-ICC-Profiles (MIT)',
  },
  {
    id: 'builtin-display-p3',
    path: 'profiles/rgb/DisplayP3Compat-v2-micro.icc',
    label: 'Display P3 兼容',
    usableAs: ['source', 'target'],
    expectedColorSpace: 'RGB',
    description: 'Apple Display P3 兼容空间',
    origin: 'Compact-ICC-Profiles (MIT)',
  },
  {
    id: 'builtin-prophoto',
    path: 'profiles/rgb/ProPhoto-v2-micro.icc',
    label: 'ProPhoto ROMM RGB',
    usableAs: ['source', 'target'],
    expectedColorSpace: 'RGB',
    description: '超大色域工作空间（数码摄影）',
    origin: 'Compact-ICC-Profiles (MIT)',
  },
  {
    id: 'builtin-ecirgb',
    path: 'profiles/rgb/eciRGB_v2.icc',
    label: 'eciRGB v2',
    usableAs: ['source', 'target'],
    expectedColorSpace: 'RGB',
    description: 'ECI 推荐印前 RGB 工作空间',
    origin: 'ECI（可自由再分发）',
  },
  {
    id: 'builtin-sgrey',
    path: 'profiles/gray/sGrey-v2-micro.icc',
    label: 'sGrey 灰度',
    usableAs: ['source', 'target'],
    expectedColorSpace: 'Gray',
    description: '标准灰度显示/工作空间',
    origin: 'Compact-ICC-Profiles (MIT)',
  },
  {
    id: 'builtin-pso-coated-v3',
    path: 'profiles/press/PSOcoated_v3.icc',
    label: 'PSO Coated v3（FOGRA51，欧洲铜版纸）',
    usableAs: ['target', 'source'],
    expectedColorSpace: 'CMYK',
    description: 'ISO 12647-2 铜版纸胶印，欧洲主流印厂配置',
    origin: 'ECI / bvdm（可自由再分发）',
  },
  {
    id: 'builtin-pso-uncoated-fogra52',
    path: 'profiles/press/PSOuncoated_v3_FOGRA52.icc',
    label: 'PSO Uncoated v3（FOGRA52，欧洲胶版纸）',
    usableAs: ['target', 'source'],
    expectedColorSpace: 'CMYK',
    description: 'ISO 12647-2 无涂布胶版纸',
    origin: 'ECI / bvdm（可自由再分发）',
  },
  {
    id: 'builtin-gracol-crpc6',
    path: 'profiles/press/GRACoL2013_CRPC6.icc',
    label: 'GRACoL 2013 CRPC6（北美 1 类铜版纸）',
    usableAs: ['target', 'source'],
    expectedColorSpace: 'CMYK',
    description: '北美商业印刷铜版纸基准',
    origin: 'IDEAlliance（可自由再分发）',
  },
  {
    id: 'builtin-swop-crpc5',
    path: 'profiles/press/SWOP2013C3_CRPC5.icc',
    label: 'SWOP 2013 C3 CRPC5（北美出版）',
    usableAs: ['target', 'source'],
    expectedColorSpace: 'CMYK',
    description: '北美卷筒纸出版印刷基准',
    origin: 'IDEAlliance（可自由再分发）',
  },
  {
    id: 'builtin-japancolor-2011',
    path: 'profiles/press/JapanColor2011Coated.icc',
    label: 'Japan Color 2011 Coated',
    usableAs: ['target', 'source'],
    expectedColorSpace: 'CMYK',
    description: '日本印刷行业标准铜版纸',
    origin: 'Japan Color（可自由再分发）',
  },
  {
    id: 'builtin-gs-default-cmyk',
    path: 'profiles/press/Ghostscript-default-CMYK.icc',
    label: 'Ghostscript 通用 CMYK',
    usableAs: ['target', 'source'],
    expectedColorSpace: 'CMYK',
    description: 'Artifex Ghostscript 随附通用 CMYK 输出配置',
    origin: 'Artifex Software（免费）',
  },
];

/** 本工具固定使用的“显示器”软打样输出空间（不承诺校准） */
export const DISPLAY_PROFILE_ID = 'builtin-srgb';

export function findBuiltin(id: string): BuiltinProfileEntry | undefined {
  return BUILTIN_PROFILES.find((p) => p.id === id);
}

/** 拉取内置配置字节（fetch 相对路径；生产/开发均由 Vite/静态服务器提供） */
export async function fetchBuiltinProfile(entry: BuiltinProfileEntry): Promise<Uint8Array> {
  const res = await fetch(entry.path);
  if (!res.ok) throw new Error(`无法加载内置配置：${entry.label}（${res.status}）`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
