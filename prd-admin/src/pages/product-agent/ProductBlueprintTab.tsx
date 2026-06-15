/**
 * 产品管理 — 单产品「产品蓝图」Tab。
 *
 * 产品级「定义层」，子 tab：
 *   产品结构：功能模块/能力骨架树（逐层展开，增删改）
 *   功能清单：已有功能挂到结构节点上的结构化全局总览（复用 Feature，不另存）
 *   （产品规则 / 产品字典 在下一波加入）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Plus, Pencil, Trash2, X, Save, Puzzle, FolderTree } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  listProductStructure, upsertProductStructureNode, deleteProductStructureNode,
  listFeatures, setFeatureStructureNode,
} from '@/services/real/productAgent';
import type { ProductStructureNode, Feature } from './types';

type BlueprintSub = 'structure' | 'features';

export function ProductBlueprintTab({ productId, isAdmin }: { productId: string; isAdmin: boolean }) {
  const [sub, setSub] = useState<BlueprintSub>('structure');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/10 px-6 py-3">
        <h2 className="text-base font-semibold text-white">产品蓝图</h2>
        <p className="mt-0.5 text-xs text-white/40">产品级定义层：先定义产品骨架与功能全景，再推进需求/功能/缺陷。</p>
        <div className="mt-3 flex items-center gap-2">
          <SubTab on={sub === 'structure'} onClick={() => setSub('structure')} icon={FolderTree}>产品结构</SubTab>
          <SubTab on={sub === 'features'} onClick={() => setSub('features')} icon={Puzzle}>功能清单</SubTab>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6" style={{ overscrollBehavior: 'contain' }}>
        {sub === 'structure' ? <StructureTab productId={productId} isAdmin={isAdmin} /> : <FeatureInventoryTab productId={productId} isAdmin={isAdmin} />}
      </div>
    </div>
  );
}

function SubTab({ on, onClick, icon: Icon, children }: { on: boolean; onClick: () => void; icon: typeof Puzzle; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${on ? 'border-cyan-500/45 bg-cyan-500/15 text-cyan-200' : 'border-white/10 text-white/55 hover:bg-white/5'}`}>
      <Icon size={14} /> {children}
    </button>
  );
}

// ── 树工具 ──
function buildChildrenMap(nodes: ProductStructureNode[]) {
  const m = new Map<string, ProductStructureNode[]>();
  for (const n of nodes) {
    const pid = n.parentId || '';
    if (!m.has(pid)) m.set(pid, []);
    m.get(pid)!.push(n);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return m;
}
/** DFS 扁平化（带深度），用于「归类到」下拉。 */
function flattenForSelect(nodes: ProductStructureNode[]): { node: ProductStructureNode; depth: number }[] {
  const cm = buildChildrenMap(nodes);
  const out: { node: ProductStructureNode; depth: number }[] = [];
  const walk = (pid: string, depth: number) => {
    for (const n of cm.get(pid) ?? []) { out.push({ node: n, depth }); walk(n.id, depth + 1); }
  };
  walk('', 0);
  return out;
}

// ════════════════════════ 产品结构（树） ════════════════════════

function StructureTab({ productId, isAdmin }: { productId: string; isAdmin: boolean }) {
  const [nodes, setNodes] = useState<ProductStructureNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ node: ProductStructureNode | null; parentId: string | null } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listProductStructure(productId);
    if (res.success) setNodes(res.data.items);
    setLoading(false);
  }, [productId]);
  useEffect(() => { void reload(); }, [reload]);

  const childrenMap = useMemo(() => buildChildrenMap(nodes), [nodes]);
  const roots = childrenMap.get('') ?? [];

  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const remove = async (node: ProductStructureNode) => {
    const ok = await systemDialog.confirm({ title: '删除结构节点', message: `删除「${node.name}」及其全部子节点？挂在这些节点上的功能将变为「未归类」（功能本身不受影响）。`, tone: 'danger', confirmText: '删除', cancelText: '取消' });
    if (!ok) return;
    const res = await deleteProductStructureNode(node.id);
    if (res.success) { toast.success('已删除'); void reload(); }
    else toast.error('删除失败', res.error?.message);
  };

  const renderNode = (node: ProductStructureNode, depth: number): React.ReactNode => {
    const kids = childrenMap.get(node.id) ?? [];
    const isCollapsed = collapsed.has(node.id);
    return (
      <div key={node.id}>
        <div className="group flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]" style={{ paddingLeft: depth * 18 + 8 }}>
          {kids.length > 0 ? (
            <button onClick={() => toggle(node.id)} className="text-white/40 hover:text-white">{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button>
          ) : <span className="inline-block w-[14px]" />}
          <span className="text-sm text-white/90">{node.name}</span>
          {node.nodeType && <span className="rounded border border-white/10 px-1.5 py-px text-[10px] text-white/45">{node.nodeType}</span>}
          {node.description && <span className="truncate text-xs text-white/35">— {node.description}</span>}
          {isAdmin && (
            <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
              <button onClick={() => setEditing({ node: null, parentId: node.id })} title="添加子节点" className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-cyan-300"><Plus size={13} /></button>
              <button onClick={() => setEditing({ node, parentId: node.parentId ?? null })} title="编辑" className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"><Pencil size={13} /></button>
              <button onClick={() => remove(node)} title="删除" className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-red-300"><Trash2 size={13} /></button>
            </div>
          )}
        </div>
        {!isCollapsed && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  if (loading) return <MapSectionLoader text="正在加载产品结构…" />;

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/45">定义产品的功能模块 / 能力骨架，逐层展开。功能清单里可把功能挂到这些节点上。</p>
        {isAdmin && (
          <button onClick={() => setEditing({ node: null, parentId: null })} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-500/30">
            <Plus size={14} /> 根节点
          </button>
        )}
      </div>
      {roots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 py-12 text-center text-sm text-white/40">
          还没有结构节点。{isAdmin ? '点「根节点」添加第一个模块（如「用户中心」「交易」「数据看板」）。' : '请联系产品管理员搭建产品结构。'}
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2">
          {roots.map((n) => renderNode(n, 0))}
        </div>
      )}
      {editing && (
        <StructureNodeModal
          productId={productId}
          node={editing.node}
          parentId={editing.parentId}
          siblingCount={(editing.node ? (childrenMap.get(editing.node.parentId || '') ?? []) : (childrenMap.get(editing.parentId || '') ?? [])).length}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      )}
    </div>
  );
}

function StructureNodeModal({ productId, node, parentId, siblingCount, onClose, onSaved }: {
  productId: string; node: ProductStructureNode | null; parentId: string | null; siblingCount: number;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(node?.name ?? '');
  const [nodeType, setNodeType] = useState(node?.nodeType ?? '');
  const [description, setDescription] = useState(node?.description ?? '');
  const [saving, setSaving] = useState(false);
  const isNew = !node;
  const inputCls = 'rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25';

  const save = async () => {
    if (!name.trim()) { toast.error('请填写名称'); return; }
    setSaving(true);
    const res = await upsertProductStructureNode(productId, {
      id: node?.id,
      parentId: node ? (node.parentId ?? null) : parentId,
      name: name.trim(),
      nodeType: nodeType.trim() || null,
      description: description.trim() || null,
      sortOrder: node?.sortOrder ?? siblingCount,
    });
    setSaving(false);
    if (res.success) { toast.success(isNew ? '已添加' : '已保存'); onSaved(); }
    else toast.error('保存失败', res.error?.message);
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-4" onClick={onClose}>
      <div className="flex w-full max-w-md flex-col rounded-xl border border-white/10 bg-[#16181d]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">{isNew ? (parentId ? '添加子节点' : '添加根节点') : '编辑节点'}</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={18} /></button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1.5"><label className="text-xs text-white/55">名称 *</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：用户中心 / 交易 / 数据看板" className={inputCls} autoFocus /></div>
          <div className="flex flex-col gap-1.5"><label className="text-xs text-white/55">类型（可选）</label><input value={nodeType} onChange={(e) => setNodeType(e.target.value)} placeholder="如：模块 / 能力 / 子系统" className={inputCls} /></div>
          <div className="flex flex-col gap-1.5"><label className="text-xs text-white/55">说明（可选）</label><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="该节点的职责 / 边界说明" className={`${inputCls} resize-none`} /></div>
        </div>
        <div className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-white/60 hover:bg-white/5">取消</button>
          <button onClick={save} disabled={saving || !name.trim()} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3.5 py-1.5 text-sm text-cyan-200 disabled:opacity-40">
            {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ════════════════════════ 功能清单（功能挂结构节点） ════════════════════════

function FeatureInventoryTab({ productId, isAdmin }: { productId: string; isAdmin: boolean }) {
  const [nodes, setNodes] = useState<ProductStructureNode[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [ns, fs] = await Promise.all([listProductStructure(productId), listFeatures(productId)]);
    if (ns.success) setNodes(ns.data.items);
    if (fs.success) setFeatures(fs.data.items);
    setLoading(false);
  }, [productId]);
  useEffect(() => { void reload(); }, [reload]);

  const flat = useMemo(() => flattenForSelect(nodes), [nodes]);
  const nodeName = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);
  const byNode = useMemo(() => {
    const m = new Map<string, Feature[]>();
    for (const f of features) { const k = f.structureNodeId || ''; if (!m.has(k)) m.set(k, []); m.get(k)!.push(f); }
    return m;
  }, [features]);
  const unassigned = byNode.get('') ?? [];

  const assign = async (feature: Feature, nodeId: string) => {
    setSavingId(feature.id);
    const res = await setFeatureStructureNode(feature.id, nodeId || null);
    setSavingId(null);
    if (res.success) {
      setFeatures((prev) => prev.map((x) => (x.id === feature.id ? { ...x, structureNodeId: nodeId || null } : x)));
    } else toast.error('归类失败', res.error?.message);
  };

  if (loading) return <MapSectionLoader text="正在加载功能清单…" />;

  const FeatureRow = ({ f }: { f: Feature }) => (
    <div className="flex items-center gap-3 px-3 py-2">
      <Puzzle size={13} className="shrink-0 text-violet-300/70" />
      <span className="font-mono text-[11px] text-white/35">{f.featureNo}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-white/85">{f.title}</span>
      {isAdmin ? (
        <span className="flex items-center gap-1.5">
          {savingId === f.id && <MapSpinner size={12} />}
          <select
            value={f.structureNodeId || ''}
            onChange={(e) => assign(f, e.target.value)}
            className="max-w-[180px] rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/70 outline-none focus:border-cyan-500/40"
            title="归类到结构节点"
          >
            <option value="">未归类</option>
            {flat.map(({ node, depth }) => <option key={node.id} value={node.id}>{'　'.repeat(depth) + node.name}</option>)}
          </select>
        </span>
      ) : (
        <span className="text-[11px] text-white/35">{f.structureNodeId ? nodeName.get(f.structureNodeId) ?? '—' : '未归类'}</span>
      )}
    </div>
  );

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="text-xs text-white/45">把已有功能挂到产品结构节点上，形成结构化的全局功能总览。功能本身仍在「功能」页维护（此处只调整归属）。</p>

      {nodes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 py-10 text-center text-sm text-white/40">
          还没有产品结构。请先到「产品结构」搭建模块树，再来归类功能。
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {flat.map(({ node, depth }) => {
            const fs = byNode.get(node.id) ?? [];
            return (
              <div key={node.id} className="rounded-xl border border-white/10 bg-white/[0.02]" style={{ marginLeft: depth * 14 }}>
                <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
                  <FolderTree size={13} className="text-cyan-300/70" />
                  <span className="text-sm font-medium text-white/80">{node.name}</span>
                  <span className="text-[11px] text-white/35">{fs.length} 个功能</span>
                </div>
                {fs.length === 0 ? <div className="px-3 py-2 text-xs text-white/30">暂无功能</div> : <div className="divide-y divide-white/5">{fs.map((f) => <FeatureRow key={f.id} f={f} />)}</div>}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
          <span className="text-sm font-medium text-white/70">未归类功能</span>
          <span className="text-[11px] text-white/35">{unassigned.length} 个</span>
        </div>
        {unassigned.length === 0 ? (
          <div className="px-3 py-3 text-center text-xs text-white/30">所有功能都已归类。</div>
        ) : (
          <div className="divide-y divide-white/5">{unassigned.map((f) => <FeatureRow key={f.id} f={f} />)}</div>
        )}
      </div>
    </div>
  );
}
