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
import { ArrowLeft, Save, ListChecks, Puzzle, Bug, Link2, FileText, GitBranch, Share2, X, Sparkles, ExternalLink, MessageSquareText } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { useAuthStore } from '@/stores/authStore';
import { useSseStream } from '@/lib/useSseStream';
import { RequirementRelationModal, DefectLinkerModal } from './ProductRelationModals';
import { RequirementCreateForm } from './RequirementCreateForm';
import { REQUIREMENT_TYPE_FORM_KEY } from './requirementTypeCatalog';
import {
  NON_PRODUCT_DEFECT_CLASSIFICATION,
  normalizeDefectClassification,
  PRODUCT_DEFECT_CLASSIFICATION,
  REQUIREMENT_PRODUCT_DEFECT_FORM_KEY,
  REQUIREMENT_PRODUCT_DEFECT_VALUE,
} from './productDefectLinkageCatalog';
import { RequirementTypeSelect } from './RequirementTypeSelect';
import { VersionKnowledgeCard } from './knowledge/VersionKnowledgeCard';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import { FormFieldsRenderer, RichTextField, useEffectiveTemplate, useEffectiveWorkflow } from './DynamicForm';
import { WorkflowBar } from './WorkflowBar';
import { ActivityTimeline } from './ActivityTimeline';
import './product-cards.css';
import {
  listRequirements,
  createRequirement,
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
  convertDefectToRequirement,
  createProductDefect,
  updateProductDefect,
  listDescTemplates,
  type TracedDefect,
} from '@/services/real/productAgent';
import type { Requirement, Feature, ProductVersion, ProductRelease, Customer, FeatureVersion, FeatureBusinessType, ItemGrade, FormField, ProductEntityType, DescTemplate, VersionLifecycle } from './types';
import { ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL, effectiveDefectGrade } from './types';

const ITEM_GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];
const FEATURE_TYPES: { value: FeatureBusinessType; label: string }[] = [
  { value: 'basic', label: '基础功能' },
  { value: 'core', label: '核心功能' },
  { value: 'value_added', label: '增值功能' },
];

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

  const reload = useCallback(async () => {
    setLoading(true);
    const [r, f, v, release, c, d] = await Promise.all([
      listRequirements(productId),
      listFeatures(productId),
      listVersions(productId),
      listReleases(productId, 'all'),
      listCustomers(),
      listTracedDefects(productId),
    ]);
    if (r.success) setRequirements(r.data.items);
    if (f.success) setFeatures(f.data.items);
    if (v.success) setVersions(v.data.items);
    if (release.success) setReleases(release.data.items);
    if (c.success) setCustomers(c.data.items);
    if (d.success) setTracedDefects(d.data.items);
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
        <div className={`${isNew && kind === 'requirement' ? 'w-full px-5 xl:px-8 py-5' : 'mx-auto py-5'}`} style={isNew && kind === 'requirement' ? undefined : { width: '80%' }}>
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
              <CreateObjectForm
                productId={productId}
                kind={kind}
                requirements={requirements}
                versions={versions}
                releases={releases}
                onCreated={(newId) => navigate(`/product-agent/p/${productId}/${kind}/${newId}`, { replace: true })}
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
            <DefectDetail
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

/** 详情骨架：头部(编号/大标题/状态流转/统一保存) + 左主栏 + 右属性栏。 */
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
  sidebar: React.ReactNode;
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

      {/* 主体双栏：左 70% / 右 30% */}
      <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-4 items-start">
        <div className="flex flex-col gap-4 min-w-0">{main}</div>
        <div className="flex flex-col gap-4 min-w-0">{sidebar}</div>
      </div>
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

function NotFound() {
  return <div className="text-white/40 text-sm text-center py-10">对象不存在或已删除</div>;
}

// ════════════════════════ AI 智能填充（输入文本 → 按模板回填）════════════════════════
interface AiFillResult { title?: string; description?: string; grade?: string; formData?: Record<string, string> }

function AiFillCard({ productId, templateId, onFill }: { productId: string; templateId?: string; onFill: (r: AiFillResult) => void }) {
  const [text, setText] = useState('');
  const { phase, phaseMessage, typing, isStreaming, start, abort } = useSseStream<AiFillResult>({
    url: `/api/product/products/${productId}/requirements/ai-fill/stream`,
    method: 'POST',
    itemEvent: 'result',
    onItem: (r) => onFill(r),
  });
  const run = () => { if (text.trim()) void start({ body: { text: text.trim(), templateId } }); };

  return (
    <Card title="AI 智能填充">
      <div className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="粘贴一段需求原始描述（背景、痛点、期望…），AI 自动拆解为标题 / 描述 / 分级 / 模板字段，回填后你再修改确认。"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40 resize-none placeholder:text-white/25"
          style={{ overscrollBehavior: 'contain' }}
        />
        <div className="flex items-center gap-2">
          {isStreaming ? (
            <button onClick={abort} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 text-white/70 hover:bg-white/5 text-sm">
              <MapSpinner size={14} /> 停止
            </button>
          ) : (
            <button onClick={run} disabled={!text.trim()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm hover:bg-cyan-500/30 disabled:opacity-40">
              <Sparkles size={14} /> 智能填充
            </button>
          )}
          {phase !== 'idle' && <span className={`text-[11px] ${phase === 'error' ? 'text-red-300/80' : 'text-white/45'}`}>{phaseMessage}</span>}
        </div>
        {isStreaming && typing && (
          <div className="text-[11px] text-white/40 font-mono max-h-24 overflow-y-auto bg-white/[0.03] border border-white/5 rounded p-2 whitespace-pre-wrap" style={{ overscrollBehavior: 'contain' }}>
            {typing}
          </div>
        )}
      </div>
    </Card>
  );
}

// ════════════════════════ 新建对象（需求 / 功能）════════════════════════
function CreateObjectForm({
  productId,
  kind,
  requirements,
  versions,
  releases,
  onCreated,
}: {
  productId: string;
  kind: string;
  requirements: Requirement[];
  versions: ProductVersion[];
  releases: ProductRelease[];
  onCreated: (newId: string) => void;
}) {
  const currentUserId = useAuthStore((state) => state.user?.userId ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [assigneeId, setAssigneeId] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [featureType, setFeatureType] = useState<FeatureBusinessType>('basic');
  const [mainRequirementId, setMainRequirementId] = useState('');
  const [requirementIds, setRequirementIds] = useState<Set<string>>(new Set());
  const [plannedVersionId, setPlannedVersionId] = useState('');
  const [officialReleaseId, setOfficialReleaseId] = useState('');
  const [ownerId, setOwnerId] = useState(currentUserId);
  const [keyRules, setKeyRules] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [remark, setRemark] = useState('');
  const [requirementType, setRequirementType] = useState('');
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const entityType = kind === 'feature' ? 'feature' : 'requirement';
  const { template } = useEffectiveTemplate(entityType, productId);
  const { workflow } = useEffectiveWorkflow(entityType, productId);
  const split = useMemo(() => splitFields(template?.fields), [template]);

  // 新建时默认套用「默认描述模板」，无需用户再点「套用模板」；用户已输入则不覆盖
  const defaultDescContent = useDefaultDescTemplateContent(entityType);
  const descAutoFilledRef = useRef(false);
  useEffect(() => {
    if (descAutoFilledRef.current || !defaultDescContent) return;
    if (description.trim() === '') {
      descAutoFilledRef.current = true;
      setDescription(defaultDescContent);
    }
  }, [defaultDescContent, description]);
  const kindLabel = kind === 'feature' ? '功能' : '需求';
  const kindColor = kind === 'feature' ? '#A78BFA' : '#FBBF24';
  const isFeature = kind === 'feature';
  const inputCls = 'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-500/40';
  const selectCls = 'w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40';

  useEffect(() => {
    if (currentUserId && !ownerId) setOwnerId(currentUserId);
  }, [currentUserId, ownerId]);

  const requirementFormData = useMemo(() => {
    if (isFeature) return formData;
    return {
      ...formData,
      ...(requirementType ? { [REQUIREMENT_TYPE_FORM_KEY]: requirementType } : {}),
    };
  }, [formData, requirementType, isFeature]);

  if (kind !== 'requirement' && kind !== 'feature') {
    return <div className="text-white/40 text-sm text-center py-10">该类型不支持在此新建</div>;
  }

  const setField = (k: string, v: string) => setFormData((d) => ({ ...d, [k]: v }));

  // AI 智能填充回填：标题/描述/分级/自定义字段
  const onAiFill = (r: AiFillResult) => {
    if (r.title) setTitle(r.title);
    if (r.description) { descAutoFilledRef.current = true; setDescription(r.description); }
    if (r.grade && ITEM_GRADES.includes(r.grade as ItemGrade)) setGrade(r.grade as ItemGrade);
    if (r.formData) {
      const typeVal = r.formData[REQUIREMENT_TYPE_FORM_KEY];
      if (typeVal) setRequirementType(typeVal);
      setFormData((prev) => ({ ...prev, ...r.formData }));
    }
  };

  const create = async () => {
    if (!title.trim()) return setMessage(`${kindLabel}名称不能为空`);
    if (isFeature && (!description.trim() || !moduleName.trim() || !mainRequirementId || !plannedVersionId || !ownerId || !keyRules.trim() || !acceptanceCriteria.trim())) {
      return setMessage('请完整填写功能说明、所属模块、主需求、计划版本、负责人、关键规则和验收标准');
    }
    setSaving(true);
    setMessage('');
    const payload = isFeature
      ? {
          title: title.trim(),
          description,
          moduleName: moduleName.trim(),
          featureType,
          mainRequirementId,
          requirementIds: Array.from(new Set([mainRequirementId, ...requirementIds])),
          plannedVersionId,
          officialReleaseId: officialReleaseId || null,
          ownerId,
          keyRules,
          acceptanceCriteria,
          remark,
          grade,
          assigneeId: assigneeId || null,
          formData,
          templateId: template?.id,
          workflowDefId: workflow?.id,
        }
      : { title: title.trim(), description, grade, assigneeId: assigneeId || null, formData: requirementFormData, templateId: template?.id, workflowDefId: workflow?.id };
    const res = kind === 'requirement' ? await createRequirement(productId, payload) : await createFeature(productId, payload);
    setSaving(false);
    if (res.success && res.data) onCreated(res.data.id);
    else setMessage(res.error?.message ?? `创建${kindLabel}失败`);
  };

  return (
    <DetailScaffold
      no={`新建${kindLabel}`}
      kindLabel={kindLabel}
      kindColor={kindColor}
      title={title}
      onTitleChange={setTitle}
      titlePlaceholder={kind === 'requirement' ? '需求标题' : '功能名称'}
      dirty
      saving={saving}
      onSave={create}
      main={
        <>
          {entityType === 'requirement' && (
            <AiFillCard productId={productId} templateId={template?.id} onFill={onAiFill} />
          )}
          <Card title={isFeature ? '功能说明' : '描述'} action={<DescTemplatePicker entityType={entityType} onApply={(c) => setDescription((p) => mergeDesc(p, c))} />}>
            <DescriptionField value={description} onChange={setDescription} />
          </Card>
          {isFeature && (
            <>
              <Card title="关键规则">
                <PlainTextArea value={keyRules} onChange={setKeyRules} placeholder="填写核心业务规则、限制条件和边界" />
              </Card>
              <Card title="验收标准">
                <PlainTextArea value={acceptanceCriteria} onChange={setAcceptanceCriteria} placeholder="填写可判断功能成立和交付完成的验收标准" />
              </Card>
              <Card title="备注">
                <PlainTextArea value={remark} onChange={setRemark} placeholder="补充特殊情况或例外说明，可不填" />
              </Card>
            </>
          )}
          {split.files.length > 0 && (
            <Card title="附件">
              <FormFieldsRenderer fields={split.files} values={formData} onChange={setField} productId={productId} />
            </Card>
          )}
          {message && <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">{message}</div>}
          <p className="text-[11px] text-white/35 px-1">创建后进入详情页，可继续维护关联关系与流转状态。</p>
        </>
      }
      sidebar={
        <Card title="属性">
          <div className="flex flex-col gap-3.5">
            {isFeature && (
              <>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel required>所属功能模块</FieldLabel>
                  <input value={moduleName} onChange={(event) => setModuleName(event.target.value)} placeholder="如：营销活动 / 权限中心" className={inputCls} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel required>功能类型</FieldLabel>
                  <select value={featureType} onChange={(event) => setFeatureType(event.target.value as FeatureBusinessType)} className={selectCls}>
                    {FEATURE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel required>主需求</FieldLabel>
                  <select value={mainRequirementId} onChange={(event) => {
                    const value = event.target.value;
                    setMainRequirementId(value);
                    if (value) setRequirementIds((prev) => new Set([...prev, value]));
                  }} className={selectCls}>
                    <option value="">请选择主需求</option>
                    {requirements.map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.requirementNo} · {requirement.title}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>关联需求</FieldLabel>
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.02] p-2" style={{ overscrollBehavior: 'contain' }}>
                    {requirements.map((requirement) => (
                      <label key={requirement.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-white/5">
                        <input
                          type="checkbox"
                          checked={requirementIds.has(requirement.id) || mainRequirementId === requirement.id}
                          disabled={mainRequirementId === requirement.id}
                          onChange={() => setRequirementIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(requirement.id)) next.delete(requirement.id); else next.add(requirement.id);
                            return next;
                          })}
                          className="mt-0.5 accent-cyan-500"
                        />
                        <span className="min-w-0 text-xs text-white/65">{requirement.title}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel required>计划版本</FieldLabel>
                  <select value={plannedVersionId} onChange={(event) => setPlannedVersionId(event.target.value)} className={selectCls}>
                    <option value="">请选择内部版本</option>
                    {versions.map((version) => <option key={version.id} value={version.id}>{version.versionName}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>正式上线版本号</FieldLabel>
                  <select value={officialReleaseId} onChange={(event) => setOfficialReleaseId(event.target.value)} className={selectCls}>
                    <option value="">上线后回写</option>
                    {releases.filter((release) => release.vCode).map((release) => <option key={release.id} value={release.id}>{release.vCode} · {release.planName}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel required>负责人</FieldLabel>
                  <UserSearchSelect value={ownerId} onChange={setOwnerId} />
                </div>
              </>
            )}
            {!isFeature && (
              <div className="flex flex-col gap-1.5">
                <FieldLabel>需求类型</FieldLabel>
                <RequirementTypeSelect value={requirementType} onChange={setRequirementType} />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <FieldLabel required>分级</FieldLabel>
              <GradeField grade={grade} setGrade={setGrade} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>处理人</FieldLabel>
              <UserSearchSelect value={assigneeId} onChange={setAssigneeId} />
            </div>
            {split.others.length > 0 && (
              <div className="pt-1 border-t border-white/5">
                <FormFieldsRenderer fields={split.others} values={formData} onChange={setField} productId={productId} />
              </div>
            )}
          </div>
        </Card>
      }
    />
  );
}

// ════════════════════════ 新建缺陷（独立页，对齐新建需求）════════════════════════
const DEFECT_STATUSES: { v: string; label: string }[] = [
  { v: 'draft', label: '草稿' },
  { v: 'reviewing', label: '评审中' },
  { v: 'awaiting', label: '待处理' },
  { v: 'submitted', label: '已提交' },
  { v: 'assigned', label: '已分配' },
  { v: 'processing', label: '处理中' },
  { v: 'verifying', label: '待验收' },
  { v: 'resolved', label: '已解决' },
  { v: 'rejected', label: '已拒绝' },
  { v: 'closed', label: '已关闭' },
];
const DEFECT_STATUS_LABEL: Record<string, string> = Object.fromEntries(DEFECT_STATUSES.map((s) => [s.v, s.label]));

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
      no={`${requirement.requirementNo}${requirement.externalId ? ` · ${requirement.externalId}` : ''}`}
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
                        {comment.content && <div className="mt-2 text-sm text-white/65 whitespace-pre-wrap leading-6">{comment.content}</div>}
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
      {requirement.externalId && (
        <InfoRow label="需求 ID" value={requirement.externalId} />
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

// ════════════════════════ 功能详情 ════════════════════════
function FeatureDetail({
  feature,
  requirements,
  allFeatures,
  featureVersions,
  versionName,
  versions,
  releases,
  onReload,
}: {
  feature?: Feature;
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
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [assigneeId, setAssigneeId] = useState('');
  const [parentId, setParentId] = useState('');
  const [selReqs, setSelReqs] = useState<Set<string>>(new Set());
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const { template } = useEffectiveTemplate('feature', feature?.productId ?? null);
  const { workflow: versionWorkflow } = useEffectiveWorkflow('version', feature?.productId ?? null);
  const split = useMemo(() => splitFields(template?.fields), [template]);
  const linkedVersion = useMemo(() => {
    const vid = plannedVersionId || featureVersions[0]?.versionId || feature?.plannedVersionId;
    return vid ? versions.find((v) => v.id === vid) : undefined;
  }, [plannedVersionId, featureVersions, feature?.plannedVersionId, versions]);

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
      setGrade(feature.grade);
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
      grade !== feature.grade ||
      assigneeId !== (feature.assigneeId ?? '') ||
      parentId !== (feature.parentId ?? '') ||
      !reqSetEqual(selReqs, feature.requirementIds) ||
      !recordEqual(formData, feature.formData ?? {})
    );
  }, [feature, title, description, moduleName, featureType, mainRequirementId, plannedVersionId, officialReleaseId, ownerId, keyRules, acceptanceCriteria, remark, grade, assigneeId, parentId, selReqs, formData]);

  if (!feature) return <NotFound />;
  const productId = feature.productId;
  const setField = (k: string, v: string) => setFormData((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (!title.trim() || !description.trim() || !moduleName.trim() || !mainRequirementId || !plannedVersionId || !ownerId || !keyRules.trim() || !acceptanceCriteria.trim()) {
      setMessage('请完整填写功能名称、功能说明、所属模块、主需求、计划版本、负责人、关键规则和验收标准');
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
      grade,
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

  const toggle = (id: string) => {
    if (id === mainRequirementId) return;
    setSelReqs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      workflow={undefined}
      main={
        <>
          <Card title="功能说明" action={<DescTemplatePicker entityType="feature" onApply={(c) => setDescription((p) => mergeDesc(p, c))} />}>
            <DescriptionField value={description} onChange={setDescription} />
          </Card>
          <Card title="关键规则">
            <PlainTextArea value={keyRules} onChange={setKeyRules} placeholder="填写核心业务规则、限制条件和边界" />
          </Card>
          <Card title="验收标准">
            <PlainTextArea value={acceptanceCriteria} onChange={setAcceptanceCriteria} placeholder="填写可判断功能成立和交付完成的验收标准" />
          </Card>
          <Card title="备注">
            <PlainTextArea value={remark} onChange={setRemark} placeholder="补充特殊情况或例外说明，可不填" />
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
          <Card title="属性">
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <FieldLabel required>所属功能模块</FieldLabel>
                <input
                  value={moduleName}
                  onChange={(event) => setModuleName(event.target.value)}
                  placeholder="如：营销活动 / 权限中心"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-500/40"
                />
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
                <FieldLabel required>分级</FieldLabel>
                <GradeField grade={grade} setGrade={setGrade} />
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
                  options={allFeatures.filter((f) => f.id !== feature.id).map((f) => ({ id: f.id, label: f.title }))}
                  placeholder="无（顶层功能）"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel required>计划版本</FieldLabel>
                <select value={plannedVersionId} onChange={(event) => setPlannedVersionId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none">
                  <option value="">请选择内部版本</option>
                  {versions.map((version) => <option key={version.id} value={version.id}>{version.versionName}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>正式上线版本号</FieldLabel>
                <select value={officialReleaseId} onChange={(event) => setOfficialReleaseId(event.target.value)} className="w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none">
                  <option value="">上线后回写</option>
                  {releases.filter((release) => release.vCode).map((release) => <option key={release.id} value={release.id}>{release.vCode} · {release.planName}</option>)}
                </select>
              </div>
              {linkedVersion?.currentState && (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>状态（跟随计划版本）</FieldLabel>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs px-2 py-1 rounded-md bg-white/8 text-white/70 border border-white/10 w-fit">
                      {versionWorkflow?.states.find((s) => s.key === linkedVersion.currentState)?.label ?? linkedVersion.currentState}
                    </span>
                    <span className="text-[11px] text-white/40">计划版本：{linkedVersion.versionName}</span>
                  </div>
                </div>
              )}
              {split.others.length > 0 && (
                <div className="pt-1 border-t border-white/5">
                  <FormFieldsRenderer fields={split.others} values={formData} onChange={setField} productId={productId} />
                </div>
              )}
            </div>
          </Card>
          <Card title="主需求与关联需求">
            {requirements.length === 0 ? (
              <div className="text-[11px] text-white/30">该产品还没有需求</div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel required>主需求</FieldLabel>
                  <select
                    value={mainRequirementId}
                    onChange={(event) => {
                      const value = event.target.value;
                      setMainRequirementId(value);
                      if (value) setSelReqs((prev) => new Set([...prev, value]));
                    }}
                    className="w-full rounded-lg border border-white/10 bg-[#15171c] px-3 py-2 text-sm text-white outline-none"
                  >
                    <option value="">请选择主需求</option>
                    {requirements.map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.requirementNo} · {requirement.title}</option>)}
                  </select>
                </div>
                <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                  {requirements.map((requirement) => (
                    <label key={requirement.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-white/5">
                      <input
                        type="checkbox"
                        checked={selReqs.has(requirement.id) || mainRequirementId === requirement.id}
                        disabled={mainRequirementId === requirement.id}
                        onChange={() => toggle(requirement.id)}
                        className="accent-cyan-500"
                      />
                      <span className="truncate text-sm text-white/80">{requirement.title}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </Card>
          <Card title="纳入的版本">
            <Chips items={featureVersions.map((fv) => versionName.get(fv.versionId) ?? fv.versionId)} empty="尚未纳入任何版本" />
          </Card>
          <Card
            title={`追溯缺陷 · ${tracedDefects.length}`}
            action={
              <button onClick={() => setShowDefectLinker(true)} className="flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
                <Link2 size={12} /> 关联缺陷
              </button>
            }
          >
            <DefectList defects={tracedDefects} onClick={(did) => navigate(`/product-agent/p/${feature.productId}/defect/${did}`)} empty="还没有缺陷追溯到本功能" />
          </Card>
          <Card title="信息">
            <div className="flex flex-col gap-2">
              <InfoRow label="创建时间" value={fmtDate(feature.createdAt)} />
              <InfoRow label="更新时间" value={fmtDate(feature.updatedAt)} />
            </div>
          </Card>
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

  if (!version) return <NotFound />;
  const setField = (k: string, v: string) => setFormData((d) => ({ ...d, [k]: v }));

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

  return (
    <DetailScaffold
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
        <>
          <Card title="版本描述" action={<DescTemplatePicker entityType="version" onApply={(c) => setDescription((p) => mergeDesc(p, c))} />}>
            <DescriptionField value={description} onChange={setDescription} />
          </Card>
          {split.files.length > 0 && (
            <Card title="附件">
              <FormFieldsRenderer fields={split.files} values={formData} onChange={setField} productId={productId} />
            </Card>
          )}
          <Card title="动态">
            <ActivityTimeline entityType="version" entityId={version.id} />
          </Card>
        </>
      }
      sidebar={
        <>
          <Card title="属性">
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <FieldLabel>生命周期</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(VERSION_LIFECYCLE_LABEL) as VersionLifecycle[]).map((lc) => (
                    <button
                      key={lc}
                      onClick={() => setLifecycle(lc)}
                      className={`px-2 py-1 rounded-md text-xs border ${lifecycle === lc ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/40 border-white/10 hover:bg-white/5'}`}
                    >
                      {VERSION_LIFECYCLE_LABEL[lc]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={isMajor} onChange={(e) => setIsMajor(e.target.checked)} className="accent-cyan-500" />
                <span className="text-sm text-white/70">标记为大版本</span>
              </label>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>父版本</FieldLabel>
                <ParentSelect
                  value={parentVersionId}
                  onChange={setParentVersionId}
                  options={allVersions.filter((v) => v.id !== version.id).map((v) => ({ id: v.id, label: v.versionName }))}
                  placeholder="无（顶层版本）"
                />
              </div>
              {version.currentState && (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>状态</FieldLabel>
                  <span className="text-xs px-2 py-1 rounded-md bg-white/8 text-white/70 border border-white/10 self-start">
                    {workflow?.states.find((s) => s.key === version.currentState)?.label ?? version.currentState}
                  </span>
                </div>
              )}
              {split.others.length > 0 && (
                <div className="pt-1 border-t border-white/5">
                  <FormFieldsRenderer fields={split.others} values={formData} onChange={setField} productId={productId} />
                </div>
              )}
            </div>
          </Card>
          <Card title="本版本知识（从产品知识库调取）">
            <VersionKnowledgeCard productId={productId} versionId={version.id} />
          </Card>
          <Card title="关联需求（本版本要做哪些需求）">
            {requirements.length === 0 ? (
              <div className="text-[11px] text-white/30">该产品还没有需求</div>
            ) : (
              <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                {requirements.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 cursor-pointer">
                    <input type="checkbox" checked={selReqs.has(r.id)} onChange={() => toggleReq(r.id)} className="accent-cyan-500" />
                    <span className="text-sm text-white/80 truncate">{r.title}</span>
                  </label>
                ))}
              </div>
            )}
          </Card>
          <Card title="纳入功能（功能版本化，即勾即存）">
            {features.length === 0 ? (
              <div className="text-[11px] text-white/30">该产品还没有功能</div>
            ) : (
              <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                {features.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 cursor-pointer">
                    <input type="checkbox" checked={!!featureIncluded(f.id)} onChange={() => void toggleFeature(f.id)} className="accent-cyan-500" />
                    <span className="text-sm text-white/80 truncate">{f.title}</span>
                  </label>
                ))}
              </div>
            )}
          </Card>
          <Card title="信息">
            <div className="flex flex-col gap-2">
              <InfoRow label="计划发布" value={fmtDate(version.plannedReleaseAt)} />
              <InfoRow label="创建时间" value={fmtDate(version.createdAt)} />
              <InfoRow label="更新时间" value={fmtDate(version.updatedAt)} />
            </div>
          </Card>
        </>
      }
    >
      {showTrace && (
        <TraceRelationDrawer productId={productId} nodeId={`version:${version.id}`} title={version.versionName} onClose={() => setShowTrace(false)} />
      )}
    </DetailScaffold>
  );
}

// ════════════════════════ 缺陷详情（产品内可编辑，对齐需求详情）════════════════════════
function DefectDetail({
  productId,
  defect,
  features,
  versions,
  versionName,
  requirementName,
  onReload,
  gotoRequirement,
  gotoFeature,
}: {
  productId: string;
  defect?: TracedDefect;
  features: Feature[];
  versions: ProductVersion[];
  versionName: Map<string, string>;
  requirementName: Map<string, string>;
  onReload: () => void;
  gotoRequirement: (id: string) => void;
  gotoFeature: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [assigneeId, setAssigneeId] = useState('');
  const [featureId, setFeatureId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [classification, setClassification] = useState(PRODUCT_DEFECT_CLASSIFICATION);
  const [saving, setSaving] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertErr, setConvertErr] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const { workflow } = useEffectiveWorkflow('defect', productId);

  useEffect(() => {
    if (defect) {
      setTitle(defect.title ?? '');
      setDescription(defect.rawContent ?? '');
      setGrade(effectiveDefectGrade(defect));
      setAssigneeId(defect.assigneeId ?? '');
      setFeatureId(defect.tracedFeatureId ?? '');
      setVersionId(defect.tracedVersionId ?? '');
      setClassification(normalizeDefectClassification(defect.productDefectClassification));
    }
  }, [defect]);

  const featureName = useMemo(() => new Map(features.map((f) => [f.id, f.title])), [features]);

  const dirty = useMemo(() => {
    if (!defect) return false;
    return (
      title !== (defect.title ?? '') ||
      description !== (defect.rawContent ?? '') ||
      grade !== effectiveDefectGrade(defect) ||
      assigneeId !== (defect.assigneeId ?? '') ||
      featureId !== (defect.tracedFeatureId ?? '') ||
      versionId !== (defect.tracedVersionId ?? '') ||
      classification !== normalizeDefectClassification(defect.productDefectClassification)
    );
  }, [defect, title, description, grade, assigneeId, featureId, versionId, classification]);

  if (!defect) return <NotFound />;

  const selectCls = 'w-full px-2.5 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40';

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    await updateProductDefect(productId, defect.id, {
      title: title.trim(),
      description,
      grade,
      assigneeId: assigneeId || null,
      featureId: featureId || undefined,
      versionId: versionId || undefined,
      productDefectClassification: classification,
    });
    setSaving(false);
    onReload();
  };

  const convert = async () => {
    setConverting(true);
    setConvertErr(null);
    const res = await convertDefectToRequirement(defect.id);
    setConverting(false);
    if (res.success && res.data) navigate(`/product-agent/p/${res.data.productId}/requirement/${res.data.id}`);
    else setConvertErr(res.error?.message ?? '转换失败');
  };

  return (
    <DetailScaffold
      no={defect.defectNo}
      kindLabel="缺陷"
      kindColor="#F87171"
      title={title}
      onTitleChange={setTitle}
      titlePlaceholder="缺陷标题"
      dirty={dirty}
      saving={saving}
      onSave={save}
      headerActions={
        <>
          <button
            onClick={convert}
            disabled={converting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-cyan-200 bg-cyan-500/15 border border-cyan-500/40 hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {converting ? <MapSpinner size={14} /> : <GitBranch size={14} />} 转为需求
          </button>
          <TraceButton onClick={() => setShowTrace(true)} />
        </>
      }
      workflow={
        workflow ? (
          <WorkflowBar
            workflow={workflow}
            entityType="defect"
            entityId={defect.id}
            productId={productId}
            currentState={defect.status}
            entitySnapshot={{ ownerId: defect.reporterId ?? '', assigneeId, title, grade }}
            onChanged={onReload}
          />
        ) : undefined
      }
      main={
        <>
          <Card title="描述 / 复现步骤">
            <DescriptionField value={description} onChange={setDescription} />
          </Card>
          <Card title="追溯指向">
            <div className="flex flex-col gap-2 text-sm">
              {featureId ? (
                <button onClick={() => gotoFeature(featureId)} className="text-left text-cyan-300 hover:underline">
                  功能：{featureName.get(featureId) ?? featureId}
                </button>
              ) : null}
              {defect.tracedRequirementId ? (
                <button onClick={() => gotoRequirement(defect.tracedRequirementId!)} className="text-left text-cyan-300 hover:underline">
                  需求：{requirementName.get(defect.tracedRequirementId) ?? defect.tracedRequirementId}
                </button>
              ) : null}
              {versionId && <div className="text-white/70">版本：{versionName.get(versionId) ?? versionId}</div>}
              {!featureId && !defect.tracedRequirementId && !versionId && <div className="text-white/50">仅追溯到产品</div>}
            </div>
          </Card>
          {convertErr && <p className="text-xs text-red-300/80 px-1">{convertErr}</p>}
          <p className="text-[11px] text-white/35 px-1">右上角「转为需求」会在本产品下生成一条需求，并把本缺陷追溯到该需求（已转过则直接跳转）。</p>
        </>
      }
      sidebar={
        <>
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
              <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
                <input
                  type="checkbox"
                  checked={classification === NON_PRODUCT_DEFECT_CLASSIFICATION}
                  onChange={(e) => setClassification(e.target.checked ? NON_PRODUCT_DEFECT_CLASSIFICATION : PRODUCT_DEFECT_CLASSIFICATION)}
                  className="accent-cyan-500"
                />
                非产品缺陷
              </label>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>关联功能</FieldLabel>
                <select className={selectCls} value={featureId} onChange={(e) => setFeatureId(e.target.value)}>
                  <option value="">不关联</option>
                  {features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>关联版本</FieldLabel>
                <select className={selectCls} value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                  <option value="">不关联</option>
                  {versions.map((v) => <option key={v.id} value={v.id}>{v.versionName}</option>)}
                </select>
              </div>
              {defect.status && (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>状态</FieldLabel>
                  <span className="text-xs px-2 py-1 rounded-md bg-white/8 text-white/70 border border-white/10 w-fit">
                    {DEFECT_STATUS_LABEL[defect.status] ?? defect.status}
                  </span>
                </div>
              )}
            </div>
          </Card>
          <Card title="信息">
            <div className="flex flex-col gap-2">
              <InfoRow label="状态" value={DEFECT_STATUS_LABEL[status] ?? status ?? '—'} />
              <InfoRow label="上报人" value={defect.reporterName || '—'} />
              <InfoRow label="创建时间" value={fmtDate(defect.createdAt)} />
              <InfoRow label="更新时间" value={fmtDate(defect.updatedAt)} />
            </div>
          </Card>
        </>
      }
    >
      {showTrace && (
        <TraceRelationDrawer productId={productId} nodeId={`defect:${defect.id}`} title={defect.title || defect.defectNo} onClose={() => setShowTrace(false)} />
      )}
    </DetailScaffold>
  );
}
