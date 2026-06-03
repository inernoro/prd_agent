/**
 * 产品管理智能体 — 对象独立详情页（需求 / 功能 / 缺陷）。
 *
 * 路由：/product-agent/:productId/:kind/:id  （kind: requirement | feature | defect）
 * 全屏页，可分享 URL。展示对象完整信息 + 关系 + 基础字段编辑 + 返回。
 * 复用既有 list/update 端点（无需新增单对象 GET），关联 id 解析为名称展示。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, Unlink, ExternalLink, ListChecks, Puzzle, Bug } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { RequirementRelationModal, DefectLinkerModal } from './ProductRelationModals';
import { FormFieldsRenderer, useEffectiveTemplate, useEffectiveWorkflow } from './DynamicForm';
import { WorkflowBar } from './WorkflowBar';
import {
  listRequirements,
  createRequirement,
  updateRequirement,
  listFeatures,
  createFeature,
  updateFeature,
  listVersions,
  listCustomers,
  listFeatureVersions,
  listTracedDefects,
  untraceDefect,
  type TracedDefect,
} from '@/services/real/productAgent';
import type { Requirement, Feature, ProductVersion, Customer, FeatureVersion, ItemGrade } from './types';
import { ITEM_GRADE_LABEL } from './types';

const ITEM_GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];

export function ProductObjectDetailPage() {
  const navigate = useNavigate();
  const { productId = '', kind = '', id = '' } = useParams();
  const isNew = id === 'new';

  const [loading, setLoading] = useState(true);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [tracedDefects, setTracedDefects] = useState<TracedDefect[]>([]);
  const [featureVersions, setFeatureVersions] = useState<FeatureVersion[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    const [r, f, v, c, d] = await Promise.all([
      listRequirements(productId),
      listFeatures(productId),
      listVersions(productId),
      listCustomers(productId),
      listTracedDefects(productId),
    ]);
    if (r.success) setRequirements(r.data.items);
    if (f.success) setFeatures(f.data.items);
    if (v.success) setVersions(v.data.items);
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
    <div className="h-screen min-h-0 flex flex-col p-4 bg-[#0f1014]">
      <div className="shrink-0 flex items-center gap-3 mb-4">
        <button
          onClick={back}
          className="flex items-center justify-center w-9 h-9 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 shrink-0"
          title="返回"
        >
          <ArrowLeft size={18} />
        </button>
        <KindBadge kind={kind} isNew={isNew} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="max-w-3xl mx-auto">
          {isNew ? (
            <CreateObjectForm
              productId={productId}
              kind={kind}
              onCreated={(newId) => navigate(`/product-agent/p/${productId}/${kind}/${newId}`, { replace: true })}
            />
          ) : loading ? (
            <MapSectionLoader text="正在加载详情…" />
          ) : kind === 'requirement' ? (
            <RequirementDetail
              productId={productId}
              requirement={requirements.find((r) => r.id === id)}
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
              featureVersions={featureVersions}
              versionName={versionName}
              onReload={reload}
            />
          ) : kind === 'defect' ? (
            <DefectDetail
              defect={tracedDefects.find((d) => d.id === id)}
              versionName={versionName}
              requirementName={requirementName}
              onReload={reload}
              gotoRequirement={(rid) => navigate(`/product-agent/p/${productId}/requirement/${rid}`)}
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
    defect: { label: '缺陷', icon: Bug, color: '#F87171' },
  };
  const m = meta[kind] ?? { label: '对象', icon: ListChecks, color: '#888' };
  const Icon = m.icon;
  return (
    <span className="flex items-center gap-2 text-base font-semibold" style={{ color: m.color }}>
      <Icon size={18} /> {isNew ? `新建${m.label}` : `${m.label}详情`}
    </span>
  );
}

// ── 新建对象表单（需求 / 功能，独立页）──
function CreateObjectForm({
  productId,
  kind,
  onCreated,
}: {
  productId: string;
  kind: string;
  onCreated: (newId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const entityType = kind === 'feature' ? 'feature' : 'requirement';
  const { template } = useEffectiveTemplate(entityType, productId);
  const { workflow } = useEffectiveWorkflow(entityType, productId);

  if (kind !== 'requirement' && kind !== 'feature') {
    return <div className="text-white/40 text-sm text-center py-10">该类型不支持在此新建</div>;
  }

  const create = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const payload = {
      title: title.trim(),
      description,
      grade,
      formData,
      templateId: template?.id,
      workflowDefId: workflow?.id,
    };
    const res = kind === 'requirement' ? await createRequirement(productId, payload) : await createFeature(productId, payload);
    setSaving(false);
    if (res.success && res.data) onCreated(res.data.id);
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-3">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={kind === 'requirement' ? '需求标题' : '功能名称'}
        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-base text-white outline-none focus:border-cyan-500/40"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={4}
        placeholder="描述"
        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 resize-none"
      />
      <div className="flex items-center gap-2">
        <span className="text-xs text-white/50">分级</span>
        {ITEM_GRADES.map((g) => (
          <button
            key={g}
            onClick={() => setGrade(g)}
            className={`px-2 py-1 rounded-md text-xs border ${grade === g ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/40 border-white/10 hover:bg-white/5'}`}
          >
            {ITEM_GRADE_LABEL[g]}
          </button>
        ))}
        <button
          onClick={create}
          disabled={!title.trim() || saving}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
        >
          {saving ? <MapSpinner size={14} /> : <Save size={14} />} 创建
        </button>
      </div>
      {template && template.fields.length > 0 && (
        <div className="border-t border-white/10 pt-3 mt-1">
          <div className="text-xs font-medium text-white/50 mb-2">{template.name}</div>
          <FormFieldsRenderer fields={template.fields} values={formData} onChange={(k, v) => setFormData((d) => ({ ...d, [k]: v }))} productId={productId} />
        </div>
      )}
      <p className="text-[11px] text-white/35">创建后进入详情页，可继续关联客户 / 版本 / 缺陷追溯。</p>
    </div>
  );
}

// ── 基础字段编辑区（标题/描述/分级）──
function BasicFields({
  title,
  setTitle,
  description,
  setDescription,
  grade,
  setGrade,
  no,
  state,
  onSave,
  saving,
}: {
  title: string;
  setTitle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  grade: ItemGrade;
  setGrade: (g: ItemGrade) => void;
  no: string;
  state?: string | null;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[11px] text-white/40">
        <span>{no}</span>
        {state && <span>· 状态 {state}</span>}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-base text-white outline-none focus:border-cyan-500/40"
        placeholder="标题"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={4}
        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 resize-none"
        placeholder="描述"
      />
      <div className="flex items-center gap-2">
        <span className="text-xs text-white/50">分级</span>
        {ITEM_GRADES.map((g) => (
          <button
            key={g}
            onClick={() => setGrade(g)}
            className={`px-2 py-1 rounded-md text-xs border ${grade === g ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/40 border-white/10 hover:bg-white/5'}`}
          >
            {ITEM_GRADE_LABEL[g]}
          </button>
        ))}
        <button
          onClick={onSave}
          disabled={saving}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
        >
          {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
        </button>
      </div>
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 mt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-white/50">{title}</div>
        {action}
      </div>
      {children}
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

// ════════════════════════ 需求详情 ════════════════════════
function RequirementDetail({
  productId,
  requirement,
  versionName,
  customerName,
  tracedDefects,
  onReload,
  gotoDefect,
}: {
  productId: string;
  requirement?: Requirement;
  versionName: Map<string, string>;
  customerName: Map<string, string>;
  tracedDefects: TracedDefect[];
  onReload: () => void;
  gotoDefect: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [showRel, setShowRel] = useState(false);
  const { template } = useEffectiveTemplate('requirement', productId);
  const { workflow } = useEffectiveWorkflow('requirement', productId);

  useEffect(() => {
    if (requirement) {
      setTitle(requirement.title);
      setDescription(requirement.description ?? '');
      setGrade(requirement.grade);
      setFormData(requirement.formData ?? {});
    }
  }, [requirement]);

  if (!requirement) return <NotFound />;

  const save = async () => {
    setSaving(true);
    await updateRequirement(requirement.id, { title: title.trim(), description, grade, formData });
    setSaving(false);
    onReload();
  };

  return (
    <>
      {requirement.workflowDefId && (
        <div className="mb-3">
          <WorkflowBar workflow={workflow} entityType="requirement" entityId={requirement.id} currentState={requirement.currentState} onChanged={onReload} />
        </div>
      )}
      <BasicFields
        title={title}
        setTitle={setTitle}
        description={description}
        setDescription={setDescription}
        grade={grade}
        setGrade={setGrade}
        no={requirement.requirementNo}
        state={requirement.currentState}
        onSave={save}
        saving={saving}
      />
      {template && template.fields.length > 0 && (
        <Section title={`自定义字段（${template.name}）`}>
          <FormFieldsRenderer fields={template.fields} values={formData} onChange={(k, v) => setFormData((d) => ({ ...d, [k]: v }))} productId={productId} />
        </Section>
      )}
      <Section
        title="关联关系（客户 / 版本 / 缺陷）"
        action={
          <button onClick={() => setShowRel(true)} className="text-[11px] text-cyan-300 hover:underline">
            编辑关联
          </button>
        }
      >
        <div className="flex flex-col gap-2">
          <div>
            <div className="text-[11px] text-white/40 mb-1">客户</div>
            <Chips items={requirement.customerIds.map((c) => customerName.get(c) ?? c)} empty="未关联客户" />
          </div>
          <div>
            <div className="text-[11px] text-white/40 mb-1">归属版本</div>
            <Chips items={requirement.versionIds.map((v) => versionName.get(v) ?? v)} empty="未归属版本" />
          </div>
        </div>
      </Section>
      <Section title={`追溯缺陷（${tracedDefects.length}）`}>
        {tracedDefects.length === 0 ? (
          <div className="text-[11px] text-white/30">还没有缺陷追溯到本需求</div>
        ) : (
          <div className="flex flex-col gap-1">
            {tracedDefects.map((d) => (
              <button
                key={d.id}
                onClick={() => gotoDefect(d.id)}
                className="text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
              >
                <span className="text-sm text-white/80 truncate">
                  <span className="text-[10px] text-white/40 mr-1">{d.defectNo}</span>
                  {d.title || '(无标题)'}
                </span>
                <span className="text-[10px] text-white/40 shrink-0">{d.status}</span>
              </button>
            ))}
          </div>
        )}
      </Section>
      {showRel && (
        <RequirementRelationModal
          productId={productId}
          requirement={requirement}
          onClose={() => setShowRel(false)}
          onSaved={onReload}
        />
      )}
    </>
  );
}

// ════════════════════════ 功能详情 ════════════════════════
function FeatureDetail({
  feature,
  requirements,
  featureVersions,
  versionName,
  onReload,
}: {
  feature?: Feature;
  requirements: Requirement[];
  featureVersions: FeatureVersion[];
  versionName: Map<string, string>;
  onReload: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [selReqs, setSelReqs] = useState<Set<string>>(new Set());
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const { template } = useEffectiveTemplate('feature', feature?.productId ?? null);
  const { workflow } = useEffectiveWorkflow('feature', feature?.productId ?? null);

  useEffect(() => {
    if (feature) {
      setTitle(feature.title);
      setDescription(feature.description ?? '');
      setGrade(feature.grade);
      setSelReqs(new Set(feature.requirementIds));
      setFormData(feature.formData ?? {});
    }
  }, [feature]);

  const navigate = useNavigate();
  const [tracedDefects, setTracedDefects] = useState<TracedDefect[]>([]);
  const [showDefectLinker, setShowDefectLinker] = useState(false);
  const reloadDefects = useCallback(async () => {
    if (!feature) return;
    const res = await listTracedDefects(feature.productId, { featureId: feature.id });
    if (res.success) setTracedDefects(res.data.items);
  }, [feature]);
  useEffect(() => {
    void reloadDefects();
  }, [reloadDefects]);

  if (!feature) return <NotFound />;
  const productId = feature.productId;

  const save = async () => {
    setSaving(true);
    await updateFeature(feature.id, { title: title.trim(), description, grade, requirementIds: Array.from(selReqs), formData });
    setSaving(false);
    onReload();
  };

  const toggle = (id: string) => {
    setSelReqs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      {feature.workflowDefId && (
        <div className="mb-3">
          <WorkflowBar workflow={workflow} entityType="feature" entityId={feature.id} currentState={feature.currentState} onChanged={onReload} />
        </div>
      )}
      <BasicFields
        title={title}
        setTitle={setTitle}
        description={description}
        setDescription={setDescription}
        grade={grade}
        setGrade={setGrade}
        no={feature.featureNo}
        state={feature.currentState}
        onSave={save}
        saving={saving}
      />
      {template && template.fields.length > 0 && (
        <Section title={`自定义字段（${template.name}）`}>
          <FormFieldsRenderer fields={template.fields} values={formData} onChange={(k, v) => setFormData((d) => ({ ...d, [k]: v }))} productId={productId} />
        </Section>
      )}
      <Section title="实现的需求（勾选后点上方保存）">
        {requirements.length === 0 ? (
          <div className="text-[11px] text-white/30">该产品还没有需求</div>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
            {requirements.map((r) => (
              <label key={r.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 cursor-pointer">
                <input type="checkbox" checked={selReqs.has(r.id)} onChange={() => toggle(r.id)} className="accent-cyan-500" />
                <span className="text-sm text-white/80 truncate">{r.title}</span>
              </label>
            ))}
          </div>
        )}
      </Section>
      <Section title="纳入的版本（功能版本化）">
        <Chips items={featureVersions.map((fv) => versionName.get(fv.versionId) ?? fv.versionId)} empty="尚未纳入任何版本（在版本关系弹层里勾选纳入）" />
      </Section>
      <Section
        title={`追溯缺陷（${tracedDefects.length}）`}
        action={
          <button onClick={() => setShowDefectLinker(true)} className="text-[11px] text-cyan-300 hover:underline">
            关联缺陷
          </button>
        }
      >
        {tracedDefects.length === 0 ? (
          <div className="text-[11px] text-white/30">还没有缺陷追溯到本功能</div>
        ) : (
          <div className="flex flex-col gap-1">
            {tracedDefects.map((d) => (
              <button
                key={d.id}
                onClick={() => navigate(`/product-agent/p/${feature.productId}/defect/${d.id}`)}
                className="text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
              >
                <span className="text-sm text-white/80 truncate">
                  <span className="text-[10px] text-white/40 mr-1">{d.defectNo}</span>
                  {d.title || '(无标题)'}
                </span>
                <span className="text-[10px] text-white/40 shrink-0">{d.status}</span>
              </button>
            ))}
          </div>
        )}
      </Section>
      {showDefectLinker && (
        <DefectLinkerModal
          productId={feature.productId}
          featureId={feature.id}
          onClose={() => setShowDefectLinker(false)}
          onLinked={reloadDefects}
        />
      )}
    </>
  );
}

// ════════════════════════ 缺陷详情 ════════════════════════
function DefectDetail({
  defect,
  versionName,
  requirementName,
  onReload,
  gotoRequirement,
}: {
  defect?: TracedDefect;
  versionName: Map<string, string>;
  requirementName: Map<string, string>;
  onReload: () => void;
  gotoRequirement: (id: string) => void;
}) {
  const navigate = useNavigate();
  if (!defect) return <NotFound />;

  return (
    <>
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-2">
        <div className="text-[11px] text-white/40">{defect.defectNo}</div>
        <div className="text-base text-white font-medium">{defect.title || '(无标题)'}</div>
        <div className="flex items-center gap-2 text-xs text-white/50">
          <span>状态 {defect.status}</span>
          {defect.severity && <span>· 严重度 {defect.severity}</span>}
          {defect.priority && <span>· 优先级 {defect.priority}</span>}
        </div>
      </div>
      <Section title="追溯指向">
        <div className="flex flex-col gap-1.5 text-sm">
          {defect.tracedRequirementId ? (
            <button onClick={() => gotoRequirement(defect.tracedRequirementId!)} className="text-left text-cyan-300 hover:underline">
              需求：{requirementName.get(defect.tracedRequirementId) ?? defect.tracedRequirementId}
            </button>
          ) : null}
          {defect.tracedVersionId && (
            <div className="text-white/70">版本：{versionName.get(defect.tracedVersionId) ?? defect.tracedVersionId}</div>
          )}
          {!defect.tracedRequirementId && !defect.tracedVersionId && <div className="text-white/50">仅追溯到产品</div>}
        </div>
      </Section>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={async () => {
            await untraceDefect(defect.id);
            onReload();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-red-300/80 border border-red-500/30 hover:bg-red-500/10"
        >
          <Unlink size={14} /> 解除追溯
        </button>
        <button
          onClick={() => navigate('/defect-agent')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white/60 border border-white/10 hover:bg-white/5"
        >
          <ExternalLink size={14} /> 在缺陷管理智能体打开完整缺陷
        </button>
      </div>
    </>
  );
}

function NotFound() {
  return <div className="text-white/40 text-sm text-center py-10">对象不存在或已删除</div>;
}
