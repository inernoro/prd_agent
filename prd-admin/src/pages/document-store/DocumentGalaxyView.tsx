/**
 * 知识库 3D 文档星系视图（Galaxy）。
 *
 * 数据：listDocumentEntriesReal（条目）+ getStoreGraph（双链）。
 * 业务关系识别复用 buildDocGalaxy（SSOT，根→分类→appname→子模块→文档树 + 横向引用）。
 *
 * 渲染内核（2026-06-25 重写；2026-07-02 艺术升级 art pass v2）：vanilla three.js，
 * 原生 EffectComposer + UnrealBloomPass 选择性 bloom。布局尺度 / 节点尺寸 / 光晕用量沿用
 * 演示版 doc-tree-3d.html 的数值基线（LEVEL_R、nodeSize、haloOpacity —— 这是
 * 「白色 group/root 节点不爆成大白团」的关键），视觉层在其上做了整套深空剧场化：
 *
 *   氛围：渐变深空穹顶（BackSide 球，天顶靛蓝 → 地底近黑 + 赤道微光带）、
 *     双层闪烁星场（自定义 shader points：远景 5000+ 细星 + 近景亮星，各自相位呼吸）、
 *     程序化星云（384px 多团簇贴图 18 片，缓漂 + 各自微旋）、银心双层辉光、偶发流星。
 *   星体：核心球换限暗着色器（视线正对处白热、向边缘回落本色、极边缘色相增益），
 *     bloom 从「整球溢出」变成「热核溢出」；hover 有亮度 + 尺寸的缓动反馈；
 *     root 与一级分类枢纽带缓旋衍射星芒。
 *   光路：父子连线改二次贝塞尔弧线（向外微拱），顶点色从父端亮蓝渐隐到子端、
 *     叶子端混入该文档 type 色；横向引用为拱高更大的能量弧（两端暗中段亮），
 *     并有流光脉冲沿弧线巡游；聚焦时非子树光路同步压暗。
 *   编排：入场为「银心向外的生长波」—— 节点按半径 + 层深错峰弹性长出、光路随后淡入、
 *     相机从远处缓推进场；全程可被用户手势打断。
 *   后期：combine pass 内联电影级 grade —— 轻色差（边缘）、柔性暗角、阴影提靛、
 *     胶片颗粒抖动（去深空色带）。bloom strength=0.62 / threshold=0.72 / radius=0.45。
 *     防死白靠 haloOpacity 压底 + glow x0.85 软叠加 + bloom 阈值的手工调校
 *    （composer 渲染到 render target 时 three 不应用 renderer.toneMapping，别指望 ACES 兜底）。
 *   标签：2x 超采样绘制（近看不糊），子模块 / 应用层标签随相机距离淡入淡出（远观不糊屏）。
 *   标签 / 连线 / 星点 / 星云全部不在 bloom 层，始终清晰。
 *
 * 功能层（保留）：type 图例筛选、点叶子复用系统 MarkdownViewer 阅读、hover 显示节点名、
 * 数据加载超时护栏、错误显式报错、full-height flex-1 撑满。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { X, RotateCcw, Search, ArrowLeft, ToggleLeft, ToggleRight, Layers, Folder, FileText, ChevronDown } from 'lucide-react';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { GalaxyConstellationLoader } from './GalaxyConstellationLoader';
import { parseFrontmatter } from '@/lib/frontmatter';
import { listDocumentEntriesReal, getDocumentContent } from '@/services/real/documentStore';
import { getStoreGraph } from '@/services/real/mentions';
import {
  buildDocGalaxy,
  DOC_TYPES,
  type DocGalaxy,
  type GalaxyNode,
  type GalaxyInputEntry,
  type GalaxyInputLink,
} from '@/lib/docGalaxy/buildDocGalaxy';

// ── docType → 颜色注册表（数值 SSOT = 演示版 doc-tree-3d.html TYPE_COLORS，照抄） ──
const TYPE_COLOR: Record<string, string> = {
  spec: '#4ade80',
  design: '#60a5fa',
  plan: '#fbbf24',
  rule: '#f87171',
  guide: '#a78bfa',
  report: '#22d3ee',
  debt: '#fb923c',
  unknown: '#94a3b8',
};
export function colorForDocType(docType?: string | null): string {
  if (!docType) return TYPE_COLOR.unknown;
  return TYPE_COLOR[docType] ?? TYPE_COLOR.unknown;
}

export function rotateOrbitOffsetByPixels(
  offset: THREE.Vector3,
  dxPx: number,
  dyPx: number,
  viewportWidth: number,
  viewportHeight: number,
  rotateSpeed: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const radius = offset.length();
  if (radius < 1e-6) return out.copy(offset);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  const rotateScale = 2 * Math.PI * rotateSpeed;
  spherical.theta += (dxPx / Math.max(1, viewportWidth)) * rotateScale;
  spherical.phi += (dyPx / Math.max(1, viewportHeight)) * rotateScale;
  spherical.makeSafe();
  return out.setFromSpherical(spherical).setLength(radius);
}

export function naturalCameraEase(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function cameraTweenDurationMs(
  fromTarget: THREE.Vector3,
  toTarget: THREE.Vector3,
  fromPos: THREE.Vector3,
  toPos: THREE.Vector3,
): number {
  const travel = fromTarget.distanceTo(toTarget) * 0.55 + fromPos.distanceTo(toPos) * 0.45;
  return Math.round(Math.min(1450, Math.max(620, 560 + Math.sqrt(Math.max(0, travel)) * 28)));
}

// 枢纽节点配色（演示版 SSOT：root 纯白、category 金、appname 冷白、submodule 灰蓝）。
// 产品 GalaxyNode 只有 root/group/leaf 三类，group 按层深映射到演示的 category/appname/submodule。
const ROOT_COLOR = '#ffffff';
const CAT_COLOR = '#ffe08a'; // 第 1 层 group ≈ 演示 category
const APP_COLOR = '#e8f0ff'; // 第 2 层 group ≈ 演示 appname
const SUB_COLOR = '#9fb4d4'; // 更深 group ≈ 演示 submodule

// ── 放射状 3D 布局：演示版 doc-tree-3d.html 的确定性球面树（数值 SSOT，照抄）──
// 每个节点在单位球上取一个方向；深度 -> 半径。顶级分类用斐波那契球均匀铺开，
// 子节点在父方向周围的圆锥内散开。与产品旧版（RING_GAP=9 小尺度）相比尺度大得多、更散。
interface PlacedNode {
  node: GalaxyNode;
  pos: THREE.Vector3;
  depth: number;
}

// 演示版 LEVEL_R = [0, 120, 300, 470, 620, 760]（逐层向外的半径）
const LEVEL_R = [0, 120, 300, 470, 620, 760];
function radiusForDepth(d: number): number {
  return d < LEVEL_R.length ? LEVEL_R[d] : LEVEL_R[LEVEL_R.length - 1] + (d - LEVEL_R.length + 1) * 120;
}

// 顶级分类用斐波那契球均匀分布方向（演示版 distributeDirections，照抄）
function distributeDirections(count: number): THREE.Vector3[] {
  const dirs: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2 * 0.85;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    dirs.push(new THREE.Vector3(Math.cos(th) * r, y * 0.9, Math.sin(th) * r).normalize());
  }
  return dirs;
}

// 子节点在父方向周围的圆锥内散开（演示版 spreadInCone，照抄）
function spreadInCone(parentDir: THREE.Vector3, count: number, spread: number): THREE.Vector3[] {
  if (count === 1) return [parentDir.clone()];
  const up = Math.abs(parentDir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = up.clone().cross(parentDir).normalize();
  const w = parentDir.clone().cross(u).normalize();
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const ang2 = i * 2.399963; // 绕轴黄金角，铺成扇面
    const rad = spread * Math.sqrt((i + 0.5) / count);
    const dir = parentDir
      .clone()
      .multiplyScalar(Math.cos(rad))
      .add(u.clone().multiplyScalar(Math.sin(rad) * Math.cos(ang2)))
      .add(w.clone().multiplyScalar(Math.sin(rad) * Math.sin(ang2)))
      .normalize();
    out.push(dir);
  }
  return out;
}

function layoutGalaxy(root: GalaxyNode): {
  placed: Map<string, PlacedNode>;
  edges: Array<{ a: THREE.Vector3; b: THREE.Vector3; child: GalaxyNode }>;
} {
  const placed = new Map<string, PlacedNode>();
  const edges: Array<{ a: THREE.Vector3; b: THREE.Vector3; child: GalaxyNode }> = [];

  // 根在原点
  placed.set(root.id, { node: root, pos: new THREE.Vector3(0, 0, 0), depth: 0 });

  // 沿父方向递归铺开子树（演示版 layoutChildren）
  const layoutChildren = (parent: GalaxyNode, parentPos: THREE.Vector3, parentDir: THREE.Vector3, depth: number) => {
    const kids = parent.children;
    if (!kids.length) return;
    const spread = depth <= 2 ? 0.95 : 0.75;
    const dirs = spreadInCone(parentDir, kids.length, spread);
    const R = radiusForDepth(depth);
    kids.forEach((kid, i) => {
      const dir = dirs[i];
      const pos = dir.clone().multiplyScalar(R);
      placed.set(kid.id, { node: kid, pos, depth });
      edges.push({ a: parentPos.clone(), b: pos.clone(), child: kid });
      layoutChildren(kid, pos, dir, depth + 1);
    });
  };

  // 顶级分类（depth=1）用斐波那契球铺满整个球面
  const cats = root.children;
  const catDirs = distributeDirections(cats.length);
  cats.forEach((c, i) => {
    const dir = catDirs[i];
    const pos = dir.clone().multiplyScalar(radiusForDepth(1));
    placed.set(c.id, { node: c, pos, depth: 1 });
    edges.push({ a: new THREE.Vector3(0, 0, 0), b: pos.clone(), child: c });
    layoutChildren(c, pos, dir, 2);
  });

  return { placed, edges };
}

// ── 径向渐变贴图（光晕 / 星点 / 星云共用，纯程序生成，不依赖外部资源） ──
function makeRadialTexture(stops: Array<[number, string]>): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ── 衍射星芒贴图（root / 一级分类枢纽的十字光斑；水平垂直主臂 + 45 度弱臂）──
function makeSpikeTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const arm = (angle: number, len: number, alpha: number) => {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(angle);
    const grad = ctx.createLinearGradient(-len, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(-len, -1.6, len * 2, 3.2);
    ctx.restore();
  };
  arm(0, c, 0.9);
  arm(Math.PI / 2, c, 0.9);
  arm(Math.PI / 4, c * 0.55, 0.35);
  arm(-Math.PI / 4, c * 0.55, 0.35);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ── 流星拖尾贴图（右端亮头、向左渐隐的细长光条）──
function makeStreakTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, 'rgba(160,190,255,0)');
  grad.addColorStop(0.75, 'rgba(210,226,255,0.55)');
  grad.addColorStop(0.97, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 12, 256, 8);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// 入场生长的弹性缓出（轻微过冲，星体「长出来」的手感）
export function easeOutBack(t: number): number {
  const c1 = 1.2;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// 确定性伪随机（按索引取相位/速度，避免每次渲染循环 re-random）
function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ── 节点视觉尺寸（演示版 nodeSize，数值 SSOT 照抄）──
// 演示有 root/category/appname/submodule/doc 五类；产品只有 root/group/leaf，
// 用 depth 把 group 映射到 category(d=1) / appname(d=2) / submodule(d>=3)。
// docCount 等价演示的 leaves（该节点自身及子树的文档数）。
function nodeSize(node: GalaxyNode, depth: number): number {
  if (node.kind === 'root') return 16;
  if (node.kind === 'leaf') return 2.1;
  // group：按层深取演示对应类的尺寸
  if (depth <= 1) return 10; // category
  if (depth === 2) return 4.5 + Math.min(5, Math.sqrt(Math.max(1, node.docCount))); // appname
  return 3.2; // submodule（更深）
}

// 演示版 haloOpacity：底数压低，附加光晕不再在重叠区叠成死白，bloom 补足其余
function haloOpacity(node: GalaxyNode, depth: number): number {
  if (node.kind === 'root') return 0.5;
  if (node.kind === 'leaf') return 0.32;
  if (depth <= 1) return 0.46; // category
  if (depth === 2) return 0.36; // appname
  return 0.26; // submodule
}

// 演示版 sphereGeo：实际球半径 = size * 0.9
function coreRadiusFromSize(size: number): number {
  return size * 0.9;
}

// 演示版 halo 缩放：size * (doc ? 7 : 10) —— 小而克制，杜绝大白团
function haloScaleFromSize(node: GalaxyNode, size: number): number {
  return size * (node.kind === 'leaf' ? 7 : 10);
}

// 枢纽节点配色：按层深取演示对应类的颜色
function groupColor(node: GalaxyNode, depth: number): string {
  if (node.kind === 'root') return ROOT_COLOR;
  if (depth <= 1) return CAT_COLOR;
  if (depth === 2) return APP_COLOR;
  return SUB_COLOR;
}

// 核心星着色器 uniforms（限暗 + 热核；uOpacity 承接聚焦淡出、uBoost 承接 hover 提亮）
interface CoreUniforms {
  uColor: { value: THREE.Color };
  uOpacity: { value: number };
  uBoost: { value: number };
}

const CORE_VERT = `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const CORE_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uBoost;
varying vec3 vN;
varying vec3 vV;
void main() {
  float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float core = pow(ndv, 2.2);
  vec3 hot = mix(uColor, vec3(1.0), 0.55);
  vec3 col = mix(uColor * 0.62, hot, core);
  float rim = pow(1.0 - ndv, 3.0);
  col += uColor * rim * 0.35;
  gl_FragColor = vec4(col * uBoost, uOpacity);
}`;

// ── 节点渲染时挂在 sprite/mesh userData 上的元信息 ──
interface NodeRender {
  node: GalaxyNode;
  core: THREE.Mesh;
  coreU: CoreUniforms;
  halo: THREE.Sprite;
  haloBaseSize: number;
  haloBaseOpacity: number;
  size: number;
  depth: number;
  /** 光晕呼吸相位（每星错开，避免整场同频闪） */
  twPhase: number;
  /** hover 强调的缓动系数（0..1，渲染循环 lerp） */
  hoverK: number;
  /** 入场生长波的错峰延迟（ms） */
  introDelay: number;
}

/**
 * 文本标签贴图（枢纽节点用，canvas 绘制后做 sprite）。
 * 标签在 bloom 层之外 → 永远清晰、不被泛光糊掉。
 */
// 仅生成标签纹理 + 尺寸（供初次创建 sprite 与切换显示模式时重绘共用）。
// 2x 超采样绘制：近观标签边缘不糊（世界尺度不变，只提纹理密度）
const LABEL_RES = 2;

// 文本测量画布单例（每次重绘新建 canvas 纯属浪费）
let labelMeasureCtx: CanvasRenderingContext2D | null = null;
function getLabelMeasureCtx(): CanvasRenderingContext2D {
  if (!labelMeasureCtx) labelMeasureCtx = document.createElement('canvas').getContext('2d')!;
  return labelMeasureCtx;
}

function makeLabelTexture(
  text: string,
  kind: GalaxyNode['kind'],
  depth: number,
  color: string,
): { tex: THREE.CanvasTexture; w: number; h: number; fontSize: number } {
  // 演示版字号：root 46 / category 40 / 其余 30（逻辑字号；实际按 LABEL_RES 超采样绘制）
  const fontSize = kind === 'root' ? 46 : depth <= 1 ? 40 : 30;
  const pad = 10 * LABEL_RES;
  const measure = getLabelMeasureCtx();
  const font = `600 ${fontSize * LABEL_RES}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
  measure.font = font;
  const w = measure.measureText(text || ' ').width;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w + pad * 2);
  cv.height = fontSize * LABEL_RES + pad * 2;
  const cx = cv.getContext('2d')!;
  cx.font = font;
  // 半透明圆角底 + 描边
  const rr = (x: number, y: number, ww: number, hh: number, r: number) => {
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.arcTo(x + ww, y, x + ww, y + hh, r);
    cx.arcTo(x + ww, y + hh, x, y + hh, r);
    cx.arcTo(x, y + hh, x, y, r);
    cx.arcTo(x, y, x + ww, y, r);
    cx.closePath();
  };
  cx.fillStyle = 'rgba(3,6,18,0.58)';
  rr(0, 0, cv.width, cv.height, 9 * LABEL_RES);
  cx.fill();
  cx.strokeStyle = color + '55';
  cx.lineWidth = 1.5 * LABEL_RES;
  rr(1, 1, cv.width - 2, cv.height - 2, 9 * LABEL_RES);
  cx.stroke();
  // 文字带同色微光（仅 root / 一级分类 —— 深层标签量大且远看即淡出，省掉逐字高斯模糊成本）
  cx.fillStyle = kind === 'root' ? '#ffffff' : color;
  cx.font = font;
  cx.textBaseline = 'middle';
  if (kind === 'root' || depth <= 1) {
    cx.shadowColor = color;
    cx.shadowBlur = 7 * LABEL_RES;
  }
  cx.fillText(text, pad, cv.height / 2 + 2 * LABEL_RES);
  cx.shadowBlur = 0;
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return { tex, w: cv.width, h: cv.height, fontSize };
}

function makeLabelSprite(text: string, kind: GalaxyNode['kind'], depth: number, color: string): THREE.Sprite {
  const { tex, w, h, fontSize } = makeLabelTexture(text, kind, depth, color);
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
  );
  // 演示版世界尺度：sc = 0.34*(fontSize/30)；超采样后除回 LABEL_RES 保持同一世界尺寸
  const sc = (0.34 * (fontSize / 30)) / LABEL_RES;
  sp.scale.set(w * sc, h * sc, 1);
  sp.renderOrder = 10;
  // 记录元数据 + 当前文本，供切换显示模式时按相同 kind/depth/color 重绘、文本未变时跳过
  sp.userData.labelMeta = { kind, depth, color };
  sp.userData.labelText = text;
  return sp;
}

// 切换显示模式时重绘已有标签 sprite 的纹理（不重建场景）。返回新纹理供外层登记释放。
function redrawLabelSprite(sprite: THREE.Sprite, text: string): THREE.CanvasTexture {
  const meta = sprite.userData.labelMeta as { kind: GalaxyNode['kind']; depth: number; color: string };
  const { tex, w, h, fontSize } = makeLabelTexture(text, meta.kind, meta.depth, meta.color);
  const mat = sprite.material as THREE.SpriteMaterial;
  const old = mat.map;
  mat.map = tex;
  mat.needsUpdate = true;
  if (old) old.dispose();
  const sc = (0.34 * (fontSize / 30)) / LABEL_RES;
  sprite.scale.set(w * sc, h * sc, 1);
  return tex;
}

// ── 子树统计：遍历某节点子树下所有叶子，按 docType 计数（hover 缩略卡 / 信息面板用）──
function tallySubtreeTypes(node: GalaxyNode): Array<{ type: string; count: number }> {
  const counts: Record<string, number> = {};
  const walk = (n: GalaxyNode) => {
    if (n.kind === 'leaf') {
      const t = n.docType ?? 'unknown';
      counts[t] = (counts[t] ?? 0) + 1;
      return;
    }
    n.children.forEach(walk);
  };
  walk(node);
  // 按 count 降序，便于面板/缩略卡突出主要类型
  return Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

// 标签显示模式：结构名（文件名/点分名，默认）vs 正文标题（frontmatter title / 首个标题）。
// 复用 DocBrowser「正文标题/文件名」开关的同一套 parseFrontmatter SSOT，口径一致。
export type GalaxyLabelMode = 'structural' | 'content';

/** 叶子节点显示名：content 模式取正文标题（取不到回退结构名）；structural 模式恒用结构名。 */
function leafDisplayName(node: GalaxyNode, mode: GalaxyLabelMode, contentTitles: Map<string, string>): string {
  if (mode === 'content' && node.entryId) {
    const t = contentTitles.get(node.entryId);
    if (t) return t;
  }
  return node.name;
}

/**
 * 从正文标题里剥掉重复的「文件名前缀」。
 * doc/ 作者约定：H1 常写成「{点分文件名} — {真标题}」甚至纯文件名。
 * 直接拿 H1 当标题会把文件名带进来（用户「都是文件名字」的根因）。
 * 尝试两种前缀：完整文件名、去掉 {type}. 段后的剩余；命中则连同其后的分隔符一并剥掉。
 */
function stripFilenamePrefix(title: string, filenameBare: string): string {
  let t = title.trim();
  const cands = [filenameBare];
  const dot = filenameBare.indexOf('.');
  if (dot > 0) cands.push(filenameBare.slice(dot + 1)); // 去掉 type 前缀（如 web-hosting-client-ip）
  for (const c of cands) {
    if (c && t.toLowerCase().startsWith(c.toLowerCase())) {
      // 剥掉前缀后，去掉紧跟的分隔符（— – -- - · : ： | 及空白）
      t = t.slice(c.length).replace(/^[\s—–―·:：|/-]+/, '').trim();
      break;
    }
  }
  return t;
}

/**
 * 从知识库 entry 的 summary 推导「人类正文标题」：frontmatter title / 首个标题，
 * 再剥掉重复的文件名前缀。无可用人类标题（如 H1 就是文件名本身）返回 null。
 */
function deriveContentTitle(summary: string | null | undefined, filenameBare: string): string | null {
  if (!summary) return null;
  if (summary.trimStart().startsWith('<')) return null; // HTML/XML 片段不参与
  const raw = parseFrontmatter(summary).title?.trim();
  if (!raw) return null;
  const cleaned = stripFilenamePrefix(raw, filenameBare);
  return cleaned || null;
}

/**
 * 把 summary 清成「纯文本预览」：剥 frontmatter + 去 markdown 标记（标题/链接/代码/列表/表格/强调），
 * 折叠空白。用于 hover 缩略卡 / 列表行预览，避免把 `--- title: ... ---` 和 `#`、`**` 直接糊在卡里。
 */
function cleanPreview(summary?: string | null): string {
  if (!summary) return '';
  return parseFrontmatter(summary)
    .body.replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/^\s*[-=|:]{3,}\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 阅读面板正文去重：面板头部已显示标题，正文若以同名标题(H1/H2)开头会出现「两个标题」。
 * 跳过 frontmatter 块与空行，取首个标题行；其文本规范化后等于头部标题、或以之结尾
 *（兼容「{文件名} — {真标题}」式 H1），则连同紧随空行一并剥掉。否则原样返回。
 */
function stripDuplicateLeadingHeading(md: string, title: string): string {
  if (!md || !title) return md;
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const want = norm(title);
  if (!want) return md;
  const lines = md.split('\n');
  let i = 0;
  // 跳过 YAML frontmatter
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  const m = lines[i]?.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
  if (m) {
    const h = norm(m[1]);
    if (h === want || (want.length >= 4 && h.endsWith(want))) {
      lines.splice(i, 1);
      if (lines[i]?.trim() === '') lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  return md;
}

/** 收集某节点子树下的全部文档叶（DFS，保留遇见顺序）。 */
function collectLeaves(node: GalaxyNode): GalaxyNode[] {
  if (node.kind === 'leaf') return [node];
  const out: GalaxyNode[] = [];
  for (const c of node.children) out.push(...collectLeaves(c));
  return out;
}

/**
 * 画布标签文本（随结构名/正文标题开关切换）：
 * - 叶子：直接走 leafDisplayName；
 * - 分组：content 模式下若该簇仅含 1 篇文档（点分命名常生成「子模块=单文档」结构，
 *   如 report.skill-eval-sample-user-guide → 子模块 eval-sample-user-guide 只裹 1 篇），
 *   用该文档正文标题；多文档分组（appname/category）保持结构段名。
 */
function labelTextFor(node: GalaxyNode, mode: GalaxyLabelMode, contentTitles: Map<string, string>): string {
  if (node.kind === 'leaf') return leafDisplayName(node, mode, contentTitles);
  if (mode === 'content') {
    const leaves = collectLeaves(node);
    if (leaves.length === 1) {
      const lt = leaves[0].entryId ? contentTitles.get(leaves[0].entryId) : undefined;
      // 有人类标题用标题；没有（H1 就是文件名）用本组结构段名，比叶子全文件名干净
      return lt ?? node.name;
    }
  }
  return node.name;
}

/** 从根到目标节点的名称链（面包屑用，不含根「知识库」本身）。 */
function pathToNode(root: GalaxyNode, targetId: string): GalaxyNode[] | null {
  const dfs = (n: GalaxyNode, acc: GalaxyNode[]): GalaxyNode[] | null => {
    const next = n.kind === 'root' ? acc : [...acc, n];
    if (n.id === targetId) return next;
    for (const c of n.children) {
      const r = dfs(c, next);
      if (r) return r;
    }
    return null;
  };
  return dfs(root, []);
}

// hover 缩略卡 / 信息面板共享的 hover 载荷
interface HoverInfo {
  x: number;
  y: number;
  flip: boolean; // 靠近右边缘时翻到节点左侧
  node: GalaxyNode;
  depth: number;
  pathNames: string[]; // 从根到该节点的祖先名链（不含根/自身），缩略卡里显示"所在位置"
}

// 枢纽聚焦时的信息面板载荷（直接子节点 + 子树 type 分布）
interface FocusInfo {
  node: GalaxyNode;
  depth: number;
  typeTally: Array<{ type: string; count: number }>;
  children: Array<{ node: GalaxyNode; isLeaf: boolean }>;
}

// type 名中文（缩略卡 / 面板分布条标注）。未知归「其他」。
const TYPE_LABEL: Record<string, string> = {
  spec: 'spec',
  design: 'design',
  plan: 'plan',
  rule: 'rule',
  guide: 'guide',
  report: 'report',
  debt: 'debt',
  unknown: '其他',
};

// 子树 type 分布彩色小条（缩略卡 + 信息面板共用）
function TypeBars({ tally, max }: { tally: Array<{ type: string; count: number }>; max?: number }) {
  const list = max ? tally.slice(0, max) : tally;
  if (!list.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {list.map(({ type, count }) => (
        <span
          key={type}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: '#c4c4d0',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 5,
            padding: '1px 6px',
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: colorForDocType(type), display: 'inline-block' }} />
          {TYPE_LABEL[type] ?? type}
          <span style={{ color: '#8a8a96' }}>{count}</span>
        </span>
      ))}
    </div>
  );
}

// 路径面包屑（缩略卡顶部"所在位置"）。
function PathLine({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <div
      style={{
        fontSize: 11,
        color: '#8a8c9c',
        marginBottom: 6,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      title={names.join(' / ')}
    >
      {names.join(' / ')}
    </div>
  );
}

// 悬浮缩略卡：叶子 = 路径 + type 徽章 + 标题 + 摘要简介（只读）；
// 枢纽（分类/应用/子模块）= 路径 + 名称 + 篇数 + type 分布 + 该簇文档清单（可点跳转，悬停保持）；
// 根（知识库）保持紧凑（不铺清单，避免一次列 347 篇）。
function HoverCard({
  info,
  labelMode,
  contentTitles,
  onOpenLeaf,
  onKeepAlive,
  onScheduleClose,
}: {
  info: HoverInfo;
  labelMode: GalaxyLabelMode;
  contentTitles: Map<string, string>;
  onOpenLeaf: (entryId: string) => void;
  onKeepAlive: () => void;
  onScheduleClose: () => void;
}) {
  const { node, depth, flip, pathNames } = info;
  const isLeaf = node.kind === 'leaf';
  // 分类/应用/子模块出可点清单；根不出（太大）
  const showList = !isLeaf && node.kind !== 'root';
  // 清单内悬停某行 → 展开该文档正文预览（2 行截断）
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const baseStyle: CSSProperties = {
    position: 'absolute',
    left: info.x,
    top: info.y,
    transform: flip ? 'translate(calc(-100% - 14px), -50%)' : 'translate(14px, -50%)',
    pointerEvents: showList ? 'auto' : 'none',
    width: showList ? 320 : 280,
    maxWidth: showList ? 320 : 280,
    background: 'rgba(14,15,22,0.94)',
    backdropFilter: 'blur(12px) saturate(130%)',
    WebkitBackdropFilter: 'blur(12px) saturate(130%)',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 12,
    padding: showList ? '10px 8px 8px 12px' : '10px 12px',
    color: '#eef0f5',
    boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
    zIndex: 18,
    display: showList ? 'flex' : undefined,
    flexDirection: showList ? 'column' : undefined,
    maxHeight: showList ? '58vh' : undefined,
  };

  if (isLeaf) {
    const t = node.docType ?? 'unknown';
    const preview = cleanPreview(node.summary);
    return (
      <div style={baseStyle}>
        <PathLine names={pathNames} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#0b0b12',
              background: colorForDocType(t),
              borderRadius: 4,
              padding: '1px 6px',
              letterSpacing: 0.3,
            }}
          >
            {TYPE_LABEL[t] ?? t}
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4, color: '#f4f5fa', wordBreak: 'break-word' }}>
          {leafDisplayName(node, labelMode, contentTitles)}
        </div>
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: preview ? '#b7b9c6' : '#76788a',
            marginTop: 6,
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {preview || '（无摘要）'}
        </div>
        <div style={{ fontSize: 11, color: '#6f7180', marginTop: 8 }}>点击阅读全文</div>
      </div>
    );
  }

  const tally = tallySubtreeTypes(node);
  const label = node.kind === 'root' ? '知识库' : depth <= 1 ? '分类' : depth === 2 ? '应用' : '子模块';

  // 根：紧凑（路径 + 名称 + 篇数 + 分布）
  if (!showList) {
    return (
      <div style={baseStyle}>
        <PathLine names={pathNames} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: '#9aa0b4', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 6px' }}>
            {label}
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4, color: '#f4f5fa', wordBreak: 'break-word' }}>
          {node.name}
        </div>
        <div style={{ fontSize: 12, color: '#b7b9c6', marginTop: 4 }}>共 {node.docCount} 篇文档</div>
        <TypeBars tally={tally} max={6} />
        <div style={{ fontSize: 11, color: '#6f7180', marginTop: 8 }}>点击聚焦该簇</div>
      </div>
    );
  }

  // 分类/应用/子模块：概览（路径 + 名称 + 篇数 + 分布）+ 可点文档清单（悬停保持）
  const CAP = 100;
  const leaves = collectLeaves(node);
  const shown = leaves.slice(0, CAP);
  const rest = leaves.length - shown.length;
  return (
    <div style={baseStyle} onMouseEnter={onKeepAlive} onMouseLeave={onScheduleClose}>
      <div style={{ flexShrink: 0, paddingRight: 4 }}>
        <PathLine names={pathNames} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: '#9aa0b4', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 6px' }}>
            {label}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#f4f5fa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.name}
          </span>
          <span style={{ fontSize: 12, color: '#b7b9c6', flexShrink: 0 }}>{node.docCount} 篇</span>
        </div>
        <TypeBars tally={tally} max={6} />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          marginTop: 8,
          paddingRight: 4,
        }}
      >
        {shown.map((leaf) => {
          const lt = leaf.docType ?? 'unknown';
          const preview = hoveredId === leaf.id ? cleanPreview(leaf.summary) : '';
          return (
            <button
              key={leaf.id}
              type="button"
              onClick={() => leaf.entryId && onOpenLeaf(leaf.entryId)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
                width: '100%',
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                borderRadius: 7,
                padding: '6px 8px',
                cursor: 'pointer',
                color: '#dcdde6',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
                setHoveredId(leaf.id);
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                setHoveredId((id) => (id === leaf.id ? null : id));
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: colorForDocType(lt), boxShadow: `0 0 6px ${colorForDocType(lt)}` }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {leafDisplayName(leaf, labelMode, contentTitles)}
                </span>
              </span>
              {/* 悬停展开：正文预览（2 行截断） */}
              {preview && (
                <span
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    fontSize: 11,
                    color: '#8f93a3',
                    marginTop: 2,
                    paddingLeft: 16,
                  }}
                >
                  {preview}
                </span>
              )}
            </button>
          );
        })}
        {rest > 0 && (
          <div style={{ fontSize: 11, color: '#6f7180', padding: '6px 8px 2px' }}>还有 {rest} 篇 · 点枢纽聚焦后查看全部</div>
        )}
      </div>
    </div>
  );
}

// 顶部图例 type chip 悬浮飞出：该 type 全部文档清单（半屏可滚，点条目跳转）。
function TypeDocFlyout({
  type,
  leaves,
  labelMode,
  contentTitles,
  onOpen,
  onKeepAlive,
  onScheduleClose,
}: {
  type: string;
  leaves: GalaxyNode[];
  labelMode: GalaxyLabelMode;
  contentTitles: Map<string, string>;
  onOpen: (entryId: string) => void;
  onKeepAlive: () => void;
  onScheduleClose: () => void;
}) {
  const sorted = [...leaves].sort((a, b) =>
    leafDisplayName(a, labelMode, contentTitles).localeCompare(leafDisplayName(b, labelMode, contentTitles), 'zh'),
  );
  // 悬停某行 → 展开该文档的正文预览（第 2 行，2 行截断）
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  return (
    <div
      onMouseEnter={onKeepAlive}
      onMouseLeave={onScheduleClose}
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        width: 340,
        maxWidth: '92vw',
        maxHeight: '52vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(15,16,24,0.96)',
        backdropFilter: 'blur(16px) saturate(140%)',
        WebkitBackdropFilter: 'blur(16px) saturate(140%)',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 12,
        boxShadow: '0 14px 38px rgba(0,0,0,0.6)',
        zIndex: 40,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: TYPE_COLOR[type] ?? TYPE_COLOR.unknown, boxShadow: `0 0 6px ${TYPE_COLOR[type] ?? TYPE_COLOR.unknown}` }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#eef0f5' }}>{TYPE_LABEL[type] ?? type}</span>
        <span style={{ fontSize: 11, color: '#8a8c9a' }}>{sorted.length} 篇 · 点条目打开</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '6px 6px 8px' }}>
        {sorted.length === 0 && (
          <div style={{ fontSize: 12, color: '#76788a', padding: '8px 10px' }}>该类型暂无文档。</div>
        )}
        {sorted.map((leaf) => {
          const preview = hoveredId === leaf.id ? cleanPreview(leaf.summary) : '';
          return (
            <button
              key={leaf.id}
              type="button"
              onClick={() => leaf.entryId && onOpen(leaf.entryId)}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
                setHoveredId(leaf.id);
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                setHoveredId((id) => (id === leaf.id ? null : id));
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
                width: '100%',
                textAlign: 'left',
                background: 'transparent',
                border: 'none',
                borderRadius: 7,
                padding: '6px 8px',
                cursor: 'pointer',
                color: '#dcdde6',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: colorForDocType(leaf.docType) }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {leafDisplayName(leaf, labelMode, contentTitles)}
                </span>
              </span>
              {/* 悬停展开：正文预览（2 行截断） */}
              {preview && (
                <span
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    fontSize: 11,
                    color: '#8f93a3',
                    marginTop: 2,
                    paddingLeft: 15,
                  }}
                >
                  {preview}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface GalaxyCanvasProps {
  galaxy: DocGalaxy;
  typeOn: Record<string, boolean>;
  onOpen: (entryId: string) => void;
  /** 标签显示模式（结构名/正文标题）。影响 hover 卡 + 聚焦面板里叶子名。 */
  labelMode: GalaxyLabelMode;
  /** entryId → 正文标题（content 模式取用）。 */
  contentTitles: Map<string, string>;
  /** 聚焦枢纽变化（用于上报面包屑；null = 复位）。 */
  onFocusChange?: (node: GalaxyNode | null) => void;
  /** 外层请求把相机飞到某文档（值变化即触发；通常 = 当前打开的 entryId）。 */
  flyToEntryId?: string | null;
  /** 外层请求聚焦某枢纽（面包屑下拉选兄弟分组时用；带单调递增 token，重复点同一 id 也能再次触发）。 */
  focusHubReq?: { id: string; n: number } | null;
  /** 阅读抽屉宽度(px，0=关)：打开时按实际宽度用 setViewOffset 把星系投影左移，让聚焦星居中于左半可见区。 */
  drawerWidth?: number;
}

/**
 * Vanilla three.js 渲染内核。挂一个 <div ref>，useEffect 里建 renderer/scene/camera/controls/composer，
 * 选择性 bloom 双 pass。type 筛选通过 typeOn 同步给场景（dim/hide leaf）。
 * unmount / galaxy 变化时彻底 dispose，避免 React 重复挂载泄漏。
 */
function GalaxyCanvas({ galaxy, typeOn, onOpen, labelMode, contentTitles, onFocusChange, flyToEntryId, focusHubReq, drawerWidth }: GalaxyCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  // 选中文档的发光旋转指针环（DOM 覆盖层，渲染循环每帧把它定位到选中星的屏幕投影处）
  const selRingRef = useRef<HTMLDivElement>(null);
  // 选中文档的标题标签（叶子不生成常驻标签 sprite，选中时在环下方显示标题，
  // 解决「选中的文档星没有标题」——用户反馈「这朵蘑菇居然没有标题」）。
  const selLabelRef = useRef<HTMLDivElement>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  // hover 缩略卡：3D 坐标 project 到屏幕后用绝对定位 DOM 卡片渲染（叶子=标题+摘要，枢纽=篇数+分布）
  const [hover, setHover] = useState<HoverInfo | null>(null);
  // 枢纽聚焦信息面板（点击枢纽后出现，含直接子节点列表）
  const [focusInfo, setFocusInfo] = useState<FocusInfo | null>(null);

  // typeOn 用 ref 透传给渲染循环，避免每次筛选都重建整个场景
  const typeOnRef = useRef(typeOn);
  typeOnRef.current = typeOn;
  // applyFilter 函数引用，typeOn 变化时调用
  const applyFilterRef = useRef<(() => void) | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onFocusChangeRef = useRef(onFocusChange);
  onFocusChangeRef.current = onFocusChange;
  // labelMode / contentTitles 走 ref：主场景 effect 只在 galaxy 变化时重建，标签文本切换走 relabelRef 重绘
  const labelModeRef = useRef(labelMode);
  labelModeRef.current = labelMode;
  const contentTitlesRef = useRef(contentTitles);
  contentTitlesRef.current = contentTitles;
  const relabelRef = useRef<(() => void) | null>(null);
  // 显示模式切换 → 重绘已有标签纹理（不重建场景）
  useEffect(() => {
    relabelRef.current?.();
  }, [labelMode, contentTitles]);
  // hover 关闭延时：让指针从节点移动到「枢纽清单卡」时不立刻消失（可点跳转）。
  // useCallback 稳定 identity，便于进 effect deps 而不触发场景重建。
  const hoverCloseTimerRef = useRef<number | null>(null);
  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);
  const scheduleHoverClose = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => setHover(null), 220);
  }, [cancelHoverClose]);
  useEffect(() => () => cancelHoverClose(), [cancelHoverClose]);
  // 聚焦/复位的命令引用（由 useEffect 内部填充，供面板列表点击 / 返回按钮调用）
  const focusNodeRef = useRef<((node: GalaxyNode) => void) | null>(null);
  const resetFocusRef = useRef<(() => void) | null>(null);
  // 飞到某文档的命令引用（图例飞出 / 面包屑 / 打开文档时让相机动起来，不再原地不动）
  const flyToRef = useRef<((entryId: string) => void) | null>(null);
  // 复位视角命令引用（常驻「复位」按钮：回中心 + 清聚焦 + 继续自动旋转）
  const recenterRef = useRef<(() => void) | null>(null);
  // 取消选中命令引用（关闭抽屉时停掉持续选中态）
  const clearSelectionRef = useRef<(() => void) | null>(null);
  // 聚焦某枢纽命令引用（面包屑下拉选兄弟分组时用）
  const focusHubRef = useRef<((id: string) => void) | null>(null);
  // 抽屉宽度 → 相机投影左移（左右分屏时聚焦星居中于左半可见区）
  const drawerWidthRef = useRef(drawerWidth);
  drawerWidthRef.current = drawerWidth;
  const applyViewOffsetRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    applyFilterRef.current?.();
  }, [typeOn]);

  // 抽屉宽度变化（开合 / 拖拽改宽）→ 重算投影偏移
  useEffect(() => {
    applyViewOffsetRef.current?.();
  }, [drawerWidth]);

  // 外层打开某文档（flyToEntryId 变化）→ 相机飞到它并进入持续选中态；关闭则清除选中态
  useEffect(() => {
    if (flyToEntryId) flyToRef.current?.(flyToEntryId);
    else clearSelectionRef.current?.();
  }, [flyToEntryId]);

  // 外层请求聚焦某枢纽（面包屑下拉）。focusHubReq 带单调 token，重复点同一兄弟也能再次聚焦。
  useEffect(() => {
    if (focusHubReq) focusHubRef.current?.(focusHubReq.id);
  }, [focusHubReq]);

  // 选中指针环用到的 CSS 动画关键帧（旋转 + 呼吸辉光）注入一次（全局 style，id 守卫防重复）。
  useEffect(() => {
    const ID = 'galaxy-sel-ring-keyframes';
    if (document.getElementById(ID)) return;
    const el = document.createElement('style');
    el.id = ID;
    el.textContent = [
      '@keyframes galaxy-sel-spin { from { transform: translate(-50%, -50%) rotate(0deg) } to { transform: translate(-50%, -50%) rotate(360deg) } }',
      '@keyframes galaxy-sel-pulse { 0%,100% { opacity: 0.55 } 50% { opacity: 1 } }',
    ].join('\n');
    document.head.appendChild(el);
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    setFatal(null);
    setHover(null);
    setFocusInfo(null);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '无法创建 WebGL 上下文');
      return;
    }

    let W = mount.clientWidth || 1;
    let H = mount.clientHeight || 1;
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // 演示版数值 SSOT：深空底色 0x02030a
    renderer.setClearColor(0x02030a, 1);
    // 注意：走 EffectComposer 渲染到 render target 时 three 不应用 renderer.toneMapping，
    // 输出实际是线性值在 1.0 硬截断。防死白依赖 haloOpacity 压底 + glow x0.85 软叠加 +
    // bloom threshold 0.72 的手工调校（视觉按此校准，不要再假设有 ACES 滚降兜底）。
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    // 画布整体淡入（重建场景时同样生效，形成柔和交叉淡化）
    mount.style.opacity = '0';
    mount.style.transition = 'opacity 900ms ease';
    requestAnimationFrame(() => {
      mount.style.opacity = '1';
    });

    // 入场编排的时间原点（生长波 / 光路淡入 / 相机推进共用）。
    // 窗口长度在节点建完后按「最大 introDelay + 单节点生长时长」动态收口（见下方赋值），
    // 固定值会在深层大库上提前关窗，让外围星体从半程直接弹到终态（Bugbot 2b920e92）。
    const introStart = performance.now();
    let INTRO_TOTAL = 2600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02030a);
    // 演示版极淡指数雾（大尺度场景，0.00035）
    scene.fog = new THREE.FogExp2(0x02030a, 0.00035);

    // 演示版相机：fov 60、近 1 远 12000；入场从远处 (0,260,2450) 缓推到常驻位 (0,120,1050)
    const camera = new THREE.PerspectiveCamera(60, W / H, 1, 12000);
    camera.position.set(0, 260, 2450);

    // 抽屉打开时：把投影窗口右移 inset/2（内容左移），使屏幕中心（聚焦星落点）落在左半可见区中心。
    // 选中环/hover 卡/拾取都走 project(camera)/raycaster，自动跟随该偏移，不需额外处理。
    const applyViewOffset = () => {
      const dw = drawerWidthRef.current ?? 0;
      // 抽屉实际占宽 + 右侧 12 边距，封顶 94vw，与 ReaderPanel 自身宽度一致 → 聚焦星稳居左半中心
      const inset = dw > 0 ? Math.min(dw + 12, W * 0.94) : 0;
      if (inset > 0 && inset < W) camera.setViewOffset(W, H, inset / 2, 0, W, H);
      else camera.clearViewOffset();
    };
    applyViewOffsetRef.current = applyViewOffset;
    applyViewOffset();

    // 演示版 OrbitControls：影院级阻尼/惯性
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.045;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.78;
    controls.minDistance = 70;
    controls.maxDistance = 6500;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.42;
    controls.enablePan = true;
    // 滚轮/触控板手势改由自定义 wheel 接管：
    // 两指滑动 = 围绕当前中心旋转视角、⌘/Ctrl+滚轮 或 双指捏合 = 缩放。
    controls.enableZoom = false;

    // 用于 dispose 的资源台账
    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    // ── 程序贴图 ──
    const HALO_TEX = track(
      makeRadialTexture([
        [0, 'rgba(255,255,255,0.85)'],
        [0.22, 'rgba(255,255,255,0.45)'],
        [0.55, 'rgba(255,255,255,0.14)'],
        [1, 'rgba(255,255,255,0)'],
      ]),
    );
    const STAR_TEX = track(
      makeRadialTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.4, 'rgba(255,255,255,0.5)'],
        [1, 'rgba(255,255,255,0)'],
      ]),
    );

    // ── 选择性 bloom 分层：只有星体核心 mesh 在 BLOOM_LAYER ──
    const BLOOM_LAYER = 1;
    const bloomLayer = new THREE.Layers();
    bloomLayer.set(BLOOM_LAYER);

    // ── 渐变深空穹顶：天顶靛蓝 → 地底近黑 + 赤道微光带，杀死「纯色底」的死板 ──
    {
      const domeMat = track(
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          depthWrite: false,
          fog: false,
          vertexShader: `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
          fragmentShader: `
varying vec3 vDir;
void main() {
  float h = vDir.y * 0.5 + 0.5;
  vec3 top = vec3(0.012, 0.015, 0.040);
  vec3 bottom = vec3(0.004, 0.005, 0.014);
  vec3 col = mix(bottom, top, smoothstep(0.0, 1.0, h));
  float by = vDir.y * 2.6;
  float band = exp(-by * by);
  col += vec3(0.010, 0.008, 0.024) * band;
  col += vec3(0.006, 0.002, 0.010) * (vDir.x * 0.5 + 0.5) * band;
  gl_FragColor = vec4(col, 1.0);
}`,
        }),
      );
      const dome = new THREE.Mesh(track(new THREE.SphereGeometry(8000, 48, 32)), domeMat);
      dome.renderOrder = -20;
      scene.add(dome);
    }

    // ── 双层闪烁星场（自定义 shader points：逐星尺寸 / 色温 / 相位 / 呼吸速度）──
    const STAR_VERT = `
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
attribute float aSpin;
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vA;
void main() {
  vColor = aColor;
  vA = 0.72 + 0.28 * sin(uTime * aSpin + aPhase);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(aSize * uScale / -mv.z, 0.75);
  gl_Position = projectionMatrix * mv;
}`;
    const STAR_FRAG = `
uniform sampler2D uMap;
varying vec3 vColor;
varying float vA;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor, 1.0) * t * vA;
}`;
    const buildStarCloud = (
      count: number,
      rMin: number,
      rMax: number,
      sizeMin: number,
      sizeMax: number,
      warm: number,
    ): { points: THREE.Points; uniforms: { uTime: { value: number }; uScale: { value: number }; uMap: { value: THREE.Texture } } } => {
      const positions = new Float32Array(count * 3);
      const sizes = new Float32Array(count);
      const colors = new Float32Array(count * 3);
      const phases = new Float32Array(count);
      const spins = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const r = rMin + Math.random() * (rMax - rMin);
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(ph) * Math.cos(th);
        positions[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        positions[i * 3 + 2] = r * Math.cos(ph);
        sizes[i] = sizeMin + Math.pow(Math.random(), 1.8) * (sizeMax - sizeMin);
        // 色温分布：多数冷白、少数暖金 / 蓝巨星；远星整体压暗
        const roll = Math.random();
        let cr: number;
        let cg: number;
        let cb: number;
        if (roll < warm) {
          cr = 1.0; cg = 0.86; cb = 0.66; // 暖金
        } else if (roll < warm + 0.16) {
          cr = 0.66; cg = 0.78; cb = 1.0; // 蓝巨星
        } else {
          cr = 0.92; cg = 0.95; cb = 1.0; // 冷白
        }
        const distDim = 1 - ((r - rMin) / Math.max(1, rMax - rMin)) * 0.45;
        const b = (0.4 + Math.random() * 0.6) * distDim;
        colors[i * 3] = cr * b;
        colors[i * 3 + 1] = cg * b;
        colors[i * 3 + 2] = cb * b;
        phases[i] = Math.random() * Math.PI * 2;
        spins[i] = 0.4 + Math.random() * 1.6;
      }
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
      geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
      geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
      geo.setAttribute('aSpin', new THREE.Float32BufferAttribute(spins, 1));
      const uniforms = { uTime: { value: 0 }, uScale: { value: renderer.domElement.height * 0.5 }, uMap: { value: STAR_TEX } };
      const mat = track(
        new THREE.ShaderMaterial({
          uniforms,
          vertexShader: STAR_VERT,
          fragmentShader: STAR_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const points = new THREE.Points(geo, mat);
      scene.add(points);
      return { points, uniforms };
    };
    // 远景细星海 + 近景亮星（亮星更大、暖星比例略高，呼吸更明显）
    const farStars = buildStarCloud(6200, 2600, 7400, 2.0, 5.0, 0.08);
    const nearStars = buildStarCloud(420, 1600, 5200, 4.5, 9.5, 0.16);

    // ── 银心辉光：暖白内芯 + 冷蓝外晕，赋予全场光源方向感 ──
    {
      const inner = new THREE.Sprite(
        track(
          new THREE.SpriteMaterial({
            map: HALO_TEX,
            color: new THREE.Color('#ffedc8'),
            transparent: true,
            opacity: 0.14,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        ),
      );
      inner.scale.set(460, 460, 1);
      inner.renderOrder = -5;
      scene.add(inner);
      const outer = new THREE.Sprite(
        track(
          new THREE.SpriteMaterial({
            map: HALO_TEX,
            color: new THREE.Color('#86a8ff'),
            transparent: true,
            opacity: 0.06,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        ),
      );
      outer.scale.set(1200, 1200, 1);
      outer.renderOrder = -6;
      scene.add(outer);
    }

    // ── EVE 风远景星云：384px 多团簇贴图、更丰富的靛紫青色相、各片独立微旋 ──
    const nebulaGroup = new THREE.Group();
    scene.add(nebulaGroup);
    const nebulaSpins: Array<{ mat: THREE.SpriteMaterial; spin: number }> = [];
    {
      // 每片由主团 + 若干卫星云团叠成，双色渐染更有层次
      const makeNebulaTex = (hue: string, accent: string): THREE.Texture => {
        const c = document.createElement('canvas');
        c.width = c.height = 384;
        const g = c.getContext('2d')!;
        const blob = (color: string, cx: number, cy: number, rad: number, a: number) => {
          const rg = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
          rg.addColorStop(0, color + Math.round(a * 255).toString(16).padStart(2, '0'));
          rg.addColorStop(0.5, color + Math.round(a * 0.32 * 255).toString(16).padStart(2, '0'));
          rg.addColorStop(1, color + '00');
          g.fillStyle = rg;
          g.beginPath();
          g.arc(cx, cy, rad, 0, Math.PI * 2);
          g.fill();
        };
        blob(hue, 150 + Math.random() * 84, 150 + Math.random() * 84, 120 + Math.random() * 60, 0.75);
        for (let k = 0; k < 7; k++) {
          blob(
            k % 3 === 0 ? accent : hue,
            70 + Math.random() * 244,
            70 + Math.random() * 244,
            36 + Math.random() * 90,
            0.3 + Math.random() * 0.4,
          );
        }
        const tex = new THREE.CanvasTexture(c);
        tex.needsUpdate = true;
        return tex;
      };
      const palettes: Array<[string, string]> = [
        ['#16224a', '#233a72'],
        ['#1a2a5e', '#2a1c56'],
        ['#2c1c56', '#4a2a6e'],
        ['#12304a', '#1a4a62'],
        ['#251743', '#3a2158'],
        ['#0f2438', '#123a54'],
        ['#331a4a', '#22224e'],
        ['#143a52', '#1c2a5e'],
      ];
      for (let i = 0; i < 18; i++) {
        const [hue, accent] = palettes[i % palettes.length];
        const mat = track(
          new THREE.SpriteMaterial({
            map: track(makeNebulaTex(hue, accent)),
            transparent: true,
            opacity: 0.34 + Math.random() * 0.26,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: false,
            rotation: Math.random() * Math.PI * 2,
          }),
        );
        const sp = new THREE.Sprite(mat);
        const r = 3200 + Math.random() * 3000;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        sp.position.set(r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th) * 0.7, r * Math.cos(ph));
        const sc = 2000 + Math.random() * 2800;
        sp.scale.set(sc, sc, 1);
        sp.renderOrder = -10;
        nebulaGroup.add(sp);
        nebulaSpins.push({ mat, spin: (Math.random() - 0.5) * 0.009 });
      }
    }

    // ── 偶发流星：远景一道细长流光划过，6..15 秒随机间隔，一次只有一颗 ──
    const STREAK_TEX = track(makeStreakTexture());
    const meteorMat = track(
      new THREE.SpriteMaterial({
        map: STREAK_TEX,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const meteorSprite = new THREE.Sprite(meteorMat);
    meteorSprite.scale.set(460, 8, 1);
    meteorSprite.visible = false;
    meteorSprite.renderOrder = -8;
    scene.add(meteorSprite);
    const meteor = {
      active: false,
      t0: 0,
      dur: 1200,
      from: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      len: 1400,
      nextAt: 4 + Math.random() * 6, // clock.elapsedTime 秒
    };
    const meteorDirCam = new THREE.Vector3();

    // ── 布局 + 节点 mesh / halo / label ──
    const { placed, edges } = layoutGalaxy(galaxy.root);
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);

    const renders: NodeRender[] = [];
    const coreMeshes: THREE.Mesh[] = [];
    // 标签随聚焦淡出 —— 单独收集 group 标签 sprite（label 没进 renders）
    const labelByNodeId = new Map<string, THREE.Sprite>();
    const sphereGeoCache = new Map<string, THREE.SphereGeometry>();
    const sphereGeo = (r: number): THREE.SphereGeometry => {
      const key = r.toFixed(2);
      let g = sphereGeoCache.get(key);
      if (!g) {
        g = track(new THREE.SphereGeometry(r, 16, 16));
        sphereGeoCache.set(key, g);
      }
      return g;
    };

    // 枢纽衍射星芒（root + 一级分类）：缓旋的十字光斑，宝石切面感
    const SPIKE_TEX = track(makeSpikeTexture());
    const sparkles: Array<{ sp: THREE.Sprite; spin: number; nodeId: string; baseOpacity: number }> = [];

    let nodeSeq = 0;
    for (const { node, pos, depth } of placed.values()) {
      const isLeaf = node.kind === 'leaf';
      const color = isLeaf ? colorForDocType(node.docType) : groupColor(node, depth);
      const col = new THREE.Color(color);

      // 演示版尺度：size 决定核心球半径(size*0.9)、光晕缩放(size*7|10)、标签偏移
      const size = nodeSize(node, depth);

      // 核心：限暗着色器（视线正对处白热、边缘回落本色）—— 选择性 bloom 只让热核溢出
      const r = coreRadiusFromSize(size);
      const coreU: CoreUniforms = {
        uColor: { value: col.clone() },
        uOpacity: { value: 1 },
        uBoost: { value: 1 },
      };
      const coreMat = track(
        new THREE.ShaderMaterial({
          uniforms: coreU as unknown as Record<string, THREE.IUniform>,
          vertexShader: CORE_VERT,
          fragmentShader: CORE_FRAG,
          transparent: true,
        }),
      );
      const core = new THREE.Mesh(sphereGeo(r), coreMat);
      core.position.copy(pos);
      core.userData.node = node;
      core.layers.enable(BLOOM_LAYER); // 只有核心进入 bloom pass
      nodeGroup.add(core);
      coreMeshes.push(core);

      // 光晕 sprite（不进 bloom 层，距离衰减）—— 演示版小而克制，杜绝大白团
      const haloBaseOpacity = haloOpacity(node, depth);
      const haloSize = haloScaleFromSize(node, size);
      const haloMat = track(
        new THREE.SpriteMaterial({
          map: HALO_TEX,
          color: col,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const halo = new THREE.Sprite(haloMat);
      halo.position.copy(pos);
      halo.scale.set(haloSize, haloSize, 1);
      nodeGroup.add(halo);

      // 星芒：root 与一级分类枢纽专属，尺度收敛、透明度极低（点缀而非喧宾）
      if (node.kind === 'root' || (!isLeaf && depth <= 1)) {
        const spikeBaseOpacity = node.kind === 'root' ? 0.13 : 0.1;
        const spikeMat = track(
          new THREE.SpriteMaterial({
            map: SPIKE_TEX,
            color: col,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            rotation: Math.random() * Math.PI,
          }),
        );
        const spike = new THREE.Sprite(spikeMat);
        spike.position.copy(pos);
        const spikeScale = size * (node.kind === 'root' ? 26 : 20);
        spike.scale.set(spikeScale, spikeScale, 1);
        spike.renderOrder = 2;
        nodeGroup.add(spike);
        sparkles.push({
          sp: spike,
          spin: (Math.random() < 0.5 ? -1 : 1) * (0.02 + Math.random() * 0.03),
          nodeId: node.id,
          baseOpacity: spikeBaseOpacity,
        });
      }

      // 枢纽标签（root / group）。文本随显示模式：结构段名 / 单文档簇取正文标题。
      let labelSprite: THREE.Sprite | null = null;
      if (!isLeaf) {
        const lab = makeLabelSprite(labelTextFor(node, labelModeRef.current, contentTitlesRef.current), node.kind, depth, color);
        if (lab.material.map) track(lab.material.map);
        track(lab.material);
        // 演示版标签偏移：size + (root?14:8)
        const dy = size + (node.kind === 'root' ? 14 : 8);
        lab.position.set(pos.x, pos.y + dy, pos.z);
        nodeGroup.add(lab);
        labelSprite = lab;
      }

      renders.push({
        node,
        core,
        coreU,
        halo,
        haloBaseSize: haloSize,
        haloBaseOpacity,
        size,
        depth,
        twPhase: hash01(nodeSeq * 7 + 1) * Math.PI * 2,
        hoverK: 0,
        // 入场生长波：银心向外扩散（按半径），同层再按层深微错峰
        introDelay: pos.length() * 1.05 + depth * 90 + hash01(nodeSeq * 13 + 5) * 120,
      });
      nodeSeq += 1;
      if (labelSprite) labelByNodeId.set(node.id, labelSprite);
    }

    // 标签入场延迟对齐其节点（渲染循环里按距离 + 入场双重淡入）
    const introDelayById = new Map<string, number>();
    for (const rec of renders) introDelayById.set(rec.node.id, rec.introDelay);

    // 入场窗口收口：保证最晚出发的节点也完整走完 850ms 生长曲线再关窗（+60ms 余量）
    INTRO_TOTAL = renders.reduce((m, r) => Math.max(m, r.introDelay), 0) + 850 + 60;

    // 显示模式切换 → 按当前 labelMode/contentTitles 重绘标签纹理（不重建场景）。
    // 文本没变的标签跳过重绘：多数分组两种模式下同名，白白重画一遍 2x 纹理是纯浪费。
    relabelRef.current = () => {
      const mode = labelModeRef.current;
      const titles = contentTitlesRef.current;
      for (const [id, sprite] of labelByNodeId) {
        const pl = placed.get(id);
        if (!pl) continue;
        const text = labelTextFor(pl.node, mode, titles);
        if (sprite.userData.labelText === text) continue;
        sprite.userData.labelText = text;
        track(redrawLabelSprite(sprite, text));
      }
    };

    // ── 父子光路：二次贝塞尔弧线（向外微拱），顶点色父端亮蓝 → 子端渐隐、
    //    叶子端混入该文档 type 色。位置由 applyFilter 填充：隐藏子树的边折叠为零长。 ──
    const SEG_H = 12;
    const HIER_BASE = new THREE.Color('#5a86c8');
    const edgeCurvePts: THREE.Vector3[][] = [];
    {
      const mid = new THREE.Vector3();
      const ctrl = new THREE.Vector3();
      for (const e of edges) {
        mid.copy(e.a).add(e.b).multiplyScalar(0.5);
        const len = e.a.distanceTo(e.b);
        const bow = Math.min(40, len * 0.14);
        ctrl.copy(mid);
        if (mid.lengthSq() > 1e-6) ctrl.addScaledVector(mid.clone().normalize(), bow);
        edgeCurvePts.push(new THREE.QuadraticBezierCurve3(e.a.clone(), ctrl.clone(), e.b.clone()).getPoints(SEG_H));
      }
    }
    const hierGeo = track(new THREE.BufferGeometry());
    hierGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(edges.length * SEG_H * 2 * 3), 3));
    // 顶点色基线（聚焦压暗时按倍率重写）：t 从父端到子端，亮度 0.92 → 0.34
    const hierBase = new Float32Array(edges.length * SEG_H * 2 * 3);
    {
      const cA = new THREE.Color();
      const cB = new THREE.Color();
      const cT = new THREE.Color();
      edges.forEach((e, i) => {
        cA.copy(HIER_BASE);
        cB.copy(HIER_BASE);
        if (e.child.kind === 'leaf') cB.lerp(new THREE.Color(colorForDocType(e.child.docType)), 0.5);
        const o = i * SEG_H * 2 * 3;
        for (let s = 0; s < SEG_H; s++) {
          for (let k = 0; k < 2; k++) {
            const t = (s + k) / SEG_H;
            cT.copy(cA).lerp(cB, t).multiplyScalar(0.92 - 0.58 * t);
            const j = o + (s * 2 + k) * 3;
            hierBase[j] = cT.r;
            hierBase[j + 1] = cT.g;
            hierBase[j + 2] = cT.b;
          }
        }
      });
    }
    const hierColorAttr = new THREE.Float32BufferAttribute(hierBase.slice(), 3);
    hierGeo.setAttribute('color', hierColorAttr);
    const hierMat = track(
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    scene.add(new THREE.LineSegments(hierGeo, hierMat));

    // ── 横向引用：拱高更大的能量弧（两端暗、中段亮），任一端隐藏则折叠 ──
    const SEG_M = 16;
    const mentionPairs: Array<{ a: THREE.Vector3; b: THREE.Vector3; source: string; target: string }> = [];
    for (const link of galaxy.links) {
      const a = placed.get(link.source);
      const b = placed.get(link.target);
      if (a && b) mentionPairs.push({ a: a.pos, b: b.pos, source: link.source, target: link.target });
    }
    const mentionCurvePts: THREE.Vector3[][] = [];
    let mentionGeo: THREE.BufferGeometry | null = null;
    let mentionColorAttr: THREE.Float32BufferAttribute | null = null;
    let mentionBase: Float32Array | null = null;
    let mentionMat: THREE.LineBasicMaterial | null = null;
    const mentionVisibleArr: boolean[] = mentionPairs.map(() => true);
    // 聚焦压暗时不在 keep 集合的引用弧 → 其流光脉冲同步驻留（不再在暗弧上亮闪）
    const mentionFocusKeep: boolean[] = mentionPairs.map(() => true);
    if (mentionPairs.length > 0) {
      const mid = new THREE.Vector3();
      const ctrl = new THREE.Vector3();
      for (const m of mentionPairs) {
        mid.copy(m.a).add(m.b).multiplyScalar(0.5);
        const len = m.a.distanceTo(m.b);
        ctrl.copy(mid);
        if (mid.lengthSq() > 1e-6) ctrl.addScaledVector(mid.clone().normalize(), len * 0.22);
        mentionCurvePts.push(new THREE.QuadraticBezierCurve3(m.a.clone(), ctrl.clone(), m.b.clone()).getPoints(SEG_M));
      }
      mentionGeo = track(new THREE.BufferGeometry());
      mentionGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(mentionPairs.length * SEG_M * 2 * 3), 3),
      );
      mentionBase = new Float32Array(mentionPairs.length * SEG_M * 2 * 3);
      const cRef = new THREE.Color('#8fc4ff');
      for (let i = 0; i < mentionPairs.length; i++) {
        const o = i * SEG_M * 2 * 3;
        for (let s = 0; s < SEG_M; s++) {
          for (let k = 0; k < 2; k++) {
            const t = (s + k) / SEG_M;
            const lum = 0.25 + 0.75 * Math.sin(Math.PI * t);
            const j = o + (s * 2 + k) * 3;
            mentionBase[j] = cRef.r * lum;
            mentionBase[j + 1] = cRef.g * lum;
            mentionBase[j + 2] = cRef.b * lum;
          }
        }
      }
      mentionColorAttr = new THREE.Float32BufferAttribute(mentionBase.slice(), 3);
      mentionGeo.setAttribute('color', mentionColorAttr);
      mentionMat = track(
        new THREE.LineBasicMaterial({
          color: 0xffffff,
          vertexColors: true,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      scene.add(new THREE.LineSegments(mentionGeo, mentionMat));
    }

    // ── 引用流光脉冲：小光点沿引用弧巡游（知识在流动）。上限 320 条控制成本。 ──
    const pulseCount = Math.min(mentionPairs.length, 320);
    let pulseGeo: THREE.BufferGeometry | null = null;
    let pulseMat: THREE.PointsMaterial | null = null;
    if (pulseCount > 0) {
      pulseGeo = track(new THREE.BufferGeometry());
      const pp = new Float32Array(pulseCount * 3);
      pp.fill(1e7);
      const attr = new THREE.Float32BufferAttribute(pp, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      pulseGeo.setAttribute('position', attr);
      pulseMat = track(
        new THREE.PointsMaterial({
          size: 6,
          sizeAttenuation: true,
          map: STAR_TEX,
          color: new THREE.Color('#bfe0ff'),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      // 动态点云禁用视锥剔除：初始位置全部驻留在 1e7 远处，首帧缓存的包围球不可信
      const pulsePoints = new THREE.Points(pulseGeo, pulseMat);
      pulsePoints.frustumCulled = false;
      scene.add(pulsePoints);
    }

    // ── 主干流光：root → 一级分类的长边上各一粒缓行光点（银心在供能） ──
    const flowEdges: Array<{ edgeIdx: number }> = [];
    edges.forEach((e, i) => {
      if ((placed.get(e.child.id)?.depth ?? 0) === 1) flowEdges.push({ edgeIdx: i });
    });
    const flowVisibleArr: boolean[] = flowEdges.map(() => true);
    const flowFocusKeep: boolean[] = flowEdges.map(() => true);
    let flowGeo: THREE.BufferGeometry | null = null;
    let flowMat: THREE.PointsMaterial | null = null;
    if (flowEdges.length > 0) {
      flowGeo = track(new THREE.BufferGeometry());
      const fp = new Float32Array(flowEdges.length * 3);
      fp.fill(1e7);
      const attr = new THREE.Float32BufferAttribute(fp, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      flowGeo.setAttribute('position', attr);
      flowMat = track(
        new THREE.PointsMaterial({
          size: 5,
          sizeAttenuation: true,
          map: STAR_TEX,
          color: new THREE.Color('#9db8ff'),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      // 同上：动态点云禁用视锥剔除
      const flowPoints = new THREE.Points(flowGeo, flowMat);
      flowPoints.frustumCulled = false;
      scene.add(flowPoints);
    }

    // ── 聚焦时光路同步压暗：keep 集合外的边按倍率重写顶点色（一次性写，非每帧） ──
    const applyEdgeDim = (keep: Set<string> | null) => {
      const arr = hierColorAttr.array as Float32Array;
      const span = SEG_H * 2 * 3;
      edges.forEach((e, i) => {
        const f = !keep || keep.has(e.child.id) ? 1 : 0.1;
        const o = i * span;
        for (let j = 0; j < span; j++) arr[o + j] = hierBase[o + j] * f;
      });
      hierColorAttr.needsUpdate = true;
      if (mentionColorAttr && mentionBase) {
        const marr = mentionColorAttr.array as Float32Array;
        const mspan = SEG_M * 2 * 3;
        mentionPairs.forEach((m, i) => {
          const keepThis = !keep || keep.has(m.source) || keep.has(m.target);
          mentionFocusKeep[i] = keepThis;
          const f = keepThis ? 1 : 0.08;
          const o = i * mspan;
          for (let j = 0; j < mspan; j++) marr[o + j] = mentionBase![o + j] * f;
        });
        mentionColorAttr.needsUpdate = true;
      }
      // 主干流光跟随聚焦：keep 集合外的分类干线不再流光
      flowEdges.forEach((fe, k) => {
        flowFocusKeep[k] = !keep || keep.has(edges[fe.edgeIdx].child.id);
      });
    };

    // ── type 筛选：隐藏被关类型的叶子 + 「空分组」整体隐藏（核心/光晕/标签）+ 折叠入边/引用线 ──
    const applyFilter = () => {
      const on = typeOnRef.current;
      // 任一类型（含 unknown）被关 → 进入过滤；按 docType ?? 'unknown' 取开关
      const anyOff = Object.values(on).some((v) => v === false);
      const vis = new Map<string, boolean>();
      // 自底向上算可见性：叶子按 type 开关；分组「子树里还有可见叶才可见」（root 恒可见，避免整图消失）。
      // 这样某分类/应用/子模块下的文档被筛光时，空枢纽 + 其标签一并消失，不再悬空（Codex P2）。
      const computeVisible = (n: GalaxyNode): boolean => {
        let v: boolean;
        if (n.kind === 'leaf') {
          v = !anyOff || on[n.docType ?? 'unknown'] !== false;
        } else {
          let anyChild = false;
          for (const c of n.children) if (computeVisible(c)) anyChild = true;
          v = n.kind === 'root' ? true : anyChild;
        }
        vis.set(n.id, v);
        return v;
      };
      computeVisible(galaxy.root);
      // 应用到所有节点（分组也参与）：核心球 / 光晕 / 标签 一起显隐
      for (const rec of renders) {
        const visible = vis.get(rec.node.id) ?? true;
        rec.core.visible = visible;
        rec.halo.visible = visible;
        const lab = labelByNodeId.get(rec.node.id);
        if (lab) lab.visible = visible;
      }
      // 星芒随其节点显隐（root 恒可见；一级分类可能被筛空）
      for (const s of sparkles) s.sp.visible = vis.get(s.nodeId) ?? true;
      // 父子弧线：子端隐藏 → 整条折叠到父端（零长，不可见）
      const hp = hierGeo.getAttribute('position') as THREE.BufferAttribute;
      edges.forEach((e, i) => {
        const show = vis.get(e.child.id) ?? true;
        const pts = edgeCurvePts[i];
        const o = i * SEG_H * 2;
        for (let s = 0; s < SEG_H; s++) {
          const p0 = show ? pts[s] : e.a;
          const p1 = show ? pts[s + 1] : e.a;
          hp.setXYZ(o + s * 2, p0.x, p0.y, p0.z);
          hp.setXYZ(o + s * 2 + 1, p1.x, p1.y, p1.z);
        }
      });
      hp.needsUpdate = true;
      // 引用弧：任一端隐藏 → 折叠；同步登记可见性给流光脉冲（隐藏的弧不再巡游）
      if (mentionGeo) {
        const mp = mentionGeo.getAttribute('position') as THREE.BufferAttribute;
        mentionPairs.forEach((m, i) => {
          const show = (vis.get(m.source) ?? true) && (vis.get(m.target) ?? true);
          mentionVisibleArr[i] = show;
          const pts = mentionCurvePts[i];
          const o = i * SEG_M * 2;
          for (let s = 0; s < SEG_M; s++) {
            const p0 = show ? pts[s] : m.a;
            const p1 = show ? pts[s + 1] : m.a;
            mp.setXYZ(o + s * 2, p0.x, p0.y, p0.z);
            mp.setXYZ(o + s * 2 + 1, p1.x, p1.y, p1.z);
          }
        });
        mp.needsUpdate = true;
      }
      // 主干流光可见性跟随其分类枢纽
      flowEdges.forEach((f, k) => {
        flowVisibleArr[k] = vis.get(edges[f.edgeIdx].child.id) ?? true;
      });
    };
    applyFilterRef.current = applyFilter;
    applyFilter();

    // ── 枢纽聚焦 + 子树高亮 + 相机缓动 ──
    // 每节点的目标亮度系数（1=高亮，<1=淡出）。渲染循环 lerp 到该目标，过渡平滑。
    const dimTargetById = new Map<string, number>();
    const dimCurrentById = new Map<string, number>();
    for (const rec of renders) {
      dimTargetById.set(rec.node.id, 1);
      dimCurrentById.set(rec.node.id, 1);
    }
    let focusedNodeId: string | null = null;

    const subtreeIds = (node: GalaxyNode): Set<string> => {
      const ids = new Set<string>();
      const walk = (n: GalaxyNode) => {
        ids.add(n.id);
        n.children.forEach(walk);
      };
      walk(node);
      return ids;
    };

    // 相机缓动：苹果式自然速度，慢起步 → 加速 → 慢停下。
    let camTween: {
      t0: number;
      dur: number;
      fromTarget: THREE.Vector3;
      toTarget: THREE.Vector3;
      fromPos: THREE.Vector3;
      toPos: THREE.Vector3;
    } | null = null;

    const startCamTween = (targetPos: THREE.Vector3, distance: number) => {
      // 沿当前相机→目标方向退到 distance 处，保留观察角度，避免镜头乱翻
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
      dir.normalize();
      const fromTarget = controls.target.clone();
      const fromPos = camera.position.clone();
      const toPos = targetPos.clone().add(dir.multiplyScalar(distance));
      camTween = {
        t0: performance.now(),
        dur: cameraTweenDurationMs(fromTarget, targetPos, fromPos, toPos),
        fromTarget,
        toTarget: targetPos.clone(),
        fromPos,
        toPos,
      };
      controls.autoRotate = false;
    };

    // 根据子树大小估算合适的观察距离（枢纽越大、子节点越多，退得越远）
    const focusDistanceFor = (node: GalaxyNode, depth: number): number => {
      const base = depth <= 1 ? 520 : depth === 2 ? 320 : 220;
      const span = Math.min(360, Math.sqrt(Math.max(1, node.docCount)) * 60);
      return Math.max(150, base + span);
    };

    // 逐层从 root 找到某节点的 id 路径（含根与自身），用于点亮祖先链
    const findIdPath = (n: GalaxyNode, target: string, acc: string[]): string[] | null => {
      if (n.id === target) return [...acc, n.id];
      for (const c of n.children) {
        const r = findIdPath(c, target, [...acc, n.id]);
        if (r) return r;
      }
      return null;
    };

    // 叶子脉冲高亮（聚焦到具体文档时让它"呼吸"一下，强化"动起来了"的反馈）
    let pulseLeafId: string | null = null;
    let pulseT0 = 0;
    // 持续选中态：被选中的文档星持续 发光 + 放大 + 呼吸动效，直到取消（关闭抽屉/复位）
    let selectedLeafId: string | null = null;

    const focusNode = (node: GalaxyNode) => {
      if (node.kind === 'leaf') return;
      const placedNode = placed.get(node.id);
      if (!placedNode) return;
      focusedNodeId = node.id;
      const inSet = subtreeIds(node);
      // 同时点亮从根到该节点的祖先链（让聚焦簇与中心仍有视觉连接）
      const ancestors = new Set<string>(findIdPath(galaxy.root, node.id, []) ?? []);
      for (const rec of renders) {
        const keep = inSet.has(rec.node.id) || ancestors.has(rec.node.id);
        dimTargetById.set(rec.node.id, keep ? 1 : 0.12);
      }
      // 光路同步压暗：keep 集合外的弧线一起退场
      const keepIds = new Set<string>(inSet);
      for (const id of ancestors) keepIds.add(id);
      applyEdgeDim(keepIds);
      const depth = placedNode.depth;
      startCamTween(placedNode.pos.clone(), focusDistanceFor(node, depth));
      // 信息面板数据
      const typeTally = tallySubtreeTypes(node);
      const childList = node.children.map((c) => ({ node: c, isLeaf: c.kind === 'leaf' }));
      setFocusInfo({ node, depth, typeTally, children: childList });
      setHover(null);
      onFocusChangeRef.current?.(node);
      selectedLeafId = null; // 选中枢纽 → 清掉文档星的持续选中态（枢纽有自己的聚焦视觉）
    };

    // 聚焦到具体文档叶：相机飞到它、点亮它与祖先链、脉冲高亮（点击列表/面包屑/星点都走这里）
    const focusLeaf = (node: GalaxyNode) => {
      const placedNode = placed.get(node.id);
      if (!placedNode) return;
      focusedNodeId = node.id;
      const keep = new Set<string>(findIdPath(galaxy.root, node.id, []) ?? [node.id]);
      keep.add(node.id);
      for (const rec of renders) dimTargetById.set(rec.node.id, keep.has(rec.node.id) ? 1 : 0.12);
      applyEdgeDim(keep);
      startCamTween(placedNode.pos.clone(), 150);
      pulseLeafId = node.id;
      pulseT0 = performance.now();
      selectedLeafId = node.id; // 进入持续选中态（发光 + 放大 + 呼吸）
      setFocusInfo(null);
      setHover(null);
      onFocusChangeRef.current?.(node);
    };
    // 供外层（图例飞出 / 面包屑 / 打开文档）命令式飞到某文档
    flyToRef.current = (entryId: string) => {
      const leaf = galaxy.leaves.find((l) => l.entryId === entryId);
      if (leaf) focusLeaf(leaf);
    };
    // 取消选中（关闭抽屉）：停掉持续选中态 + 取消变暗，但不动相机（保留当前视角）
    clearSelectionRef.current = () => {
      if (selectedLeafId) {
        const rec = renders.find((r) => r.node.id === selectedLeafId);
        if (rec) rec.core.scale.setScalar(1);
      }
      selectedLeafId = null;
      pulseLeafId = null;
      focusedNodeId = null;
      for (const rec of renders) dimTargetById.set(rec.node.id, 1);
      applyEdgeDim(null);
      setFocusInfo(null);
      onFocusChangeRef.current?.(null);
    };

    const resetFocus = () => {
      focusedNodeId = null;
      if (selectedLeafId) {
        const rec = renders.find((r) => r.node.id === selectedLeafId);
        if (rec) rec.core.scale.setScalar(1);
      }
      selectedLeafId = null;
      pulseLeafId = null;
      for (const rec of renders) dimTargetById.set(rec.node.id, 1);
      applyEdgeDim(null);
      setFocusInfo(null);
      onFocusChangeRef.current?.(null);
      // 相机平滑回到初始机位
      const fromTarget = controls.target.clone();
      const fromPos = camera.position.clone();
      const toTarget = new THREE.Vector3(0, 0, 0);
      const toPos = new THREE.Vector3(0, 120, 1050);
      camTween = {
        t0: performance.now(),
        dur: cameraTweenDurationMs(fromTarget, toTarget, fromPos, toPos),
        fromTarget,
        toTarget,
        fromPos,
        toPos,
      };
    };

    focusNodeRef.current = focusNode;
    resetFocusRef.current = resetFocus;
    recenterRef.current = () => {
      resetFocus();
      controls.autoRotate = true; // 复位即回到初始自动旋转态
    };
    // 面包屑下拉选兄弟分组 → 聚焦该枢纽（按 id 取 placed 节点）
    focusHubRef.current = (id: string) => {
      const pl = placed.get(id);
      if (pl) focusNode(pl.node);
    };

    // 入场相机推进：从远处缓推到常驻位（不关自动旋转 —— 推进中带一点公转更有生命感；
    // 任何用户手势会照常打断该 tween）
    camTween = {
      t0: performance.now() + 100,
      dur: 2400,
      fromTarget: new THREE.Vector3(0, 0, 0),
      toTarget: new THREE.Vector3(0, 0, 0),
      fromPos: camera.position.clone(),
      toPos: new THREE.Vector3(0, 120, 1050),
    };

    // ── 选择性 bloom 双 pass（演示版同款配方） ──
    const renderTargetSize = new THREE.Vector2(W, H);
    const bloomComposer = new EffectComposer(renderer);
    bloomComposer.renderToScreen = false;
    bloomComposer.addPass(new RenderPass(scene, camera));
    // strength 0.62 / radius 0.45 / threshold 0.72：核心换限暗着色器后只有热核过阈，
    // 辉光从「整球溢出」收敛为「星心溢出」，radius 微增让溢出更柔
    const bloomPass = new UnrealBloomPass(renderTargetSize, 0.62, 0.45, 0.72);
    bloomComposer.addPass(bloomPass);

    // combine + 电影级 grade 一体（单 pass）：软叠加 glow、轻色差、柔性暗角、阴影提靛、胶片颗粒去色带
    const gradeUniforms = {
      baseTexture: { value: null as THREE.Texture | null },
      bloomTexture: { value: bloomComposer.renderTarget2.texture },
      uTime: { value: 0 },
    };
    const combineMaterial = new THREE.ShaderMaterial({
      uniforms: gradeUniforms,
      vertexShader:
        'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `
uniform sampler2D baseTexture;
uniform sampler2D bloomTexture;
uniform float uTime;
varying vec2 vUv;
float hashN(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  // 轻色差：中心为零、向边缘二次增大（镜头感，不伤正文标签可读性）
  vec2 ca = c * r2 * 0.010;
  vec4 base = texture2D(baseTexture, vUv);
  base.r = mix(base.r, texture2D(baseTexture, vUv + ca).r, 0.85);
  base.b = mix(base.b, texture2D(baseTexture, vUv - ca).b, 0.85);
  vec4 glow = texture2D(bloomTexture, vUv);
  // 软叠加：glow ×0.85，重叠辉光不超过过曝阈值
  vec3 col = base.rgb + glow.rgb * 0.85;
  // 柔性暗角：把视线收向中心
  col *= 1.0 - smoothstep(0.18, 0.62, r2) * 0.34;
  // 阴影提靛：极暗处注入一点冷靛，深海而非死黑
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col += vec3(0.010, 0.012, 0.030) * (1.0 - smoothstep(0.0, 0.22, lum));
  // 胶片颗粒抖动：杀掉深空渐变的色带
  col += (hashN(gl_FragCoord.xy + vec2(uTime * 61.7, uTime * 47.3)) - 0.5) * (2.4 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}`,
    });
    const combinePass = new ShaderPass(combineMaterial, 'baseTexture');
    combinePass.needsSwap = true;

    const finalComposer = new EffectComposer(renderer);
    finalComposer.addPass(new RenderPass(scene, camera));
    finalComposer.addPass(combinePass);

    // 临时变黑/隐藏非 bloom 物体，渲染 glow，再还原
    const darkMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const matStash = new Map<string, THREE.Material | THREE.Material[]>();
    const visStash = new Map<string, boolean>();
    const darkenNonBloomed = (obj: THREE.Object3D) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && bloomLayer.test(obj.layers) === false) {
        matStash.set(obj.uuid, mesh.material);
        mesh.material = darkMat;
      } else if (
        (obj as THREE.Sprite).isSprite ||
        (obj as THREE.Line).isLine ||
        (obj as THREE.LineSegments).isLineSegments ||
        (obj as THREE.Points).isPoints
      ) {
        visStash.set(obj.uuid, obj.visible);
        obj.visible = false;
      }
    };
    const restoreMaterial = (obj: THREE.Object3D) => {
      const stashedMat = matStash.get(obj.uuid);
      if (stashedMat !== undefined) {
        (obj as THREE.Mesh).material = stashedMat;
        matStash.delete(obj.uuid);
      }
      const stashedVis = visStash.get(obj.uuid);
      if (stashedVis !== undefined) {
        obj.visible = stashedVis;
        visStash.delete(obj.uuid);
      }
    };
    const renderBloom = () => {
      scene.traverse(darkenNonBloomed);
      const oldBg = scene.background;
      const oldFog = scene.fog;
      scene.background = null; // glow 目标要黑底
      scene.fog = null;
      bloomComposer.render();
      scene.traverse(restoreMaterial);
      scene.fog = oldFog;
      scene.background = oldBg;
      finalComposer.render();
    };

    // ── raycaster：hover 标签 + 点击叶子打开 ──
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoverNode: GalaxyNode | null = null;
    const projVec = new THREE.Vector3();

    // depthById：缩略卡 / 聚焦距离需要 depth；从 placed 取
    const depthById = new Map<string, number>();
    for (const { node, depth } of placed.values()) depthById.set(node.id, depth);

    // pathNamesById：每个节点的祖先名链（不含根与自身），缩略卡显示"所在位置"
    const pathNamesById = new Map<string, string[]>();
    const walkPathNames = (n: GalaxyNode, acc: string[]) => {
      pathNamesById.set(n.id, acc);
      const next = n.kind === 'root' ? acc : [...acc, n.name];
      for (const c of n.children) walkPathNames(c, next);
    };
    walkPathNames(galaxy.root, []);

    const pick = (clientX: number, clientY: number): { node: GalaxyNode; mesh: THREE.Mesh } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // root/group 核心始终 visible；leaf 受 type 筛选影响。只 pick 可见者。
      const visibleCores = coreMeshes.filter((m) => m.visible);
      const hits = raycaster.intersectObjects(visibleCores, false);
      if (!hits.length) return null;
      const mesh = hits[0].object as THREE.Mesh;
      return { node: mesh.userData.node as GalaxyNode, mesh };
    };

    let downXY: [number, number] | null = null;
    let dragMoved = false;

    const onPointerMove = (ev: PointerEvent) => {
      if (downXY && (Math.abs(ev.clientX - downXY[0]) > 4 || Math.abs(ev.clientY - downXY[1]) > 4)) {
        if (!dragMoved) camTween = null; // 真实拖拽才打断相机缓动（与 onWheel 一致，含入场推进）
        dragMoved = true;
      }
      const hit = pick(ev.clientX, ev.clientY);
      const node = hit?.node ?? null;
      if (node !== hoverNode) {
        hoverNode = node;
        renderer.domElement.style.cursor = node ? 'pointer' : 'grab';
        // 离开节点不立刻关：延时关闭，给指针留出移进「枢纽清单卡」的时间（卡内可点跳转）
        if (!node) scheduleHoverClose();
      }
      if (node && hit) {
        cancelHoverClose();
        // 把核心世界坐标投影到屏幕，定位缩略卡；靠右边缘则翻到左侧
        hit.mesh.getWorldPosition(projVec);
        projVec.project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        const sx = (projVec.x * 0.5 + 0.5) * rect.width;
        const sy = (-projVec.y * 0.5 + 0.5) * rect.height;
        const flip = sx > rect.width - 340; // 卡片最宽 ~320 + 余量
        setHover({ x: sx, y: sy, flip, node, depth: depthById.get(node.id) ?? 0, pathNames: pathNamesById.get(node.id) ?? [] });
      }
    };
    const onPointerDown = (ev: PointerEvent) => {
      downXY = [ev.clientX, ev.clientY];
      dragMoved = false;
      controls.autoRotate = false;
      // 注意：不在 pointerdown 打断相机缓动 —— 空白单击（无拖拽）会把入场推进搁浅在远位
      //（Bugbot 90f25eb6）。真正的打断放在 onPointerMove 判定为拖拽的瞬间。
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (dragMoved) {
        downXY = null;
        return;
      }
      const hit = pick(ev.clientX, ev.clientY);
      if (hit) {
        if (hit.node.kind === 'leaf') {
          if (hit.node.entryId) onOpenRef.current(hit.node.entryId);
        } else {
          // 枢纽（root/group）：聚焦 + 高亮子树 + 信息面板
          focusNode(hit.node);
        }
      } else if (focusedNodeId) {
        // 点空白 → 取消聚焦复位
        resetFocus();
      }
      downXY = null;
    };
    const onPointerLeave = () => {
      hoverNode = null;
      // 同样延时关闭：指针可能正移向悬浮的枢纽清单卡（卡在 canvas 外的 DOM 层）
      scheduleHoverClose();
    };

    // ── 触控板/滚轮手势：两指滑动像转动中心球体，只改变观察角度，不改变距离/焦点。──
    const gOffset = new THREE.Vector3();
    const gRotatedOffset = new THREE.Vector3();
    const rotateViewByPixels = (dxPx: number, dyPx: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      gOffset.copy(camera.position).sub(controls.target);
      const radius = gOffset.length();
      if (radius < 1e-6) return;
      rotateOrbitOffsetByPixels(gOffset, dxPx, dyPx, rect.width, rect.height, controls.rotateSpeed, gRotatedOffset);
      camera.position.copy(controls.target).add(gRotatedOffset);
      camera.lookAt(controls.target);
    };
    const dollyByDelta = (deltaY: number) => {
      gOffset.copy(camera.position).sub(controls.target);
      let d = gOffset.length() * Math.pow(0.95, -deltaY * 0.01);
      d = Math.min(controls.maxDistance, Math.max(controls.minDistance, d));
      camera.position.copy(controls.target).add(gOffset.setLength(d));
    };
    // 鼠标滚轮 vs 触摸板的「黏性」判别（鼠标滚轮=缩放、触摸板双指滑=轨道旋转）。
    // 正确约定（业界 3D 通行，Figma/Blender/Earth/本项目视觉创作画布）：
    //   · 鼠标滚轮（无修饰键）          → 缩放
    //   · 触摸板双指上下/左右滑          → 围绕当前中心旋转观察方向，距离与 target 不变
    //   · 触摸板双指捏合（浏览器合成 ctrlKey）/ ⌘·Ctrl+滚轮 → 缩放
    // 判别启发：滚轮 deltaMode≠0(行/页) 或「纯垂直 + 整数 + 大步(≥100)」；触摸板 deltaX≠0 或小数或小步。
    // 一旦识别出某设备就黏住，避免同一设备在大小步之间反复横跳；模糊时维持上次结论、首次默认鼠标。
    let wheelDevice: 'mouse' | 'trackpad' | 'unknown' = 'unknown';
    const classifyWheel = (ev: WheelEvent): 'mouse' | 'trackpad' => {
      if (ev.deltaMode !== 0) { wheelDevice = 'mouse'; return 'mouse'; }
      const ay = Math.abs(ev.deltaY);
      const ax = Math.abs(ev.deltaX);
      // 触摸板强特征：有水平分量 / 小数 delta / 很小的步长
      if (ax > 0 || !Number.isInteger(ev.deltaY) || ay < 40) { wheelDevice = 'trackpad'; return 'trackpad'; }
      // 鼠标强特征：纯垂直 + 整数 + 大步
      if (ay >= 100) { wheelDevice = 'mouse'; return 'mouse'; }
      // 模糊：沿用上次结论，首次默认鼠标（让「滚轮=缩放」成为不确定时的默认）
      return wheelDevice === 'unknown' ? 'mouse' : wheelDevice;
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      controls.autoRotate = false;
      camTween = null; // 手势打断聚焦缓动
      // 捏合 / ⌘·Ctrl+滚轮 一律缩放；否则按设备判别：鼠标滚轮缩放、触摸板旋转
      if (ev.ctrlKey || ev.metaKey || classifyWheel(ev) === 'mouse') dollyByDelta(ev.deltaY);
      else rotateViewByPixels(ev.deltaX, ev.deltaY);
    };
    // 双击空白处 → 继续自动旋转（双击节点不触发；不做双击缩放，遵守 gesture-unification）
    const onDblClick = (ev: MouseEvent) => {
      if (!pick(ev.clientX, ev.clientY)) controls.autoRotate = true;
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    renderer.domElement.addEventListener('dblclick', onDblClick);

    // ── 渲染循环 ──
    const clock = new THREE.Clock();
    let rafId = 0;
    const camPos = new THREE.Vector3();
    const haloWorld = new THREE.Vector3();
    const render = () => {
      rafId = requestAnimationFrame(render);
      const dt = clock.getDelta();
      const tNow = clock.elapsedTime;
      const nowMs = performance.now();
      const introElapsed = nowMs - introStart;
      const introActive = introElapsed < INTRO_TOTAL;

      // 星场闪烁 / 后期颗粒的时间推进
      farStars.uniforms.uTime.value = tNow;
      nearStars.uniforms.uTime.value = tNow;
      // 颗粒噪声时间取模：fract(sin(大数)) 在 float32 下约 31 分钟后精度崩塌，包一层 CPU 侧 wrap
      gradeUniforms.uTime.value = tNow % 64;

      // 星云缓慢漂移 + 各片独立微旋
      nebulaGroup.rotation.y += dt * 0.0035;
      nebulaGroup.rotation.x += dt * 0.0013;
      for (const n of nebulaSpins) n.mat.rotation += dt * n.spin;

      // 相机聚焦缓动：自然速度曲线，距离越远时长略增。
      if (camTween) {
        const k = Math.min(1, (nowMs - camTween.t0) / camTween.dur);
        const e = naturalCameraEase(k);
        controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
        camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
        if (k >= 1) camTween = null;
      }

      // 叶子脉冲高亮生命周期：聚焦到具体文档后"呼吸"约 1.4s（衰减正弦），结束复位
      let pulseScale = 1;
      if (pulseLeafId) {
        const elapsed = nowMs - pulseT0;
        if (elapsed >= 1400) {
          pulseLeafId = null;
        } else {
          const p = elapsed / 1400;
          pulseScale = 1 + 0.85 * (1 - p) * Math.abs(Math.sin(p * Math.PI * 3));
        }
      }
      const selPhase = Math.sin(tNow * 2.6);

      // 每星统一结算：聚焦淡出 lerp + hover 缓动 + 入场生长波 + 交互缩放（单处写 scale，杜绝互相覆盖）
      for (const rec of renders) {
        const cur = dimCurrentById.get(rec.node.id) ?? 1;
        const tgt = dimTargetById.get(rec.node.id) ?? 1;
        const next = cur + (tgt - cur) * 0.12;
        dimCurrentById.set(rec.node.id, next);
        rec.coreU.uOpacity.value = 0.15 + 0.85 * next;
        // hover：亮度 + 尺寸双通道缓动反馈
        const hovTgt = hoverNode === rec.node ? 1 : 0;
        rec.hoverK += (hovTgt - rec.hoverK) * 0.14;
        rec.coreU.uBoost.value = 1 + rec.hoverK * 0.35;
        // 入场生长波：银心向外错峰弹性长出
        let intro = 1;
        if (introActive) intro = easeOutBack(clamp01((introElapsed - rec.introDelay) / 850));
        // 交互缩放：选中呼吸（首 1.4s 与点击脉冲取大，让「点中了」的爆发感真的播出来）> 点击脉冲 > hover 微放大
        let s = 1 + rec.hoverK * 0.16;
        if (selectedLeafId === rec.node.id) {
          const selS = 1.55 + 0.18 * selPhase;
          s = pulseLeafId === rec.node.id ? Math.max(selS, pulseScale) : selS;
        } else if (pulseLeafId === rec.node.id) s = pulseScale;
        rec.core.scale.setScalar(Math.max(0.0001, intro * s));
      }

      // 光晕：距离衰减（演示版数值基线）+ 呼吸微闪 + 聚焦淡出 + 入场淡入 + hover/选中强调
      camPos.copy(camera.position);
      for (const rec of renders) {
        if (!rec.halo.visible) continue;
        rec.halo.getWorldPosition(haloWorld);
        const d = camPos.distanceTo(haloWorld);
        const refD = Math.max(220, rec.size * 26); // 近于 refD 时缩小，避免贴脸过曝
        const att = Math.min(1, d / refD);
        const attScale = 0.35 + 0.65 * att; // 永不完全坍缩，永不超过基准
        let scale = rec.haloBaseSize * attScale;
        const dim = dimCurrentById.get(rec.node.id) ?? 1;
        const introF = introActive ? clamp01((introElapsed - rec.introDelay) / 850) : 1;
        // 呼吸微闪：每星错相位，幅度克制（活着，但不闹）
        const shimmer = 1 + 0.06 * Math.sin(tNow * 1.6 + rec.twPhase);
        let tgt = rec.haloBaseOpacity * (0.45 + 0.55 * att) * dim * shimmer * introF;
        if (hoverNode === rec.node) tgt = Math.min(0.85, tgt * 1.7);
        if (selectedLeafId === rec.node.id) {
          scale = rec.haloBaseSize * (2.2 + 0.3 * selPhase);
          tgt = Math.min(0.95, rec.haloBaseOpacity * 2.4);
          rec.coreU.uOpacity.value = 1; // 选中恒亮
        }
        if (rec.node.kind === 'root') scale *= 1 + 0.05 * Math.sin(tNow * 0.9); // 银心心跳
        rec.halo.scale.set(scale, scale, 1);
        const mat = rec.halo.material as THREE.SpriteMaterial;
        mat.opacity += (tgt - mat.opacity) * 0.2;
      }

      // 枢纽星芒：缓旋 + 跟随聚焦压暗 + 入场淡入
      for (const s of sparkles) {
        if (!s.sp.visible) continue;
        const m = s.sp.material as THREE.SpriteMaterial;
        m.rotation += dt * s.spin;
        const dim = dimCurrentById.get(s.nodeId) ?? 1;
        const introF = introActive ? clamp01((introElapsed - (introDelayById.get(s.nodeId) ?? 0)) / 850) : 1;
        m.opacity = s.baseOpacity * dim * introF;
      }

      // 标签：聚焦淡出 x 入场淡入 x 距离分级淡出（远观只留分类级，靠近才浮现子模块名 —— declutter）
      // 完全淡没的标签用 material.visible 跳过渲染（object.visible 归 applyFilter 独占，避免互相打架）
      for (const [id, lab] of labelByNodeId) {
        if (!lab.visible) continue;
        const dim = dimCurrentById.get(id) ?? 1;
        const dCam = camPos.distanceTo(lab.position);
        const d = depthById.get(id) ?? 0;
        let fade = 1;
        if (d >= 3) fade = clamp01((1500 - dCam) / 420);
        else if (d === 2) fade = clamp01((2600 - dCam) / 700);
        const introF = introActive ? clamp01((introElapsed - (introDelayById.get(id) ?? 0)) / 850) : 1;
        const mat = lab.material as THREE.SpriteMaterial;
        const op = dim * fade * introF;
        mat.opacity = op;
        mat.visible = op > 0.01;
      }

      // 光路入场淡入（节点长出后光路跟上）
      hierMat.opacity = 0.42 * clamp01((introElapsed - 400) / 1300);
      if (mentionMat) mentionMat.opacity = 0.3 * clamp01((introElapsed - 900) / 1300);

      // 引用流光脉冲：沿引用弧巡游；隐藏弧的光点驻留远处不可见
      if (pulseGeo && pulseMat) {
        pulseMat.opacity = 0.85 * clamp01((introElapsed - 1400) / 900);
        const pa = pulseGeo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pulseCount; i++) {
          if (!mentionVisibleArr[i] || !mentionFocusKeep[i]) {
            pa.setXYZ(i, 1e7, 1e7, 1e7);
            continue;
          }
          const speed = 0.07 + hash01(i * 7 + 3) * 0.05;
          const t = (tNow * speed + hash01(i * 11 + 1)) % 1;
          const pts = mentionCurvePts[i];
          const x = t * SEG_M;
          const si = Math.min(SEG_M - 1, Math.floor(x));
          const f = x - si;
          const p0 = pts[si];
          const p1 = pts[si + 1];
          pa.setXYZ(i, p0.x + (p1.x - p0.x) * f, p0.y + (p1.y - p0.y) * f, p0.z + (p1.z - p0.z) * f);
        }
        pa.needsUpdate = true;
      }

      // 主干流光：root → 一级分类，缓慢外行
      if (flowGeo && flowMat) {
        flowMat.opacity = 0.5 * clamp01((introElapsed - 1200) / 900);
        const fa = flowGeo.getAttribute('position') as THREE.BufferAttribute;
        for (let k = 0; k < flowEdges.length; k++) {
          if (!flowVisibleArr[k] || !flowFocusKeep[k]) {
            fa.setXYZ(k, 1e7, 1e7, 1e7);
            continue;
          }
          const speed = 0.05 + hash01(k * 5 + 2) * 0.03;
          const t = (tNow * speed + hash01(k * 17 + 9)) % 1;
          const pts = edgeCurvePts[flowEdges[k].edgeIdx];
          const x = t * SEG_H;
          const si = Math.min(SEG_H - 1, Math.floor(x));
          const f = x - si;
          const p0 = pts[si];
          const p1 = pts[si + 1];
          fa.setXYZ(k, p0.x + (p1.x - p0.x) * f, p0.y + (p1.y - p0.y) * f, p0.z + (p1.z - p0.z) * f);
        }
        fa.needsUpdate = true;
      }

      // 偶发流星：随机方位一道流光划过远景
      if (!meteor.active && tNow > meteor.nextAt) {
        meteor.active = true;
        meteor.t0 = nowMs;
        meteor.dur = 1000 + Math.random() * 600;
        meteor.len = 1100 + Math.random() * 900;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        const r = 3800 + Math.random() * 1400;
        meteor.from.set(r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph));
        // 运动方向取该点切平面内的随机向量
        const radial = meteor.from.clone().normalize();
        const seed = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        meteor.dir.copy(seed.sub(radial.multiplyScalar(seed.dot(radial))).normalize());
      }
      if (meteor.active) {
        const p = (nowMs - meteor.t0) / meteor.dur;
        if (p >= 1) {
          meteor.active = false;
          meteor.nextAt = tNow + 6 + Math.random() * 9;
          meteorSprite.visible = false;
        } else {
          meteorSprite.visible = true;
          meteorSprite.position.copy(meteor.from).addScaledVector(meteor.dir, p * meteor.len);
          meteorMat.opacity = 0.5 * Math.sin(Math.PI * p);
          // 拖尾贴图沿屏幕投影方向旋转（sprite 永远面向相机，rotation 是屏幕面内角度）
          meteorDirCam.copy(meteor.dir).transformDirection(camera.matrixWorldInverse);
          meteorMat.rotation = Math.atan2(meteorDirCam.y, meteorDirCam.x);
        }
      }

      // 选中文档的发光旋转指针环：把选中星的世界坐标投影到屏幕，定位 DOM 覆盖层。
      // 星被筛选隐藏 / 没有选中 → 隐藏环。环颜色随该文档 docType。
      {
        const ring = selRingRef.current;
        const selLabel = selLabelRef.current;
        if (ring) {
          const rec = selectedLeafId ? renders.find((r) => r.node.id === selectedLeafId) : null;
          if (rec && rec.core.visible) {
            rec.core.getWorldPosition(haloWorld);
            projVec.copy(haloWorld).project(camera);
            const rect = renderer.domElement.getBoundingClientRect();
            const sx = (projVec.x * 0.5 + 0.5) * rect.width;
            const sy = (-projVec.y * 0.5 + 0.5) * rect.height;
            // projVec.z > 1 表示在相机背后 → 隐藏，避免环错位贴在屏幕反面
            if (projVec.z <= 1) {
              const accent = colorForDocType(rec.node.docType);
              ring.style.display = 'block';
              ring.style.left = `${sx}px`;
              ring.style.top = `${sy}px`;
              ring.style.setProperty('--galaxy-sel-accent', accent);
              // 选中星的标题：叶子无常驻 sprite，这里在环下方补一个标题标签
              if (selLabel) {
                selLabel.style.display = 'block';
                selLabel.style.left = `${sx}px`;
                selLabel.style.top = `${sy}px`;
                const txt = leafDisplayName(rec.node, labelModeRef.current, contentTitlesRef.current);
                if (selLabel.textContent !== txt) selLabel.textContent = txt;
              }
            } else {
              ring.style.display = 'none';
              if (selLabel) selLabel.style.display = 'none';
            }
          } else {
            ring.style.display = 'none';
            if (selLabel) selLabel.style.display = 'none';
          }
        }
      }

      controls.update();
      renderBloom();
    };
    render();

    // ── 尺寸响应 ──
    const resize = () => {
      W = mount.clientWidth || 1;
      H = mount.clientHeight || 1;
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      applyViewOffset(); // 尺寸变了重算抽屉投影偏移（W 变 → inset 变）
      renderer.setSize(W, H);
      bloomComposer.setSize(W, H);
      finalComposer.setSize(W, H);
      // 星场点径随绘制缓冲高度换算（对齐 three PointsMaterial 的 sizeAttenuation 口径）
      farStars.uniforms.uScale.value = renderer.domElement.height * 0.5;
      nearStars.uniforms.uScale.value = renderer.domElement.height * 0.5;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    window.addEventListener('resize', resize);

    // ── 清理 ──
    return () => {
      relabelRef.current = null;
      flyToRef.current = null;
      recenterRef.current = null;
      clearSelectionRef.current = null;
      focusHubRef.current = null;
      applyViewOffsetRef.current = null;
      applyFilterRef.current = null;
      focusNodeRef.current = null;
      resetFocusRef.current = null;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener('resize', resize);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('dblclick', onDblClick);
      controls.dispose();
      bloomComposer.dispose();
      finalComposer.dispose();
      bloomPass.dispose();
      combineMaterial.dispose();
      darkMat.dispose();
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* noop */
        }
      }
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // galaxy 变化重建场景；typeOn 走 applyFilterRef，不在此 deps。
    // scheduleHoverClose/cancelHoverClose 是 useCallback 稳定值，列入仅为满足 exhaustive-deps，不会触发重建。
  }, [galaxy, scheduleHoverClose, cancelHoverClose]);

  if (fatal) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 40,
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            background: 'rgba(60,30,30,0.95)',
            border: '1px solid rgba(255,90,90,0.5)',
            borderRadius: 8,
            padding: '16px 20px',
            color: '#ffd0d0',
            fontSize: 13,
            maxWidth: 520,
            lineHeight: 1.6,
          }}
        >
          3D 渲染失败：{fatal}。你的浏览器可能不支持 WebGL，或数据异常。
        </div>
      </div>
    );
  }

  return (
    <div ref={mountRef} style={{ position: 'absolute', inset: 0 }}>
      {/* 选中文档的标题标签：叶子不生成常驻标签 sprite，选中时在环下方补标题
          （render 循环每帧写 left/top=星投影点 + textContent；transform 把它放到星下方居中）。 */}
      <div
        ref={selLabelRef}
        style={{
          position: 'absolute',
          display: 'none',
          left: 0,
          top: 0,
          transform: 'translate(-50%, 42px)',
          maxWidth: 260,
          padding: '3px 9px',
          borderRadius: 7,
          background: 'rgba(8,9,14,0.78)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: '#eef0f6',
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1.3,
          textAlign: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          pointerEvents: 'none',
          zIndex: 14,
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      />
      {/* 选中文档的发光旋转指针环：渲染循环每帧更新 left/top + display + 强调色。
          外层定位（left/top 由 JS 写），内层旋转环 + 4 个朝内的指针尖角。pointer-events:none 不挡操作。 */}
      <div
        ref={selRingRef}
        style={{
          position: 'absolute',
          display: 'none',
          left: 0,
          top: 0,
          width: 64,
          height: 64,
          // 关键：render 循环把 left/top 写成星的投影点(sx,sy)，那是星的「屏幕坐标」。
          // 容器默认以左上角对齐该点，而内部环/指针都绕「容器中心(32,32)」排布 →
          // 整圈会偏到星的右下方 ~32px（用户反馈的「歪/溢出位移」根因）。
          // 用 translate(-50%,-50%) 把容器中心对到 (sx,sy)，环才真正套在星上。
          // render 循环只改 left/top/display，不动 transform，此静态值持续生效。
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 14,
          // 用 CSS 变量承接强调色（render 循环写 --galaxy-sel-accent）
          ['--galaxy-sel-accent' as string]: '#ffe08a',
        }}
      >
        {/* 旋转的虚线发光环（绕中心自转） */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 64,
            height: 64,
            borderRadius: '50%',
            border: '2px dashed var(--galaxy-sel-accent)',
            boxShadow: '0 0 12px var(--galaxy-sel-accent), inset 0 0 8px var(--galaxy-sel-accent)',
            filter: 'drop-shadow(0 0 4px var(--galaxy-sel-accent))',
            animation: 'galaxy-sel-spin 6s linear infinite',
          }}
        />
        {/* 呼吸的实线内圈（不自转，只脉冲发光，强调"指向这里"） */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 44,
            height: 44,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            border: '1px solid var(--galaxy-sel-accent)',
            boxShadow: '0 0 10px var(--galaxy-sel-accent)',
            opacity: 0.7,
            animation: 'galaxy-sel-pulse 1.6s ease-in-out infinite',
          }}
        />
        {/* 4 个朝内的指针尖角（上/右/下/左），用三角形指向中心选中星。
            统一锚到容器中心(left/top:50%)，先 translate(-50%,-50%) 把三角形自身居中，
            再沿轴向 ±34px 对称推出 —— 对边用「相同的盒尺寸居中 + 相反的半径」，几何中心
            必然落在容器中心(=星)。旧写法对边各钉同名边(top:-2/top:66、left:-2/left:66)，
            盒尺寸项同向相加而非镜像抵消，会让指针整体偏右下 ~3.5px（Codex 几何复核发现）。 */}
        {[
          { dir: 'down', transform: 'translate(-50%, calc(-50% - 34px))' },
          { dir: 'left', transform: 'translate(calc(-50% + 34px), -50%)' },
          { dir: 'up', transform: 'translate(-50%, calc(-50% + 34px))' },
          { dir: 'right', transform: 'translate(calc(-50% - 34px), -50%)' },
        ].map((p, i) => {
          // 每个尖角是一个三角形，缺口边透明、指向边用强调色
          const border: CSSProperties =
            p.dir === 'down'
              ? { borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '7px solid var(--galaxy-sel-accent)' }
              : p.dir === 'up'
                ? { borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: '7px solid var(--galaxy-sel-accent)' }
                : p.dir === 'left'
                  ? { borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '7px solid var(--galaxy-sel-accent)' }
                  : { borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderRight: '7px solid var(--galaxy-sel-accent)' };
          return (
            <span
              key={i}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: 0,
                height: 0,
                transform: p.transform,
                filter: 'drop-shadow(0 0 3px var(--galaxy-sel-accent))',
                ...border,
              }}
            />
          );
        })}
      </div>

      {/* 常驻「复位视角」：回中心 + 清聚焦 + 继续自动旋转（不止双击/点空白） */}
      <button
        type="button"
        onClick={() => recenterRef.current?.()}
        title="复位视角：回到中心并继续自动旋转"
        style={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          zIndex: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(20,21,30,0.82)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 8,
          padding: '6px 10px',
          color: '#cfcfd6',
          cursor: 'pointer',
          fontSize: 12,
        }}
      >
        <RotateCcw size={13} /> 复位视角
      </button>

      {hover && (
        <HoverCard
          info={hover}
          labelMode={labelMode}
          contentTitles={contentTitles}
          onOpenLeaf={(id) => {
            cancelHoverClose();
            setHover(null);
            onOpenRef.current(id);
          }}
          onKeepAlive={cancelHoverClose}
          onScheduleClose={scheduleHoverClose}
        />
      )}

      {focusInfo && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            width: 'min(300px, 84vw)',
            maxHeight: 'calc(100% - 24px)',
            background: 'rgba(14,15,22,0.95)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 12,
            boxShadow: '0 10px 32px rgba(0,0,0,0.55)',
            zIndex: 22,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: '#9aa0b4', marginBottom: 2 }}>
                  {focusInfo.node.kind === 'root' ? '知识库' : focusInfo.depth <= 1 ? '分类' : focusInfo.depth === 2 ? '应用' : '子模块'}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#f4f5fa', wordBreak: 'break-word' }}>
                  {focusInfo.node.name}
                </div>
                <div style={{ fontSize: 12, color: '#b7b9c6', marginTop: 3 }}>共 {focusInfo.node.docCount} 篇文档</div>
              </div>
              <button
                type="button"
                onClick={() => resetFocusRef.current?.()}
                style={{
                  flexShrink: 0,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 6,
                  color: '#c8c8d0',
                  fontSize: 11,
                  padding: '4px 8px',
                  cursor: 'pointer',
                }}
              >
                返回
              </button>
            </div>
            <TypeBars tally={focusInfo.typeTally} />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '8px 10px' }}>
            <div style={{ fontSize: 11, color: '#76788a', padding: '2px 4px 6px' }}>
              直接子项（{focusInfo.children.length}）
            </div>
            {focusInfo.children.map(({ node, isLeaf }) => (
              <button
                key={node.id}
                type="button"
                onClick={() => {
                  if (isLeaf) {
                    if (node.entryId) onOpenRef.current(node.entryId);
                  } else {
                    focusNodeRef.current?.(node);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 7,
                  padding: '7px 8px',
                  cursor: 'pointer',
                  color: '#dcdde6',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: isLeaf ? colorForDocType(node.docType) : '#ffe08a',
                    boxShadow: isLeaf ? `0 0 5px ${colorForDocType(node.docType)}` : 'none',
                  }}
                />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {isLeaf ? leafDisplayName(node, labelMode, contentTitles) : node.name}
                </span>
                <span style={{ flexShrink: 0, fontSize: 11, color: '#76788a' }}>
                  {isLeaf ? '阅读' : `${node.docCount} 篇`}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 阅读面板：点星弹出，复用系统 MarkdownViewer。玻璃质感悬浮卡（拉宽 + 通透 + 圆润）──
function ReaderPanel({
  entryId,
  displayTitle,
  pathNames,
  width,
  onResize,
  onClose,
}: {
  entryId: string;
  displayTitle?: string;
  pathNames?: string[];
  width: number;
  onResize: (w: number) => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    getDocumentContent(entryId)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error?.message || '加载文档失败');
          return;
        }
        setTitle(res.data.title || '');
        setContent(res.data.hasContent ? (res.data.content ?? '') : '');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 左缘拖拽改宽：按指针 x 反推宽度 = 视口宽 - x - 右边距(12)，夹 [360, 94vw]。
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      onResizeRef.current(window.innerWidth - ev.clientX - 12);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        (e.target as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        /* 已释放 */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shownTitle = displayTitle || title || '文档';
  const crumbLine = (pathNames ?? []).join(' / ');
  // 去重：面板头部已经显示标题，正文若以同名 H1/H2 开头会变成「两个标题」（用户反馈）。
  // 正文首个标题文本 ≈ 头部标题（或以其结尾，兼容「文件名 — 真标题」式 H1）时，剥掉该行。
  const bodyForView = content ? stripDuplicateLeadingHeading(content, shownTitle) : content;

  return (
    // 悬浮玻璃卡：四周留白 + 全圆角，比贴边硬面板更圆润通透
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        bottom: 12,
        width: `min(${Math.round(width)}px, 94vw)`,
        // 玻璃质感但保证可读：底色足够实（0.92），blur 只做轻微通透，正文不被背景星点干扰
        background: 'rgba(17,18,26,0.92)',
        backdropFilter: 'blur(20px) saturate(130%)',
        WebkitBackdropFilter: 'blur(20px) saturate(130%)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 18,
        boxShadow: '0 18px 60px rgba(0,0,0,0.6)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* 左缘拖拽手柄：改阅读面板宽度（投影偏移随之同步，聚焦星保持左半居中）。 */}
      <div
        onPointerDown={startResize}
        title="拖拽调整阅读面板宽度"
        style={{
          position: 'absolute',
          left: -3,
          top: 0,
          bottom: 0,
          width: 10,
          cursor: 'ew-resize',
          zIndex: 2,
          touchAction: 'none',
        }}
      >
        <div style={{ position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)', width: 3, height: 42, borderRadius: 3, background: 'rgba(255,255,255,0.22)' }} />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          padding: '16px 20px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {crumbLine && (
            <div style={{ fontSize: 11, color: '#8a8c9c', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {crumbLine}
            </div>
          )}
          <div style={{ fontSize: 17, fontWeight: 700, color: '#f1f2f7', lineHeight: 1.35, wordBreak: 'break-word' }}>
            {shownTitle}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 9,
            width: 30,
            height: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#c8c8d0',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X size={15} />
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: '22px 28px 32px',
        }}
      >
        {/* 正文限宽居中，长行不顶到边，阅读更舒适（容器仍撑满，靠 padding 收口） */}
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          {loading && <div style={{ padding: '32px 0' }}><GalaxyConstellationLoader text="正在加载文档…" size={140} /></div>}
          {error && !loading && <div style={{ color: '#ffb0b0', fontSize: 13 }}>加载失败：{error}</div>}
          {!loading && !error && content !== null && content.trim() !== '' && <MarkdownViewer content={bodyForView ?? content} />}
          {!loading && !error && (content === null || content.trim() === '') && (
            <div style={{ color: '#888', fontSize: 13 }}>该文档暂无可预览的正文内容。</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 面包屑一节（关系链）。叶子节点带 entryId，可点击打开。 */
export interface GalaxyCrumb {
  id: string;
  name: string;
  kind: GalaxyNode['kind'];
  entryId?: string;
  /** 叶子才有：文档类型（spec/design/...），头部面包屑用它上色图标。 */
  docType?: string | null;
}

export interface DocumentGalaxyViewProps {
  storeId: string;
  storeName?: string;
  /** 叶子名显示模式（结构名/正文标题），由外层头部开关控制。默认正文标题。 */
  labelMode?: GalaxyLabelMode;
  /** 当前关系链变化（聚焦枢纽 / 打开文档），供外层头部渲染面包屑。 */
  onContextChange?: (ctx: { crumbs: GalaxyCrumb[]; kind: 'none' | 'focus' | 'open' }) => void;
  /** 外层请求打开某文档（点面包屑叶子）。受控暴露当前 openEntryId 的 setter 太重，这里用 ref 命令式。 */
  openEntryRef?: MutableRefObject<((entryId: string) => void) | null>;
  /** 返回按钮（合并到单条顶栏后由本组件渲染）。不传则不显示返回。 */
  onBack?: () => void;
  /** 切换标题显示模式（结构名 ↔ 正文标题）。不传则不显示开关。 */
  onToggleLabelMode?: () => void;
}

export function DocumentGalaxyView({ storeId, storeName, labelMode = 'content', onContextChange, openEntryRef, onBack, onToggleLabelMode }: DocumentGalaxyViewProps) {
  const [galaxy, setGalaxy] = useState<DocGalaxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false); // 翻页有页失败 → 图谱不完整
  const [linksFailed, setLinksFailed] = useState(false); // 双链接口失败 → 引用关系未知（区别于「真的 0 引用」）
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number } | null>(null); // 构建期进度
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  // 阅读面板宽度（可拖拽改宽；默认比原来宽 1/4 = 950）。纯 UI 偏好，可入 localStorage（no-localStorage 规则允许）。
  const [drawerWidth, setDrawerWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('galaxy-reader-width'));
    return saved >= 360 && saved <= 4000 ? saved : 950;
  });
  const setDrawerWidthPersist = useCallback((w: number) => {
    const clamped = Math.max(360, Math.min(w, Math.round(window.innerWidth * 0.94)));
    setDrawerWidth(clamped);
    try {
      localStorage.setItem('galaxy-reader-width', String(clamped));
    } catch {
      /* 隐私模式 setItem 可能抛错，忽略 */
    }
  }, []);
  // 当前聚焦的枢纽（GalaxyCanvas 上报；用于面包屑）
  const [focusedNode, setFocusedNode] = useState<GalaxyNode | null>(null);
  // 关系链面包屑（现浮在画布左上角；同时仍可经 onContextChange 上报给外层）
  const [crumbs, setCrumbs] = useState<GalaxyCrumb[]>([]);
  // 面包屑某段的下拉（跳转同级兄弟）。-1 = 全关；同时只开一个。
  const [openCrumbIdx, setOpenCrumbIdx] = useState<number>(-1);
  // 下拉用 createPortal 挂到 body（顶栏与面包屑容器都有 overflow:hidden，原地 absolute 会被裁掉，
  // 用户根本看不到这个新加的同级跳转菜单 —— Codex P2）。打开时按被点段的 rect 计算 fixed 定位。
  const [crumbMenuPos, setCrumbMenuPos] = useState<{ left: number; top: number } | null>(null);
  const crumbMenuRef = useRef<HTMLDivElement>(null);
  // 请求 GalaxyCanvas 聚焦某枢纽（面包屑下拉选兄弟分组）。带单调 token 让重复点同一 id 也能再触发。
  const [focusHubReq, setFocusHubReq] = useState<{ id: string; n: number } | null>(null);
  const focusHubReqN = useRef(0);
  const storeNameRef = useRef(storeName);
  storeNameRef.current = storeName;

  // onContextChange 用 ref 透传，避免内联回调每次换 identity 触发面包屑 effect 自激成环
  const onContextChangeRef = useRef(onContextChange);
  onContextChangeRef.current = onContextChange;

  // 命令式打开（供外层面包屑点击叶子）
  useEffect(() => {
    if (openEntryRef) openEntryRef.current = (id: string) => setOpenEntryId(id);
    return () => {
      if (openEntryRef) openEntryRef.current = null;
    };
  }, [openEntryRef]);

  // 节点查找表（id → {node, parent}）：面包屑下拉「跳到同级兄弟」用它从 crumb.id 回查真实节点。
  // 兄弟 = 父节点的 children；i===0 段的父 = root。
  const nodeIndex = useMemo(() => {
    const m = new Map<string, { node: GalaxyNode; parent: GalaxyNode | null }>();
    if (!galaxy) return m;
    const walk = (n: GalaxyNode, parent: GalaxyNode | null) => {
      m.set(n.id, { node: n, parent });
      for (const c of n.children) walk(c, n);
    };
    walk(galaxy.root, null);
    return m;
  }, [galaxy]);

  // 请求聚焦某枢纽：递增 token，确保重复点同一兄弟分组也能再次触发 GalaxyCanvas 的聚焦。
  const requestFocusHub = useCallback((id: string) => {
    focusHubReqN.current += 1;
    setFocusHubReq({ id, n: focusHubReqN.current });
  }, []);

  // entryId → 人类正文标题（content 模式取用）。复用 parseFrontmatter SSOT + 剥文件名前缀。
  const contentTitles = useMemo(() => {
    const m = new Map<string, string>();
    if (!galaxy) return m;
    for (const leaf of galaxy.leaves) {
      if (!leaf.entryId) continue;
      const t = deriveContentTitle(leaf.summary, leaf.name);
      if (t) m.set(leaf.entryId, t);
    }
    return m;
  }, [galaxy]);

  // 计算关系链（面包屑）：优先打开的文档，其次聚焦的枢纽。本组件自渲染在顶栏 +
  // 可选经 onContextChange 上报。onContextChange 走 ref（不进 deps）避免内联回调自激成环。
  useEffect(() => {
    const toCrumbs = (nodes: GalaxyNode[]): GalaxyCrumb[] =>
      nodes.map((n) => ({
        id: n.id,
        name: n.kind === 'leaf' ? leafDisplayName(n, labelMode, contentTitles) : n.name,
        kind: n.kind,
        entryId: n.entryId,
        docType: n.docType,
      }));
    let result: { crumbs: GalaxyCrumb[]; kind: 'none' | 'focus' | 'open' } = { crumbs: [], kind: 'none' };
    if (galaxy) {
      if (openEntryId) {
        const path = pathToNode(galaxy.root, 'e:' + openEntryId);
        if (path) result = { crumbs: toCrumbs(path), kind: 'open' };
      }
      if (result.kind === 'none' && focusedNode) {
        const path = pathToNode(galaxy.root, focusedNode.id);
        if (path) result = { crumbs: toCrumbs(path), kind: 'focus' };
      }
    }
    setCrumbs(result.crumbs);
    onContextChangeRef.current?.(result);
  }, [galaxy, openEntryId, focusedNode, labelMode, contentTitles]);

  // type 图例筛选状态（7 种 type + unknown，全开）
  const [typeOn, setTypeOn] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = { unknown: true };
    for (const t of DOC_TYPES) init[t] = true;
    return init;
  });

  // 图例渲染的类型列表：只列「本库真实存在（count>0）」的类型，不再把 spec/design/... 全摆成一排 0
  // （用户反馈：很多库的文档没细分类型，全是「其他」，却仍显示一长串 0 的分类 chip，没意义）。
  // unknown(其他) 同样仅在有未分类文档时追加。
  const legendTypes = useMemo<string[]>(() => {
    if (!galaxy) return [];
    const counts = galaxy.stats.typeCounts;
    const present: string[] = DOC_TYPES.filter((t) => (counts[t] ?? 0) > 0);
    if ((counts.unknown ?? 0) > 0) present.push('unknown');
    return present;
  }, [galaxy]);

  // 图例 type chip 悬浮飞出：列出该 type 全部文档（半屏可滚，点条目跳转）。
  const [flyoutType, setFlyoutType] = useState<string | null>(null);
  const flyoutTimerRef = useRef<number | null>(null);
  const openFlyout = useCallback((t: string) => {
    if (flyoutTimerRef.current !== null) {
      window.clearTimeout(flyoutTimerRef.current);
      flyoutTimerRef.current = null;
    }
    setFlyoutType(t);
  }, []);
  const scheduleCloseFlyout = useCallback(() => {
    if (flyoutTimerRef.current !== null) window.clearTimeout(flyoutTimerRef.current);
    flyoutTimerRef.current = window.setTimeout(() => setFlyoutType(null), 200);
  }, []);
  useEffect(() => () => {
    if (flyoutTimerRef.current !== null) window.clearTimeout(flyoutTimerRef.current);
  }, []);
  // 按 type 预聚合叶子（飞出清单数据源）
  const leavesByType = useMemo(() => {
    const m = new Map<string, GalaxyNode[]>();
    if (!galaxy) return m;
    for (const leaf of galaxy.leaves) {
      const t = leaf.docType ?? 'unknown';
      const arr = m.get(t);
      if (arr) arr.push(leaf);
      else m.set(t, [leaf]);
    }
    return m;
  }, [galaxy]);

  // 全局搜索：按显示名 / 结构名匹配，命中可点（→ 飞到 + 打开）
  const [search, setSearch] = useState('');
  // 搜索结果某行悬停 → 展开正文预览（2 行截断）
  const [searchHoverId, setSearchHoverId] = useState<string | null>(null);

  // 面包屑下拉点击外部关闭：开着时挂 document mousedown，命中下拉容器外即收起。
  const crumbOverlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openCrumbIdx < 0) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // 菜单已 portal 到 body，不在 crumbOverlayRef 子树里 —— 必须同时排除菜单 ref，
      // 否则点菜单项会被判成「点外面」先关掉，按钮 onClick 都来不及触发。
      if (
        crumbOverlayRef.current && !crumbOverlayRef.current.contains(t) &&
        (!crumbMenuRef.current || !crumbMenuRef.current.contains(t))
      ) {
        setOpenCrumbIdx(-1);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openCrumbIdx]);

  // 切换聚焦/打开文档导致面包屑变化时，关掉旧的下拉，避免指向失效的段。
  useEffect(() => {
    setOpenCrumbIdx(-1);
  }, [crumbs]);
  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !galaxy) return [];
    const out: GalaxyNode[] = [];
    for (const leaf of galaxy.leaves) {
      const dn = leafDisplayName(leaf, labelMode, contentTitles).toLowerCase();
      if (dn.includes(q) || leaf.name.toLowerCase().includes(q)) out.push(leaf);
      if (out.length >= 40) break;
    }
    return out;
  }, [search, galaxy, labelMode, contentTitles]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGalaxy(null);
    setPartial(false);
    setLinksFailed(false);
    setLoadProgress(null);
    setOpenEntryId(null);
    setFocusedNode(null);

    // 超时护栏：25s 内拿不到数据就显式报错，绝不静默空转
    const TIMEOUT_MS = 25_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('__galaxy_timeout__')), TIMEOUT_MS),
    );

    // 整个加载（首页 + 翻页 + 成图）作为一个 async 单元，整体纳入下面的超时 race，
    // 任何一页 await 卡住都会触发超时报错，不会再静默停在「正在构建文档星系...」
    const loadGalaxy = async (): Promise<{ built: DocGalaxy; partial: boolean; linksFailed: boolean }> => {
      const [firstRes, graphRes] = await Promise.all([
        listDocumentEntriesReal(storeId, 1, 200),
        getStoreGraph(storeId),
      ]);
      if (!firstRes.success) {
        console.error('[galaxy] 加载文档条目失败', firstRes.error);
        throw new Error(firstRes.error?.message || '加载文档条目失败');
      }
      const PAGE_SIZE = 200;
      const MAX_PAGES = 50; // 上限 10000 条，防御异常分页
      const allItems = [...firstRes.data.items];
      const total = firstRes.data.total ?? allItems.length;
      if (!cancelled) setLoadProgress({ loaded: allItems.length, total });
      let isPartial = false; // 某页失败 → 图谱不完整，下面 UI 显式提示
      // 还有剩余页就继续翻：用 total 推断总页数，items.length < pageSize 作兜底终止
      let page = 1;
      while (
        allItems.length < total &&
        firstRes.data.items.length >= PAGE_SIZE &&
        page < MAX_PAGES
      ) {
        page += 1;
        const res = await listDocumentEntriesReal(storeId, page, PAGE_SIZE);
        if (cancelled) break;
        if (!res.success) {
          console.error('[galaxy] 翻页加载条目失败（图谱将不完整）', page, res.error);
          isPartial = true;
          break;
        }
        allItems.push(...res.data.items);
        if (!cancelled) setLoadProgress({ loaded: allItems.length, total });
        if (res.data.items.length < PAGE_SIZE) break;
      }
      // 翻到上限仍未取全也算不完整
      if (page >= MAX_PAGES && allItems.length < total) isPartial = true;

      const entries: GalaxyInputEntry[] = allItems.map((e) => ({
        id: e.id,
        title: e.title,
        parentId: e.parentId ?? null,
        isFolder: e.isFolder,
        contentType: e.contentType,
        sourceUrl: e.sourceUrl ?? null,
        summary: e.summary ?? null,
      }));
      // 双链可选：取不到不阻断成图，但必须把「失败」与「真的没引用」区分开 ——
      // 否则 graph 接口临时报错时会静默渲染成「0 引用」，让用户误以为该库没有关系（Codex P2）。
      const linksFailed = !graphRes.success;
      if (linksFailed) {
        console.error('[galaxy] 引用关系（双链）加载失败，将以「引用加载失败」显式标注', graphRes.error);
      }
      const links: GalaxyInputLink[] = graphRes.success
        ? graphRes.data.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            anchorText: edge.anchorText,
            isAutoDetected: edge.isAutoDetected,
          }))
        : [];
      // 默认 canonical resolver：含旧扁平名前缀去扁平化（cds-xxx → cds > xxx），减少悬空
      return { built: buildDocGalaxy(entries, links, { rootName: storeNameRef.current }), partial: isPartial, linksFailed };
    };

    Promise.race([loadGalaxy(), timeout])
      .then((result) => {
        if (!cancelled) {
          setGalaxy(result.built);
          setPartial(result.partial);
          setLinksFailed(result.linksFailed);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        const isTimeout = e instanceof Error && e.message === '__galaxy_timeout__';
        const msg = isTimeout
          ? '数据加载超时（25s），请检查网络或该库是否可访问'
          : e instanceof Error
            ? e.message
            : '加载失败';
        console.error('[galaxy] 数据加载失败', e);
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [storeId]);

  // 关系链面包屑（透明，无药丸底盒）—— 渲染在顶栏里（第一层）。每段带 ▾ 跳同级兄弟下拉。
  const breadcrumbNode =
    galaxy && crumbs.length > 0 ? (
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 4, minWidth: 0, overflow: 'hidden' }}>
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          const isLeaf = c.kind === 'leaf';
          const clickable = isLeaf && !!c.entryId;
          const iconColor = isLeaf ? colorForDocType(c.docType) : i === 0 ? '#ffe08a' : '#9fb4d4';
          const Icon = isLeaf ? FileText : i === 0 ? Layers : Folder;
          const parentNode = i === 0 ? galaxy.root : (nodeIndex.get(crumbs[i - 1].id)?.node ?? null);
          const siblings = parentNode ? parentNode.children : [];
          const hasDropdown = siblings.length > 0;
          const dropdownOpen = openCrumbIdx === i;
          return (
            <span key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, position: 'relative' }}>
              {i > 0 && <span style={{ color: '#4d4f5c', fontSize: 12 }}>/</span>}
              <span
                onClick={
                  hasDropdown
                    ? (e) => {
                        const willOpen = openCrumbIdx !== i;
                        if (willOpen) {
                          const r = e.currentTarget.getBoundingClientRect();
                          // 菜单宽 280，落在段左下方；贴右边时左移避免溢出视口。
                          const left = Math.min(r.left, window.innerWidth - 280 - 8);
                          setCrumbMenuPos({ left: Math.max(8, left), top: r.bottom + 8 });
                        }
                        setOpenCrumbIdx(willOpen ? i : -1);
                      }
                    : clickable
                      ? () => setOpenEntryId(c.entryId!)
                      : undefined
                }
                title={isLeaf && c.docType ? `${c.docType} · ${c.name}` : c.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  color: isLast ? '#eef0f6' : '#9a9cab',
                  fontWeight: isLast ? 600 : 400,
                  cursor: hasDropdown || clickable ? 'pointer' : 'default',
                  maxWidth: 200,
                  minWidth: 0,
                }}
              >
                <Icon size={12} style={{ color: iconColor, flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                {hasDropdown && <ChevronDown size={11} style={{ opacity: 0.6, flexShrink: 0 }} />}
              </span>
              {dropdownOpen && hasDropdown && crumbMenuPos && createPortal(
                <div
                  ref={crumbMenuRef}
                  style={{
                    position: 'fixed',
                    top: crumbMenuPos.top,
                    left: crumbMenuPos.left,
                    width: 280,
                    maxWidth: '80vw',
                    maxHeight: '52vh',
                    display: 'flex',
                    flexDirection: 'column',
                    background: 'rgba(15,16,24,0.97)',
                    backdropFilter: 'blur(16px) saturate(140%)',
                    WebkitBackdropFilter: 'blur(16px) saturate(140%)',
                    border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: 10,
                    boxShadow: '0 14px 38px rgba(0,0,0,0.6)',
                    zIndex: 70,
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ flexShrink: 0, fontSize: 11, color: '#8a8c9a', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    同级（{siblings.length}） · 点击跳转
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '6px 6px 8px' }}>
                    {siblings.map((sib) => {
                      const sibLeaf = sib.kind === 'leaf';
                      const active = sib.id === c.id;
                      return (
                        <button
                          key={sib.id}
                          type="button"
                          onClick={() => {
                            if (sibLeaf) {
                              if (sib.entryId) setOpenEntryId(sib.entryId);
                            } else {
                              requestFocusHub(sib.id);
                            }
                            setOpenCrumbIdx(-1);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            textAlign: 'left',
                            background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                            border: 'none',
                            borderRadius: 7,
                            padding: '6px 8px',
                            cursor: 'pointer',
                            color: active ? '#f4f5fa' : '#dcdde6',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.09)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = active ? 'rgba(255,255,255,0.06)' : 'transparent')}
                        >
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              flexShrink: 0,
                              background: sibLeaf ? colorForDocType(sib.docType) : '#ffe08a',
                              boxShadow: sibLeaf ? `0 0 5px ${colorForDocType(sib.docType)}` : 'none',
                            }}
                          />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {sibLeaf ? leafDisplayName(sib, labelMode, contentTitles) : sib.name}
                          </span>
                          {!sibLeaf && <span style={{ flexShrink: 0, fontSize: 11, color: '#76788a' }}>{sib.docCount} 篇</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>,
                document.body,
              )}
            </span>
          );
        })}
      </div>
    ) : null;

  return (
    <div className="h-full w-full min-h-0 flex flex-col relative" style={{ background: '#02030a' }}>
      {/* 极简兜底顶栏：galaxy 尚未构建成功（加载中 / 失败 / 超时）时也要有「返回」——
          本路由是全屏，隐藏了 AppShell 导航，否则用户只能靠浏览器后退（Codex P2）。 */}
      {!galaxy && (
        <div
          className="shrink-0"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: 'rgba(18,18,26,0.82)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'rgba(45,45,55,0.85)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6,
                padding: '5px 9px',
                color: '#cfcfd6',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              <ArrowLeft size={13} /> 返回
            </button>
          )}
          {storeName && (
            <span style={{ fontSize: 13, fontWeight: 600, color: '#eaeaf0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={storeName}>
              {storeName}
            </span>
          )}
        </div>
      )}

      {/* 瘦身顶栏（类型 chips + 关系链面包屑已下放到画布左上角浮层，见下方）：
          返回 + 库名 + 分隔 + flex 撑开 + 统计 + 引用/部分加载提示 + 搜索 + 标题开关。 */}
      {galaxy && (
        <div
          className="shrink-0"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: 'rgba(18,18,26,0.82)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'rgba(45,45,55,0.85)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6,
                padding: '5px 9px',
                color: '#cfcfd6',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              <ArrowLeft size={13} /> 返回
            </button>
          )}
          {storeName && (
            <span
              style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: '#eaeaf0', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={storeName}
            >
              {storeName}
            </span>
          )}
          <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.12)', flexShrink: 0 }} />
          {/* 关系链面包屑（左上角，紧挨库名左对齐；用户要求放左上角，不再居中）。
              可收缩 + 省略，后面的弹性占位把统计/搜索/开关推到最右。 */}
          <div
            ref={crumbOverlayRef}
            style={{ flex: '0 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', overflow: 'hidden' }}
          >
            {breadcrumbNode ?? (
              <span style={{ fontSize: 11.5, color: '#5a5c6a' }}>点枢纽或文档，这里显示所在关系链</span>
            )}
          </div>
          {/* 弹性占位：把右侧统计/搜索/开关推到最右，面包屑因此停在左侧 */}
          <div style={{ flex: 1, minWidth: 8 }} />
          <div style={{ fontSize: 11, color: '#8a8a96', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: 8 }}>
            共 {galaxy.stats.totalDocs} 篇 · {linksFailed ? '引用未知' : `${galaxy.links.length} 引用`}
            {galaxy.stats.orphanCount > 0 && (
              <span style={{ color: '#9a8a6a' }} title="未能从命名归到 canonical 分类、落「未分类」的文档数">
                {' '}· {galaxy.stats.orphanCount} 悬空
              </span>
            )}
          </div>
          {linksFailed && (
            <div
              style={{
                fontSize: 11,
                color: '#ffd0a0',
                background: 'rgba(120,70,20,0.55)',
                border: '1px solid rgba(255,160,80,0.5)',
                borderRadius: 6,
                padding: '2px 8px',
              }}
              title="引用关系（双链）接口加载失败：当前图中未画任何引用连线，并不代表该库没有引用。请稍后重试或检查权限/服务。"
            >
              引用关系加载失败
            </div>
          )}
          {partial && (
            <div
              style={{
                fontSize: 11,
                color: '#ffd0a0',
                background: 'rgba(120,70,20,0.55)',
                border: '1px solid rgba(255,160,80,0.5)',
                borderRadius: 6,
                padding: '2px 8px',
              }}
              title="部分文档分页加载失败，当前星系不完整（缺少部分文档及其连线）"
            >
              部分加载失败 · 图谱不完整
            </div>
          )}

          {/* 全局搜索：输入标题 → 命中下拉 → 点击飞到 + 打开 */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8,
                padding: '4px 8px',
              }}
            >
              <Search size={13} style={{ color: '#8a8c9a', flexShrink: 0 }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索文档…"
                style={{ background: 'transparent', border: 'none', outline: 'none', color: '#e8e8ee', fontSize: 12, width: 150 }}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="清除搜索"
                  style={{ background: 'none', border: 'none', color: '#9a9cab', cursor: 'pointer', display: 'flex', padding: 0 }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {search.trim() && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  width: 320,
                  maxWidth: '92vw',
                  maxHeight: '52vh',
                  display: 'flex',
                  flexDirection: 'column',
                  background: 'rgba(15,16,24,0.97)',
                  backdropFilter: 'blur(16px) saturate(140%)',
                  WebkitBackdropFilter: 'blur(16px) saturate(140%)',
                  border: '1px solid rgba(255,255,255,0.14)',
                  borderRadius: 12,
                  boxShadow: '0 14px 38px rgba(0,0,0,0.6)',
                  zIndex: 50,
                  overflow: 'hidden',
                }}
              >
                <div style={{ flexShrink: 0, fontSize: 11, color: '#8a8c9a', padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  {searchMatches.length === 0 ? '无匹配文档' : `${searchMatches.length}${searchMatches.length >= 40 ? '+' : ''} 个匹配 · 点击飞到并打开`}
                </div>
                <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '6px 6px 8px' }}>
                  {searchMatches.map((leaf) => {
                    const preview = searchHoverId === leaf.id ? cleanPreview(leaf.summary) : '';
                    return (
                      <button
                        key={leaf.id}
                        type="button"
                        onClick={() => {
                          if (leaf.entryId) setOpenEntryId(leaf.entryId);
                          setSearch('');
                        }}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 0,
                          width: '100%',
                          textAlign: 'left',
                          background: 'transparent',
                          border: 'none',
                          borderRadius: 7,
                          padding: '6px 8px',
                          cursor: 'pointer',
                          color: '#dcdde6',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
                          setSearchHoverId(leaf.id);
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                          setSearchHoverId((id) => (id === leaf.id ? null : id));
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: colorForDocType(leaf.docType) }} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {leafDisplayName(leaf, labelMode, contentTitles)}
                          </span>
                        </span>
                        {/* 悬停展开：正文预览（2 行截断） */}
                        {preview && (
                          <span
                            style={{
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                              fontSize: 11,
                              color: '#8f93a3',
                              marginTop: 2,
                              paddingLeft: 16,
                            }}
                          >
                            {preview}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 标题显示开关（最右）：结构名 ↔ 正文标题 */}
          {onToggleLabelMode && (
            <button
              type="button"
              onClick={onToggleLabelMode}
              title={
                labelMode === 'content'
                  ? '当前：显示正文标题（正文第一行 / frontmatter title）。点击切回结构名'
                  : '当前：显示结构名（文件名 / 点分命名）。点击切到正文标题'
              }
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'rgba(45,45,55,0.85)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6,
                padding: '5px 9px',
                color: '#cfcfd6',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {labelMode === 'content' ? <ToggleRight size={14} style={{ color: '#8ab4ff' }} /> : <ToggleLeft size={14} />}
              {labelMode === 'content' ? '正文标题' : '结构名'}
            </button>
          )}
        </div>
      )}

      {/* 画布层（flex-1 撑满图例下方的剩余高度，画布/状态相对它定位） */}
      <div className="flex-1 min-h-0 relative">
        {/* 操作提示 */}
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            zIndex: 10,
            fontSize: 11,
            color: '#7c8093',
            background: 'rgba(6,8,16,0.5)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 999,
            padding: '5px 12px',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            maxWidth: 'calc(100% - 160px)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          拖动旋转 · 两指滑动旋转视角 · 捏合或 ⌘/Ctrl+滚轮缩放 · 悬停看详情/清单 · 点文档星阅读 · 点枢纽聚焦 · 双击空白继续旋转
        </div>

        {/* 画布左上角浮层（第二层）：仅类型 chips（透明，无底盒）。面包屑已上移到顶栏（第一层）。 */}
        {galaxy && (
          <div
            style={{
              position: 'absolute',
              top: 10,
              left: 12,
              zIndex: 15,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              alignItems: 'flex-start',
              pointerEvents: 'none',
              maxWidth: 'min(70%, 640px)',
            }}
          >
            {/* 类型 chips（透明浮层，无底盒）：点击切显隐、悬停飞出该类全部文档清单 */}
            <div style={{ pointerEvents: 'auto', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {legendTypes.map((t) => {
                const on = typeOn[t] !== false;
                return (
                  <span
                    key={t}
                    style={{ position: 'relative', display: 'inline-flex' }}
                    onMouseEnter={() => openFlyout(t)}
                    onMouseLeave={scheduleCloseFlyout}
                  >
                    <button
                      type="button"
                      onClick={() => setTypeOn((prev) => ({ ...prev, [t]: prev[t] === false }))}
                      title={`点击切换显示「${t}」类文档；悬停查看该类全部文档`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 11,
                        color: on ? '#c8c8d2' : '#5a5a66',
                        background: flyoutType === t ? 'rgba(255,255,255,0.1)' : 'rgba(8,9,14,0.42)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        cursor: 'pointer',
                        padding: '3px 8px',
                        borderRadius: 999,
                        opacity: on ? 1 : 0.5,
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                      }}
                    >
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: '50%',
                          background: TYPE_COLOR[t],
                          display: 'inline-block',
                          boxShadow: on ? `0 0 6px ${TYPE_COLOR[t]}` : 'none',
                        }}
                      />
                      {TYPE_LABEL[t] ?? t}
                      <span style={{ color: '#6a6a78' }}>{galaxy.stats.typeCounts[t] ?? 0}</span>
                    </button>
                    {flyoutType === t && (
                      <TypeDocFlyout
                        type={t}
                        leaves={leavesByType.get(t) ?? []}
                        labelMode={labelMode}
                        contentTitles={contentTitles}
                        onOpen={(id) => {
                          setFlyoutType(null);
                          setOpenEntryId(id);
                        }}
                        onKeepAlive={() => openFlyout(t)}
                        onScheduleClose={scheduleCloseFlyout}
                      />
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* 3D 画布（vanilla three.js 渲染内核；内部 try/catch + fatal state 替代 ErrorBoundary） */}
        {galaxy && !loading && !error && galaxy.stats.totalDocs > 0 && (
          <GalaxyCanvas
            galaxy={galaxy}
            typeOn={typeOn}
            onOpen={setOpenEntryId}
            labelMode={labelMode}
            contentTitles={contentTitles}
            onFocusChange={setFocusedNode}
            flyToEntryId={openEntryId}
            focusHubReq={focusHubReq}
            drawerWidth={openEntryId ? drawerWidth : 0}
          />
        )}

        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}>
            <GalaxyConstellationLoader
              text={
                loadProgress
                  ? `正在构建文档星系… 已加载 ${loadProgress.loaded}/${loadProgress.total} 篇`
                  : '正在构建文档星系…'
              }
            />
          </div>
        )}

        {error && !loading && (
          <div
            style={{
              position: 'absolute',
              top: 24,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(60,30,30,0.95)',
              border: '1px solid rgba(255,90,90,0.5)',
              borderRadius: 8,
              padding: '12px 16px',
              color: '#ffd0d0',
              fontSize: 13,
              maxWidth: 'min(560px, 92%)',
              textAlign: 'center',
              zIndex: 50,
            }}
          >
            加载失败：{error}
          </div>
        )}

        {!loading && !error && galaxy && galaxy.stats.totalDocs === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#777',
              fontSize: 14,
              textAlign: 'center',
              zIndex: 5,
            }}
          >
            <div>
              <div style={{ fontSize: 16, marginBottom: 8 }}>这个库还没有文档</div>
              <div>上传或新建文档后，星系会自动生长。</div>
            </div>
          </div>
        )}
      </div>

      {openEntryId && (() => {
        const openLeaf = galaxy?.leaves.find((l) => l.entryId === openEntryId) ?? null;
        const displayTitle = openLeaf ? leafDisplayName(openLeaf, labelMode, contentTitles) : undefined;
        const path = galaxy ? pathToNode(galaxy.root, 'e:' + openEntryId) : null;
        const pathNames = path ? path.slice(0, -1).map((n) => n.name) : [];
        return (
          <ReaderPanel
            entryId={openEntryId}
            displayTitle={displayTitle}
            pathNames={pathNames}
            width={drawerWidth}
            onResize={setDrawerWidthPersist}
            onClose={() => setOpenEntryId(null)}
          />
        );
      })()}
    </div>
  );
}

// 供 React.lazy 懒加载使用
export default function DocumentGalaxyViewLazy(props: DocumentGalaxyViewProps) {
  return (
    <Suspense fallback={<div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><GalaxyConstellationLoader text="正在加载星系…" /></div>}>
      <DocumentGalaxyView {...props} />
    </Suspense>
  );
}
