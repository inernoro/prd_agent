/**
 * 产品内缺陷详情 — TAPD 缺陷详情页结构对齐（字段 key 与 TAPD 导入 SSOT 一致）。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Bug, ExternalLink, GitBranch, Image as ImageIcon, Paperclip, Share2, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import {
  convertDefectToRequirement,
  updateProductDefect,
  type TracedDefect,
} from '@/services/real/productAgent';
import type { Feature, ProductVersion } from './types';
import { readDefectPriorityGrade, readDefectSeverityLevel } from './types';
import {
  DEFECT_SEVERITY_LEVEL_HINT,
  DEFECT_SEVERITY_LEVEL_OPTIONS,
  type DefectSeverityLevel,
} from './defectSeverity';
import { RichTextField, useEffectiveWorkflow } from './DynamicForm';
import { WorkflowBar } from './WorkflowBar';
import { ActivityTimeline } from './ActivityTimeline';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import { DetailRecordActions } from './DetailRecordActions';
import {
  NON_PRODUCT_DEFECT_CLASSIFICATION,
  PRODUCT_DEFECT_CLASSIFICATION,
  normalizeDefectClassification,
} from './productDefectLinkageCatalog';
import {
  TAPD_DEFECT_FIELD,
  TAPD_DEFECT_SIDEBAR_FIELDS,
  computeTapdDerivedFields,
  tierToStructuredValue,
  type TapdDefectSidebarField,
} from './tapdDefectFieldCatalog';

const DEFECT_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewing: '评审中',
  awaiting: '待处理',
  submitted: '已提交',
  assigned: '已分配',
  processing: '处理中',
  verifying: '待验收',
  resolved: '已解决',
  rejected: '已拒绝',
  closed: '已关闭',
};

function fmtDate(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

function Card({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
      {title ? (
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
          <span className="text-xs font-medium text-white/55">{title}</span>
          {action}
        </div>
      ) : null}
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-white/45">{children}</span>;
}

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
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white" title="关闭"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0">
          <ProductGraphCanvas productId={productId} focusNodeId={nodeId} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function readEntityField(defect: TracedDefect, source: TapdDefectSidebarField['entitySource']): string {
  switch (source) {
    case 'externalId':
      return defect.productExternalId ?? defect.structuredData?.[TAPD_DEFECT_FIELD.defectId] ?? defect.defectNo ?? '—';
    case 'status':
      return DEFECT_STATUS_LABEL[defect.status] ?? defect.status ?? '—';
    case 'reporterName':
      return defect.reporterName ?? '—';
    case 'createdAt':
      return fmtDate(defect.createdAt);
    case 'resolvedAt':
      return fmtDate(defect.resolvedAt ?? defect.structuredData?.[TAPD_DEFECT_FIELD.resolved]);
    case 'closedAt':
      return fmtDate(defect.closedAt ?? defect.structuredData?.[TAPD_DEFECT_FIELD.closed]);
    case 'assigneeName':
      return defect.assigneeName ?? '—';
    default:
      return '—';
  }
}

const inputCls = 'w-full px-2.5 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40';
const readonlyCls = 'text-sm text-white/75 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5';

export function ProductDefectDetail({
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
  const { workflow } = useEffectiveWorkflow('defect', productId);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severityLevel, setSeverityLevel] = useState<DefectSeverityLevel | ''>('');
  const [assigneeId, setAssigneeId] = useState('');
  const [featureId, setFeatureId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [classification, setClassification] = useState(PRODUCT_DEFECT_CLASSIFICATION);
  const [structuredData, setStructuredData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertErr, setConvertErr] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [commentTab, setCommentTab] = useState<'comment' | 'change'>('comment');

  useEffect(() => {
    if (!defect) return;
    setTitle(defect.title ?? '');
    setDescription(defect.rawContent ?? '');
    setSeverityLevel(readDefectSeverityLevel(defect) ?? '');
    setAssigneeId(defect.assigneeId ?? '');
    setFeatureId(defect.tracedFeatureId ?? '');
    setVersionId(defect.tracedVersionId ?? '');
    setClassification(normalizeDefectClassification(defect.productDefectClassification));
    const base = { ...(defect.structuredData ?? {}) };
    if (defect.productExternalId) base[TAPD_DEFECT_FIELD.defectId] = defect.productExternalId;
    if (defect.resolvedAt) base[TAPD_DEFECT_FIELD.resolved] = defect.resolvedAt;
    if (defect.closedAt) base[TAPD_DEFECT_FIELD.closed] = defect.closedAt;
    base[TAPD_DEFECT_FIELD.defectDivision] = normalizeDefectClassification(defect.productDefectClassification);
    setStructuredData(computeTapdDerivedFields(base));
  }, [defect]);

  const featureName = useMemo(() => new Map(features.map((f) => [f.id, f.title])), [features]);
  const derivedStructured = useMemo(() => computeTapdDerivedFields(structuredData), [structuredData]);

  const dirty = useMemo(() => {
    if (!defect) return false;
    const origStructured = defect.structuredData ?? {};
    const structuredChanged = TAPD_DEFECT_SIDEBAR_FIELDS.some((f) => {
      if (f.kind === 'readonly' || f.kind === 'severity' || f.kind === 'classification') return false;
      return (derivedStructured[f.key] ?? '') !== (origStructured[f.key] ?? '');
    });
    return (
      title !== (defect.title ?? '') ||
      description !== (defect.rawContent ?? '') ||
      severityLevel !== (readDefectSeverityLevel(defect) ?? '') ||
      assigneeId !== (defect.assigneeId ?? '') ||
      featureId !== (defect.tracedFeatureId ?? '') ||
      versionId !== (defect.tracedVersionId ?? '') ||
      classification !== normalizeDefectClassification(defect.productDefectClassification) ||
      structuredChanged
    );
  }, [defect, title, description, severityLevel, assigneeId, featureId, versionId, classification, derivedStructured]);

  if (!defect) {
    return <div className="text-white/40 text-sm text-center py-10">缺陷不存在</div>;
  }

  const setTapdField = (key: string, value: string) => {
    setStructuredData((prev) => computeTapdDerivedFields({ ...prev, [key]: value }));
  };

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const payloadStructured = { ...derivedStructured };
    payloadStructured[TAPD_DEFECT_FIELD.defectDivision] = classification;
    payloadStructured[TAPD_DEFECT_FIELD.defectSeverity] = tierToStructuredValue(severityLevel);
    await updateProductDefect(productId, defect.id, {
      title: title.trim(),
      description,
      assigneeId: assigneeId || null,
      featureId: featureId || undefined,
      versionId: versionId || undefined,
      productDefectClassification: classification,
      structuredData: payloadStructured,
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

  const attachments = defect.attachments ?? [];
  const imageAttachments = attachments.filter((a) => a.mimeType?.startsWith('image/'));
  const otherAttachments = attachments.filter((a) => !a.mimeType?.startsWith('image/'));

  const renderSidebarField = (field: TapdDefectSidebarField) => {
    if (field.kind === 'readonly' && field.entitySource) {
      return <div className={readonlyCls}>{readEntityField(defect, field.entitySource)}</div>;
    }
    if (field.kind === 'severity') {
      return (
        <div className="flex flex-col gap-1">
          <select className={inputCls} value={severityLevel} onChange={(e) => setSeverityLevel(e.target.value as DefectSeverityLevel | '')}>
            <option value="">未设置</option>
            {DEFECT_SEVERITY_LEVEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {severityLevel ? (
            <p className="text-[11px] text-white/40 leading-snug">{DEFECT_SEVERITY_LEVEL_HINT[severityLevel]}</p>
          ) : null}
        </div>
      );
    }
    if (field.kind === 'classification') {
      const isNonProduct = classification === NON_PRODUCT_DEFECT_CLASSIFICATION;
      return (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
            <input type="radio" name="defect-division" checked={!isNonProduct} onChange={() => setClassification(PRODUCT_DEFECT_CLASSIFICATION)} className="accent-cyan-500" />
            缺陷（产品缺陷）
          </label>
          <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
            <input type="radio" name="defect-division" checked={isNonProduct} onChange={() => setClassification(NON_PRODUCT_DEFECT_CLASSIFICATION)} className="accent-cyan-500" />
            非产品缺陷
          </label>
        </div>
      );
    }
    if (field.key === TAPD_DEFECT_FIELD.currentOwner) {
      return <UserSearchSelect value={assigneeId} onChange={setAssigneeId} />;
    }
    const value = derivedStructured[field.key] ?? '';
    if (field.kind === 'url') {
      return value ? (
        <a href={value} target="_blank" rel="noopener noreferrer" className="text-sm text-cyan-300 hover:underline flex items-center gap-1 break-all">
          <ExternalLink size={12} className="shrink-0" /> {value}
        </a>
      ) : (
        <input className={inputCls} value={value} placeholder="TAPD 原链接" onChange={(e) => setTapdField(field.key, e.target.value)} />
      );
    }
    if (field.kind === 'textarea') {
      return <textarea className={`${inputCls} min-h-[72px] resize-y`} value={value} onChange={(e) => setTapdField(field.key, e.target.value)} />;
    }
    return <input className={inputCls} type={field.kind === 'date' ? 'datetime-local' : 'text'} value={value} onChange={(e) => setTapdField(field.key, e.target.value)} />;
  };

  return (
    <div className="flex flex-col gap-4 min-h-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono bg-red-500/10 text-red-200/90 border border-red-500/25">
            <Bug size={12} /> {defect.defectNo}
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="缺陷标题"
            className="min-w-0 flex-1 text-xl font-semibold text-white bg-transparent border-none outline-none placeholder:text-white/25"
          />
          <DetailRecordActions
            kind="defect"
            productId={productId}
            recordId={defect.id}
            recordNo={defect.defectNo}
            title={title}
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={convert} disabled={converting} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-cyan-200 bg-cyan-500/15 border border-cyan-500/40 hover:bg-cyan-500/25 disabled:opacity-50">
            {converting ? <MapSpinner size={14} /> : <GitBranch size={14} />} 转为需求
          </button>
          <button type="button" onClick={() => setShowTrace(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/70 hover:bg-white/5 text-sm">
            <Share2 size={14} /> 追溯
          </button>
          <button type="button" onClick={() => void save()} disabled={!dirty || saving || !title.trim()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-cyan-500 text-slate-950 hover:bg-cyan-400 disabled:opacity-40">
            {saving ? <MapSpinner size={14} /> : null} 保存
          </button>
        </div>
      </div>

      {workflow ? (
        <WorkflowBar workflow={workflow} entityType="defect" entityId={defect.id} productId={productId} currentState={defect.status} entitySnapshot={{ ownerId: defect.reporterId ?? '', assigneeId, title, grade: readDefectPriorityGrade(defect) ?? undefined }} onChanged={onReload} />
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="描述">
            <RichTextField value={description} onChange={setDescription} minHeight={360} placeholder="复现步骤、预期/实际结果…（支持排版与截图粘贴，对齐 TAPD 描述区）" />
          </Card>

          {imageAttachments.length > 0 ? (
            <Card title={`截图 (${imageAttachments.length})`}>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {imageAttachments.map((att) => (
                  <a key={att.id ?? att.url} href={att.url ?? '#'} target="_blank" rel="noopener noreferrer" className="shrink-0 w-[100px] h-[70px] rounded-lg overflow-hidden border border-white/10">
                    {att.url ? <img src={att.url} alt={att.fileName} className="w-full h-full object-cover" /> : <ImageIcon className="m-auto text-white/30" />}
                  </a>
                ))}
              </div>
            </Card>
          ) : null}

          {otherAttachments.length > 0 ? (
            <Card title={`附件 (${otherAttachments.length})`}>
              <div className="flex flex-wrap gap-2">
                {otherAttachments.map((att) => (
                  <a key={att.id ?? att.url} href={att.url ?? '#'} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-white/70 border border-white/10 hover:bg-white/5">
                    <Paperclip size={12} /> {att.fileName}
                  </a>
                ))}
              </div>
            </Card>
          ) : null}

          {defect.resolution ? <Card title="解决说明"><div className="text-sm text-white/70 whitespace-pre-wrap">{defect.resolution}</div></Card> : null}
          {defect.rejectReason ? <Card title="拒绝原因"><div className="text-sm text-red-200/80 whitespace-pre-wrap">{defect.rejectReason}</div></Card> : null}

          <Card title="关联">
            <div className="flex flex-col gap-2 text-sm">
              {featureId ? <button type="button" onClick={() => gotoFeature(featureId)} className="text-left text-cyan-300 hover:underline">功能：{featureName.get(featureId) ?? featureId}</button> : null}
              {defect.tracedRequirementId ? <button type="button" onClick={() => gotoRequirement(defect.tracedRequirementId!)} className="text-left text-cyan-300 hover:underline">需求：{requirementName.get(defect.tracedRequirementId) ?? defect.tracedRequirementId}</button> : null}
              {versionId ? <div className="text-white/70">版本：{versionName.get(versionId) ?? versionId}</div> : null}
              <div className="pt-2 border-t border-white/5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="flex flex-col gap-1"><FieldLabel>关联功能</FieldLabel><select className={inputCls} value={featureId} onChange={(e) => setFeatureId(e.target.value)}><option value="">不关联</option>{features.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}</select></div>
                <div className="flex flex-col gap-1"><FieldLabel>关联版本</FieldLabel><select className={inputCls} value={versionId} onChange={(e) => setVersionId(e.target.value)}><option value="">不关联</option>{versions.map((v) => <option key={v.id} value={v.id}>{v.versionName}</option>)}</select></div>
              </div>
            </div>
          </Card>

          <Card
            title="评论与动态"
            action={(
              <div className="flex gap-1">
                <button type="button" onClick={() => setCommentTab('comment')} className={`px-2 py-0.5 rounded text-[11px] ${commentTab === 'comment' ? 'bg-white/10 text-white/80' : 'text-white/40'}`}>评论</button>
                <button type="button" onClick={() => setCommentTab('change')} className={`px-2 py-0.5 rounded text-[11px] ${commentTab === 'change' ? 'bg-white/10 text-white/80' : 'text-white/40'}`}>变更历史</button>
              </div>
            )}
          >
            <ActivityTimeline entityType="defect" entityId={defect.id} filter={commentTab === 'comment' ? 'comment' : 'system'} />
          </Card>
          {convertErr ? <p className="text-xs text-red-300/80">{convertErr}</p> : null}
        </div>

        <div className="flex flex-col gap-4 xl:sticky xl:top-4">
          <Card title="属性">
            <div className="flex flex-col gap-3">
              {TAPD_DEFECT_SIDEBAR_FIELDS.map((field) => (
                <div key={field.key} className="flex flex-col gap-1">
                  <FieldLabel>{field.label}</FieldLabel>
                  {renderSidebarField(field)}
                </div>
              ))}
            </div>
          </Card>
          {defect.productSourceSystem ? (
            <Card title="来源">
              <div className="text-[11px] text-white/45 space-y-1">
                <div>系统：{defect.productSourceSystem}</div>
                {defect.productExternalId ? <div className="font-mono break-all">ID：{defect.productExternalId}</div> : null}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      {showTrace ? <TraceRelationDrawer productId={productId} nodeId={`defect:${defect.id}`} title={defect.title || defect.defectNo} onClose={() => setShowTrace(false)} /> : null}
    </div>
  );
}
