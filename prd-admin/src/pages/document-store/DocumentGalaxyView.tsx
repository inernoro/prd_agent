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
import { Suspense, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { X } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
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
function colorForDocType(docType?: string | null): string {
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
function makeLabelSprite(text: string, kind: GalaxyNode['kind'], depth: number, color: string): THREE.Sprite {
  // 演示版字号：root 46 / category 40 / 其余 30
  const fontSize = kind === 'root' ? 46 : depth <= 1 ? 40 : 30;
  const pad = 10;
  const measure = document.createElement('canvas').getContext('2d')!;
  const font = `600 ${fontSize}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
  measure.font = font;
  const w = measure.measureText(text).width;
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
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
  );
  // 演示版世界尺度：sc = 0.34*(fontSize/30)
  const sc = 0.34 * (fontSize / 30);
  sp.scale.set(cv.width * sc, cv.height * sc, 1);
  sp.renderOrder = 10;
  return sp;
}

interface GalaxyCanvasProps {
  galaxy: DocGalaxy;
  typeOn: Record<string, boolean>;
  onOpen: (entryId: string) => void;
}

/**
 * Vanilla three.js 渲染内核。挂一个 <div ref>，useEffect 里建 renderer/scene/camera/controls/composer，
 * 选择性 bloom 双 pass。type 筛选通过 typeOn 同步给场景（dim/hide leaf）。
 * unmount / galaxy 变化时彻底 dispose，避免 React 重复挂载泄漏。
 */
function GalaxyCanvas({ galaxy, typeOn, onOpen }: GalaxyCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  // hover 标签：3D 坐标 project 到屏幕后用绝对定位 DOM tooltip 渲染
  const [hoverLabel, setHoverLabel] = useState<{ x: number; y: number; text: string } | null>(null);

  // typeOn 用 ref 透传给渲染循环，避免每次筛选都重建整个场景
  const typeOnRef = useRef(typeOn);
  typeOnRef.current = typeOn;
  // applyFilter 函数引用，typeOn 变化时调用
  const applyFilterRef = useRef<(() => void) | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    applyFilterRef.current?.();
  }, [typeOn]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    setFatal(null);
    setHoverLabel(null);

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

      // 枢纽标签（root / group）
      if (!isLeaf) {
        const lab = makeLabelSprite(node.name, node.kind, depth, color);
        if (lab.material.map) track(lab.material.map);
        track(lab.material);
        // 演示版标签偏移：size + (root?14:8)
        const dy = size + (node.kind === 'root' ? 14 : 8);
        lab.position.set(pos.x, pos.y + dy, pos.z);
        nodeGroup.add(lab);
      }

      renders.push({ node, core, halo, haloBaseSize: haloSize, haloBaseOpacity, size });
    }

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

    // ── type 筛选：隐藏叶子核心/光晕 + 同步折叠其入边和引用线，不留连向空处的线 ──
    const applyFilter = () => {
      const on = typeOnRef.current;
      const anyOff = DOC_TYPES.some((t) => !on[t]);
      const vis = new Map<string, boolean>();
      for (const rec of renders) {
        const n = rec.node;
        const visible = n.kind !== 'leaf' || !anyOff || (n.docType ? on[n.docType] !== false : true);
        vis.set(n.id, visible);
        if (n.kind === 'leaf') {
          rec.core.visible = visible;
          rec.halo.visible = visible;
        }
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

    const pick = (clientX: number, clientY: number): { node: GalaxyNode; mesh: THREE.Mesh } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
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
        if (!node) setHoverLabel(null);
      }
      if (node && hit) {
        // 把核心世界坐标投影到屏幕，定位 tooltip
        hit.mesh.getWorldPosition(projVec);
        projVec.project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        const sx = (projVec.x * 0.5 + 0.5) * rect.width;
        const sy = (-projVec.y * 0.5 + 0.5) * rect.height;
        setHoverLabel({ x: sx, y: sy, text: node.name });
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
      if (hit && hit.node.kind === 'leaf' && hit.node.entryId) {
        onOpenRef.current(hit.node.entryId);
      }
      downXY = null;
    };
    const onPointerLeave = () => {
      hoverNode = null;
      setHoverLabel(null);
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

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
      // 光晕距离衰减 + hover 强调（演示版数值 SSOT 照抄）
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
        let tgt = rec.haloBaseOpacity * (0.45 + 0.55 * att); // 极近时淡化辉光
        if (hoverNode === rec.node) tgt = Math.min(0.85, tgt * 1.7);
        const mat = rec.halo.material as THREE.SpriteMaterial;
        mat.opacity += (tgt - mat.opacity) * 0.2;
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
      renderer.setSize(W, H);
      bloomComposer.setSize(W, H);
      finalComposer.setSize(W, H);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    window.addEventListener('resize', resize);

    // ── 清理 ──
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener('resize', resize);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
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
    // galaxy 变化重建场景；typeOn 走 applyFilterRef，不在此 deps
  }, [galaxy]);

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
      {hoverLabel && (
        <div
          style={{
            position: 'absolute',
            left: hoverLabel.x,
            top: hoverLabel.y,
            transform: 'translate(12px, -50%)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            background: 'rgba(20,20,28,0.92)',
            border: '1px solid rgba(255,255,255,0.16)',
            borderRadius: 6,
            padding: '4px 8px',
            color: '#f0f0f5',
            fontSize: 13,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            zIndex: 15,
          }}
        >
          {hoverLabel.text}
        </div>
      )}
    </div>
  );
}

// ── 阅读面板：点星弹出，复用系统 MarkdownViewer ──
function ReaderPanel({ entryId, onClose }: { entryId: string; onClose: () => void }) {
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

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(560px, 92vw)',
        background: '#15151c',
        borderLeft: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '-8px 0 28px rgba(0,0,0,0.5)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: '#eaeaf0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || '文档'}
        </div>
        <button
          onClick={onClose}
          aria-label="关闭"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            width: 28,
            height: 28,
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
          padding: '16px 18px',
        }}
      >
        {loading && <MapSectionLoader text="正在加载文档..." />}
        {error && !loading && <div style={{ color: '#ffb0b0', fontSize: 13 }}>加载失败：{error}</div>}
        {!loading && !error && content !== null && content.trim() !== '' && <MarkdownViewer content={content} />}
        {!loading && !error && (content === null || content.trim() === '') && (
          <div style={{ color: '#888', fontSize: 13 }}>该文档暂无可预览的正文内容。</div>
        )}
      </div>
    </div>
  );
}

export interface DocumentGalaxyViewProps {
  storeId: string;
  storeName?: string;
}

export function DocumentGalaxyView({ storeId, storeName }: DocumentGalaxyViewProps) {
  const [galaxy, setGalaxy] = useState<DocGalaxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false); // 翻页有页失败 → 图谱不完整
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const storeNameRef = useRef(storeName);
  storeNameRef.current = storeName;

  // type 图例筛选状态（7 种 type 全开）
  const [typeOn, setTypeOn] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const t of DOC_TYPES) init[t] = true;
    return init;
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGalaxy(null);
    setPartial(false);
    setOpenEntryId(null);

    // 超时护栏：25s 内拿不到数据就显式报错，绝不静默空转
    const TIMEOUT_MS = 25_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('__galaxy_timeout__')), TIMEOUT_MS),
    );

    // 整个加载（首页 + 翻页 + 成图）作为一个 async 单元，整体纳入下面的超时 race，
    // 任何一页 await 卡住都会触发超时报错，不会再静默停在「正在构建文档星系...」
    const loadGalaxy = async (): Promise<{ built: DocGalaxy; partial: boolean }> => {
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
      }));
      // 双链可选：取不到不阻断成图
      const links: GalaxyInputLink[] = graphRes.success
        ? graphRes.data.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            anchorText: edge.anchorText,
            isAutoDetected: edge.isAutoDetected,
          }))
        : [];
      // 默认 canonical resolver：含旧扁平名前缀去扁平化（cds-xxx → cds > xxx），减少悬空
      return { built: buildDocGalaxy(entries, links, { rootName: storeNameRef.current }), partial: isPartial };
    };

    Promise.race([loadGalaxy(), timeout])
      .then((result) => {
        if (!cancelled) {
          setGalaxy(result.built);
          setPartial(result.partial);
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

  return (
    <div className="h-full w-full min-h-0 flex flex-col relative" style={{ background: '#02030a' }}>
      {/* 图例 + 统计：独立页里它是顶部唯一头部，正常 flex 排布（不再绝对定位叠头部）。
          点击 chip 切换该 type 显隐（与渲染内核 typeOn 同步） */}
      {galaxy && (
        <div
          className="shrink-0"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: 'rgba(18,18,26,0.78)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          {DOC_TYPES.map((t) => {
            const on = typeOn[t] !== false;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTypeOn((prev) => ({ ...prev, [t]: prev[t] === false }))}
                title={`点击切换显示「${t}」类文档`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 11,
                  color: on ? '#c8c8d2' : '#5a5a66',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  borderRadius: 6,
                  opacity: on ? 1 : 0.5,
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
                {t}
                <span style={{ color: '#6a6a78' }}>{galaxy.stats.typeCounts[t] ?? 0}</span>
              </button>
            );
          })}
          <div style={{ fontSize: 11, color: '#8a8a96', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: 8 }}>
            共 {galaxy.stats.totalDocs} 篇 · {galaxy.links.length} 引用
          </div>
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
        </div>
      )}

      {/* 画布层（flex-1 撑满图例下方的剩余高度，画布/状态相对它定位） */}
      <div className="flex-1 min-h-0 relative">
        {/* 操作提示 */}
        <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, fontSize: 11, color: '#5a5a66' }}>
          拖动旋转 · 滚轮缩放 · 悬停看标题 · 点击文档星阅读
        </div>

        {/* 3D 画布（vanilla three.js 渲染内核；内部 try/catch + fatal state 替代 ErrorBoundary） */}
        {galaxy && !loading && !error && galaxy.stats.totalDocs > 0 && (
          <GalaxyCanvas galaxy={galaxy} typeOn={typeOn} onOpen={setOpenEntryId} />
        )}

        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}>
            <MapSectionLoader text="正在构建文档星系..." />
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

      {openEntryId && <ReaderPanel entryId={openEntryId} onClose={() => setOpenEntryId(null)} />}
    </div>
  );
}

// 供 React.lazy 懒加载使用
export default function DocumentGalaxyViewLazy(props: DocumentGalaxyViewProps) {
  return (
    <Suspense fallback={<MapSectionLoader text="正在加载星系..." />}>
      <DocumentGalaxyView {...props} />
    </Suspense>
  );
}
