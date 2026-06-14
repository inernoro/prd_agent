/**
 * 内部版本立项详情 — 基础信息 + 需求 + 功能 + 缺陷四标签页（结构固定，空数据仍展示表头）。
 * 路由：/product-agent/p/:productId/initiation/:id
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getInitiation, getProduct, listFeatures, listProductMembers, listRequirements, listTracedDefects, type TracedDefect } from '@/services/real/productAgent';
import { getUserCards } from '@/services/real/teams';
import type { Feature, ProductInitiation, ProductMember, Requirement } from './types';
import { useEffectiveWorkflow } from './DynamicForm';
import { WorkflowAttributeTable, WorkflowDetailCard, WorkflowRecordTable } from './workflowDetailUi';
import { buildInitiationBasicInfoRows } from './versionBasicInfoCatalog';
import { defectDetailColumns, featureDetailColumns, requirementDetailColumns } from './versionDetailTables';
import { DetailRecordActions } from './DetailRecordActions';
import { InitiationWorkflowPanel } from './InitiationWorkflowPanel';
import { InitiationWizard } from './VersionWorkflowTab';
import { useAuthStore } from '@/stores/authStore';

const SCALE_LABEL = { major: '大版本', medium: '中版本', minor: '小版本' } as const;
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  review_pending: 'Agent 评审中',
  review_failed: '评审未通过',
  decision_pending: '待确认评审方式',
  owner_pending: '待负责人同意',
  approved: '已取得立项号',
};

type DetailTab = 'basic' | 'requirements' | 'features' | 'defects' | 'workflow';

export function InitiationWorkflowDetail({
  productId,
  initiationId,
}: {
  productId: string;
  initiationId: string;
}) {
  const navigate = useNavigate();
  const currentUserId = useAuthStore((s) => s.user?.userId);
  const [tab, setTab] = useState<DetailTab>('basic');
  const [loading, setLoading] = useState(true);
  const [initiation, setInitiation] = useState<ProductInitiation | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [members, setMembers] = useState<ProductMember[]>([]);
  const [tracedDefects, setTracedDefects] = useState<TracedDefect[]>([]);
  const [displayNames, setDisplayNames] = useState<Map<string, string>>(new Map());
  const [retryOpen, setRetryOpen] = useState(false);
  const [productName, setProductName] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const [initRes, reqRes, featRes, memRes, defRes, productRes] = await Promise.all([
      getInitiation(initiationId),
      listRequirements(productId),
      listFeatures(productId),
      listProductMembers(productId),
      listTracedDefects(productId),
      getProduct(productId),
    ]);
    if (initRes.success) setInitiation(initRes.data);
    if (reqRes.success) setRequirements(reqRes.data.items);
    if (featRes.success) setFeatures(featRes.data.items);
    if (memRes.success) setMembers(memRes.data.members);
    if (defRes.success) setTracedDefects(defRes.data.items);
    if (productRes.success) setProductName(productRes.data.name);
    setLoading(false);
  }, [initiationId, productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const linkedRequirements = useMemo(
    () => requirements.filter((r) => initiation?.requirementIds.includes(r.id)),
    [initiation?.requirementIds, requirements],
  );

  const linkedFeatures = useMemo(() => {
    const reqIds = new Set(initiation?.requirementIds ?? []);
    if (reqIds.size === 0) return [] as Feature[];
    return features.filter((f) => f.requirementIds.some((rid) => reqIds.has(rid)));
  }, [features, initiation?.requirementIds]);

  const linkedDefects = useMemo(() => {
    const reqIds = new Set(initiation?.requirementIds ?? []);
    const featureIds = new Set(linkedFeatures.map((f) => f.id));
    return tracedDefects.filter((d) =>
      (d.tracedRequirementId && reqIds.has(d.tracedRequirementId))
      || (d.tracedFeatureId && featureIds.has(d.tracedFeatureId)));
  }, [initiation?.requirementIds, linkedFeatures, tracedDefects]);

  const memberNameMap = useMemo(() => new Map(members.map((m) => [m.userId, m.displayName])), [members]);
  const { workflow: reqWorkflow } = useEffectiveWorkflow('requirement', productId);

  useEffect(() => {
    const ids = [
      initiation?.primaryOwnerId,
      initiation?.createdBy,
    ].filter(Boolean) as string[];
    if (ids.length === 0) return;
    let cancelled = false;
    void getUserCards(ids).then((res) => {
      if (cancelled || !res.success) return;
      setDisplayNames(new Map(res.data.items.map((u) => [u.userId, u.displayName])));
    });
    return () => { cancelled = true; };
  }, [initiation?.createdBy, initiation?.primaryOwnerId]);

  const resolveName = (userId?: string | null) => {
    if (!userId) return '—';
    return displayNames.get(userId) ?? memberNameMap.get(userId) ?? userId;
  };

  const basicRows = useMemo(
    () => (initiation ? buildInitiationBasicInfoRows(initiation, resolveName, productName) : []),
    [initiation, displayNames, members, productName],
  );

  const displayTitle = initiation?.tCode?.trim() || initiation?.planName?.trim() || '内部版本';
  const canRetryReview = initiation?.status === 'review_failed' && initiation.createdBy === currentUserId;
  const canContinueDecision = initiation?.status === 'decision_pending' && initiation.createdBy === currentUserId;
  const canEditMeeting = Boolean(
    initiation?.reviewMeetingRequired
    && (initiation.createdBy === currentUserId),
  );

  if (loading) return <MapSectionLoader text="正在加载立项详情…" />;

  if (!initiation) {
    return <div className="text-sm text-white/35">未找到立项记录</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-white/90">{displayTitle}</h1>
          <p className="mt-1 text-xs text-white/40">
            {initiation.planName} · {SCALE_LABEL[initiation.versionType]} · {STATUS_LABEL[initiation.status] ?? initiation.status}
            {initiation.sourceType === 'import' ? ' · 历史导入' : ''}
          </p>
        </div>
        <DetailRecordActions
          kind="initiation"
          productId={productId}
          recordId={initiation.id}
          recordNo={initiation.tCode ?? initiation.id}
          title={displayTitle}
        />
        {canRetryReview && (
          <button
            type="button"
            onClick={() => setRetryOpen(true)}
            className="rounded-lg border border-amber-400/35 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-400/20"
          >
            重新发起立项
          </button>
        )}
        {canContinueDecision && (
          <button
            type="button"
            onClick={() => setRetryOpen(true)}
            className="rounded-lg border border-cyan-400/35 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-400/20"
          >
            继续立项决策
          </button>
        )}
      </div>

      <div className="flex border-b border-white/10">
        <TabButton active={tab === 'basic'} onClick={() => setTab('basic')}>基础信息</TabButton>
        <TabButton active={tab === 'requirements'} onClick={() => setTab('requirements')}>
          需求
          {linkedRequirements.length > 0 && (
            <span className="ml-1.5 rounded-full bg-cyan-400/20 px-1.5 text-[10px] text-cyan-200">{linkedRequirements.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === 'features'} onClick={() => setTab('features')}>
          功能
          {linkedFeatures.length > 0 && (
            <span className="ml-1.5 rounded-full bg-violet-400/20 px-1.5 text-[10px] text-violet-200">{linkedFeatures.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === 'defects'} onClick={() => setTab('defects')}>
          缺陷
          {linkedDefects.length > 0 && (
            <span className="ml-1.5 rounded-full bg-red-400/20 px-1.5 text-[10px] text-red-200">{linkedDefects.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === 'workflow'} onClick={() => setTab('workflow')}>立项详情</TabButton>
      </div>

      {tab === 'basic' && (
        <WorkflowDetailCard title="基础信息">
          <WorkflowAttributeTable rows={basicRows} />
        </WorkflowDetailCard>
      )}

      {tab === 'requirements' && (
        <WorkflowDetailCard title={`关联需求 · ${linkedRequirements.length} 条`}>
          <WorkflowRecordTable
            emptyText="该内部版本暂未关联需求"
            rows={linkedRequirements}
            onRowClick={(id) => navigate(`/product-agent/p/${productId}/requirement/${id}`)}
            columns={requirementDetailColumns(reqWorkflow)}
          />
        </WorkflowDetailCard>
      )}

      {tab === 'features' && (
        <WorkflowDetailCard title={`关联功能 · ${linkedFeatures.length} 条`}>
          <WorkflowRecordTable
            emptyText="该内部版本暂未关联功能"
            rows={linkedFeatures}
            onRowClick={(id) => navigate(`/product-agent/p/${productId}/feature/${id}`)}
            columns={featureDetailColumns()}
          />
        </WorkflowDetailCard>
      )}

      {tab === 'defects' && (
        <WorkflowDetailCard title={`关联缺陷 · ${linkedDefects.length} 条`}>
          <WorkflowRecordTable
            emptyText="该内部版本暂未关联缺陷"
            rows={linkedDefects}
            onRowClick={(id) => navigate(`/product-agent/p/${productId}/defect/${id}`)}
            columns={defectDetailColumns()}
          />
        </WorkflowDetailCard>
      )}

      {tab === 'workflow' && (
        <InitiationWorkflowPanel
          initiation={initiation}
          editableMeeting={canEditMeeting}
          onInitiationChange={setInitiation}
        />
      )}

      {retryOpen && (
        <InitiationWizard
          productId={productId}
          requirements={requirements}
          members={members}
          seed={initiation}
          onClose={() => setRetryOpen(false)}
          onChanged={async () => {
            setRetryOpen(false);
            await reload();
            setTab('workflow');
          }}
        />
      )}

      <div className="flex justify-end border-t border-white/10 pt-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/65 hover:bg-white/10"
        >
          返回
        </button>
      </div>
    </div>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
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
