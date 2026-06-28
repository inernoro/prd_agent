/**
 * 知识库 3D 文档星系视图（Galaxy）。
 *
 * 数据：listDocumentEntriesReal（条目）+ getStoreGraph（双链）。
 * 业务关系识别复用 buildDocGalaxy（SSOT，根→分类→appname→子模块→文档树 + 横向引用）。
 *
 * 渲染内核（2026-06-25 重写 + 视觉对齐）：vanilla three.js（原生 EffectComposer +
 * UnrealBloomPass 选择性 bloom），**完整照搬演示版 doc-tree-3d.html 的视觉数值**（演示是 SSOT）。
 * 这是「白色 group/root 节点不爆成大白团」的关键 —— 不只搬 bloom 双 pass，更搬真实的视觉用量：
 *
 *   尺度与布局（照抄演示）：LEVEL_R=[0,120,300,470,620,760] 球面树 + 斐波那契球铺顶级分类 +
 *     圆锥散开子节点；相机 fov 60 / pos (0,120,1050) / 远 12000；OrbitControls 阻尼 0.045。
 *   节点尺寸（照抄演示 nodeSize）：root 16 / category(d1) 10 / appname(d2) 4.5+min(5,√docCount) /
 *     submodule(d≥3) 3.2 / leaf 2.1；核心球半径 = size*0.9。
 *   光晕（白团根因，改成演示同款的小光晕）：缩放 = size*(leaf?7:10)、不透明度
 *     root 0.5 / category 0.46 / appname 0.36 / submodule 0.26 / leaf 0.32；随相机距离衰减(refD=size*26)。
 *   配色（照抄演示，更克制）：TYPE_COLORS + root 纯白 / category 金 / appname 冷白 / submodule 灰蓝。
 *   选择性 bloom 双 pass（保留）：
 *     1) bloomComposer 只渲染 BLOOM_LAYER（星体核心 mesh），其余物体临时变黑/隐藏 → 离屏 glow 纹理；
 *     2) finalComposer 正常渲染整场景，再用 combine ShaderPass 把 glow 叠加上去（×0.85 软叠加）。
 *   核心 MeshBasicMaterial（非 emissive），bloom strength=0.62 / threshold=0.72 / radius=0.4；
 *   ACES 色调映射 + 曝光 0.82：高光柔性滚降，放大时不死白。
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

// 顶级分类用斐波那契球均匀分布方向。
// 全球面对称：y 由接近 +1 均匀铺到接近 -1（含南北极），密度处处相等 → 正圆。
// 旧版 `y = 1 - i/(count-1) * 2 * 0.85` 再 `* 0.9` 是「压扁球」：y 只到 [+0.90, -0.63]，
// 整块南极帽永远空着、且上多下少（200 点时上 118 下 82）。分类少时秃顶看不出，
// 分类一多就暴露成「顶部大、底部小」——这是「不再全局均衡」的直接根因。
function distributeDirections(count: number): THREE.Vector3[] {
  const dirs: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2; // [+1, -1) 端点对称，覆盖全球面
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    dirs.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).normalize());
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

// ── 节点渲染时挂在 sprite/mesh userData 上的元信息 ──
interface NodeRender {
  node: GalaxyNode;
  core: THREE.Mesh;
  halo: THREE.Sprite;
  haloBaseSize: number;
  haloBaseOpacity: number;
  size: number;
}

/**
 * 文本标签贴图（枢纽节点用，canvas 绘制后做 sprite）。
 * 标签在 bloom 层之外 → 永远清晰、不被泛光糊掉。
 */
// 仅生成标签纹理 + 尺寸（供初次创建 sprite 与切换显示模式时重绘共用）。
function makeLabelTexture(
  text: string,
  kind: GalaxyNode['kind'],
  depth: number,
  color: string,
): { tex: THREE.CanvasTexture; w: number; h: number; fontSize: number } {
  // 演示版字号：root 46 / category 40 / 其余 30
  const fontSize = kind === 'root' ? 46 : depth <= 1 ? 40 : 30;
  const pad = 10;
  const measure = document.createElement('canvas').getContext('2d')!;
  const font = `600 ${fontSize}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
  measure.font = font;
  const w = measure.measureText(text || ' ').width;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w + pad * 2);
  cv.height = fontSize + pad * 2;
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
  cx.fillStyle = 'rgba(3,6,18,0.6)';
  rr(0, 0, cv.width, cv.height, 9);
  cx.fill();
  cx.strokeStyle = color + '66';
  cx.lineWidth = 2;
  rr(1, 1, cv.width - 2, cv.height - 2, 9);
  cx.stroke();
  cx.fillStyle = kind === 'root' ? '#ffffff' : color;
  cx.font = font;
  cx.textBaseline = 'middle';
  cx.fillText(text, pad, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return { tex, w: cv.width, h: cv.height, fontSize };
}

function makeLabelSprite(text: string, kind: GalaxyNode['kind'], depth: number, color: string): THREE.Sprite {
  const { tex, w, h, fontSize } = makeLabelTexture(text, kind, depth, color);
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
  );
  // 演示版世界尺度：sc = 0.34*(fontSize/30)
  const sc = 0.34 * (fontSize / 30);
  sp.scale.set(w * sc, h * sc, 1);
  sp.renderOrder = 10;
  // 记录元数据，供切换显示模式时按相同 kind/depth/color 重绘
  sp.userData.labelMeta = { kind, depth, color };
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
  const sc = 0.34 * (fontSize / 30);
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
    // ACES filmic 色调映射 + 曝光 0.82：高光柔性滚降，放大不死白（演示版同款）
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.82;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02030a);
    // 演示版极淡指数雾（大尺度场景，0.00035）
    scene.fog = new THREE.FogExp2(0x02030a, 0.00035);

    // 演示版相机：fov 60、近 1 远 12000、起始位 (0,120,1050)
    const camera = new THREE.PerspectiveCamera(60, W / H, 1, 12000);
    camera.position.set(0, 120, 1050);

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
    // 滚轮/触控板手势改由自定义 wheel 接管（对齐 .claude/rules/gesture-unification.md）：
    // 两指滑动 = 平移、⌘/Ctrl+滚轮 或 双指捏合 = 缩放。
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

    // ── 深空星点 starfield（演示版数值 SSOT：N=3000、半径 2200..6400、size 3、opacity 0.8）──
    {
      const N = 3000;
      const positions = new Float32Array(N * 3);
      const colors = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const r = 2200 + Math.random() * 4200;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(ph) * Math.cos(th);
        positions[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
        positions[i * 3 + 2] = r * Math.cos(ph);
        // 演示版亮度：b=0.35..0.9，蓝偏，克制
        const b = 0.35 + Math.random() * 0.55;
        colors[i * 3] = b;
        colors[i * 3 + 1] = b;
        colors[i * 3 + 2] = b * (0.85 + Math.random() * 0.2);
      }
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const mat = track(
        new THREE.PointsMaterial({
          size: 3,
          sizeAttenuation: true,
          map: STAR_TEX,
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          opacity: 0.8,
        }),
      );
      scene.add(new THREE.Points(geo, mat));
    }

    // ── EVE 风远景星云（演示版数值 SSOT：14 片、半径 3400..6000、scale 2200..4600、opacity 0.5、additive）──
    const nebulaGroup = new THREE.Group();
    scene.add(nebulaGroup);
    {
      // 演示版 makeNebulaTex：每片由 5 个随机径向云团叠成，wispy
      const makeNebulaTex = (hue: string): THREE.Texture => {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const g = c.getContext('2d')!;
        for (let k = 0; k < 5; k++) {
          const cx = 64 + Math.random() * 128;
          const cy = 64 + Math.random() * 128;
          const rad = 40 + Math.random() * 90;
          const rg = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
          rg.addColorStop(0, hue + 'cc');
          rg.addColorStop(0.5, hue + '44');
          rg.addColorStop(1, hue + '00');
          g.fillStyle = rg;
          g.beginPath();
          g.arc(cx, cy, rad, 0, Math.PI * 2);
          g.fill();
        }
        const tex = new THREE.CanvasTexture(c);
        tex.needsUpdate = true;
        return tex;
      };
      const hues = ['#16243f', '#1c2a52', '#2a1c46', '#102a3a', '#231a3e', '#0f2030'];
      for (let i = 0; i < 14; i++) {
        const hue = hues[i % hues.length];
        const mat = track(
          new THREE.SpriteMaterial({
            map: track(makeNebulaTex(hue)),
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: false,
          }),
        );
        const sp = new THREE.Sprite(mat);
        const r = 3400 + Math.random() * 2600;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        sp.position.set(r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th) * 0.7, r * Math.cos(ph));
        const sc = 2200 + Math.random() * 2400;
        sp.scale.set(sc, sc, 1);
        sp.renderOrder = -10;
        nebulaGroup.add(sp);
      }
    }

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

    for (const { node, pos, depth } of placed.values()) {
      const isLeaf = node.kind === 'leaf';
      const color = isLeaf ? colorForDocType(node.docType) : groupColor(node, depth);
      const col = new THREE.Color(color);

      // 演示版尺度：size 决定核心球半径(size*0.9)、光晕缩放(size*7|10)、标签偏移
      const size = nodeSize(node, depth);

      // 核心：MeshBasicMaterial（非 emissive 泛光）—— 选择性 bloom 只让这层溢出
      const r = coreRadiusFromSize(size);
      const coreMat = track(new THREE.MeshBasicMaterial({ color: col }));
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
          opacity: haloBaseOpacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const halo = new THREE.Sprite(haloMat);
      halo.position.copy(pos);
      halo.scale.set(haloSize, haloSize, 1);
      nodeGroup.add(halo);

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

      renders.push({ node, core, halo, haloBaseSize: haloSize, haloBaseOpacity, size });
      if (labelSprite) labelByNodeId.set(node.id, labelSprite);
    }

    // 显示模式切换 → 按当前 labelMode/contentTitles 重绘所有标签纹理（不重建场景）
    relabelRef.current = () => {
      const mode = labelModeRef.current;
      const titles = contentTitlesRef.current;
      for (const [id, sprite] of labelByNodeId) {
        const pl = placed.get(id);
        if (!pl) continue;
        track(redrawLabelSprite(sprite, labelTextFor(pl.node, mode, titles)));
      }
    };

    // ── 父子连线（偏冷蓝细线，不进 bloom 层）。位置由 applyFilter 填充/重建：
    //    隐藏叶子的入边折叠为零长，不再连向空处。 ──
    const hierGeo = track(new THREE.BufferGeometry());
    hierGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(edges.length * 6), 3));
    // 演示版 EVE 星座线：冷蓝 #5a86c8、additive、opacity 0.42
    scene.add(
      new THREE.LineSegments(
        hierGeo,
        track(
          new THREE.LineBasicMaterial({
            color: new THREE.Color('#5a86c8'),
            transparent: true,
            opacity: 0.42,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        ),
      ),
    );

    // ── 横向引用连线（更淡，不进 bloom 层）。任一端隐藏则该段折叠。 ──
    const mentionPairs: Array<{ a: THREE.Vector3; b: THREE.Vector3; source: string; target: string }> = [];
    for (const link of galaxy.links) {
      const a = placed.get(link.source);
      const b = placed.get(link.target);
      if (a && b) mentionPairs.push({ a: a.pos, b: b.pos, source: link.source, target: link.target });
    }
    let mentionGeo: THREE.BufferGeometry | null = null;
    if (mentionPairs.length > 0) {
      mentionGeo = track(new THREE.BufferGeometry());
      mentionGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(mentionPairs.length * 6), 3));
      // 横向引用线：略亮冷蓝、additive、opacity 0.32（与父子线同色系，演示风格）
      scene.add(
        new THREE.LineSegments(
          mentionGeo,
          track(
            new THREE.LineBasicMaterial({
              color: new THREE.Color('#8fc4ff'),
              transparent: true,
              opacity: 0.32,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          ),
        ),
      );
    }

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
      // 父子线：child 是隐藏叶子 → 两端折叠成同点（零长，不可见）
      const hp = hierGeo.getAttribute('position') as THREE.BufferAttribute;
      edges.forEach((e, i) => {
        const show = vis.get(e.child.id) ?? true;
        hp.setXYZ(i * 2, e.a.x, e.a.y, e.a.z);
        hp.setXYZ(i * 2 + 1, show ? e.b.x : e.a.x, show ? e.b.y : e.a.y, show ? e.b.z : e.a.z);
      });
      hp.needsUpdate = true;
      // 引用线：任一端隐藏 → 折叠
      if (mentionGeo) {
        const mp = mentionGeo.getAttribute('position') as THREE.BufferAttribute;
        mentionPairs.forEach((e, i) => {
          const show = (vis.get(e.source) ?? true) && (vis.get(e.target) ?? true);
          mp.setXYZ(i * 2, e.a.x, e.a.y, e.a.z);
          mp.setXYZ(i * 2 + 1, show ? e.b.x : e.a.x, show ? e.b.y : e.a.y, show ? e.b.z : e.a.z);
        });
        mp.needsUpdate = true;
      }
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

    // 相机缓动：1s easeInOutCubic 把 controls.target + camera.position 移到聚焦点。
    let camTween: {
      t0: number;
      dur: number;
      fromTarget: THREE.Vector3;
      toTarget: THREE.Vector3;
      fromPos: THREE.Vector3;
      toPos: THREE.Vector3;
    } | null = null;
    const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

    const startCamTween = (targetPos: THREE.Vector3, distance: number) => {
      // 沿当前相机→目标方向退到 distance 处，保留观察角度，避免镜头乱翻
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
      dir.normalize();
      const toPos = targetPos.clone().add(dir.multiplyScalar(distance));
      camTween = {
        t0: performance.now(),
        dur: 1000,
        fromTarget: controls.target.clone(),
        toTarget: targetPos.clone(),
        fromPos: camera.position.clone(),
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
      setFocusInfo(null);
      onFocusChangeRef.current?.(null);
      // 相机平滑回到初始机位
      camTween = {
        t0: performance.now(),
        dur: 1000,
        fromTarget: controls.target.clone(),
        toTarget: new THREE.Vector3(0, 0, 0),
        fromPos: camera.position.clone(),
        toPos: new THREE.Vector3(0, 120, 1050),
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

    // ── 选择性 bloom 双 pass（演示版同款配方） ──
    const renderTargetSize = new THREE.Vector2(W, H);
    const bloomComposer = new EffectComposer(renderer);
    bloomComposer.renderToScreen = false;
    bloomComposer.addPass(new RenderPass(scene, camera));
    // strength 0.62 / radius 0.4 / threshold 0.72：只有最亮核心溢出，辉光是点缀不是泛滥
    const bloomPass = new UnrealBloomPass(renderTargetSize, 0.62, 0.4, 0.72);
    bloomComposer.addPass(bloomPass);

    const combineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture },
      },
      vertexShader:
        'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:
        'uniform sampler2D baseTexture;uniform sampler2D bloomTexture;varying vec2 vUv;' +
        'void main(){vec4 base=texture2D(baseTexture,vUv);vec4 glow=texture2D(bloomTexture,vUv);' +
        // 软叠加：glow ×0.85，重叠辉光不超过过曝阈值
        'gl_FragColor=base + vec4(glow.rgb*0.85,0.0);}',
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

    // ── 触控板/滚轮手势（gesture-unification.md 的 OrbitControls 落地）──
    //   两指滑动 = 平移（含苹果触控板左右滑 → 左右移动）；⌘/Ctrl+滚轮 或 双指捏合 = 缩放。
    const gOffset = new THREE.Vector3();
    const gRight = new THREE.Vector3();
    const gUp = new THREE.Vector3();
    const panByPixels = (dxPx: number, dyPx: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      gOffset.copy(camera.position).sub(controls.target);
      const dist = gOffset.length() * Math.tan(((camera.fov / 2) * Math.PI) / 180);
      const panX = (2 * dxPx * dist) / Math.max(1, rect.height);
      const panY = (2 * dyPx * dist) / Math.max(1, rect.height);
      const te = camera.matrix.elements;
      gRight.set(te[0], te[1], te[2]);
      gUp.set(te[4], te[5], te[6]);
      // 对齐视觉创作（AdvancedVisualAgentTab）的 trackpad 手感：内容随手指反向位移
      // （cam - delta）。相机右移=内容左移、相机下移=内容上移 → move = right*Δx - up*Δy。
      const move = gRight.multiplyScalar(panX).add(gUp.multiplyScalar(-panY));
      camera.position.add(move);
      controls.target.add(move);
    };
    const dollyByDelta = (deltaY: number) => {
      gOffset.copy(camera.position).sub(controls.target);
      let d = gOffset.length() * Math.pow(0.95, -deltaY * 0.01);
      d = Math.min(controls.maxDistance, Math.max(controls.minDistance, d));
      camera.position.copy(controls.target).add(gOffset.setLength(d));
    };
    // 鼠标滚轮 vs 触摸板的「黏性」判别（用户要求：鼠标滚轮=缩放、触摸板双指滑=平移）。
    // 正确约定（业界 3D 通行，Figma/Blender/Earth/本项目视觉创作画布）：
    //   · 鼠标滚轮（无修饰键）          → 缩放
    //   · 触摸板双指上下/左右滑          → 平移
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
      // 捏合 / ⌘·Ctrl+滚轮 一律缩放；否则按设备判别：鼠标滚轮缩放、触摸板平移
      if (ev.ctrlKey || ev.metaKey || classifyWheel(ev) === 'mouse') dollyByDelta(ev.deltaY);
      else panByPixels(ev.deltaX, ev.deltaY);
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
      // 星云缓慢漂移
      nebulaGroup.rotation.y += dt * 0.004;
      nebulaGroup.rotation.x += dt * 0.0016;

      // 相机聚焦缓动（easeInOutCubic，~1s）
      if (camTween) {
        const k = Math.min(1, (performance.now() - camTween.t0) / camTween.dur);
        const e = easeInOutCubic(k);
        controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, e);
        camera.position.lerpVectors(camTween.fromPos, camTween.toPos, e);
        if (k >= 1) camTween = null;
      }

      // 叶子脉冲高亮：聚焦到具体文档后让它"呼吸"约 1.4s（衰减正弦），结束复位
      if (pulseLeafId) {
        const elapsed = performance.now() - pulseT0;
        const rec = renders.find((r) => r.node.id === pulseLeafId);
        if (!rec || elapsed >= 1400) {
          if (rec) rec.core.scale.setScalar(1);
          pulseLeafId = null;
        } else {
          const p = elapsed / 1400;
          rec.core.scale.setScalar(1 + 0.85 * (1 - p) * Math.abs(Math.sin(p * Math.PI * 3)));
        }
      }

      // 聚焦淡出系数 lerp（平滑过渡，避免硬切）
      for (const rec of renders) {
        const cur = dimCurrentById.get(rec.node.id) ?? 1;
        const tgt = dimTargetById.get(rec.node.id) ?? 1;
        const next = cur + (tgt - cur) * 0.12;
        dimCurrentById.set(rec.node.id, next);
        // 核心球：dim 时调暗其颜色（用 material.color 缩放会污染基色，改用 opacity）
        const coreMat = rec.core.material as THREE.MeshBasicMaterial;
        if (!coreMat.transparent) coreMat.transparent = true;
        coreMat.opacity = 0.15 + 0.85 * next;
        // 标签：随聚焦淡出
        const lab = labelByNodeId.get(rec.node.id);
        if (lab) (lab.material as THREE.SpriteMaterial).opacity = next;
      }

      // 光晕距离衰减 + hover 强调（演示版数值 SSOT 照抄）+ 聚焦淡出
      camPos.copy(camera.position);
      for (const rec of renders) {
        if (!rec.halo.visible) continue;
        rec.halo.getWorldPosition(haloWorld);
        const d = camPos.distanceTo(haloWorld);
        const refD = Math.max(220, rec.size * 26); // 近于 refD 时缩小，避免贴脸过曝
        const att = Math.min(1, d / refD);
        const attScale = 0.35 + 0.65 * att; // 永不完全坍缩，永不超过基准
        const scale = rec.haloBaseSize * attScale;
        rec.halo.scale.set(scale, scale, 1);
        const dim = dimCurrentById.get(rec.node.id) ?? 1;
        let tgt = rec.haloBaseOpacity * (0.45 + 0.55 * att) * dim; // 极近时淡化辉光，聚焦时集合外淡出
        if (hoverNode === rec.node) tgt = Math.min(0.85, tgt * 1.7);
        const mat = rec.halo.material as THREE.SpriteMaterial;
        mat.opacity += (tgt - mat.opacity) * 0.2;
      }

      // 持续选中态：被选中的文档星 发光（bloom 更强 + 光晕更亮）+ 放大 + 呼吸动效。
      // 放在常态 dim/halo 之后，覆盖其值，让"哪个是选中的"一眼可见。
      if (selectedLeafId) {
        const rec = renders.find((r) => r.node.id === selectedLeafId);
        if (rec) {
          const phase = Math.sin(clock.elapsedTime * 2.6);
          rec.core.scale.setScalar(1.55 + 0.18 * phase); // 放大 + 呼吸（bloom 层 → 自带发光）
          (rec.core.material as THREE.MeshBasicMaterial).opacity = 1; // 选中恒亮
          if (rec.halo.visible) {
            const hs = rec.haloBaseSize * (2.2 + 0.3 * phase);
            rec.halo.scale.set(hs, hs, 1);
            (rec.halo.material as THREE.SpriteMaterial).opacity = Math.min(0.95, rec.haloBaseOpacity * 2.4);
          }
          const lab = labelByNodeId.get(rec.node.id);
          if (lab) (lab.material as THREE.SpriteMaterial).opacity = 1;
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
        <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, fontSize: 11, color: '#5a5a66' }}>
          拖动旋转 · 两指滑动平移 · ⌘/Ctrl+滚轮缩放 · 悬停看详情/清单 · 点文档星阅读 · 点枢纽聚焦 · 双击空白继续旋转
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
