/**
 * 知识库 3D 文档星系视图（Galaxy）。
 *
 * 数据：listDocumentEntriesReal（条目）+ getStoreGraph（双链）。
 * 业务关系识别复用 buildDocGalaxy（SSOT，根→分类→appname→子模块→文档树 + 横向引用）。
 * 渲染：@react-three/fiber Canvas + drei OrbitControls，放射状 3D 布局；
 *       叶子按 docType 上色，点叶子复用系统 MarkdownViewer 阅读。
 *
 * 视觉精修（辉光 / EVE 风格）后续迭代，本版做到能用、能编译、能验收。
 */
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
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

// ── docType → 颜色注册表（不用 switch；7 种 type + 兜底） ──
const TYPE_COLOR: Record<string, string> = {
  spec: '#5b9eff',
  design: '#c47cff',
  plan: '#5bcc8a',
  rule: '#ff5b7a',
  guide: '#5bcfd8',
  report: '#ffd84d',
  debt: '#ff9c5b',
  unknown: '#9aa0b5',
};
function colorForDocType(docType?: string | null): string {
  if (!docType) return TYPE_COLOR.unknown;
  return TYPE_COLOR[docType] ?? TYPE_COLOR.unknown;
}

// ── 3D 渲染错误边界：R3F / WebGL 渲染抛错时 catch，显式报错而非白屏空转 ──
interface CanvasErrorBoundaryState {
  error: Error | null;
}

class CanvasErrorBoundary extends Component<{ children: ReactNode }, CanvasErrorBoundaryState> {
  state: CanvasErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): CanvasErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[galaxy] 3D 渲染失败', error, info);
  }

  render() {
    if (this.state.error) {
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
            3D 渲染失败：{this.state.error.message}。你的浏览器可能不支持 WebGL，或数据异常。
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── 放射状 3D 布局：根在原点，逐层沿球面向外铺开 ──
interface PlacedNode {
  node: GalaxyNode;
  pos: THREE.Vector3;
}

/**
 * 递归布局：父节点在 center，子节点按数量在以 center 为顶点、沿 dir 方向的圆锥面上分布。
 * 半径随深度线性增长；同层子节点用黄金角错开，避免堆叠。
 */
function layoutGalaxy(root: GalaxyNode): {
  placed: Map<string, PlacedNode>;
  edges: Array<[THREE.Vector3, THREE.Vector3]>;
} {
  const placed = new Map<string, PlacedNode>();
  const edges: Array<[THREE.Vector3, THREE.Vector3]> = [];
  const RING_GAP = 9; // 每深一层向外推进的半径

  const place = (
    node: GalaxyNode,
    center: THREE.Vector3,
    dir: THREE.Vector3,
    spread: number,
  ) => {
    placed.set(node.id, { node, pos: center.clone() });
    const kids = node.children;
    if (kids.length === 0) return;

    // 在以 dir 为轴的圆锥/球冠上均匀撒点
    const radius = RING_GAP;
    // 构造与 dir 垂直的两个基向量
    const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(dir, up).normalize();
    const w = new THREE.Vector3().crossVectors(dir, u).normalize();
    const golden = Math.PI * (3 - Math.sqrt(5)); // 黄金角

    kids.forEach((kid, i) => {
      const n = kids.length;
      // 子节点越多，圆锥张得越开（spread 控制半角，封顶约 70 度）
      const half = Math.min(spread, Math.PI / 2.6);
      // 沿圆锥面分布：极角 theta 随 i 在 [0, half] 间，方位角 phi 用黄金角
      const t = n === 1 ? 0 : i / (n - 1);
      const theta = half * Math.sqrt(t);
      const phi = i * golden;
      const sinT = Math.sin(theta);
      const offset = new THREE.Vector3()
        .addScaledVector(dir, Math.cos(theta))
        .addScaledVector(u, sinT * Math.cos(phi))
        .addScaledVector(w, sinT * Math.sin(phi))
        .normalize();
      const childCenter = center.clone().addScaledVector(offset, radius);
      edges.push([center.clone(), childCenter.clone()]);
      // 子树继续向同方向延展，半角随深度收窄
      place(kid, childCenter, offset, half * 0.7);
    });
  };

  // 根的若干顶级分类沿整个球面铺开（spread = PI 让第一层 360 度散开）
  place(root, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), Math.PI);
  return { placed, edges };
}

interface GalaxyLeafProps {
  pos: THREE.Vector3;
  node: GalaxyNode;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onOpen: (entryId: string) => void;
}

function LeafStar({ pos, node, hovered, onHover, onOpen }: GalaxyLeafProps) {
  const color = colorForDocType(node.docType);
  return (
    <group position={pos}>
      <mesh
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(node.id);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          onHover(null);
          document.body.style.cursor = 'auto';
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (node.entryId) onOpen(node.entryId);
        }}
        scale={hovered ? 1.7 : 1}
      >
        <sphereGeometry args={[0.55, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={hovered ? 0.9 : 0.35} />
      </mesh>
      {hovered && (
        <Html distanceFactor={26} style={{ pointerEvents: 'none' }}>
          <div
            style={{
              transform: 'translate(12px, -50%)',
              whiteSpace: 'nowrap',
              background: 'rgba(20,20,28,0.92)',
              border: '1px solid rgba(255,255,255,0.16)',
              borderRadius: 6,
              padding: '4px 8px',
              color: '#f0f0f5',
              fontSize: 13,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            }}
          >
            {node.name}
          </div>
        </Html>
      )}
    </group>
  );
}

function GroupStar({ pos, node }: { pos: THREE.Vector3; node: GalaxyNode }) {
  const isRoot = node.kind === 'root';
  const r = isRoot ? 1.5 : Math.min(1.2, 0.6 + Math.sqrt(node.docCount) * 0.12);
  const color = isRoot ? '#ffe7a0' : '#dfe4f5';
  return (
    <group position={pos}>
      <mesh>
        <sphereGeometry args={[r, 20, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={isRoot ? 0.7 : 0.4} />
      </mesh>
    </group>
  );
}

interface SceneProps {
  galaxy: DocGalaxy;
  onOpen: (entryId: string) => void;
}

function GalaxyScene({ galaxy, onOpen }: SceneProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const { placed, edges, mentionEdges } = useMemo(() => {
    const { placed, edges } = layoutGalaxy(galaxy.root);
    // 横向引用连线：两端都已布局才画
    const mentionEdges: Array<[THREE.Vector3, THREE.Vector3]> = [];
    for (const link of galaxy.links) {
      const a = placed.get(link.source);
      const b = placed.get(link.target);
      if (a && b) mentionEdges.push([a.pos, b.pos]);
    }
    return { placed, edges, mentionEdges };
  }, [galaxy]);

  // 父子连线几何（细灰）
  const hierarchyGeom = useMemo(() => {
    const positions: number[] = [];
    for (const [a, b] of edges) {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return g;
  }, [edges]);

  // 横向引用连线几何（淡蓝）
  const mentionGeom = useMemo(() => {
    const positions: number[] = [];
    for (const [a, b] of mentionEdges) {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return g;
  }, [mentionEdges]);

  const placedList = useMemo(() => Array.from(placed.values()), [placed]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <pointLight position={[0, 0, 0]} intensity={1.2} distance={120} />
      <pointLight position={[40, 40, 40]} intensity={0.5} />

      {/* 父子连线 */}
      <lineSegments geometry={hierarchyGeom}>
        <lineBasicMaterial color="#5a5f72" transparent opacity={0.35} />
      </lineSegments>

      {/* 横向引用连线 */}
      {mentionEdges.length > 0 && (
        <lineSegments geometry={mentionGeom}>
          <lineBasicMaterial color="#6fa8ff" transparent opacity={0.4} />
        </lineSegments>
      )}

      {placedList.map(({ node, pos }) =>
        node.kind === 'leaf' ? (
          <LeafStar
            key={node.id}
            pos={pos}
            node={node}
            hovered={hoverId === node.id}
            onHover={setHoverId}
            onOpen={onOpen}
          />
        ) : (
          <GroupStar key={node.id} pos={pos} node={node} />
        ),
      )}

      <OrbitControls enableDamping dampingFactor={0.08} rotateSpeed={0.6} zoomSpeed={0.8} minDistance={6} maxDistance={160} />
    </>
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
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const storeNameRef = useRef(storeName);
  storeNameRef.current = storeName;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGalaxy(null);
    setOpenEntryId(null);

    // 超时护栏：25s 内拿不到数据就显式报错，绝不静默空转
    const TIMEOUT_MS = 25_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('__galaxy_timeout__')), TIMEOUT_MS),
    );

    // 先并行拉第一页 entries + 双链；entries 可能多页（doc/ 库 330+），下面再翻页补齐
    Promise.race([
      Promise.all([listDocumentEntriesReal(storeId, 1, 200), getStoreGraph(storeId)]),
      timeout,
    ])
      .then(async ([firstRes, graphRes]) => {
        if (cancelled) return;
        if (!firstRes.success) {
          console.error('[galaxy] 加载文档条目失败', firstRes.error);
          setError(firstRes.error?.message || '加载文档条目失败');
          return;
        }
        const PAGE_SIZE = 200;
        const MAX_PAGES = 50; // 上限 10000 条，防御异常分页
        const allItems = [...firstRes.data.items];
        const total = firstRes.data.total ?? allItems.length;
        // 还有剩余页就继续翻：用 total 推断总页数，items.length < pageSize 作兜底终止
        let page = 1;
        while (
          allItems.length < total &&
          firstRes.data.items.length >= PAGE_SIZE &&
          page < MAX_PAGES
        ) {
          page += 1;
          const res = await listDocumentEntriesReal(storeId, page, PAGE_SIZE);
          if (cancelled) return;
          if (!res.success) {
            console.error('[galaxy] 翻页加载条目失败（用已拉取页继续成图）', page, res.error);
            break;
          }
          allItems.push(...res.data.items);
          if (res.data.items.length < PAGE_SIZE) break;
        }

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
        const built = buildDocGalaxy(entries, links, {
          rootName: storeNameRef.current,
        });
        setGalaxy(built);
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
    <div className="h-full w-full min-h-0 flex flex-col relative" style={{ background: '#0c0c12' }}>
      {/* 图例 + 统计：独立页里它是顶部唯一头部，正常 flex 排布（不再绝对定位叠头部） */}
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
          {DOC_TYPES.map((t) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#c8c8d2' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: TYPE_COLOR[t], display: 'inline-block' }} />
              {t}
              <span style={{ color: '#6a6a78' }}>{galaxy.stats.typeCounts[t] ?? 0}</span>
            </div>
          ))}
          <div style={{ fontSize: 11, color: '#8a8a96', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: 8 }}>
            共 {galaxy.stats.totalDocs} 篇 · {galaxy.links.length} 引用
          </div>
        </div>
      )}

      {/* 画布层（flex-1 撑满图例下方的剩余高度，画布/状态相对它定位） */}
      <div className="flex-1 min-h-0 relative">
        {/* 操作提示 */}
        <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, fontSize: 11, color: '#5a5a66' }}>
          拖动旋转 · 滚轮缩放 · 悬停看标题 · 点击文档星阅读
        </div>

        {/* 3D 画布（外套 ErrorBoundary：WebGL/R3F 抛错时显式报错，不白屏空转） */}
        {galaxy && !loading && !error && galaxy.stats.totalDocs > 0 && (
          <CanvasErrorBoundary>
            <Canvas camera={{ position: [0, 18, 42], fov: 55 }} style={{ position: 'absolute', inset: 0 }}>
              <color attach="background" args={['#0c0c12']} />
              <GalaxyScene galaxy={galaxy} onOpen={setOpenEntryId} />
            </Canvas>
          </CanvasErrorBoundary>
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
