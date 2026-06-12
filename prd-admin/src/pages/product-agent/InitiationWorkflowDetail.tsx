/**
 * 内部版本立项详情 — 基础信息 + 需求 + 功能三标签页。
 * 路由：/product-agent/p/:productId/initiation/:id
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getInitiation, listFeatures, listProductMembers, listRequirements } from '@/services/real/productAgent';
import { getUserCards } from '@/services/real/teams';
import type { Feature, ProductInitiation, ProductMember, Requirement } from './types';
import { FeatureLinkList, RequirementLinkList } from './WorkflowObjectLinkList';

const SCALE_LABEL = { major: '大版本', medium: '中版本', minor: '小版本' } as const;
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  review_pending: 'Agent 评审中',
  review_failed: '评审未通过',
  decision_pending: '待确认评审方式',
  owner_pending: '待负责人同意',
  approved: '已取得立项号',
};

type DetailTab = 'basic' | 'requirements' | 'features';

function formatDate(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function formatBool(value?: boolean | null) {
  if (value == null) return '—';
  return value ? '是' : '否';
}

export function InitiationWorkflowDetail({
  productId,
  initiationId,
}: {
  productId: string;
  initiationId: string;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<DetailTab>('basic');
  const [loading, setLoading] = useState(true);
  const [initiation, setInitiation] = useState<ProductInitiation | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [members, setMembers] = useState<ProductMember[]>([]);
  const [displayNames, setDisplayNames] = useState<Map<string, string>>(new Map());

  const reload = useCallback(async () => {
    setLoading(true);
    const [initRes, reqRes, featRes, memRes] = await Promise.all([
      getInitiation(initiationId),
      listRequirements(productId),
      listFeatures(productId),
      listProductMembers(productId),
    ]);
    if (initRes.success) setInitiation(initRes.data);
    if (reqRes.success) setRequirements(reqRes.data.items);
    if (featRes.success) setFeatures(featRes.data.items);
    if (memRes.success) setMembers(memRes.data.members);
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

  const memberNameMap = useMemo(() => new Map(members.map((m) => [m.userId, m.displayName])), [members]);

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

  if (loading) return <MapSectionLoader text="正在加载立项详情…" />;

  if (!initiation) {
    return <div className="text-sm text-white/35">未找到立项记录</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-white/90">
          {initiation.tCode ?? '内部版本立项'}
        </h1>
        <p className="mt-1 text-xs text-white/40">
          {initiation.planName} · {SCALE_LABEL[initiation.versionType]} · {STATUS_LABEL[initiation.status] ?? initiation.status}
        </p>
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
      </div>

      {tab === 'basic' && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 text-sm">
            <InfoRow label="立项号" value={initiation.tCode ?? '—'} mono />
            <InfoRow label="状态" value={STATUS_LABEL[initiation.status] ?? initiation.status} />
            <InfoRow label="方案名称" value={initiation.planName} />
            <InfoRow label="版本级别" value={SCALE_LABEL[initiation.versionType]} />
            <InfoRow label="系统" value={initiation.systemName || '—'} />
            <InfoRow label="应用" value={initiation.appName || '—'} />
            <InfoRow
              label="项目类别"
              value={initiation.projectType === 'custom'
                ? `定制项目${initiation.customerSource ? ` · ${initiation.customerSource}` : ''}`
                : '非定制项目'}
            />
            <InfoRow label="所属部门" value={initiation.departmentName || '—'} />
            <InfoRow label="产品负责人" value={resolveName(initiation.primaryOwnerId ?? initiation.createdBy)} />
            <InfoRow label="开发状态" value={initiation.developmentStatus || '待开发'} />
            <InfoRow label="是否需要 UI 设计" value={formatBool(initiation.needUiDesign)} />
            <InfoRow label="是否 AI POC" value={formatBool(initiation.isAiPoc)} />
            <InfoRow label="Agent 评审得分" value={initiation.reviewScore != null ? String(initiation.reviewScore) : '—'} />
            <InfoRow label="评审是否通过" value={initiation.reviewPassed == null ? '—' : initiation.reviewPassed ? '是' : '否'} />
            <InfoRow label="第一稿会议时间" value={formatDate(initiation.firstDraftMeetingAt)} />
            <InfoRow label="第二稿会议时间" value={formatDate(initiation.secondDraftMeetingAt)} />
            <InfoRow label="第三稿会议时间" value={formatDate(initiation.thirdDraftMeetingAt)} />
            <InfoRow label="立项时间（三稿通过）" value={formatDate(initiation.projectAt)} />
            <InfoRow label="计划立项时间" value={formatDate(initiation.plannedProjectAt)} />
            {initiation.planUrl && (
              <div className="md:col-span-2">
                <div className="text-[11px] text-white/40">方案地址</div>
                <a href={initiation.planUrl} target="_blank" rel="noreferrer" className="mt-0.5 inline-block text-sm text-cyan-300">查看方案</a>
              </div>
            )}
            {initiation.requirementDescription && (
              <div className="md:col-span-2">
                <div className="text-[11px] text-white/40">项目需求描述</div>
                <div className="mt-1 whitespace-pre-wrap text-sm text-white/70">{initiation.requirementDescription}</div>
              </div>
            )}
            {initiation.remark && (
              <div className="md:col-span-2">
                <div className="text-[11px] text-white/40">备注</div>
                <div className="mt-1 text-sm text-white/70">{initiation.remark}</div>
              </div>
            )}
            {initiation.approvalComment && (
              <div className="md:col-span-2">
                <div className="text-[11px] text-white/40">审批意见</div>
                <div className="mt-1 text-sm text-white/70">{initiation.approvalComment}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'requirements' && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <RequirementLinkList
            productId={productId}
            requirements={linkedRequirements}
            emptyText="该立项暂未关联需求，可在版本工作流列表中编辑立项时补充"
          />
        </div>
      )}

      {tab === 'features' && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <p className="mb-3 text-xs text-white/45">
            展示与立项关联需求有实现关系的功能条目。正式版本申领时的功能清单在「正式版本」详情中维护。
          </p>
          <FeatureLinkList
            productId={productId}
            features={linkedFeatures}
            emptyText="暂无与关联需求绑定的功能，请先在功能库中建立需求与功能的关联"
          />
        </div>
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

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-white/40">{label}</div>
      <div className={`mt-0.5 text-white/75 ${mono ? 'font-mono text-cyan-200' : ''}`}>{value}</div>
    </div>
  );
}
