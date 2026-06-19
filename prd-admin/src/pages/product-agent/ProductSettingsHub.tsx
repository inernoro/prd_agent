/**
 * 产品管理 — 统一「设置」中心。
 *
 * 把原先分散在「应用」(WorkflowTemplateSection) 与「设置」(SettingsSection) 的配置
 * 合并为单一设置模块，按七分类组织：权限 / 产品 / 需求 / 功能 / 缺陷 / 客户 / 问策知识库。
 * 复用各底层编辑器（FormTemplateEditor / WorkflowEditor / 类型 / 描述模板 / 管理员），
 * 优先级与严重程度走通用等级目录 GradeCatalogManager。
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ShieldCheck,
  Boxes,
  ListChecks,
  Puzzle,
  Bug,
  Users,
  BookOpen,
  Plus,
  Save,
  Trash2,
  FileText,
  X,
} from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { toast } from '@/lib/toast';
import {
  listProducts, upsertGradeOption, deleteGradeOption,
  getConsultKnowledge, getConsultKnowledgeEntry, addConsultKnowledge,
  type ConsultKbEntry,
} from '@/services/real/productAgent';
import type { Product, ProductEntityType, ProductGradeOption, GradeDimension, GradeEntityType } from './types';
import {
  FormTemplateEditor,
  DescTemplateManager,
  CategoryManager,
  RequirementTypeManager,
  ApplicationAdminManager,
} from './SettingsSection';
import { WorkflowEditor } from './WorkflowTemplateSection';
import { ProductAdminOverviewPanel } from './ProductAdminOverviewPanel';
import { useGradeOptions } from './gradeOptions';

type SettingsCat = 'perm' | 'product' | 'requirement' | 'feature' | 'defect' | 'customer' | 'consult-kb';

const CATS: { key: SettingsCat; label: string; icon: typeof ShieldCheck; desc: string }[] = [
  { key: 'perm', label: '权限', icon: ShieldCheck, desc: '按角色分配产品管理内部各页面的访问权限' },
  { key: 'product', label: '产品', icon: Boxes, desc: '产品类型与产品管理员指派' },
  { key: 'requirement', label: '需求', icon: ListChecks, desc: '需求的表单、流程、类型、优先级与严重程度' },
  { key: 'feature', label: '功能', icon: Puzzle, desc: '功能的表单、流程、优先级与严重程度' },
  { key: 'defect', label: '缺陷', icon: Bug, desc: '缺陷的表单、流程、优先级与严重程度' },
  { key: 'customer', label: '客户', icon: Users, desc: '客户表单字段定义' },
  { key: 'consult-kb', label: '问策知识库', icon: BookOpen, desc: '营销问策智能体的专属知识库' },
];

export function ProductSettingsHub() {
  const [cat, setCat] = useState<SettingsCat>('perm');
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    void listProducts({ pageSize: 200 }).then((res) => {
      if (res.success) setProducts(res.data.items);
    });
  }, []);

  const activeCat = CATS.find((c) => c.key === cat)!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/10 px-6 py-4">
        <h2 className="text-base font-semibold text-white">设置</h2>
        <p className="mt-0.5 text-xs text-white/40">{activeCat.desc}</p>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 左侧分类导航 */}
        <nav className="w-44 shrink-0 overflow-y-auto border-r border-white/10 px-2 py-3" style={{ overscrollBehavior: 'contain' }}>
          {CATS.map((c) => {
            const Icon = c.icon;
            const on = c.key === cat;
            return (
              <button
                key={c.key}
                onClick={() => setCat(c.key)}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ${on ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/55 hover:bg-white/5 hover:text-white'}`}
              >
                <Icon size={15} className="shrink-0" />
                {c.label}
              </button>
            );
          })}
        </nav>
        {/* 右侧内容 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6" style={{ overscrollBehavior: 'contain' }}>
          {cat === 'perm' && <PermissionPanel />}
          {cat === 'product' && <ProductCategoryPanel />}
          {(cat === 'requirement' || cat === 'feature' || cat === 'defect' || cat === 'customer') && (
            <EntitySettingsPanel key={cat} entityType={cat} products={products} />
          )}
          {cat === 'consult-kb' && <ConsultKnowledgePanel />}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════ 权限 ════════════════════════

function PermissionPanel() {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-4">
        <div className="text-sm font-medium text-white/75">按角色分配页面权限</div>
        <div className="mt-1 text-xs leading-5 text-white/40">
          根据用户角色分配产品管理内部各页面（概览 / 产品 / 需求 / 功能 / 缺陷 / 客户 / 设置等）的访问权限。该细粒度授权矩阵建设中，将在后续版本上线；当前页面访问沿用 product-agent.use / manage / admin 三级权限。
        </div>
      </div>
      <div>
        <div className="mb-2 text-sm font-medium text-white/75">历史数据导入权限</div>
        <ApplicationAdminManager />
      </div>
    </div>
  );
}

// ════════════════════════ 产品 ════════════════════════

function ProductCategoryPanel() {
  const [tab, setTab] = useState<'category' | 'admins'>('category');
  return (
    <div className="flex flex-col gap-4">
      <SubTabBar
        tabs={[
          { key: 'category', label: '产品类型' },
          { key: 'admins', label: '产品管理员' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as 'category' | 'admins')}
      />
      {tab === 'category' ? <CategoryManager /> : <ProductAdminOverviewPanel />}
    </div>
  );
}

// ════════════════════════ 需求 / 功能 / 缺陷 / 客户 ════════════════════════

type EntitySubTab = 'form' | 'workflow' | 'reqtype' | 'priority' | 'severity' | 'desc';

const ENTITY_SUBTABS: Record<'requirement' | 'feature' | 'defect' | 'customer', { key: EntitySubTab; label: string }[]> = {
  requirement: [
    { key: 'form', label: '需求表单' },
    { key: 'workflow', label: '需求流程' },
    { key: 'reqtype', label: '需求类型' },
    { key: 'priority', label: '需求优先级' },
    { key: 'severity', label: '需求严重程度' },
    { key: 'desc', label: '描述模板' },
  ],
  feature: [
    { key: 'form', label: '功能表单' },
    { key: 'workflow', label: '功能流程' },
    { key: 'priority', label: '功能优先级' },
    { key: 'severity', label: '功能严重程度' },
    { key: 'desc', label: '描述模板' },
  ],
  defect: [
    { key: 'form', label: '缺陷表单' },
    { key: 'workflow', label: '缺陷流程' },
    { key: 'priority', label: '缺陷优先级' },
    { key: 'severity', label: '缺陷严重程度' },
    { key: 'desc', label: '描述模板' },
  ],
  customer: [
    { key: 'form', label: '客户表单' },
    { key: 'desc', label: '描述模板' },
  ],
};

function EntitySettingsPanel({
  entityType,
  products,
}: {
  entityType: 'requirement' | 'feature' | 'defect' | 'customer';
  products: Product[];
}) {
  const subtabs = ENTITY_SUBTABS[entityType];
  const [sub, setSub] = useState<EntitySubTab>(subtabs[0].key);
  const [productScope, setProductScope] = useState('');

  // 切换实体时回到首个子项
  useEffect(() => {
    setSub(subtabs[0].key);
  }, [entityType, subtabs]);

  const needsScope = sub === 'form' || sub === 'workflow';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SubTabBar tabs={subtabs} active={sub} onChange={(k) => setSub(k as EntitySubTab)} />
        {needsScope && (
          <>
            <div className="h-6 w-px bg-white/10" />
            <select
              value={productScope}
              onChange={(e) => setProductScope(e.target.value)}
              className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white/70 outline-none"
            >
              <option value="">全局默认（所有产品共用）</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>覆盖：{p.name}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {sub === 'form' && (
        <FormTemplateEditor key={`f-${entityType}-${productScope}`} entityType={entityType as ProductEntityType} productId={productScope || null} />
      )}
      {sub === 'workflow' && (
        <WorkflowEditor key={`w-${entityType}-${productScope}`} entityType={entityType as ProductEntityType} productId={productScope || null} />
      )}
      {sub === 'reqtype' && <RequirementTypeManager />}
      {sub === 'priority' && <GradeCatalogManager key={`p-${entityType}`} dimension="priority" entityType={entityType as GradeEntityType} />}
      {sub === 'severity' && <GradeCatalogManager key={`s-${entityType}`} dimension="severity" entityType={entityType as GradeEntityType} />}
      {sub === 'desc' && <DescTemplateManager key={`d-${entityType}`} entityType={entityType as ProductEntityType} />}
    </div>
  );
}

// ════════════════════════ 通用等级目录（优先级 / 严重程度） ════════════════════════

function GradeCatalogManager({
  dimension,
  entityType,
}: {
  dimension: GradeDimension;
  entityType: GradeEntityType;
}) {
  const { options, reload, loading } = useGradeOptions(dimension, entityType);
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('#60A5FA');
  const [draftDefinition, setDraftDefinition] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const dimLabel = dimension === 'priority' ? '优先级' : '严重程度';

  const add = async () => {
    if (!draftName.trim()) return;
    setSaving(true);
    setMsg(null);
    const res = await upsertGradeOption({ dimension, entityType, name: draftName.trim(), color: draftColor, definition: draftDefinition.trim() });
    setSaving(false);
    if (res.success) {
      setDraftName('');
      setDraftColor('#60A5FA');
      setDraftDefinition('');
      await reload();
    } else {
      setMsg(res.error?.message || '新增失败');
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <div className="text-xs text-white/50">
        配置「{dimLabel}」可选项，供新建 / 编辑时选择。内置项可改名称、颜色与定义，但不可删除；自定义项在无占用时可删除。
      </div>

      <div className="divide-y divide-white/5 rounded-xl border border-white/10">
        {loading && options.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-white/40">正在加载{dimLabel}…</div>
        )}
        {options.map((o) => (
          <GradeOptionRow key={o.id} option={o} onChanged={reload} />
        ))}
        {!loading && options.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-white/40">还没有{dimLabel}选项，在下方添加。</div>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-white/15 px-3 py-3">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={draftColor}
            onChange={(e) => setDraftColor(e.target.value)}
            className="h-7 w-7 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
            title="选择颜色"
          />
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
            placeholder={`新增${dimLabel}名称，如「紧急」`}
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white outline-none focus:border-cyan-500/40"
          />
          <button
            onClick={add}
            disabled={!draftName.trim() || saving}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3 py-1.5 text-sm text-cyan-200 disabled:opacity-50"
          >
            {saving ? <MapSpinner size={14} /> : <Plus size={14} />} 新增
          </button>
        </div>
        <input
          value={draftDefinition}
          onChange={(e) => setDraftDefinition(e.target.value)}
          placeholder="定义（可选）：说明该等级的判定标准"
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/80 outline-none focus:border-cyan-500/40"
        />
      </div>
      {msg && <div className="text-xs text-red-300/80">{msg}</div>}
    </div>
  );
}

function GradeOptionRow({ option, onChanged }: { option: ProductGradeOption; onChanged: () => Promise<unknown> }) {
  const [name, setName] = useState(option.name);
  const [color, setColor] = useState(option.color);
  const [definition, setDefinition] = useState(option.definition ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = name.trim() !== option.name || color !== option.color || definition !== (option.definition ?? '');

  useEffect(() => {
    setName(option.name);
    setColor(option.color);
    setDefinition(option.definition ?? '');
  }, [option.id, option.name, option.color, option.definition]);

  const save = async () => {
    if (!name.trim() || !dirty) return;
    setBusy(true);
    setErr(null);
    const res = await upsertGradeOption({
      id: option.id,
      dimension: option.dimension,
      entityType: option.entityType,
      name: name.trim(),
      color,
      definition: definition.trim(),
      sortOrder: option.sortOrder,
    });
    setBusy(false);
    if (res.success) await onChanged();
    else setErr(res.error?.message || '保存失败');
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    const res = await deleteGradeOption(option.id);
    setBusy(false);
    if (res.success) await onChanged();
    else setErr(res.error?.message || '删除失败');
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="h-7 w-7 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent"
        title="选择颜色"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
        className="w-32 shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white outline-none focus:border-cyan-500/40"
      />
      <input
        value={definition}
        onChange={(e) => setDefinition(e.target.value)}
        placeholder="定义（可选）"
        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/80 outline-none focus:border-cyan-500/40"
      />
      {option.isBuiltin && (
        <span className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-white/40">内置</span>
      )}
      {err && <span className="max-w-[140px] shrink-0 truncate text-[11px] text-red-300/80" title={err}>{err}</span>}
      <button
        onClick={save}
        disabled={!dirty || !name.trim() || busy}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-cyan-200/80 hover:bg-cyan-500/10 hover:text-cyan-200 disabled:opacity-30"
      >
        {busy ? <MapSpinner size={12} /> : <Save size={12} />} 保存
      </button>
      <button
        onClick={remove}
        disabled={option.isBuiltin || busy}
        title={option.isBuiltin ? '内置项不可删除' : '删除'}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-300/60 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-30"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// ════════════════════════ 问策知识库（营销问策专属，文档列表 + 查看 + 添加） ════════════════════════

function ConsultKnowledgePanel() {
  const [entries, setEntries] = useState<ConsultKbEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getConsultKnowledge();
    if (res.success) setEntries(res.data.entries);
    setLoading(false);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="text-sm font-medium text-white/75">营销问策专属知识库</div>
        <div className="mt-1 text-xs leading-5 text-white/45">
          「营销问策」生成评估时以本知识库内容（全域粉销 / 营销四力模型 4FM）作为专业依据。系统已内置 3 份默认资料，可在下方查看，并随时「添加资料」扩充——新增内容即时纳入后续问策上下文。
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">资料列表{entries.length > 0 ? `（${entries.length}）` : ''}</span>
        <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-500/30">
          <Plus size={14} /> 添加资料
        </button>
      </div>

      {loading ? (
        <MapSectionLoader text="正在加载知识库…" />
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 py-10 text-center text-sm text-white/40">还没有资料。点「添加资料」录入第一份问策参考。</div>
      ) : (
        <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10">
          {entries.map((e) => (
            <button key={e.id} onClick={() => setViewingId(e.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03]">
              <FileText size={15} className="shrink-0 text-cyan-300/70" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white/90">{e.title}</div>
                {e.summary && <div className="truncate text-xs text-white/40">{e.summary}</div>}
              </div>
              <span className="shrink-0 text-[11px] text-white/35">{fmtKbMeta(e)}</span>
            </button>
          ))}
        </div>
      )}

      {viewingId && <KbEntryViewModal entryId={viewingId} onClose={() => setViewingId(null)} />}
      {adding && <KbAddModal onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void reload(); }} />}
    </div>
  );
}

function fmtKbMeta(e: ConsultKbEntry): string {
  const kb = e.fileSize ? `${Math.max(1, Math.round(e.fileSize / 1024))} KB` : '';
  const d = new Date(e.createdAt);
  const date = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN');
  return [kb, date].filter(Boolean).join(' · ');
}

function KbEntryViewModal({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const [data, setData] = useState<{ title: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      const res = await getConsultKnowledgeEntry(entryId);
      if (res.success) setData({ title: res.data.title, content: res.data.content });
      else toast.error('加载失败', res.error?.message);
      setLoading(false);
    })();
  }, [entryId]);

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex w-full max-w-3xl flex-col rounded-xl border border-white/10 bg-[#16181d]" style={{ height: '86vh', maxHeight: '86vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
          <h3 className="truncate text-sm font-semibold text-white">{data?.title ?? '加载中…'}</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" style={{ overscrollBehavior: 'contain' }}>
          {loading ? <MapSectionLoader text="正在加载…" /> : data ? <MarkdownViewer content={data.content} /> : <div className="text-sm text-white/40">内容为空</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function KbAddModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim() || !content.trim()) { toast.error('请填写标题与内容'); return; }
    setSaving(true);
    const res = await addConsultKnowledge({ title: title.trim(), content });
    setSaving(false);
    if (res.success) { toast.success('已添加'); onAdded(); }
    else toast.error('添加失败', res.error?.message);
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex w-full max-w-2xl flex-col rounded-xl border border-white/10 bg-[#16181d]" style={{ maxHeight: '88vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
          <h3 className="text-sm font-semibold text-white">添加问策资料</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={18} /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4" style={{ overscrollBehavior: 'contain' }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="资料标题，如：某行业全域粉销打法"
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25" />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={16} placeholder="资料正文（支持 Markdown）。将作为营销问策评估的参考依据。"
            className="resize-y rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25" style={{ minHeight: 280 }} />
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-white/10 px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-white/60 hover:bg-white/5">取消</button>
          <button onClick={save} disabled={saving || !title.trim() || !content.trim()} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3.5 py-1.5 text-sm text-cyan-200 disabled:opacity-40">
            {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ════════════════════════ 小组件 ════════════════════════

function SubTabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`rounded-md border px-2.5 py-1 text-xs ${active === t.key ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200' : 'border-white/10 text-white/50 hover:bg-white/5'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
