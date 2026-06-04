/**
 * 产品管理智能体 — P1 关系连边弹层 + 知识库面板。
 *
 * - VersionRelationModal：版本 ↔ 需求（多选）、版本 ↔ 功能（功能版本化，勾选即纳入）+ 版本知识库入口
 * - RequirementRelationModal：需求 ↔ 客户、需求 ↔ 版本（多选）、需求 ← 缺陷追溯（关联/解除）
 * - KnowledgeStoreModal：find-or-create 后嵌入 DocumentStoreBrowser（复用文档空间，含 MRD/SRS/PRD）
 *
 * 浮层遵循 .claude/rules/frontend-modal.md：createPortal 到 body + inline 高度 + min-h-0 滚动。
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Link2, Unlink, BookOpen, Search } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { DocumentStoreBrowser } from '@/components/doc-browser/DocumentStoreBrowser';
import { FormFieldsRenderer, useEffectiveTemplate, useEffectiveWorkflow } from './DynamicForm';
import { WorkflowBar } from './WorkflowBar';
import {
  listRequirements,
  listFeatures,
  listVersions,
  listCustomers,
  listFeatureVersions,
  createFeatureVersion,
  deleteFeatureVersion,
  updateVersion,
  updateRequirement,
  listTracedDefects,
  listLinkableDefects,
  traceDefect,
  untraceDefect,
  getVersionKnowledgeStore,
  getProductKnowledgeStore,
  type TracedDefect,
} from '@/services/real/productAgent';
import type { ProductVersion, Requirement, Feature, FeatureVersion, Customer } from './types';
import { ITEM_GRADE_LABEL } from './types';

// ── 通用弹层壳 ──
function ModalShell({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="rounded-xl border border-white/10 bg-[#16181d] flex flex-col"
        style={{ width, maxWidth: '92vw', height: '78vh', maxHeight: '78vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 px-4 py-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── 复用：多选勾选列表 ──
function CheckboxList<T extends { id: string }>({
  items,
  selected,
  toggle,
  label,
  sub,
  empty,
}: {
  items: T[];
  selected: Set<string>;
  toggle: (id: string) => void;
  label: (t: T) => string;
  sub?: (t: T) => string;
  empty: string;
}) {
  if (items.length === 0) return <div className="text-xs text-white/40 py-4 text-center">{empty}</div>;
  return (
    <div className="flex flex-col gap-1">
      {items.map((t) => (
        <label
          key={t.id}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 cursor-pointer"
        >
          <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} className="accent-cyan-500" />
          <span className="text-sm text-white/80 truncate flex-1">{label(t)}</span>
          {sub && <span className="text-[10px] text-white/40 shrink-0">{sub(t)}</span>}
        </label>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-medium text-white/50 mb-1.5">{title}</div>
      {children}
    </div>
  );
}

// ════════════════════════ 版本关系 ════════════════════════

export function VersionRelationModal({
  productId,
  version,
  onClose,
  onSaved,
}: {
  productId: string;
  version: ProductVersion;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [featureVersions, setFeatureVersions] = useState<FeatureVersion[]>([]);
  const [selectedReqs, setSelectedReqs] = useState<Set<string>>(new Set(version.requirementIds));
  const [formData, setFormData] = useState<Record<string, string>>(version.formData ?? {});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const { template } = useEffectiveTemplate('version', productId);
  const { workflow } = useEffectiveWorkflow('version', productId);

  const reload = useCallback(async () => {
    setLoading(true);
    const [r, f, fv] = await Promise.all([
      listRequirements(productId),
      listFeatures(productId),
      listFeatureVersions(productId, { versionId: version.id }),
    ]);
    if (r.success) setReqs(r.data.items);
    if (f.success) setFeatures(f.data.items);
    if (fv.success) setFeatureVersions(fv.data.items);
    setLoading(false);
  }, [productId, version.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleReq = (id: string) => {
    setSelectedReqs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const featureIncluded = (featureId: string) => featureVersions.find((fv) => fv.featureId === featureId);

  const toggleFeature = async (featureId: string) => {
    const existing = featureIncluded(featureId);
    if (existing) {
      await deleteFeatureVersion(existing.id);
    } else {
      await createFeatureVersion(productId, { featureId, versionId: version.id });
    }
    const fv = await listFeatureVersions(productId, { versionId: version.id });
    if (fv.success) setFeatureVersions(fv.data.items);
  };

  const save = async () => {
    setSaving(true);
    await updateVersion(version.id, { requirementIds: Array.from(selectedReqs), formData });
    setSaving(false);
    onSaved();
    onClose();
  };

  if (showKnowledge) {
    return <KnowledgeStoreModal title={`${version.versionName} · 版本知识库`} fetcher={() => getVersionKnowledgeStore(version.id)} onClose={() => setShowKnowledge(false)} />;
  }

  return (
    <ModalShell title={`版本关系 · ${version.versionName}`} onClose={onClose}>
      {loading ? (
        <MapSectionLoader text="正在加载…" />
      ) : (
        <>
          {version.workflowDefId && (
            <div className="mb-3">
              <WorkflowBar workflow={workflow} entityType="version" entityId={version.id} currentState={version.currentState} onChanged={onSaved} />
            </div>
          )}
          {template && template.fields.length > 0 && (
            <Section title={`自定义字段（${template.name}）`}>
              <FormFieldsRenderer fields={template.fields} values={formData} onChange={(k, v) => setFormData((d) => ({ ...d, [k]: v }))} productId={productId} />
            </Section>
          )}
          <div className="flex justify-end mb-2">
            <button
              onClick={() => setShowKnowledge(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10"
            >
              <BookOpen size={13} /> 版本知识库（MRD/SRS/PRD）
            </button>
          </div>
          <Section title="关联需求（本版本要做哪些需求）">
            <CheckboxList
              items={reqs}
              selected={selectedReqs}
              toggle={toggleReq}
              label={(r) => r.title}
              sub={(r) => ITEM_GRADE_LABEL[r.grade]}
              empty="该产品还没有需求，先去「需求」tab 新建。"
            />
          </Section>
          <Section title="纳入功能（功能版本化，勾选即把功能纳入本版本）">
            <CheckboxList
              items={features}
              selected={new Set(featureVersions.map((fv) => fv.featureId))}
              toggle={(id) => void toggleFeature(id)}
              label={(f) => f.title}
              sub={(f) => ITEM_GRADE_LABEL[f.grade]}
              empty="该产品还没有功能，先去「功能」tab 新建。"
            />
          </Section>
          <div className="flex justify-end gap-2 pt-2 border-t border-white/10">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">
              取消
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
            >
              {saving ? <MapSpinner size={14} /> : <Link2 size={14} />} 保存关联
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// ════════════════════════ 需求关系 ════════════════════════

export function RequirementRelationModal({
  productId,
  requirement,
  onClose,
  onSaved,
}: {
  productId: string;
  requirement: Requirement;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [traced, setTraced] = useState<TracedDefect[]>([]);
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set(requirement.customerIds));
  const [selectedVersions, setSelectedVersions] = useState<Set<string>>(new Set(requirement.versionIds));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showLinker, setShowLinker] = useState(false);

  const reloadTraced = useCallback(async () => {
    const t = await listTracedDefects(productId, { requirementId: requirement.id });
    if (t.success) setTraced(t.data.items);
  }, [productId, requirement.id]);

  const reload = useCallback(async () => {
    setLoading(true);
    const [c, v] = await Promise.all([listCustomers(productId), listVersions(productId)]);
    if (c.success) setCustomers(c.data.items);
    if (v.success) setVersions(v.data.items);
    await reloadTraced();
    setLoading(false);
  }, [productId, reloadTraced]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const save = async () => {
    setSaving(true);
    await updateRequirement(requirement.id, {
      customerIds: Array.from(selectedCustomers),
      versionIds: Array.from(selectedVersions),
    });
    setSaving(false);
    onSaved();
    onClose();
  };

  return (
    <ModalShell title={`需求关系 · ${requirement.title}`} onClose={onClose}>
      {loading ? (
        <MapSectionLoader text="正在加载…" />
      ) : (
        <>
          <Section title="关联客户（这个需求是哪些客户提的 / 影响谁）">
            <CheckboxList
              items={customers}
              selected={selectedCustomers}
              toggle={(id) => toggle(selectedCustomers, setSelectedCustomers, id)}
              label={(c) => c.name}
              sub={(c) => c.company || ''}
              empty="该产品还没有客户，先去「客户」tab 录入。"
            />
          </Section>
          <Section title="归属版本（这个需求在哪些版本交付）">
            <CheckboxList
              items={versions}
              selected={selectedVersions}
              toggle={(id) => toggle(selectedVersions, setSelectedVersions, id)}
              label={(v) => v.versionName}
              empty="该产品还没有版本，先去「版本」tab 新建。"
            />
          </Section>
          <Section title="追溯缺陷（追溯到本需求的缺陷）">
            <div className="flex justify-end mb-1.5">
              <button
                onClick={() => setShowLinker(true)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10"
              >
                <Plus size={12} /> 关联缺陷
              </button>
            </div>
            {traced.length === 0 ? (
              <div className="text-xs text-white/40 py-2 text-center">还没有缺陷追溯到本需求。</div>
            ) : (
              <div className="flex flex-col gap-1">
                {traced.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.02]">
                    <span className="text-sm text-white/80 truncate">
                      <span className="text-[10px] text-white/40 mr-1">{d.defectNo}</span>
                      {d.title || '(无标题)'}
                    </span>
                    <button
                      onClick={async () => {
                        await untraceDefect(d.id);
                        await reloadTraced();
                      }}
                      className="text-white/30 hover:text-red-300 shrink-0"
                      title="解除追溯"
                    >
                      <Unlink size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <div className="flex justify-end gap-2 pt-2 border-t border-white/10">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">
              取消
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
            >
              {saving ? <MapSpinner size={14} /> : <Link2 size={14} />} 保存关联
            </button>
          </div>

          {showLinker && (
            <DefectLinkerModal
              productId={productId}
              requirementId={requirement.id}
              versionId={requirement.versionIds[0]}
              onClose={() => setShowLinker(false)}
              onLinked={async () => {
                await reloadTraced();
              }}
            />
          )}
        </>
      )}
    </ModalShell>
  );
}

// ── 缺陷关联选择器 ──
export function DefectLinkerModal({
  productId,
  requirementId,
  versionId,
  featureId,
  onClose,
  onLinked,
}: {
  productId: string;
  requirementId?: string;
  versionId?: string;
  featureId?: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<TracedDefect[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listLinkableDefects(productId, { keyword: keyword.trim() || undefined });
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId, keyword]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <ModalShell title="关联缺陷（追溯到本需求）" onClose={onClose} width={480}>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center gap-1.5 flex-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10">
          <Search size={14} className="text-white/40" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="按标题 / 编号搜索我可见的缺陷"
            className="bg-transparent text-sm text-white outline-none flex-1"
          />
        </div>
      </div>
      {loading ? (
        <MapSectionLoader text="正在加载…" />
      ) : items.length === 0 ? (
        <div className="text-xs text-white/40 py-6 text-center">
          没有可关联的缺陷（仅显示你可见、且尚未追溯到任何产品的缺陷）。
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.02]">
              <span className="text-sm text-white/80 truncate">
                <span className="text-[10px] text-white/40 mr-1">{d.defectNo}</span>
                {d.title || '(无标题)'}
              </span>
              <button
                onClick={async () => {
                  await traceDefect({ defectId: d.id, productId, requirementId, versionId, featureId });
                  setItems((prev) => prev.filter((x) => x.id !== d.id));
                  onLinked();
                }}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10 shrink-0"
              >
                <Link2 size={12} /> 追溯
              </button>
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}

// ════════════════════════ 知识库弹层（嵌入 DocumentStoreBrowser）════════════════════════

export function KnowledgeStoreModal({
  title,
  fetcher,
  onClose,
}: {
  title: string;
  fetcher: () => Promise<{ success: boolean; data: { id: string } | null }>;
  onClose: () => void;
}) {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await fetcher();
      if (alive && res.success && res.data) setStoreId(res.data.id);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [fetcher]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="rounded-xl border border-white/10 bg-[#16181d] flex flex-col"
        style={{ width: 960, maxWidth: '94vw', height: '86vh', maxHeight: '86vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <BookOpen size={15} className="text-cyan-400" /> {title}
          </h2>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1" style={{ minHeight: 0 }}>
          {loading ? (
            <MapSectionLoader text="正在准备知识库…" />
          ) : storeId ? (
            <DocumentStoreBrowser storeId={storeId} canWrite />
          ) : (
            <div className="text-sm text-white/40 text-center py-10">知识库加载失败</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 产品整体知识库面板（直接在详情 tab 内嵌入） */
export function ProductKnowledgePanel({ productId }: { productId: string }) {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getProductKnowledgeStore(productId);
      if (alive && res.success) setStoreId(res.data.id);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [productId]);

  if (loading) return <MapSectionLoader text="正在准备整体知识库…" />;
  if (!storeId) return <div className="text-sm text-white/40 text-center py-10">知识库加载失败</div>;
  return (
    <div className="h-full min-h-0">
      <DocumentStoreBrowser storeId={storeId} canWrite />
    </div>
  );
}
