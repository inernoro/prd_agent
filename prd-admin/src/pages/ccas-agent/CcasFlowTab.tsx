import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Sparkles,
  Loader2,
  AlertCircle,
  StopCircle,
  Save,
  RefreshCw,
  Image as ImageIcon,
  Layers,
  ListTree,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { connectSse } from '@/lib/useSseStream';
import {
  CCAS_FLOW_PARSE_STREAM_URL,
  listCcasEquipment,
  saveCcasFlowDiagram,
  listCcasFlowDiagrams,
  getCcasFlowDiagram,
} from '@/services';
import type { CcasEquipmentAsset, CcasFlowDiagramSummary, CcasMeta } from '@/services';
import { toast } from '@/lib/toast';

interface Props {
  meta: CcasMeta;
}

interface ParsedNode {
  id: string;
  label: string;
  equipmentType?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  note?: string;
}
interface ParsedEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}
interface ParsedGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

// ──────────────────────────────────────────────
// 自定义节点：带配图的设备节点
// ──────────────────────────────────────────────

interface CcasNodeData extends Record<string, unknown> {
  label: string;
  equipmentType?: string;
  assetUrl?: string;
  note?: string;
}

function CcasNodeView({ data }: NodeProps<Node<CcasNodeData>>) {
  return (
    <div className="rounded-lg border border-white/15 bg-[#1a1c22] shadow-md min-w-[140px] max-w-[260px]">
      <Handle type="target" position={Position.Left} className="!bg-amber-400/70" />
      <Handle type="source" position={Position.Right} className="!bg-amber-400/70" />
      <Handle type="target" position={Position.Top} id="top" className="!bg-amber-400/70" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-amber-400/70" />
      <div className="px-2 py-1 text-[11px] text-amber-200/90 border-b border-white/10 truncate">{data.label}</div>
      <div className="aspect-[4/3] bg-black/40 flex items-center justify-center text-white/30">
        {data.assetUrl ? (
          <img src={data.assetUrl} alt={data.label} className="w-full h-full object-contain" />
        ) : (
          <ImageIcon className="w-6 h-6" />
        )}
      </div>
      {data.note && <div className="px-2 py-1 text-[10px] text-white/50 truncate" title={data.note}>{data.note}</div>}
    </div>
  );
}

const NODE_TYPES = { ccas: CcasNodeView };

// ──────────────────────────────────────────────
// 主组件
// ──────────────────────────────────────────────

export function CcasFlowTab({ meta }: Props) {
  return (
    <ReactFlowProvider>
      <FlowInner meta={meta} />
    </ReactFlowProvider>
  );
}

function FlowInner({ meta }: Props) {
  const [title, setTitle] = useState('');
  const [associationMode, setAssociationMode] = useState(meta.associationModes[0]?.label ?? '瓶箱垛');
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const [phaseMsg, setPhaseMsg] = useState('');
  const [model, setModel] = useState<{ name?: string; platform?: string }>({});
  const [thinkText, setThinkText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [groups, setGroups] = useState<ParsedGroup[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [diagrams, setDiagrams] = useState<CcasFlowDiagramSummary[]>([]);

  const [equipment, setEquipment] = useState<CcasEquipmentAsset[]>([]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CcasNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const abortRef = useRef<AbortController | null>(null);

  // 加载素材库（按 equipmentType 匹配节点）
  useEffect(() => {
    listCcasEquipment({ pageSize: 200 }).then((res) => {
      if (res.success && res.data) setEquipment(res.data.items);
    });
  }, []);
  // 加载已保存的流程图列表
  const reloadDiagrams = useCallback(() => {
    listCcasFlowDiagrams(1, 30).then((res) => {
      if (res.success && res.data) setDiagrams(res.data.items);
    });
  }, []);
  useEffect(() => { reloadDiagrams(); }, [reloadDiagrams]);

  /** 按 equipmentType 在素材库里挑一张图（优先收藏） */
  const findAssetUrl = useCallback(
    (equipType?: string): string | undefined => {
      if (!equipType) return undefined;
      const matches = equipment.filter((e) => e.equipmentType === equipType);
      if (matches.length === 0) return undefined;
      const fav = matches.find((m) => m.isFavorite);
      return (fav ?? matches[0]).originalUrl ?? matches[0].url;
    },
    [equipment]
  );

  const applyParsed = useCallback(
    (parsedNodes: ParsedNode[], parsedEdges: ParsedEdge[], parsedGroups: ParsedGroup[]) => {
      const rfNodes: Node<CcasNodeData>[] = parsedNodes.map((n, i) => ({
        id: n.id,
        type: 'ccas',
        position: { x: n.x ?? 80 + (i % 5) * 220, y: n.y ?? 100 + Math.floor(i / 5) * 220 },
        data: {
          label: n.label,
          equipmentType: n.equipmentType,
          assetUrl: findAssetUrl(n.equipmentType ?? n.label),
          note: n.note,
        },
        width: n.width ?? 180,
        height: n.height ?? 160,
      }));
      const rfEdges: Edge[] = parsedEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: true,
        style: { stroke: 'rgba(252,211,77,0.55)' },
        labelStyle: { fill: 'rgba(252,211,77,0.85)', fontSize: 11 },
      }));
      setNodes(rfNodes);
      setEdges(rfEdges);
      setGroups(parsedGroups);
    },
    [findAssetUrl, setNodes, setEdges]
  );

  const onParse = useCallback(async () => {
    if (!description.trim()) {
      toast.error('请填写流程描述');
      return;
    }
    setErrorMsg(null);
    setThinkText('');
    setPhase('streaming');
    setPhaseMsg('连接中…');
    setModel({});
    setSavedId(null);

    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;

    const { success, errorMessage } = await connectSse({
      url: CCAS_FLOW_PARSE_STREAM_URL,
      method: 'POST',
      body: { title: title || '未命名流程', associationMode, description },
      signal: ac.signal,
      onEvent: (evt) => {
        const data = evt.data ? safeJson(evt.data) : null;
        if (!data) return;
        switch (evt.event) {
          case 'phase':
            setPhaseMsg(typeof data.message === 'string' ? data.message : '');
            break;
          case 'model':
            setModel({
              name: typeof data.model === 'string' ? data.model : undefined,
              platform: typeof data.platform === 'string' ? data.platform : undefined,
            });
            break;
          case 'typing':
            if (typeof data.text === 'string') setThinkText((prev) => prev + data.text);
            break;
          case 'parsed': {
            const nodesArr = parseJsonArray<ParsedNode>(data.nodesJson);
            const edgesArr = parseJsonArray<ParsedEdge>(data.edgesJson);
            const groupsArr = parseJsonArray<ParsedGroup>(data.groupsJson);
            applyParsed(nodesArr, edgesArr, groupsArr);
            setPhaseMsg(`已解析 ${nodesArr.length} 个节点 + ${edgesArr.length} 条流向 + ${groupsArr.length} 个区段`);
            break;
          }
          case 'done':
            setPhase('done');
            break;
          case 'error':
            setPhase('error');
            setErrorMsg(typeof data.message === 'string' ? data.message : '解析失败');
            break;
        }
      },
    });
    if (!success && phase !== 'error') {
      setPhase('error');
      setErrorMsg(errorMessage || '连接失败');
    }
  }, [title, associationMode, description, applyParsed, phase]);

  const onAbort = useCallback(() => {
    abortRef.current?.abort();
    setPhase('idle');
    setPhaseMsg('已中止');
  }, []);

  const onSave = useCallback(async () => {
    if (nodes.length === 0) {
      toast.error('画布为空，先生成或加载流程图');
      return;
    }
    const nodesJson = JSON.stringify(
      nodes.map((n) => ({
        id: n.id,
        label: n.data.label,
        equipmentType: n.data.equipmentType,
        x: n.position.x,
        y: n.position.y,
        width: n.width,
        height: n.height,
        note: n.data.note,
      }))
    );
    const edgesJson = JSON.stringify(edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label })));
    const groupsJson = JSON.stringify(groups);

    const res = await saveCcasFlowDiagram({
      id: savedId ?? undefined,
      title: title || '未命名流程',
      originalInput: description,
      associationMode,
      nodesJson,
      edgesJson,
      groupsJson,
      model: model.name,
      platformName: model.platform,
    });
    if (res.success && res.data) {
      setSavedId(res.data.diagram.id);
      toast.success('已保存');
      reloadDiagrams();
    } else {
      toast.error(res.error?.message || '保存失败');
    }
  }, [nodes, edges, groups, savedId, title, description, associationMode, model, reloadDiagrams]);

  const loadDiagram = useCallback(async (id: string) => {
    const res = await getCcasFlowDiagram(id);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '加载失败');
      return;
    }
    const d = res.data.diagram;
    setSavedId(d.id);
    setTitle(d.title);
    setAssociationMode(d.associationMode ?? meta.associationModes[0]?.label ?? '');
    setDescription(d.originalInput ?? '');
    const nodesArr = parseJsonArray<ParsedNode>(d.nodesJson);
    const edgesArr = parseJsonArray<ParsedEdge>(d.edgesJson);
    const groupsArr = parseJsonArray<ParsedGroup>(d.groupsJson);
    applyParsed(nodesArr, edgesArr, groupsArr);
    setPhase('done');
    setPhaseMsg('已加载');
  }, [applyParsed, meta]);

  const isStreaming = phase === 'streaming';

  // 区段（车间分区）作为 Background 后面的色块
  const groupBlocks = useMemo(
    () =>
      groups.map((g) => (
        <div
          key={g.id}
          className="absolute pointer-events-none border-2 border-dashed rounded-lg flex items-end justify-start"
          style={{
            left: g.x,
            top: g.y,
            width: g.width,
            height: g.height,
            borderColor: g.color || 'rgba(156,163,175,0.4)',
            background: hexToRgba(g.color || '#9CA3AF', 0.06),
          }}
        >
          <div className="text-[10px] text-white/45 px-1.5 py-0.5 bg-black/40 rounded m-1">{g.label}</div>
        </div>
      )),
    [groups]
  );

  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4 overflow-hidden">
      {/* 左：表单 + 控制 + 历史 */}
      <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-3">流程描述</h2>
          <label className="block text-xs text-white/65 mb-1">流程标题</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：瓶箱垛采集关联整体流程"
            className="w-full mb-2 rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60"
          />

          <label className="block text-xs text-white/65 mb-1">关联模式</label>
          <select
            value={associationMode}
            onChange={(e) => setAssociationMode(e.target.value)}
            className="w-full mb-2 rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm text-white focus:outline-none focus:border-amber-400/60"
          >
            {meta.associationModes.map((m) => (
              <option key={m.key} value={m.label}>{m.label}（{m.description}）</option>
            ))}
          </select>

          <label className="block text-xs text-white/65 mb-1">流程描述（设备 + 位置 + 流向）</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={10}
            placeholder={`从灌装车间出来的瓶子，进入裹包机；
裹包机上部装有 4 个工业相机做瓶码采集；
裹包机后接龙门架（带 1 个工业相机做剔除校验），NC 不通过则剔除；
继续走 80 米传送带，途经墙体上的工控机展示画面；
最终到达箱码垛工位，由工业相机做尾箱计数。`}
            className="w-full mb-1 rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60"
          />
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button onClick={onParse} disabled={isStreaming || !description.trim()} className="!h-9 !px-3 !text-xs">
              {isStreaming ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> 解析中…</>
              ) : (
                <><Sparkles className="w-3.5 h-3.5 mr-1" /> AI 解析为流程图</>
              )}
            </Button>
            {isStreaming && (
              <Button variant="ghost" onClick={onAbort} className="!h-9 !px-3 !text-xs">
                <StopCircle className="w-3.5 h-3.5 mr-1" /> 中止
              </Button>
            )}
            <Button variant="primary" onClick={onSave} disabled={nodes.length === 0} className="!h-9 !px-3 !text-xs">
              <Save className="w-3.5 h-3.5 mr-1" /> {savedId ? '更新' : '保存'}
            </Button>
          </div>

          {(phaseMsg || model.name) && (
            <div className="text-[11px] text-white/45 flex items-center gap-2 flex-wrap">
              {phaseMsg && <span>{phaseMsg}</span>}
              {model.name && (
                <span className="font-mono opacity-70">
                  ● {model.name}{model.platform ? ` · ${model.platform}` : ''}
                </span>
              )}
            </div>
          )}
          {errorMsg && (
            <div className="text-xs text-red-300/90 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {errorMsg}
            </div>
          )}
          <div className="text-[11px] text-white/40 leading-relaxed">
            提示：节点的设备图来自「设备素材库」（按设备名匹配）。先在素材库 Tab 生成或上传对应设备图，再回来生成流程图，节点会自动套图。
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-2 flex items-center gap-1.5">
            <ListTree className="w-4 h-4" /> 我的流程图（{diagrams.length}）
            <Button variant="ghost" onClick={reloadDiagrams} className="!h-6 !px-1.5 !text-[10px] ml-auto">
              <RefreshCw className="w-3 h-3" />
            </Button>
          </h2>
          <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
            {diagrams.length === 0 ? (
              <div className="text-[11px] text-white/35 py-2">暂无保存记录</div>
            ) : (
              diagrams.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => loadDiagram(d.id)}
                  className={`text-left rounded-md border px-2 py-1.5 transition ${
                    savedId === d.id
                      ? 'border-amber-400/60 bg-amber-500/10'
                      : 'border-white/10 bg-white/5 hover:bg-white/10'
                  }`}
                >
                  <div className="text-xs text-white truncate">{d.title}</div>
                  <div className="text-[10px] text-white/35">
                    {d.associationMode ?? '自定义'} · {new Date(d.updatedAt).toLocaleString()}
                  </div>
                </button>
              ))
            )}
          </div>
        </section>
      </div>

      {/* 右：画布 */}
      <div className="relative flex flex-col min-h-0 rounded-lg border border-white/10 bg-[#0c0d11] overflow-hidden">
        <div className="absolute inset-0">
          {/* group 色块铺底 */}
          <div className="absolute inset-0">{groupBlocks}</div>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={NODE_TYPES}
            fitView
            attributionPosition="bottom-right"
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgba(255,255,255,0.06)" />
            <Controls position="bottom-left" />
            <MiniMap pannable zoomable nodeColor={() => 'rgba(252,211,77,0.6)'} maskColor="rgba(0,0,0,0.6)" />
          </ReactFlow>
        </div>
        {nodes.length === 0 && phase === 'idle' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/35 pointer-events-none">
            <div className="text-center">
              <Layers className="w-8 h-8 mx-auto mb-2 opacity-50" />
              填好描述 → 点「AI 解析」即可看到流程图
            </div>
          </div>
        )}
        {thinkText && phase === 'streaming' && (
          <div
            className="absolute bottom-2 right-2 max-w-[340px] max-h-[180px] overflow-y-auto rounded bg-black/70 backdrop-blur px-2 py-1.5 text-[10px] text-white/55 font-mono whitespace-pre-wrap"
            style={{ overscrollBehavior: 'contain' }}
          >
            {thinkText.length > 1200 ? thinkText.slice(-1200) : thinkText}
          </div>
        )}
      </div>
    </div>
  );
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function hexToRgba(hex: string, alpha: number) {
  if (hex.startsWith('rgba(') || hex.startsWith('rgb(')) return hex;
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
