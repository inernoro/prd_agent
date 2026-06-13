/**
 * 产品管理智能体 — 对象独立详情页（需求 / 功能 / 缺陷）。
 *
 * 路由：/product-agent/:productId/:kind/:id  （kind: requirement | feature | defect）
 * 布局：头部(编号+大标题+状态流转+统一保存) + 左主栏(描述/内容型字段/关联)
 * + 右属性栏(分级/状态/属性型自定义字段/信息)。系统字段与自定义字段同一套视觉语言、必填带星号。
 * 自定义模板里与系统字段重名的项(标题/描述)自动去重，避免「重复填两遍」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, ListChecks, Puzzle, Bug, Link2, FileText, GitBranch, Share2, X, ExternalLink, MessageSquareText } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { ItemMultiSearchSelect } from '@/components/ItemMultiSearchSelect';
import { ItemSearchSelect } from '@/components/ItemSearchSelect';
import { FeatureModuleSearchSelect } from '@/components/FeatureModuleSearchSelect';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { useAuthStore } from '@/stores/authStore';
import { searchDirectoryUsers } from '@/services';
import { RequirementRelationModal, DefectLinkerModal } from './ProductRelationModals';
import { RequirementCreateForm } from './RequirementCreateForm';
import { TapdPropertyPanel, TapdPropertyRow } from './TapdPropertyPanel';
import { featurePathLabel } from './featureTreeUtils';
import { InitiationWorkflowDetail } from './InitiationWorkflowDetail';
import { ReleaseWorkflowDetail } from './ReleaseWorkflowDetail';
import { REQUIREMENT_TYPE_FORM_KEY } from './requirementTypeCatalog';
import {
  REQUIREMENT_PRODUCT_DEFECT_FORM_KEY,
  REQUIREMENT_PRODUCT_DEFECT_VALUE,
} from './productDefectLinkageCatalog';
import { RequirementTypeSelect } from './RequirementTypeSelect';
import { toRequirementOptions } from './comboboxOptions';
import { VersionKnowledgeCard } from './knowledge/VersionKnowledgeCard';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import { FormFieldsRenderer, RichTextField, useEffectiveTemplate, useEffectiveWorkflow } from './DynamicForm';
import { WorkflowBar } from './WorkflowBar';
import { ActivityTimeline } from './ActivityTimeline';
import { ProductDefectDetail } from './ProductDefectDetail';
import { sanitizeHtml } from '@/lib/sanitizeHtml';
import { enrichContentWithMentions } from '@/lib/mentionRender';
import './product-cards.css';
import {
  listRequirements,
  updateRequirement,
  listFeatures,
  createFeature,
  updateFeature,
  listVersions,
  listReleases,
  updateVersion,
  createFeatureVersion,
  deleteFeatureVersion,
  listCustomers,
  listFeatureVersions,
  listTracedDefects,
  createProductDefect,
  listDescTemplates,
  getProduct,
  type TracedDefect,
} from '@/services/real/productAgent';
import type { Requirement, Feature, Product, ProductVersion, ProductRelease, Customer, FeatureVersion, FeatureBusinessType, ItemGrade, FormField, ProductEntityType, DescTemplate, VersionLifecycle } from './types';
import { ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL } from './types';
import { slaInfo } from './sla';
import { resolveRequirementStateLabel } from './requirementWorkflowUtils';

const FEATURE_TYPE_LABEL: Record<FeatureBusinessType, string> = {
  basic: '基础功能',
  core: '核心功能',
  value_added: '增值功能',
};
const FEATURE_TYPES: { value: FeatureBusinessType; label: string }[] = [
  { value: 'basic', label: '基础功能' },
  { value: 'core', label: '核心功能' },
  { value: 'value_added', label: '增值功能' },
];
const ITEM_GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];

// ── 自定义字段去重 / 分栏 ──
const NATIVE_DUP_KEYS = new Set(['title', 'name', 'description', 'desc']);
const NATIVE_DUP_LABELS = ['标题', '名称', '描述', '需求名称', '需求描述', '功能名称', '功能描述', '缺陷标题', '需求类型', '需求来源'];

/** 与系统原生字段（标题/描述）重名的模板字段视为重复，详情页不再渲染。 */
function isNativeDuplicate(f: FormField): boolean {
  const key = (f.key || '').toLowerCase();
  const label = (f.label || '').trim();
  return NATIVE_DUP_KEYS.has(key) || NATIVE_DUP_LABELS.includes(label);
}

/** 左主栏只保留「描述 + 附件(file)」，其余字段全进右属性栏。 */
function splitFields(fields: FormField[] | undefined) {
  const usable = (fields ?? []).filter((f) => !isNativeDuplicate(f));
  return {
    files: usable.filter((f) => f.type === 'file'),
    others: usable.filter((f) => f.type !== 'file'),
  };
}

function recordEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

function fmtDate(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ProductObjectDetailPage() {
  const navigate = useNavigate();
  const { productId = '', kind = '', id = '' } = useParams();
  const isNew = id === 'new';

  const [loading, setLoading] = useState(true);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [tracedDefects, setTracedDefects] = useState<TracedDefect[]>([]);
  const [featureVersions, setFeatureVersions] = useState<FeatureVersion[]>([]);
  const [product, setProduct] = useState<Product | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [r, f, v, release, c, d, p] = await Promise.all([
      listRequirements(productId),
      listFeatures(productId),
      listVersions(productId),
      listReleases(productId, 'all'),
      listCustomers(),
      listTracedDefects(productId),
      getProduct(productId),
    ]);
    if (r.success) setRequirements(r.data.items);
    if (f.success) setFeatures(f.data.items);
    if (v.success) setVersions(v.data.items);
    if (release.success) setReleases(release.data.items);
    if (c.success) setCustomers(c.data.items);
    if (d.success) setTracedDefects(d.data.items);
    if (p.success) setProduct(p.data);
    if (kind === 'feature') {
      const fv = await listFeatureVersions(productId, { featureId: id });
      if (fv.success) setFeatureVersions(fv.data.items);
    }
    setLoading(false);
  }, [productId, kind, id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const versionName = useMemo(() => new Map(versions.map((v) => [v.id, v.versionName])), [versions]);
  const customerName = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const requirementName = useMemo(() => new Map(requirements.map((r) => [r.id, r.title])), [requirements]);

  const back = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/product-agent');
  };

  if (kind === 'release') {
    return (
      <div className="h-screen min-h-0 flex flex-col bg-[#0f1014]">
        <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-white/8">
          <button onClick={back} className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-white/60 hover:bg-white/5 hover:text-white shrink-0" title="返回">
            <ArrowLeft size={16} />
          </button>
          <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-200">正式版本</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <div className="mx-auto w-full max-w-4xl py-5 px-5">
            <ReleaseWorkflowDetail productId={productId} releaseId={id} isNew={isNew} />
          </div>
        </div>
      </div>
    );
  }

  if (kind === 'initiation') {
    return (
      <div className="h-screen min-h-0 flex flex-col bg-[#0f1014]">
        <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-white/8">
          <button onClick={back} className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-white/60 hover:bg-white/5 hover:text-white shrink-0" title="返回">
            <ArrowLeft size={16} />
          </button>
          <span className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-200">内部版本</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <div className="mx-auto w-full max-w-4xl py-5 px-5">
            <InitiationWorkflowDetail productId={productId} initiationId={id} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen min-h-0 flex flex-col bg-[#0f1014]">
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-white/8">
        <button
          onClick={back}
          className="flex items-center justify-center w-8 h-8 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 shrink-0"
          title="返回"
        >
          <ArrowLeft size={16} />
        </button>
        <KindBadge kind={kind} isNew={isNew} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className={`${(isNew && kind === 'requirement') || kind === 'feature' || kind === 'version' ? 'w-full px-5 xl:px-8 py-5' : 'mx-auto py-5'}`} style={(isNew && kind === 'requirement') || kind === 'feature' || kind === 'version' ? undefined : { width: '80%' }}>
          {isNew ? (
            kind === 'defect' ? (
              <CreateDefectForm
                productId={productId}
                onCreated={(newId) => navigate(`/product-agent/p/${productId}/defect/${newId}`, { replace: true })}
              />
            ) : kind === 'requirement' ? (
              <RequirementCreateForm
                productId={productId}
                requirements={requirements}
                customers={customers}
                onCreated={(newId) => navigate(`/product-agent/p/${productId}/requirement/${newId}`, { replace: true })}
              />
            ) : (
              <FeatureCreateForm
                productId={productId}
                requirements={requirements}
                allFeatures={features}
                versions={versions}
                releases={releases}
                onCreated={(newId) => navigate(`/product-agent/p/${productId}/feature/${newId}`, { replace: true })}
              />
            )
          ) : loading ? (
            <MapSectionLoader text="正在加载详情…" />
          ) : kind === 'requirement' ? (
            <RequirementDetail
              productId={productId}
              requirement={requirements.find((r) => r.id === id)}
              allRequirements={requirements}
              versionName={versionName}
              customerName={customerName}
              tracedDefects={tracedDefects.filter((d) => d.tracedRequirementId === id)}
              onReload={reload}
              gotoDefect={(did) => navigate(`/product-agent/p/${productId}/defect/${did}`)}
            />
          ) : kind === 'feature' ? (
            <FeatureDetail
              feature={features.find((f) => f.id === id)}
              productName={product?.name ?? productId}
              requirements={requirements}
              allFeatures={features}
              featureVersions={featureVersions}
              versionName={versionName}
              versions={versions}
              releases={releases}
              onReload={reload}
            />
          ) : kind === 'version' ? (
            <VersionDetail
              productId={productId}
              version={versions.find((v) => v.id === id)}
              allVersions={versions}
              requirements={requirements}
              features={features}
              onReload={reload}
            />
          ) : kind === 'defect' ? (
            <ProductDefectDetail
              productId={productId}
              defect={tracedDefects.find((d) => d.id === id)}
              features={features}
              versions={versions}
              versionName={versionName}
              requirementName={requirementName}
              onReload={reload}
              gotoRequirement={(rid) => navigate(`/product-agent/p/${productId}/requirement/${rid}`)}
              gotoFeature={(fid) => navigate(`/product-agent/p/${productId}/feature/${fid}`)}
            />
          ) : (
            <div className="text-white/40 text-sm text-center py-10">不支持的对象类型</div>
          )}
        </div>
      </div>
    </div>
  );
}

function KindBadge({ kind, isNew }: { kind: string; isNew?: boolean }) {
  const meta: Record<string, { label: string; icon: typeof ListChecks; color: string }> = {
    requirement: { label: '需求', icon: ListChecks, color: '#FBBF24' },
    feature: { label: '功能', icon: Puzzle, color: '#A78BFA' },
    version: { label: '版本', icon: GitBranch, color: '#34D399' },
    defect: { label: '缺陷', icon: Bug, color: '#F87171' },
  };
  const m = meta[kind] ?? { label: '对象', icon: ListChecks, color: '#888' };
  const Icon = m.icon;
  return (
    <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: m.color }}>
      <Icon size={16} /> {isNew ? `新建${m.label}` : `${m.label}详情`}
    </span>
  );
}

// ════════════════════════ 通用构件 ════════════════════════

/** 详情骨架：头部 + 主内容；split 为左右双栏，stack 为单列全宽（一行一个容器）。 */
function DetailScaffold({
  no,
  kindLabel,
  kindColor,
  title,
  onTitleChange,
  titlePlaceholder = '标题',
  readOnlyTitle,
  dirty,
  saving,
  onSave,
  headerActions,
  workflow,
  main,
  sidebar,
  layout = 'split',
  children,
}: {
  no: string;
  kindLabel: string;
  kindColor: string;
  title: string;
  onTitleChange?: (v: string) => void;
  titlePlaceholder?: string;
  readOnlyTitle?: boolean;
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void;
  headerActions?: React.ReactNode;
  workflow?: React.ReactNode;
  main: React.ReactNode;
  sidebar?: React.ReactNode;
  layout?: 'split' | 'stack';
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* 头部 */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="text-[11px] font-mono text-white/40">{no}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: kindColor, background: `${kindColor}1a` }}>{kindLabel}</span>
          {(onSave || headerActions) && (
            <div className="ml-auto flex items-center gap-2.5">
              {headerActions}
              {onSave && dirty && <span className="text-[11px] text-amber-300/80 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> 未保存</span>}
              {onSave && (
                <button
                  onClick={onSave}
                  disabled={saving || !title.trim() || !dirty}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
                </button>
              )}
            </div>
          )}
        </div>
        <div className="px-4 pb-3 pt-1.5">
          <div className="flex items-baseline gap-1">
            <input
              value={title}
              readOnly={readOnlyTitle}
              onChange={(e) => onTitleChange?.(e.target.value)}
              placeholder={titlePlaceholder}
              className="flex-1 bg-transparent text-xl font-semibold text-white outline-none placeholder:text-white/25 read-only:cursor-default"
            />
            {!readOnlyTitle && <span className="text-red-300/70 text-sm">*</span>}
          </div>
        </div>
        {workflow && <div className="px-4 py-2.5 border-t border-white/5">{workflow}</div>}
      </div>

      {/* 主体：split 左 70% / 右 30%；stack 单列全宽 */}
      {layout === 'stack' ? (
        <div className="flex flex-col gap-4 min-w-0">{main}</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-4 items-start">
          <div className="flex flex-col gap-4 min-w-0">{main}</div>
          <div className="flex flex-col gap-4 min-w-0">{sidebar}</div>
        </div>
      )}
      {children}
    </div>
  );
}

function Card({ title, action, children, dense }: { title?: string; action?: React.ReactNode; children: React.ReactNode; dense?: boolean }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-white/[0.02] ${dense ? 'p-3.5' : 'p-4'}`}>
      {(title || action) && (
        <div className="flex items-center justify-between mb-3">
          {title && <div className="text-xs font-semibold text-white/60">{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="text-xs text-white/55">
      {children}
      {required && <span className="text-red-300/70 ml-1">*</span>}
    </label>
  );
}

function GradeField({ grade, setGrade }: { grade: ItemGrade; setGrade: (g: ItemGrade) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ITEM_GRADES.map((g) => (
        <button
          key={g}
          onClick={() => setGrade(g)}
          className={`px-2 py-1 rounded-md text-xs border ${grade === g ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/40 border-white/10 hover:bg-white/5'}`}
        >
          {ITEM_GRADE_LABEL[g]}
        </button>
      ))}
    </div>
  );
}

/** 父项选择（单选下拉，用于设置需求/功能的父子层级）。 */
function ParentSelect({ value, onChange, options, placeholder }: { value: string; onChange: (v: string) => void; options: { id: string; label: string }[]; placeholder: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}

/** 描述字段：富文本（排版工具栏 + 截图粘贴/拖拽上传）。 */
function DescriptionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <RichTextField value={value} onChange={onChange} minHeight={420} placeholder="补充背景、目标、验收标准…（支持排版与截图粘贴 / 点右上角套用模板）" />;
}

function PlainTextArea({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      rows={6}
      className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-white/25 focus:border-cyan-500/40"
      style={{ minHeight: 132, overscrollBehavior: 'contain' }}
    />
  );
}

/** 详情页头部「追溯关系路径」触发按钮。 */
function TraceButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/70 hover:bg-white/5 hover:text-cyan-200 text-sm"
      title="在图谱中查看本对象的全部关联（动态高亮）"
    >
      <Share2 size={14} /> 追溯关系路径
    </button>
  );
}

/**
 * 追溯关系路径抽屉：从右侧滑出（占 70% 宽），内嵌复用图谱画布并自动锚定当前对象，
 * 高亮其在图谱中的全部关联（动态）。复用 ProductGraphCanvas 的 focusNodeId 能力。
 */
function TraceRelationDrawer({ productId, nodeId, title, onClose }: { productId: string; nodeId: string; title: string; onClose: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(true); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex">
      <div className="flex-1 bg-black/40" style={{ opacity: shown ? 1 : 0, transition: 'opacity .25s ease' }} onClick={onClose} />
      <div
        className="h-full bg-[#0f1014] border-l border-white/10 flex flex-col shadow-2xl"
        style={{ width: '70%', transform: shown ? 'translateX(0)' : 'translateX(100%)', transition: 'transform .25s ease' }}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/8">
          <span className="flex items-center gap-2 text-sm font-semibold text-white">
            <Share2 size={15} className="text-cyan-400" /> 追溯关系路径 · {title}
          </span>
          <button onClick={onClose} className="text-white/40 hover:text-white" title="关闭"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0">
          <ProductGraphCanvas productId={productId} focusNodeId={nodeId} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 内容非空时追加模板，空时直接套用。 */
function mergeDesc(prev: string, tpl: string): string {
  const stripped = (prev || '').replace(/<br\s*\/?>/gi, '').replace(/<div>\s*<\/div>/gi, '').replace(/&nbsp;/gi, '').trim();
  return stripped ? `${prev}${tpl}` : tpl;
}

/** 取默认描述模板内容（列表按 SortOrder 升序，首个即默认），用于新建时自动预填。 */
function useDefaultDescTemplateContent(entityType: ProductEntityType) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await listDescTemplates(entityType);
      if (!alive || !res.success) return;
      setContent(res.data.items[0]?.content ?? null);
    })();
    return () => { alive = false; };
  }, [entityType]);
  return content;
}

/** 描述模板选择器：列出该对象类型的描述模板，一键套用。无模板时不显示。 */
function DescTemplatePicker({ entityType, onApply }: { entityType: ProductEntityType; onApply: (content: string) => void }) {
  const [templates, setTemplates] = useState<DescTemplate[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await listDescTemplates(entityType);
      if (alive && res.success) setTemplates(res.data.items);
    })();
    return () => { alive = false; };
  }, [entityType]);

  if (templates.length === 0) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
        <FileText size={12} /> 套用模板
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-20 w-56 max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-[#1b1d22] shadow-xl p-1" style={{ overscrollBehavior: 'contain' }}>
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => { onApply(t.content); setOpen(false); }}
                className="w-full text-left px-2.5 py-1.5 rounded text-sm text-white/80 hover:bg-white/5 truncate"
                title={t.name}
              >
                {t.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <div className="text-[11px] text-white/30">{empty}</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t, i) => (
        <span key={i} className="text-[11px] px-2 py-0.5 rounded bg-white/8 text-white/70 border border-white/10">
          {t}
        </span>
      ))}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-white/40">{label}</span>
      <span className="text-white/60">{value}</span>
    </div>
  );
}

/** 属性字段表：左列字段名、右列值，一行一个字段 */
function AttributeFieldTable({ rows }: { rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col style={{ width: '22%' }} />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-white/5 first:border-t-0">
              <td className="px-4 py-3 text-xs font-medium text-white/45 bg-white/[0.02] align-top">{row.label}</td>
              <td className="px-4 py-3 text-sm text-white/80 min-w-0">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailRecordTable({
  columns,
  rows,
  emptyText,
  onRowClick,
}: {
  columns: { header: string; width?: string; className?: string; render: (row: { id: string }) => React.ReactNode }[];
  rows: { id: string }[];
  emptyText: string;
  onRowClick?: (id: string) => void;
}) {
  if (rows.length === 0) {
    return <div className="py-10 text-center text-sm text-white/35">{emptyText}</div>;
  }
  const cell = 'px-3 py-2.5 text-xs text-white/65 truncate';
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full table-fixed text-left text-sm min-w-[960px]">
        {columns.some((c) => c.width) && (
          <colgroup>
            {columns.map((c, i) => (
              <col key={i} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
        )}
        <thead className="bg-white/[0.03] text-[11px] text-white/45 border-b border-white/10">
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={`px-3 py-2.5 font-medium whitespace-nowrap ${c.className ?? ''}`}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onRowClick?.(row.id)}
              className={`border-t border-white/5 ${onRowClick ? 'cursor-pointer hover:bg-white/[0.03]' : ''}`}
            >
              {columns.map((c) => (
                <td key={c.header} className={`${cell} ${c.className ?? ''}`}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotFound() {
  return <div className="text-white/40 text-sm text-center py-10">对象不存在或已删除</div>;
}

// ════════════════════════ 新建功能（布局对齐功能详情）════════════════════════
function FeatureCreateForm({
  productId,
  requirements,
  allFeatures,
  versions,
  releases,
  onCreated,
}: {
  productId: string;
  requirements: Requirement[];
  allFeatures: Feature[];
  versions: ProductVersion[];
  releases: ProductRelease[];
  onCreated: (newId: string) => void;
}) {
  const navigate = useNavigate();
  const currentUserId = useAuthStore((state) => state.user?.userId ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [featureType, setFeatureType] = useState<FeatureBusinessType>('basic');
  const [mainRequirementId, setMainRequirementId] = useState('');
  const [selReqs, setSelReqs] = useState<Set<string>>(new Set());
  const [plannedVersionId, setPlannedVersionId] = useState('');
  const [officialReleaseId, setOfficialReleaseId] = useState('');
  const [ownerId, setOwnerId] = useState(currentUserId);
  const [assigneeId, setAssigneeId] = useState('');
  const [parentId, setParentId] = useState('');
  const [keyRules, setKeyRules] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [remark, setRemark] = useState('');
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const { template } = useEffectiveTemplate('feature', productId);
  const { workflow } = useEffectiveWorkflow('feature', productId);
  const split = useMemo(() => splitFields(template?.fields), [template]);

  const defaultDescContent = useDefaultDescTemplateContent('feature');
  const descAutoFilledRef = useRef(false);
  useEffect(() => {
    if (descAutoFilledRef.current || !defaultDescContent) return;
    if (description.trim() === '') {
      descAutoFilledRef.current = true;
      setDescription(defaultDescContent);
    }
  }, [defaultDescContent, description]);

  useEffect(() => {
    if (currentUserId && !ownerId) setOwnerId(currentUserId);
  }, [currentUserId, ownerId]);

  const setField = (k: string, v: string) => setFormData((d) => ({ ...d, [k]: v }));

  const create = async () => {
    if (!title.trim() || !description.trim() || !moduleName.trim() || !mainRequirementId || !plannedVersionId || !ownerId || !keyRules.trim() || !acceptanceCriteria.trim()) {
      setMessage('请完整填写功能名称、功能说明、所属模块、主需求、内部版本号、负责人、关键规则和验收标准');
      return;
    }
    setSaving(true);
    setMessage('');
    const res = await createFeature(productId, {
      title: title.trim(),
      description,
      moduleName: moduleName.trim(),
      featureType,
      mainRequirementId,
      requirementIds: Array.from(new Set([mainRequirementId, ...selReqs])),
      plannedVersionId,
      officialReleaseId: officialReleaseId || null,
      ownerId,
      parentId: parentId || null,
      keyRules,
      acceptanceCriteria,
      remark,
      assigneeId: assigneeId || null,
      formData,
      templateId: template?.id,
      workflowDefId: workflow?.id,
    });
    setSaving(false);
    if (res.success && res.data) onCreated(res.data.id);
    else setMessage(res.error?.message ?? '创建功能失败');
  };

  return (
    <DetailScaffold
      no="新建功能"
      kindLabel="功能"
      kindColor="#A78BFA"
      title={title}
      onTitleChange={setTitle}
      titlePlaceholder="功能名称"
      dirty
      saving={saving}
      onSave={create}
      main={
        <>
          <Card title="功能说明" action={<DescTemplatePicker entityType="feature" onApply={(c) => setDescription((p) => mergeDesc(p, c))} />}>
            <DescriptionField value={description} onChange={setDescription} />
          </Card>
          <Card title="关键规则">
            <PlainTextArea value={keyRules} onChange={setKeyRules} placeholder="填写核心业务规则、限制条件和边界" />
          </Card>
          <Card title="验收标准">
            <p className="text-[11px] text-white/35 mb-2">写清怎样算做完、测试和产品怎样验收（给定场景与条件，系统应出现什么结果）</p>
            <PlainTextArea value={acceptanceCriteria} onChange={setAcceptanceCriteria} placeholder="例：给定合法输入，系统返回预期结果；异常场景有明确提示…" />
          </Card>
          <Card title="备注">
            <PlainTextArea value={remark} onChange={setRemark} placeholder="补充特殊情况或例外说明，可不填" />
          </Card>
          {split.files.length > 0 && (
            <Card title="附件">
              <FormFieldsRenderer fields={split.files} values={formData} onChange={setField} productId={productId} />
            </Card>
          )}
          {message && <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">{message}</div>}
          <p className="text-[11px] text-white/35 px-1">保存后进入功能详情，可继续维护版本纳入、缺陷追溯与状态流转。</p>
        </>
      }
      sidebar={
        <>
          <Card title="属性">
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <FieldLabel required>所属功能模块</FieldLabel>
                <p className="text-[11px] text-white/35 -mt-0.5">从功能目录树逐级点选，或在搜索框输入路径/名称快捷定位</p>
                <FeatureModuleSearchSelect value={moduleName} onChange={setModuleName} features={allFeatures} />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel required>功能类型</FieldLabel>
                <select value={featureType} onChange={(event) => setFeatureType(event.target.value as FeatureBusinessType)} className="w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none">
                  {FEATURE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel required>负责人</FieldLabel>
                <UserSearchSelect value={ownerId} onChange={setOwnerId} />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>处理人</FieldLabel>
                <UserSearchSelect value={assigneeId} onChange={setAssigneeId} />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>父功能</FieldLabel>
                <ParentSelect
                  value={parentId}
                  onChange={setParentId}
                  options={allFeatures.map((f) => ({ id: f.id, label: f.title }))}
                  placeholder="无（顶层功能）"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel required>内部版本号</FieldLabel>
                <p className="text-[11px] text-white/35 -mt-0.5">立项时确定本功能归属的内部版本（T 号），关联下方内部版本记录</p>
                <InternalVersionSelect value={plannedVersionId} onChange={setPlannedVersionId} versions={versions} />
                {plannedVersionId && (
                  <FeatureInternalVersionLink
                    version={versions.find((v) => v.id === plannedVersionId)}
                    onOpen={(id) => navigate(`/product-agent/p/${productId}/version/${id}`)}
                  />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>正式版本号</FieldLabel>
                <select value={officialReleaseId} onChange={(event) => setOfficialReleaseId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none">
                  <option value="">上线后回写</option>
                  {releases.filter((release) => release.vCode).map((release) => <option key={release.id} value={release.id}>{release.vCode} · {release.planName}</option>)}
                </select>
              </div>
              {split.others.length > 0 && (
                <div className="pt-1 border-t border-white/5">
                  <FormFieldsRenderer fields={split.others} values={formData} onChange={setField} productId={productId} />
                </div>
              )}
            </div>
          </Card>
          <Card title="主需求与关联需求">
            {requirements.length === 0 ? (
              <div className="text-[11px] text-white/30">该产品还没有需求，请先创建需求后再新建功能</div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel required>主需求</FieldLabel>
                  <ItemSearchSelect
                    value={mainRequirementId}
                    onChange={(id) => {
                      setMainRequirementId(id);
                      if (id) setSelReqs((prev) => new Set([...prev, id]));
                    }}
                    options={toRequirementOptions(requirements)}
                    placeholder="搜索需求标题或编号..."
                    clearOptionLabel="请选择主需求"
                    countUnit="条需求"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>关联需求</FieldLabel>
                  <ItemMultiSearchSelect
                    value={Array.from(selReqs).filter((id) => id !== mainRequirementId)}
                    onChange={(ids) => setSelReqs(new Set(mainRequirementId ? [mainRequirementId, ...ids] : ids))}
                    options={toRequirementOptions(requirements)}
                    placeholder="搜索并选择关联需求..."
                    countUnit="条需求"
                    lockedIds={mainRequirementId ? [mainRequirementId] : []}
                    emptyText="暂无其他需求可选"
                  />
                </div>
              </div>
            )}
          </Card>
        </>
      }
    />
  );
}

// ════════════════════════ 新建缺陷（独立页，对齐新建需求）════════════════════════
function CreateDefectForm({ productId, onCreated }: { productId: string; onCreated: (newId: string) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [assigneeId, setAssigneeId] = useState('');
  const [featureId, setFeatureId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [versionTouched, setVersionTouched] = useState(false);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [featureVersions, setFeatureVersions] = useState<FeatureVersion[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const [f, v, fv] = await Promise.all([listFeatures(productId), listVersions(productId), listFeatureVersions(productId)]);
      if (f.success && f.data) setFeatures(f.data.items);
      if (v.success && v.data) setVersions(v.data.items);
      if (fv.success && fv.data) setFeatureVersions(fv.data.items);
    })();
  }, [productId]);

  // 版本默认填充所选功能的版本号（取该功能最新关联的版本），用户未手动改过时随功能联动。
  const versionCreatedAt = useMemo(() => new Map(versions.map((v) => [v.id, v.createdAt])), [versions]);
  const defaultVersionForFeature = useCallback(
    (fid: string): string => {
      if (!fid) return '';
      const linked = featureVersions.filter((x) => x.featureId === fid).map((x) => x.versionId);
      if (linked.length === 0) return '';
      // 取关联版本里创建时间最新的那个作为默认
      return linked.sort((a, b) => (versionCreatedAt.get(b) ?? '').localeCompare(versionCreatedAt.get(a) ?? ''))[0] ?? '';
    },
    [featureVersions, versionCreatedAt],
  );

  const onFeatureChange = (fid: string) => {
    setFeatureId(fid);
    if (!versionTouched) setVersionId(defaultVersionForFeature(fid));
  };

  const canSubmit = !!title.trim() && !!featureId;

  const create = async () => {
    if (!canSubmit) return;
    setSaving(true);
    const res = await createProductDefect(productId, {
      title: title.trim(),
      description: description || undefined,
      grade,
      assigneeId: assigneeId || null,
      featureId,
      versionId: versionId || undefined,
    });
    setSaving(false);
    if (res.success && res.data) onCreated(res.data.id);
  };

  const selectCls = 'w-full px-2.5 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40';

  return (
    <DetailScaffold
      no="新建缺陷"
      kindLabel="缺陷"
      kindColor="#F87171"
      title={title}
      onTitleChange={setTitle}
      titlePlaceholder="缺陷标题"
      dirty={canSubmit}
      saving={saving}
      onSave={create}
      main={
        <>
          <Card title="描述 / 复现步骤">
            <DescriptionField value={description} onChange={setDescription} />
          </Card>
          {!canSubmit && (
            <p className="text-[11px] text-amber-300/70 px-1">请填写「标题」「关联功能」后才能提交。</p>
          )}
          <p className="text-[11px] text-white/35 px-1">创建后进入缺陷详情页，自动追溯到本产品与所选功能；可在缺陷管理智能体继续处理流转。</p>
        </>
      }
      sidebar={
        <Card title="属性">
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <FieldLabel>等级</FieldLabel>
              <GradeField grade={grade} setGrade={setGrade} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>处理人</FieldLabel>
              <UserSearchSelect value={assigneeId} onChange={setAssigneeId} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel required>关联功能</FieldLabel>
              <select className={selectCls} value={featureId} onChange={(e) => onFeatureChange(e.target.value)}>
                <option value="">请选择功能</option>
                {features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
              <span className="text-[10px] text-white/30">缺陷通过功能关联到需求，请先选择所属功能。</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>关联版本</FieldLabel>
              <select className={selectCls} value={versionId} onChange={(e) => { setVersionTouched(true); setVersionId(e.target.value); }}>
                <option value="">不关联</option>
                {versions.map((v) => <option key={v.id} value={v.id}>{v.versionName}</option>)}
              </select>
              <span className="text-[10px] text-white/30">默认填充所选功能的版本，可手动调整。</span>
            </div>
          </div>
        </Card>
      }
    />
  );
}

// ════════════════════════ 需求详情 ════════════════════════
function RequirementDetail({
  productId,
  requirement,
  allRequirements,
  versionName,
  customerName,
  tracedDefects,
  onReload,
  gotoDefect,
}: {
  productId: string;
  requirement?: Requirement;
  allRequirements: Requirement[];
  versionName: Map<string, string>;
  customerName: Map<string, string>;
  tracedDefects: TracedDefect[];
  onReload: () => void;
  gotoDefect: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [assigneeId, setAssigneeId] = useState('');
  const [parentId, setParentId] = useState('');
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [showRel, setShowRel] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const { template } = useEffectiveTemplate('requirement', productId);
  const { workflow } = useEffectiveWorkflow('requirement', productId);
  const split = useMemo(() => splitFields(template?.fields), [template]);

  useEffect(() => {
    if (requirement) {
      setTitle(requirement.title);
      setDescription(requirement.description ?? '');
      setGrade(requirement.grade);
      setAssigneeId(requirement.assigneeId ?? '');
      setParentId(requirement.parentId ?? '');
      setFormData(requirement.formData ?? {});
    }
  }, [requirement]);

  const dirty = useMemo(() => {
    if (!requirement) return false;
    return (
      title !== requirement.title ||
      description !== (requirement.description ?? '') ||
      grade !== requirement.grade ||
      assigneeId !== (requirement.assigneeId ?? '') ||
      parentId !== (requirement.parentId ?? '') ||
      !recordEqual(formData, requirement.formData ?? {})
    );
  }, [requirement, title, description, grade, assigneeId, parentId, formData]);

  if (!requirement) return <NotFound />;
  const setField = (k: string, v: string) => setFormData((d) => ({ ...d, [k]: v }));

  const save = async () => {
    setSaving(true);
    await updateRequirement(requirement.id, { title: title.trim(), description, grade, assigneeId: assigneeId || null, parentId, formData });
    setSaving(false);
    onReload();
  };

  return (
    <DetailScaffold
      no={requirement.requirementNo}
      kindLabel="需求"
      kindColor="#FBBF24"
      title={title}
      onTitleChange={setTitle}
      dirty={dirty}
      saving={saving}
      onSave={save}
      headerActions={<TraceButton onClick={() => setShowTrace(true)} />}
      workflow={
        workflow ? (
          <WorkflowBar
            workflow={workflow}
            entityType="requirement"
            entityId={requirement.id}
            productId={productId}
            currentState={requirement.currentState}
            importedStatusLabel={requirement.sourceSnapshot?.status || requirement.sourceSnapshot?.fields?.['状态']}
            entitySnapshot={{ ownerId: requirement.ownerId, assigneeId, title, grade, versionIds: requirement.versionIds }}
            onChanged={onReload}
          />
        ) : undefined
      }
      main={
        <>
          <Card title="描述" action={<DescTemplatePicker entityType="requirement" onApply={(c) => setDescription((p) => mergeDesc(p, c))} />}>
            <DescriptionField value={description} onChange={setDescription} />
          </Card>
          {split.files.length > 0 && (
            <Card title="附件">
              <FormFieldsRenderer fields={split.files} values={formData} onChange={setField} productId={productId} />
            </Card>
          )}
          {requirement.sourceSnapshot?.comments?.length ? (
            <Card title={`评论与流转 · ${requirement.sourceSnapshot.comments.length}`}>
              <div className="flex flex-col gap-3">
                {requirement.sourceSnapshot.comments.map((comment, index) => (
                  <div key={`${comment.author}-${comment.createdAt ?? index}`} className="rounded-lg border border-white/10 bg-white/[0.025] p-3">
                    <div className="flex items-start gap-2">
                      <MessageSquareText size={15} className="text-cyan-300 mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm text-white/80">
                            <span className="font-medium">{comment.author || '未知用户'}</span>
                            <span className="text-white/40 ml-2">{comment.title}</span>
                          </div>
                          <span className="text-[11px] text-white/35 shrink-0">{fmtDate(comment.createdAt)}</span>
                        </div>
                        {comment.content && (
                          <div
                            className="mt-2 text-sm text-white/65 prose-product leading-6"
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(enrichContentWithMentions(comment.content)) }}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          <Card title="动态">
            <ActivityTimeline entityType="requirement" entityId={requirement.id} />
          </Card>
        </>
      }
      sidebar={
        <>
          <Card title="属性">
            <div className="flex flex-col gap-3.5">
              {requirement.sourceSnapshot && (
                <RequirementExtendedFields requirement={requirement} />
              )}
              {requirement.sourceDefectId && (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>来源缺陷</FieldLabel>
                  <button
                    onClick={() => gotoDefect(requirement.sourceDefectId!)}
                    className="self-start flex items-center gap-1.5 text-xs px-2 py-1 rounded-md bg-red-500/10 text-red-200/90 border border-red-500/30 hover:bg-red-500/20"
                  >
                    <Bug size={12} /> {tracedDefects.find((d) => d.id === requirement.sourceDefectId)?.defectNo ?? '由缺陷转化'}
                  </button>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <FieldLabel>需求类型</FieldLabel>
                <RequirementTypeSelect
                  value={formData[REQUIREMENT_TYPE_FORM_KEY] ?? ''}
                  onChange={(v) => setField(REQUIREMENT_TYPE_FORM_KEY, v)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel required>分级</FieldLabel>
                <GradeField grade={grade} setGrade={setGrade} />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>处理人</FieldLabel>
                <UserSearchSelect value={assigneeId} onChange={setAssigneeId} />
              </div>
              <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData[REQUIREMENT_PRODUCT_DEFECT_FORM_KEY] === REQUIREMENT_PRODUCT_DEFECT_VALUE}
                  onChange={(e) => setField(REQUIREMENT_PRODUCT_DEFECT_FORM_KEY, e.target.checked ? REQUIREMENT_PRODUCT_DEFECT_VALUE : '')}
                  className="accent-cyan-500"
                />
                产品缺陷
              </label>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>父需求</FieldLabel>
                <ParentSelect
                  value={parentId}
                  onChange={setParentId}
                  options={allRequirements.filter((r) => r.id !== requirement.id).map((r) => ({ id: r.id, label: r.title }))}
                  placeholder="无（顶层需求）"
                />
              </div>
              {split.others.length > 0 && (
                <div className="pt-1 border-t border-white/5">
                  <FormFieldsRenderer fields={split.others} values={formData} onChange={setField} productId={productId} />
                </div>
              )}
            </div>
          </Card>
          <Card
            title="关联关系"
            action={
              <button onClick={() => setShowRel(true)} className="flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
                <Link2 size={12} /> 编辑关联
              </button>
            }
          >
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-[11px] text-white/40 mb-1.5">客户</div>
                <Chips items={requirement.customerIds.map((c) => customerName.get(c) ?? c)} empty="未关联客户" />
              </div>
              <div>
                <div className="text-[11px] text-white/40 mb-1.5">归属版本</div>
                <Chips items={requirement.versionIds.map((v) => versionName.get(v) ?? v)} empty="未归属版本" />
              </div>
            </div>
          </Card>
          <Card title={`追溯缺陷 · ${tracedDefects.length}`}>
            <DefectList defects={tracedDefects} onClick={gotoDefect} empty="还没有缺陷追溯到本需求" />
          </Card>
          <Card title="信息">
            <div className="flex flex-col gap-2">
              <InfoRow label="创建时间" value={fmtDate(requirement.createdAt)} />
              <InfoRow label="更新时间" value={fmtDate(requirement.updatedAt)} />
            </div>
          </Card>
        </>
      }
    >
      {showRel && (
        <RequirementRelationModal productId={productId} requirement={requirement} onClose={() => setShowRel(false)} onSaved={onReload} />
      )}
      {showTrace && (
        <TraceRelationDrawer productId={productId} nodeId={`requirement:${requirement.id}`} title={requirement.title} onClose={() => setShowTrace(false)} />
      )}
    </DetailScaffold>
  );
}

const REQUIREMENT_EXTENDED_FIELD_ORDER = [
  '状态',
  '优先级',
  '模块',
  '规模',
  '分类',
  '业务价值',
  '需求来源',
  '需求类型',
  '需求类别',
  '功能',
  '处理人',
  '开发人员',
  '创建人',
  '抄送人',
  '客户名称',
  '责任团队',
  '所属产品',
  '所属团队',
  '预计开始',
  '预计结束',
  '完成时间',
  '开发实际排期',
  '评审时效',
  '评审明确性',
  '每月排期优化',
  '需求联系人',
  '期望排期时间',
] as const;

const REQUIREMENT_PERSON_FIELD_LABELS = new Set(['处理人', '开发人员', '创建人', '抄送人']);

function RequirementExtendedFields({ requirement }: { requirement: Requirement }) {
  const snapshot = requirement.sourceSnapshot!;
  const fields = snapshot.fields ?? {};
  const visibleFields = REQUIREMENT_EXTENDED_FIELD_ORDER
    .filter((label) => !REQUIREMENT_PERSON_FIELD_LABELS.has(label))
    .map((label) => ({ label, value: fields[label] }))
    .filter((item) => item.value);

  return (
    <>
      {requirement.externalId && requirement.externalId !== requirement.requirementNo && (
        <InfoRow label="来源 ID" value={requirement.externalId} />
      )}
      {requirement.sourceUrl && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel>来源链接</FieldLabel>
          <a href={requirement.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200">
            打开链接 <ExternalLink size={11} />
          </a>
        </div>
      )}
      {visibleFields.map((item) => (
        <InfoRow key={item.label} label={item.label} value={item.value} />
      ))}
      {(snapshot.handlerNames.length > 0 || snapshot.developerNames.length > 0 || snapshot.creatorNames.length > 0 || snapshot.ccNames.length > 0) && (
        <>
          {snapshot.handlerNames.length > 0 && <InfoRow label="处理人" value={snapshot.handlerNames.join('、')} />}
          {snapshot.developerNames.length > 0 && <InfoRow label="开发人员" value={snapshot.developerNames.join('、')} />}
          {snapshot.creatorNames.length > 0 && <InfoRow label="创建人" value={snapshot.creatorNames.join('、')} />}
          {snapshot.ccNames.length > 0 && <InfoRow label="抄送人" value={snapshot.ccNames.join('、')} />}
        </>
      )}
      <div className="pt-2 border-t border-white/8 flex flex-col gap-2">
        <InfoRow label="创建时间" value={fmtDate(snapshot.sourceCreatedAt)} />
        <InfoRow label="最后修改" value={fmtDate(snapshot.sourceModifiedAt)} />
        {snapshot.importedFileName && <InfoRow label="导入文件" value={snapshot.importedFileName} />}
        <InfoRow label="导入时间" value={fmtDate(snapshot.importedAt)} />
      </div>
      <div className="pt-2 border-t border-white/8" />
    </>
  );
}

function DefectList({ defects, onClick, empty }: { defects: TracedDefect[]; onClick: (id: string) => void; empty: string }) {
  if (defects.length === 0) return <div className="text-[11px] text-white/30">{empty}</div>;
  return (
    <div className="flex flex-col gap-1">
      {defects.map((d) => (
        <button
          key={d.id}
          onClick={() => onClick(d.id)}
          className="pa-row text-left flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border border-white/10 bg-white/[0.02]"
        >
          <span className="text-sm text-white/80 truncate">
            <span className="text-[10px] text-white/40 mr-1.5 font-mono">{d.defectNo}</span>
            {d.title || '(无标题)'}
          </span>
          <span className="text-[10px] text-white/40 shrink-0">{d.status}</span>
        </button>
      ))}
    </div>
  );
}

function FeatureRequirementLink({
  requirement,
  onOpen,
}: {
  requirement?: Requirement;
  onOpen: (id: string) => void;
}) {
  if (!requirement) return <span className="text-xs text-white/35">未选择</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(requirement.id)}
      className="w-full text-left rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 hover:border-cyan-400/30 hover:bg-cyan-400/5"
    >
      <span className="block text-[10px] font-mono text-cyan-200/80">{requirement.requirementNo}</span>
      <span className="block text-xs text-white/80 truncate mt-0.5">{requirement.title}</span>
    </button>
  );
}

function FeatureInternalVersionLink({
  version,
  onOpen,
}: {
  version?: ProductVersion;
  onOpen: (id: string) => void;
}) {
  if (!version) return null;
  return (
    <button
      type="button"
      onClick={() => onOpen(version.id)}
      className="w-full text-left rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 hover:border-violet-400/30 hover:bg-violet-400/5"
    >
      <span className="block text-[10px] font-mono text-violet-200/80">{version.versionName}</span>
      {version.description && (
        <span className="block text-xs text-white/60 truncate mt-0.5">{version.description}</span>
      )}
      <span className="block text-[10px] text-white/35 mt-1">点击查看内部版本详情</span>
    </button>
  );
}

function InternalVersionSelect({
  value,
  onChange,
  versions,
}: {
  value: string;
  onChange: (id: string) => void;
  versions: ProductVersion[];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none"
    >
      <option value="">请选择内部版本（T 号）</option>
      {versions.map((version) => (
        <option key={version.id} value={version.id}>{version.versionName}</option>
      ))}
    </select>
  );
}

// ════════════════════════ 功能详情（字段对齐 V2.6 §3.6）════════════════════════
function FeatureDetail({
  feature,
  productName,
  requirements,
  allFeatures,
  featureVersions,
  versionName,
  versions,
  releases,
  onReload,
}: {
  feature?: Feature;
  productName: string;
  requirements: Requirement[];
  allFeatures: Feature[];
  featureVersions: FeatureVersion[];
  versionName: Map<string, string>;
  versions: ProductVersion[];
  releases: ProductRelease[];
  onReload: () => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [featureType, setFeatureType] = useState<FeatureBusinessType>('basic');
  const [mainRequirementId, setMainRequirementId] = useState('');
  const [plannedVersionId, setPlannedVersionId] = useState('');
  const [officialReleaseId, setOfficialReleaseId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [keyRules, setKeyRules] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [remark, setRemark] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [parentId, setParentId] = useState('');
  const [selReqs, setSelReqs] = useState<Set<string>>(new Set());
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const { template } = useEffectiveTemplate('feature', feature?.productId ?? null);
  const { workflow } = useEffectiveWorkflow('feature', feature?.productId ?? null);
  const split = useMemo(() => splitFields(template?.fields), [template]);

  const [tracedDefects, setTracedDefects] = useState<TracedDefect[]>([]);
  const [showDefectLinker, setShowDefectLinker] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const reloadDefects = useCallback(async () => {
    if (!feature) return;
    const res = await listTracedDefects(feature.productId, { featureId: feature.id });
    if (res.success) setTracedDefects(res.data.items);
  }, [feature]);
  useEffect(() => {
    void reloadDefects();
  }, [reloadDefects]);

  useEffect(() => {
    if (feature) {
      setTitle(feature.title);
      setDescription(feature.description ?? '');
      setModuleName(feature.moduleName ?? '');
      setFeatureType(feature.featureType ?? 'basic');
      setMainRequirementId(feature.mainRequirementId ?? feature.requirementIds[0] ?? '');
      setPlannedVersionId(feature.plannedVersionId ?? '');
      setOfficialReleaseId(feature.officialReleaseId ?? '');
      setOwnerId(feature.ownerId ?? '');
      setKeyRules(feature.keyRules ?? '');
      setAcceptanceCriteria(feature.acceptanceCriteria ?? '');
      setRemark(feature.remark ?? '');
      setAssigneeId(feature.assigneeId ?? '');
      setParentId(feature.parentId ?? '');
      setSelReqs(new Set(feature.requirementIds));
      setFormData(feature.formData ?? {});
    }
  }, [feature]);

  const reqSetEqual = (a: Set<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));
  const dirty = useMemo(() => {
    if (!feature) return false;
    return (
      title !== feature.title ||
      description !== (feature.description ?? '') ||
      moduleName !== (feature.moduleName ?? '') ||
      featureType !== (feature.featureType ?? 'basic') ||
      mainRequirementId !== (feature.mainRequirementId ?? feature.requirementIds[0] ?? '') ||
      plannedVersionId !== (feature.plannedVersionId ?? '') ||
      officialReleaseId !== (feature.officialReleaseId ?? '') ||
      ownerId !== (feature.ownerId ?? '') ||
      keyRules !== (feature.keyRules ?? '') ||
      acceptanceCriteria !== (feature.acceptanceCriteria ?? '') ||
      remark !== (feature.remark ?? '') ||
      assigneeId !== (feature.assigneeId ?? '') ||
      parentId !== (feature.parentId ?? '') ||
      !reqSetEqual(selReqs, feature.requirementIds) ||
      !recordEqual(formData, feature.formData ?? {})
    );
  }, [feature, title, description, moduleName, featureType, mainRequirementId, plannedVersionId, officialReleaseId, ownerId, keyRules, acceptanceCriteria, remark, assigneeId, parentId, selReqs, formData]);

  if (!feature) return <NotFound />;
  const productId = feature.productId;
  const setField = (k: string, v: string) => setFormData((d) => ({ ...d, [k]: v }));
  const mainRequirement = requirements.find((r) => r.id === mainRequirementId);
  const relatedRequirements = requirements.filter((r) => selReqs.has(r.id) && r.id !== mainRequirementId);
  const selectedInternalVersion = versions.find((v) => v.id === plannedVersionId);
  const officialReleaseLabel = releases.find((r) => r.id === officialReleaseId);
  const parentFeature = parentId ? allFeatures.find((f) => f.id === parentId) : undefined;
  const catalogPath = parentId || allFeatures.some((f) => f.parentId === feature.id)
    ? featurePathLabel(allFeatures, feature.id)
    : moduleName;

  const save = async () => {
    if (!title.trim() || !description.trim() || !moduleName.trim() || !mainRequirementId || !plannedVersionId || !ownerId || !keyRules.trim() || !acceptanceCriteria.trim()) {
      setMessage('请完整填写功能名称、功能说明、所属模块、主需求、内部版本号、负责人、关键规则和验收标准');
      return;
    }
    setSaving(true);
    setMessage('');
    const result = await updateFeature(feature.id, {
      title: title.trim(),
      description,
      moduleName: moduleName.trim(),
      featureType,
      mainRequirementId,
      plannedVersionId,
      officialReleaseId: officialReleaseId || null,
      ownerId,
      keyRules,
      acceptanceCriteria,
      remark,
      assigneeId: assigneeId || null,
      parentId,
      requirementIds: Array.from(new Set([mainRequirementId, ...selReqs])),
      formData,
    });
    setSaving(false);
    if (!result.success) {
      setMessage(result.error?.message ?? '保存功能失败');
      return;
    }
    onReload();
  };

  return (
    <DetailScaffold
      no={feature.featureNo}
      kindLabel="功能"
      kindColor="#A78BFA"
      title={title}
      onTitleChange={setTitle}
      titlePlaceholder="功能名称"
      dirty={dirty}
      saving={saving}
      onSave={save}
      headerActions={<TraceButton onClick={() => setShowTrace(true)} />}
      workflow={
        workflow ? (
          <WorkflowBar
            workflow={workflow}
            entityType="feature"
            entityId={feature.id}
            productId={feature.productId}
            currentState={feature.currentState}
            entitySnapshot={{ ownerId: ownerId || feature.ownerId, assigneeId, title, grade: feature.grade }}
            onChanged={onReload}
          />
        ) : undefined
      }
      main={
        <>
          <Card title="交付内容" action={<DescTemplatePicker entityType="feature" onApply={(c) => setDescription((p) => mergeDesc(p, c))} />}>
            <div className="flex flex-col gap-4">
              <div>
                <FieldLabel required>功能说明</FieldLabel>
                <p className="text-[11px] text-white/35 mt-1 mb-2">面向的业务场景与本次交付目标</p>
                <DescriptionField value={description} onChange={setDescription} />
              </div>
              <div>
                <FieldLabel required>关键规则</FieldLabel>
                <p className="text-[11px] text-white/35 mt-1 mb-2">核心业务规则、限制条件与边界（输入约束、权限、判空等）</p>
                <PlainTextArea value={keyRules} onChange={setKeyRules} placeholder="例：仅负责人可认领；单日上限 20 条；必填客户编号…" />
              </div>
              <div>
                <FieldLabel required>验收标准</FieldLabel>
                <p className="text-[11px] text-white/35 mt-1 mb-2">写清怎样算做完、测试和产品怎样验收（给定场景与条件，系统应出现什么结果）</p>
                <PlainTextArea value={acceptanceCriteria} onChange={setAcceptanceCriteria} placeholder="例：给定合法输入，系统返回预期结果；异常场景有明确提示…" />
              </div>
              <div>
                <FieldLabel>备注</FieldLabel>
                <PlainTextArea value={remark} onChange={setRemark} placeholder="补充特殊情况或例外说明，可不填" />
              </div>
            </div>
          </Card>
          {split.files.length > 0 && (
            <Card title="附件">
              <FormFieldsRenderer fields={split.files} values={formData} onChange={setField} productId={productId} />
            </Card>
          )}
          <Card title="动态">
            <ActivityTimeline entityType="feature" entityId={feature.id} />
          </Card>
          {message && <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">{message}</div>}
        </>
      }
      sidebar={
        <>
          <TapdPropertyPanel title="基础信息">
            <TapdPropertyRow label="功能 ID">
              <span className="text-xs font-mono text-violet-200/90 pt-2 block">{feature.featureNo}</span>
            </TapdPropertyRow>
            {feature.externalId && (
              <TapdPropertyRow label="外部 ID">
                <span className="text-xs text-white/60 pt-2 block">{feature.externalId}</span>
              </TapdPropertyRow>
            )}
            <TapdPropertyRow label="所属产品">
              <span className="text-xs text-white/75 pt-2 block">{productName}</span>
            </TapdPropertyRow>
            <TapdPropertyRow label="所属功能模块" required>
              <FeatureModuleSearchSelect value={moduleName} onChange={setModuleName} features={allFeatures} uiSize="md" />
            </TapdPropertyRow>
            {catalogPath && catalogPath !== moduleName && (
              <TapdPropertyRow label="目录路径">
                <span className="text-[11px] text-white/45 pt-2 block leading-relaxed">{catalogPath}</span>
              </TapdPropertyRow>
            )}
            <TapdPropertyRow label="功能类型" required>
              <select value={featureType} onChange={(event) => setFeatureType(event.target.value as FeatureBusinessType)} className="w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none">
                {FEATURE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </TapdPropertyRow>
            <TapdPropertyRow label="负责人" required>
              <UserSearchSelect value={ownerId} onChange={setOwnerId} uiSize="md" />
            </TapdPropertyRow>
            <TapdPropertyRow label="处理人">
              <UserSearchSelect value={assigneeId} onChange={setAssigneeId} uiSize="md" />
            </TapdPropertyRow>
            <TapdPropertyRow label="父功能">
              <ParentSelect
                value={parentId}
                onChange={setParentId}
                options={allFeatures.filter((f) => f.id !== feature.id).map((f) => ({ id: f.id, label: f.title }))}
                placeholder="无（顶层功能）"
              />
            </TapdPropertyRow>
            {parentFeature && (
              <TapdPropertyRow label="父功能路径">
                <span className="text-[11px] text-white/45 pt-2 block">{featurePathLabel(allFeatures, parentFeature.id)}</span>
              </TapdPropertyRow>
            )}
            {feature.currentState && (
              <TapdPropertyRow label="状态">
                <div className="flex items-center gap-2 flex-wrap pt-1">
                  <span className="text-xs px-2 py-1 rounded-md bg-white/8 text-white/70 border border-white/10">
                    {workflow?.states.find((s) => s.key === feature.currentState)?.label ?? feature.currentState}
                  </span>
                  {(() => {
                    const sla = slaInfo(feature.stateEnteredAt, workflow?.states.find((s) => s.key === feature.currentState)?.slaHours);
                    if (!sla) return null;
                    return (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${sla.overdue ? 'text-red-300 border-red-500/30 bg-red-500/10' : 'text-white/40 border-white/10'}`}>
                        停留 {sla.label}{sla.overdue ? ' · 超时' : ''}
                      </span>
                    );
                  })()}
                </div>
              </TapdPropertyRow>
            )}
          </TapdPropertyPanel>

          <TapdPropertyPanel title="版本信息">
            <p className="px-3 pb-2 text-[11px] text-white/35 leading-relaxed">立项时指定内部版本号，关联本产品的内部版本（T 号）；正式上线后回写 V 号。</p>
            <TapdPropertyRow label="内部版本号" required>
              <InternalVersionSelect value={plannedVersionId} onChange={setPlannedVersionId} versions={versions} />
            </TapdPropertyRow>
            {selectedInternalVersion && (
              <div className="px-3 pb-2">
                <FeatureInternalVersionLink
                  version={selectedInternalVersion}
                  onOpen={(id) => navigate(`/product-agent/p/${productId}/version/${id}`)}
                />
              </div>
            )}
            <TapdPropertyRow label="正式版本号">
              <select value={officialReleaseId} onChange={(event) => setOfficialReleaseId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none">
                <option value="">上线后回写 V 号</option>
                {releases.filter((release) => release.vCode).map((release) => <option key={release.id} value={release.id}>{release.vCode} · {release.planName}</option>)}
              </select>
            </TapdPropertyRow>
            {officialReleaseLabel?.vCode && (
              <TapdPropertyRow label="已回写">
                <span className="text-xs font-mono text-emerald-200/90 pt-2 block">{officialReleaseLabel.vCode}</span>
              </TapdPropertyRow>
            )}
            <TapdPropertyRow label="纳入版本">
              <Chips items={featureVersions.map((fv) => versionName.get(fv.versionId) ?? fv.versionId)} empty="尚未纳入任何版本" />
            </TapdPropertyRow>
          </TapdPropertyPanel>

          <TapdPropertyPanel title="需求关联">
            {requirements.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-white/30">该产品还没有需求，请先在需求池建立主需求来源。</div>
            ) : (
              <>
                <TapdPropertyRow label="主需求" required>
                  <ItemSearchSelect
                    value={mainRequirementId}
                    onChange={(id) => {
                      setMainRequirementId(id);
                      if (id) setSelReqs((prev) => new Set([...prev, id]));
                    }}
                    options={toRequirementOptions(requirements)}
                    placeholder="搜索需求标题或编号..."
                    clearOptionLabel="请选择主需求"
                    countUnit="条需求"
                    uiSize="md"
                  />
                </TapdPropertyRow>
                {mainRequirement && (
                  <div className="px-3 pb-2">
                    <FeatureRequirementLink requirement={mainRequirement} onOpen={(rid) => navigate(`/product-agent/p/${productId}/requirement/${rid}`)} />
                  </div>
                )}
                <TapdPropertyRow label="关联需求">
                  <ItemMultiSearchSelect
                    value={Array.from(selReqs).filter((id) => id !== mainRequirementId)}
                    onChange={(ids) => setSelReqs(new Set(mainRequirementId ? [mainRequirementId, ...ids] : ids))}
                    options={toRequirementOptions(requirements)}
                    placeholder="搜索并选择关联需求..."
                    countUnit="条需求"
                    lockedIds={mainRequirementId ? [mainRequirementId] : []}
                    emptyText="暂无其他需求可选"
                    uiSize="md"
                  />
                </TapdPropertyRow>
                {relatedRequirements.length > 0 && (
                  <div className="px-3 pb-3 flex flex-col gap-1.5">
                    {relatedRequirements.map((r) => (
                      <FeatureRequirementLink key={r.id} requirement={r} onOpen={(rid) => navigate(`/product-agent/p/${productId}/requirement/${rid}`)} />
                    ))}
                  </div>
                )}
              </>
            )}
          </TapdPropertyPanel>

          <TapdPropertyPanel
            title={`缺陷关联 · ${tracedDefects.length}`}
          >
            <div className="px-3 py-2 flex justify-end">
              <button type="button" onClick={() => setShowDefectLinker(true)} className="flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
                <Link2 size={12} /> 关联缺陷
              </button>
            </div>
            <div className="px-3 pb-3">
              <DefectList defects={tracedDefects} onClick={(did) => navigate(`/product-agent/p/${feature.productId}/defect/${did}`)} empty="还没有缺陷追溯到本功能" />
            </div>
          </TapdPropertyPanel>

          {split.others.length > 0 && (
            <TapdPropertyPanel title="扩展字段">
              {split.others.map((field) => (
                <TapdPropertyRow key={field.key} label={field.label || field.key} required={field.required}>
                  <FormFieldsRenderer fields={[field]} values={formData} onChange={setField} productId={productId} hideLabels />
                </TapdPropertyRow>
              ))}
            </TapdPropertyPanel>
          )}

          <TapdPropertyPanel title="系统信息">
            <TapdPropertyRow label="创建时间">
              <span className="text-xs text-white/55 pt-2 block">{fmtDate(feature.createdAt)}</span>
            </TapdPropertyRow>
            <TapdPropertyRow label="更新时间">
              <span className="text-xs text-white/55 pt-2 block">{fmtDate(feature.updatedAt)}</span>
            </TapdPropertyRow>
          </TapdPropertyPanel>
        </>
      }
    >
      {showDefectLinker && (
        <DefectLinkerModal productId={feature.productId} featureId={feature.id} onClose={() => setShowDefectLinker(false)} onLinked={reloadDefects} />
      )}
      {showTrace && (
        <TraceRelationDrawer productId={feature.productId} nodeId={`feature:${feature.id}`} title={feature.title} onClose={() => setShowTrace(false)} />
      )}
    </DetailScaffold>
  );
}

// ════════════════════════ 版本详情 ════════════════════════
function VersionDetail({
  productId,
  version,
  allVersions,
  requirements,
  features,
  onReload,
}: {
  productId: string;
  version?: ProductVersion;
  allVersions: ProductVersion[];
  requirements: Requirement[];
  features: Feature[];
  onReload: () => void;
}) {
  const [versionName, setVersionName] = useState('');
  const [description, setDescription] = useState('');
  const [lifecycle, setLifecycle] = useState<VersionLifecycle>('planning');
  const [isMajor, setIsMajor] = useState(false);
  const [parentVersionId, setParentVersionId] = useState('');
  const [selReqs, setSelReqs] = useState<Set<string>>(new Set());
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const [detailTab, setDetailTab] = useState<'basic' | 'requirements' | 'features'>('basic');
  const navigate = useNavigate();
  const { template } = useEffectiveTemplate('version', productId);
  const { workflow } = useEffectiveWorkflow('version', productId);
  const split = useMemo(() => splitFields(template?.fields), [template]);

  // 纳入功能：本地管理 featureVersions（即勾即存，走 create/deleteFeatureVersion）
  const [featureVersions, setFeatureVersions] = useState<FeatureVersion[]>([]);
  const reloadFv = useCallback(async () => {
    if (!version) return;
    const res = await listFeatureVersions(productId, { versionId: version.id });
    if (res.success) setFeatureVersions(res.data.items);
  }, [productId, version]);
  useEffect(() => { void reloadFv(); }, [reloadFv]);

  useEffect(() => {
    if (version) {
      setVersionName(version.versionName);
      setDescription(version.description ?? '');
      setLifecycle(version.lifecycle);
      setIsMajor(version.isMajor);
      setParentVersionId(version.parentVersionId ?? '');
      setSelReqs(new Set(version.requirementIds));
      setFormData(version.formData ?? {});
    }
  }, [version]);

  const reqSetEqual = (a: Set<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));
  const dirty = useMemo(() => {
    if (!version) return false;
    return (
      versionName !== version.versionName ||
      description !== (version.description ?? '') ||
      lifecycle !== version.lifecycle ||
      isMajor !== version.isMajor ||
      parentVersionId !== (version.parentVersionId ?? '') ||
      !reqSetEqual(selReqs, version.requirementIds) ||
      !recordEqual(formData, version.formData ?? {})
    );
  }, [version, versionName, description, lifecycle, isMajor, parentVersionId, selReqs, formData]);

  const { workflow: reqWorkflow } = useEffectiveWorkflow('requirement', productId);
  const { workflow: featWorkflow } = useEffectiveWorkflow('feature', productId);
  const [userNames, setUserNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const ids = Array.from(new Set([
      ...requirements.flatMap((r) => [r.ownerId, r.assigneeId].filter(Boolean) as string[]),
      ...features.flatMap((f) => [f.ownerId, f.assigneeId].filter(Boolean) as string[]),
    ]));
    if (ids.length === 0) return;
    let cancelled = false;
    void searchDirectoryUsers('', 200).then((res) => {
      if (cancelled || !res.success) return;
      setUserNames(new Map(res.data.items.map((u) => [u.userId, u.displayName])));
    });
    return () => { cancelled = true; };
  }, [requirements, features]);

  const linkedRequirements = useMemo(
    () => requirements.filter((r) => selReqs.has(r.id)),
    [requirements, selReqs],
  );
  const linkedFeatures = useMemo(
    () => features.filter((f) => featureVersions.some((fv) => fv.featureId === f.id)),
    [features, featureVersions],
  );

  const versionAttributeRows = useMemo(() => {
    if (!version) return [];
    const rows: { label: string; value: React.ReactNode }[] = [
      {
        label: '生命周期',
        value: (
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(VERSION_LIFECYCLE_LABEL) as VersionLifecycle[]).map((lc) => (
              <button
                key={lc}
                type="button"
                onClick={() => setLifecycle(lc)}
                className={`px-2 py-1 rounded-md text-xs border ${lifecycle === lc ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/40 border-white/10 hover:bg-white/5'}`}
              >
                {VERSION_LIFECYCLE_LABEL[lc]}
              </button>
            ))}
          </div>
        ),
      },
      {
        label: '大版本',
        value: (
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isMajor} onChange={(e) => setIsMajor(e.target.checked)} className="accent-cyan-500" />
            <span className="text-sm text-white/70">{isMajor ? '是' : '否'}</span>
          </label>
        ),
      },
      {
        label: '父版本',
        value: (
          <ParentSelect
            value={parentVersionId}
            onChange={setParentVersionId}
            options={allVersions.filter((v) => v.id !== version.id).map((v) => ({ id: v.id, label: v.versionName }))}
            placeholder="无（顶层版本）"
          />
        ),
      },
    ];
    if (version.currentState) {
      rows.push({
        label: '工作流状态',
        value: (
          <span className="text-xs px-2 py-1 rounded-md bg-white/8 text-white/70 border border-white/10 inline-block">
            {workflow?.states.find((s) => s.key === version.currentState)?.label ?? version.currentState}
          </span>
        ),
      });
    }
    rows.push(
      { label: '计划发布', value: fmtDate(version.plannedReleaseAt) || '—' },
      { label: '创建时间', value: fmtDate(version.createdAt) },
      { label: '更新时间', value: fmtDate(version.updatedAt) },
    );
    return rows;
  }, [allVersions, isMajor, lifecycle, parentVersionId, version, workflow]);

  if (!version) return <NotFound />;
  const setField = (k: string, v: string) => setFormData((d) => ({ ...d, [k]: v }));
  const nameOf = (id?: string | null) => (id ? userNames.get(id) ?? id : '—');
  const attributeRowsWithCustom = [
    ...versionAttributeRows,
    ...split.others.map((field) => ({
      label: field.label || field.key,
      value: (
        <FormFieldsRenderer
          fields={[field]}
          values={formData}
          onChange={setField}
          productId={productId}
          hideLabels
        />
      ),
    })),
  ];

  const save = async () => {
    setSaving(true);
    await updateVersion(version.id, {
      versionName: versionName.trim(),
      description,
      lifecycle,
      isMajor,
      parentVersionId,
      requirementIds: Array.from(selReqs),
      formData,
    });
    setSaving(false);
    onReload();
  };

  const toggleReq = (rid: string) => {
    setSelReqs((prev) => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid);
      else next.add(rid);
      return next;
    });
  };
  const featureIncluded = (featureId: string) => featureVersions.find((fv) => fv.featureId === featureId);
  const toggleFeature = async (featureId: string) => {
    const existing = featureIncluded(featureId);
    if (existing) await deleteFeatureVersion(existing.id);
    else await createFeatureVersion(productId, { featureId, versionId: version.id });
    await reloadFv();
  };

  const linkedReqCount = selReqs.size;
  const linkedFeatCount = featureVersions.length;

  return (
    <>
      <div className="mb-4 flex border-b border-white/10">
        <VersionDetailTab active={detailTab === 'basic'} onClick={() => setDetailTab('basic')}>基础信息</VersionDetailTab>
        <VersionDetailTab active={detailTab === 'requirements'} onClick={() => setDetailTab('requirements')}>
          需求
          {linkedReqCount > 0 && <span className="ml-1.5 rounded-full bg-cyan-400/20 px-1.5 text-[10px] text-cyan-200">{linkedReqCount}</span>}
        </VersionDetailTab>
        <VersionDetailTab active={detailTab === 'features'} onClick={() => setDetailTab('features')}>
          功能
          {linkedFeatCount > 0 && <span className="ml-1.5 rounded-full bg-violet-400/20 px-1.5 text-[10px] text-violet-200">{linkedFeatCount}</span>}
        </VersionDetailTab>
      </div>
      <DetailScaffold
      layout="stack"
      no={VERSION_LIFECYCLE_LABEL[version.lifecycle]}
      kindLabel="版本"
      kindColor="#34D399"
      title={versionName}
      onTitleChange={setVersionName}
      titlePlaceholder="版本名，如 v2.0"
      dirty={dirty}
      saving={saving}
      onSave={save}
      headerActions={<TraceButton onClick={() => setShowTrace(true)} />}
      workflow={
        workflow ? (
          <WorkflowBar
            workflow={workflow}
            entityType="version"
            entityId={version.id}
            productId={productId}
            currentState={version.currentState}
            onChanged={onReload}
          />
        ) : undefined
      }
      main={
        detailTab === 'basic' ? (
          <>
            <Card title="版本属性">
              <AttributeFieldTable rows={attributeRowsWithCustom} />
            </Card>
            <Card title="版本描述" action={<DescTemplatePicker entityType="version" onApply={(c) => setDescription((p) => mergeDesc(p, c))} />}>
              <DescriptionField value={description} onChange={setDescription} />
            </Card>
            {split.files.length > 0 && (
              <Card title="附件">
                <FormFieldsRenderer fields={split.files} values={formData} onChange={setField} productId={productId} />
              </Card>
            )}
            <Card title="本版本知识">
              <VersionKnowledgeCard productId={productId} versionId={version.id} />
            </Card>
          </>
        ) : detailTab === 'requirements' ? (
          <Card title={`关联需求 · 已纳入 ${linkedRequirements.length} / ${requirements.length}`} action={
            <span className="text-[11px] text-white/35">勾选纳入后点顶部保存</span>
          }>
            <DetailRecordTable
              emptyText="该产品还没有需求"
              rows={requirements}
              onRowClick={(id) => navigate(`/product-agent/p/${productId}/requirement/${id}`)}
              columns={[
                {
                  header: '纳入',
                  width: '56px',
                  className: 'text-center',
                  render: (row) => (
                    <input
                      type="checkbox"
                      checked={selReqs.has(row.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleReq(row.id)}
                      className="accent-cyan-500"
                    />
                  ),
                },
                { header: 'ID', width: '10%', render: (row) => <span className="font-mono text-cyan-200/80">{(row as Requirement).requirementNo}</span> },
                { header: '标题', width: '22%', render: (row) => <span className="text-white/85 truncate block" title={(row as Requirement).title}>{(row as Requirement).title}</span> },
                { header: '分级', width: '7%', render: (row) => ITEM_GRADE_LABEL[(row as Requirement).grade] },
                { header: '状态', width: '10%', render: (row) => resolveRequirementStateLabel((row as Requirement).currentState ?? '', reqWorkflow) || '—' },
                { header: '处理人', width: '10%', render: (row) => nameOf((row as Requirement).assigneeId) },
                { header: '负责人', width: '10%', render: (row) => nameOf((row as Requirement).ownerId) },
                { header: '更新时间', width: '12%', render: (row) => fmtDate((row as Requirement).updatedAt) },
                {
                  header: '操作',
                  width: '64px',
                  className: 'text-center',
                  render: (row) => (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); navigate(`/product-agent/p/${productId}/requirement/${row.id}`); }}
                      className="text-[11px] text-cyan-300 hover:underline"
                    >
                      详情
                    </button>
                  ),
                },
              ]}
            />
          </Card>
        ) : (
          <Card title={`纳入功能 · 已纳入 ${linkedFeatures.length} / ${features.length}`} action={
            <span className="text-[11px] text-white/35">勾选即写入，无需点保存</span>
          }>
            <DetailRecordTable
              emptyText="该产品还没有功能"
              rows={features}
              onRowClick={(id) => navigate(`/product-agent/p/${productId}/feature/${id}`)}
              columns={[
                {
                  header: '纳入',
                  width: '56px',
                  className: 'text-center',
                  render: (row) => (
                    <input
                      type="checkbox"
                      checked={!!featureIncluded(row.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => void toggleFeature(row.id)}
                      className="accent-cyan-500"
                    />
                  ),
                },
                { header: '功能编号', width: '10%', render: (row) => <span className="font-mono text-violet-200/80">{(row as Feature).featureNo}</span> },
                { header: '标题', width: '18%', render: (row) => <span className="text-white/85 truncate block" title={(row as Feature).title}>{(row as Feature).title}</span> },
                { header: '所属模块', width: '14%', render: (row) => (row as Feature).moduleName || '—' },
                { header: '功能类型', width: '9%', render: (row) => FEATURE_TYPE_LABEL[(row as Feature).featureType] ?? (row as Feature).featureType },
                { header: '状态', width: '10%', render: (row) => featWorkflow?.states.find((s) => s.key === (row as Feature).currentState)?.label ?? (row as Feature).currentState ?? '—' },
                { header: '处理人', width: '9%', render: (row) => nameOf((row as Feature).assigneeId) },
                { header: '负责人', width: '9%', render: (row) => nameOf((row as Feature).ownerId) },
                { header: '更新时间', width: '11%', render: (row) => fmtDate((row as Feature).updatedAt) },
                {
                  header: '操作',
                  width: '64px',
                  className: 'text-center',
                  render: (row) => (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); navigate(`/product-agent/p/${productId}/feature/${row.id}`); }}
                      className="text-[11px] text-cyan-300 hover:underline"
                    >
                      详情
                    </button>
                  ),
                },
              ]}
            />
          </Card>
        )
      }
    >
      {showTrace && (
        <TraceRelationDrawer productId={productId} nodeId={`version:${version.id}`} title={version.versionName} onClose={() => setShowTrace(false)} />
      )}
    </DetailScaffold>
    </>
  );
}

function VersionDetailTab({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 px-4 py-2.5 text-sm ${active ? 'border-cyan-400 text-cyan-200' : 'border-transparent text-white/40 hover:text-white/60'}`}
    >
      {children}
    </button>
  );
}
