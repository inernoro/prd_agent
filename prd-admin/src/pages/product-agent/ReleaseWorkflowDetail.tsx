/**
 * 正式版本申领 / 详情 — 基础信息 + 需求 + 功能 + 缺陷四标签页。
 * 路由：/product-agent/p/:productId/release/:id（id=new 为新建）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, Search, X } from 'lucide-react';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { getUserCards } from '@/services/real/teams';
import {
  completeRelease,
  createRelease,
  getInitiation,
  getInheritReleaseManifest,
  getRelease,
  listFeatures,
  listInitiations,
  listProductMembers,
  listReleases,
  listRequirements,
  listTracedDefects,
  updateReleaseFeatureManifest,
  type TracedDefect,
} from '@/services/real/productAgent';
import type {
  Feature,
  FeatureChangeType,
  ProductInitiation,
  ProductMember,
  ProductRelease,
  ReleaseFeatureItem,
  Requirement,
} from './types';
import { useEffectiveWorkflow } from './DynamicForm';
import { WorkflowAttributeTable, WorkflowDetailCard, WorkflowRecordTable } from './workflowDetailUi';
import { buildReleaseBasicInfoRows } from './versionBasicInfoCatalog';
import { defectDetailColumns, featureDetailColumns, requirementDetailColumns } from './versionDetailTables';
import { DetailRecordActions } from './DetailRecordActions';

const SCALE_LABEL = { major: '大版本', medium: '中版本', minor: '小版本' } as const;
const STATUS_LABEL: Record<string, string> = {
  announcement_pending: '待填写上线公告',
  released: '已上线',
};

export const FEATURE_CHANGE_LABEL: Record<FeatureChangeType, string> = {
  added: '新增',
  modified: '优化',
  deprecated: '废弃',
  unchanged: '继承',
};

const CHANGE_BADGE_CLASS: Record<FeatureChangeType, string> = {
  added: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  modified: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  deprecated: 'border-red-400/30 bg-red-400/10 text-red-200',
  unchanged: 'border-white/15 bg-white/5 text-white/45',
};

type DetailTab = 'basic' | 'requirements' | 'manifest' | 'defects';

export function ReleaseWorkflowDetail({
  productId,
  releaseId,
  isNew,
}: {
  productId: string;
  releaseId: string;
  isNew: boolean;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const temporary = searchParams.get('temporary') === '1';
  const currentUser = useAuthStore((state) => state.user);

  const [tab, setTab] = useState<DetailTab>('basic');
  const [loading, setLoading] = useState(true);
  const [release, setRelease] = useState<ProductRelease | null>(null);
  const [initiations, setInitiations] = useState<ProductInitiation[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [members, setMembers] = useState<ProductMember[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [previousReleaseId, setPreviousReleaseId] = useState<string | null>(null);
  const [previousVCode, setPreviousVCode] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ReleaseFeatureItem[]>([]);
  const [baselineManifest, setBaselineManifest] = useState<ReleaseFeatureItem[]>([]);
  const [linkedInitiation, setLinkedInitiation] = useState<ProductInitiation | null>(null);
  const [userDisplayNames, setUserDisplayNames] = useState<Map<string, string>>(new Map());
  const [tracedDefects, setTracedDefects] = useState<TracedDefect[]>([]);
  const [loadError, setLoadError] = useState('');

  const [initiationId, setInitiationId] = useState('');
  const [ownerId, setOwnerId] = useState(currentUser?.userId ?? '');
  const [showOwnerPicker, setShowOwnerPicker] = useState(false);
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [showRequirementPicker, setShowRequirementPicker] = useState(false);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [releaseAt, setReleaseAt] = useState('');
  const [openBrandScope, setOpenBrandScope] = useState('上线全域开放');
  const [announcementUrl, setAnnouncementUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const approved = useMemo(
    () => initiations.filter((item) => item.status === 'approved' && item.tCode),
    [initiations],
  );
  const selectedInitiation = approved.find((item) => item.id === initiationId);
  const featureById = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const readOnly = !isNew && release?.status === 'released';

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    const [initRes, reqRes, memRes, featRes, defRes] = await Promise.all([
      listInitiations(productId, 'mine'),
      listRequirements(productId),
      listProductMembers(productId),
      listFeatures(productId),
      listTracedDefects(productId),
    ]);
    if (initRes.success) setInitiations(initRes.data.items);
    if (reqRes.success) setRequirements(reqRes.data.items);
    if (memRes.success) setMembers(memRes.data.members);
    if (featRes.success) setFeatures(featRes.data.items);
    if (defRes.success) setTracedDefects(defRes.data.items);

    if (isNew) {
      const inheritRes = await getInheritReleaseManifest(productId);
      if (inheritRes.success) {
        setPreviousReleaseId(inheritRes.data.previousReleaseId);
        setPreviousVCode(inheritRes.data.previousVCode ?? null);
        const items = inheritRes.data.items ?? [];
        setManifest(items);
        setBaselineManifest(items);
      }
    } else {
      let releaseData: ProductRelease | null = null;
      const relRes = await getRelease(releaseId);
      if (relRes.success) {
        releaseData = relRes.data;
      } else {
        const listRes = await listReleases(productId, 'all');
        if (listRes.success) {
          releaseData = listRes.data.items.find((item) => item.id === releaseId)
            ?? listRes.data.items.find((item) => item.vCode === releaseId)
            ?? null;
        }
        if (!releaseData) {
          setLoadError(relRes.error?.message ?? '未找到上线记录');
        }
      }
      if (releaseData) {
        setRelease(releaseData);
        setPreviousReleaseId(releaseData.previousReleaseId ?? null);
        setManifest(releaseData.featureManifest ?? []);
        setAnnouncementUrl(releaseData.announcementUrl ?? '');
        if (releaseData.initiationId) {
          const initDetail = await getInitiation(releaseData.initiationId);
          if (initDetail.success) setLinkedInitiation(initDetail.data);
          else setLinkedInitiation(null);
        } else {
          setLinkedInitiation(null);
        }
        if (releaseData.previousReleaseId) {
          const prevRes = await getRelease(releaseData.previousReleaseId);
          if (prevRes.success) {
            setPreviousVCode(prevRes.data.vCode);
            setBaselineManifest(prevRes.data.featureManifest ?? []);
          } else {
            setBaselineManifest(releaseData.featureManifest ?? []);
          }
        } else {
          setBaselineManifest(releaseData.featureManifest ?? []);
        }
      } else {
        setRelease(null);
      }
    }
    setLoading(false);
  }, [isNew, productId, releaseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (currentUser?.userId && !ownerId) setOwnerId(currentUser.userId);
  }, [currentUser?.userId, ownerId]);

  const inheritedRequirementIds = useMemo(() => selectedInitiation?.requirementIds ?? [], [selectedInitiation]);
  const inheritedRequirements = useMemo(
    () => requirements.filter((r) => inheritedRequirementIds.includes(r.id)),
    [inheritedRequirementIds, requirements],
  );
  const additionalRequirements = useMemo(
    () => requirements.filter((r) => !inheritedRequirementIds.includes(r.id)),
    [inheritedRequirementIds, requirements],
  );
  const selectedAdditionalRequirements = useMemo(
    () => requirements.filter((r) => extraIds.includes(r.id)),
    [extraIds, requirements],
  );
  const temporaryPlanName = useMemo(() => {
    if (selectedAdditionalRequirements.length === 0) return '临时优化需求';
    if (selectedAdditionalRequirements.length === 1) return selectedAdditionalRequirements[0].title;
    return `${selectedAdditionalRequirements[0].title}等 ${selectedAdditionalRequirements.length} 项优化需求`;
  }, [selectedAdditionalRequirements]);

  const removedFromPrevious = useMemo(() => {
    if (!previousReleaseId || baselineManifest.length === 0) return [] as ReleaseFeatureItem[];
    const currentIds = new Set(manifest.map((m) => m.featureId));
    return baselineManifest
      .filter((m) => m.changeType !== 'deprecated' && !currentIds.has(m.featureId))
      .map((m) => ({ ...m, changeType: 'deprecated' as FeatureChangeType, changeNote: '本版已移除' }));
  }, [baselineManifest, manifest, previousReleaseId]);

  const changeStats = useMemo(() => {
    const stats = { added: 0, modified: 0, deprecated: 0, unchanged: 0 };
    manifest.forEach((m) => { stats[m.changeType] += 1; });
    stats.deprecated += removedFromPrevious.length;
    return stats;
  }, [manifest, removedFromPrevious]);

  const setItemChangeType = (featureId: string, changeType: FeatureChangeType) => {
    setManifest((items) => items.map((item) => (item.featureId === featureId ? { ...item, changeType } : item)));
  };
  const setItemChangeNote = (featureId: string, changeNote: string) => {
    setManifest((items) => items.map((item) => (item.featureId === featureId ? { ...item, changeNote } : item)));
  };
  const addFeatureToManifest = (featureId: string) => {
    if (manifest.some((m) => m.featureId === featureId)) return;
    const wasInBaseline = baselineManifest.some((m) => m.featureId === featureId);
    setManifest((items) => [
      ...items,
      { featureId, changeType: wasInBaseline ? 'modified' : 'added', changeNote: null },
    ]);
  };
  const removeFeatureFromManifest = (featureId: string) => {
    setManifest((items) => items.filter((m) => m.featureId !== featureId));
  };

  const activeManifest = useMemo(
    () => manifest.filter((m) => m.changeType !== 'deprecated'),
    [manifest],
  );

  const releaseRequirements = useMemo(
    () => (release ? requirements.filter((r) => release.requirementIds.includes(r.id)) : []),
    [release, requirements],
  );
  const memberNameMap = useMemo(() => new Map(members.map((m) => [m.userId, m.displayName])), [members]);

  useEffect(() => {
    if (!release) return;
    const ids = [release.ownerId, ...release.teamMemberIds].filter(Boolean) as string[];
    if (ids.length === 0) return;
    let cancelled = false;
    void getUserCards(ids).then((res) => {
      if (cancelled || !res.success) return;
      setUserDisplayNames(new Map(res.data.items.map((u) => [u.userId, u.displayName])));
    });
    return () => { cancelled = true; };
  }, [release]);

  const resolveUserName = (userId?: string | null) => {
    if (!userId) return '—';
    return userDisplayNames.get(userId) ?? memberNameMap.get(userId) ?? userId;
  };

  const { workflow: reqWorkflow } = useEffectiveWorkflow('requirement', productId);
  const isRecordDetail = !isNew && !!release;
  const isPendingWorkflow = isRecordDetail && release?.status === 'announcement_pending';
  const canCompleteRelease = isPendingWorkflow && release?.sourceType !== 'import';

  const releaseLinkedFeatures = useMemo(() => {
    if (!release) return [] as Feature[];
    const manifestIds = new Set((release.featureManifest ?? []).map((m) => m.featureId));
    return features.filter((f) => f.officialReleaseId === release.id || manifestIds.has(f.id));
  }, [features, release]);

  const releaseDefects = useMemo(() => {
    if (!release) return [] as TracedDefect[];
    const reqIds = new Set(release.requirementIds);
    const featureIds = new Set(releaseLinkedFeatures.map((f) => f.id));
    return tracedDefects.filter((d) =>
      (d.tracedRequirementId && reqIds.has(d.tracedRequirementId))
      || (d.tracedFeatureId && featureIds.has(d.tracedFeatureId)));
  }, [release, releaseLinkedFeatures, tracedDefects]);

  const releaseBasicRows = useMemo(
    () => (release ? buildReleaseBasicInfoRows(release, resolveUserName) : []),
    [release, userDisplayNames, members],
  );

  const saveNew = async () => {
    setBusy(true);
    setMessage('');
    const res = await createRelease(productId, {
      initiationId: temporary ? undefined : initiationId,
      isTemporaryOptimization: temporary,
      planName: temporary ? temporaryPlanName : undefined,
      ownerId,
      openBrandScope,
      additionalRequirementIds: extraIds,
      teamMemberIds: teamIds,
      plannedReleaseAt: new Date(`${releaseAt}T00:00:00`).toISOString(),
      previousReleaseId: previousReleaseId ?? undefined,
      featureManifest: activeManifest,
    });
    setBusy(false);
    if (!res.success) {
      setMessage(res.error?.message ?? '申领失败');
      return;
    }
    navigate(`/product-agent/p/${productId}/release/${res.data.id}`, { replace: true });
  };

  const saveManifest = async () => {
    if (!release) return;
    setBusy(true);
    setMessage('');
    const res = await updateReleaseFeatureManifest(release.id, {
      previousReleaseId: previousReleaseId ?? undefined,
      featureManifest: activeManifest,
    });
    setBusy(false);
    if (!res.success) setMessage(res.error?.message ?? '保存失败');
    else {
      setRelease(res.data);
      setManifest(res.data.featureManifest ?? []);
    }
  };

  const complete = async () => {
    if (!release) return;
    setBusy(true);
    const res = await completeRelease(release.id, announcementUrl.trim());
    setBusy(false);
    if (!res.success) setMessage(res.error?.message ?? '完成上线失败');
    else setRelease(res.data);
  };

  const basicInvalid = !ownerId || !releaseAt || teamIds.length === 0
    || (temporary ? extraIds.length === 0 : !initiationId);
  const manifestInvalid = activeManifest.length === 0;
  const releaseDisplayTitle = useMemo(() => {
    if (!release) return '正式版本';
    return release.vCode?.trim()
      || release.legacyData?.['正式版本号']?.trim()
      || release.planName?.trim()
      || '正式版本';
  }, [release]);

  if (loading) return <MapSectionLoader text="正在加载版本详情…" />;

  if (!isNew && !release) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <div className="text-sm text-white/50">{loadError || '未找到上线记录'}</div>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/65 hover:bg-white/10"
        >
          返回
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-white/90">
            {isNew ? (temporary ? '临时优化需求上线' : '申领正式版本号') : releaseDisplayTitle}
          </h1>
          {!isNew && release && (
            <p className="mt-1 text-xs text-white/40">
              {release.planName} · {SCALE_LABEL[release.versionType]} · {STATUS_LABEL[release.status] ?? release.status}
              {release.sourceType === 'import' ? ' · 历史导入' : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isNew && release?.status === 'announcement_pending' && (
            <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-xs text-amber-200">
              待填写上线公告
            </span>
          )}
          {!isNew && release && (
            <DetailRecordActions
              kind="release"
              productId={productId}
              recordId={release.id}
              recordNo={release.vCode || release.id}
              title={releaseDisplayTitle}
            />
          )}
        </div>
      </div>

      <div className="flex border-b border-white/10">
        <TabButton active={tab === 'basic'} onClick={() => setTab('basic')}>基础信息</TabButton>
        <TabButton active={tab === 'requirements'} onClick={() => setTab('requirements')}>
          需求
          {(isNew
            ? (temporary ? extraIds.length : inheritedRequirementIds.length + extraIds.length)
            : releaseRequirements.length) > 0 && (
            <span className="ml-1.5 rounded-full bg-cyan-400/20 px-1.5 text-[10px] text-cyan-200">
              {isNew
                ? (temporary ? extraIds.length : inheritedRequirementIds.length + extraIds.length)
                : releaseRequirements.length}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === 'manifest'} onClick={() => setTab('manifest')}>
          功能
          {(isNew
            ? changeStats.added + changeStats.modified + changeStats.deprecated
            : releaseLinkedFeatures.length) > 0 && (
            <span className="ml-1.5 rounded-full bg-cyan-400/20 px-1.5 text-[10px] text-cyan-200">
              {isNew
                ? changeStats.added + changeStats.modified + changeStats.deprecated
                : releaseLinkedFeatures.length}
            </span>
          )}
        </TabButton>
        {!isNew && (
          <TabButton active={tab === 'defects'} onClick={() => setTab('defects')}>
            缺陷
            {releaseDefects.length > 0 && (
              <span className="ml-1.5 rounded-full bg-red-400/20 px-1.5 text-[10px] text-red-200">{releaseDefects.length}</span>
            )}
          </TabButton>
        )}
      </div>

      {isRecordDetail ? (
        <>
          {tab === 'basic' && (
            <WorkflowDetailCard title="基础信息">
              <WorkflowAttributeTable rows={releaseBasicRows} />
              {canCompleteRelease && (
                <div className="mt-4 border-t border-white/10 pt-4">
                  <Field label="上线公告地址 *">
                    <Input value={announcementUrl} onChange={(e) => setAnnouncementUrl(e.target.value)} placeholder="粘贴公告地址" />
                  </Field>
                </div>
              )}
              {linkedInitiation && (
                <div className="mt-4 border-t border-white/10 pt-3 text-xs text-white/45">
                  来源立项：
                  <button
                    type="button"
                    onClick={() => navigate(`/product-agent/p/${productId}/initiation/${linkedInitiation.id}`)}
                    className="ml-1 font-mono text-cyan-300 hover:underline"
                  >
                    {linkedInitiation.tCode}
                  </button>
                </div>
              )}
            </WorkflowDetailCard>
          )}
          {tab === 'requirements' && (
            <WorkflowDetailCard title={`关联需求 · ${releaseRequirements.length} 条`}>
              <WorkflowRecordTable
                emptyText="该正式版本未关联需求"
                rows={releaseRequirements}
                onRowClick={(id) => navigate(`/product-agent/p/${productId}/requirement/${id}`)}
                columns={requirementDetailColumns(reqWorkflow)}
              />
            </WorkflowDetailCard>
          )}
          {tab === 'manifest' && (
            <WorkflowDetailCard title={`功能清单 · ${releaseLinkedFeatures.length} 条`}>
              <WorkflowRecordTable
                emptyText="该正式版本下还没有功能记录"
                rows={releaseLinkedFeatures}
                onRowClick={(id) => navigate(`/product-agent/p/${productId}/feature/${id}`)}
                columns={featureDetailColumns()}
              />
              {canCompleteRelease && (
                <div className="mt-4 border-t border-white/10 pt-4">
                  <FeatureManifestPanel
                    navigate={navigate}
                    productId={productId}
                    features={features}
                    featureById={featureById}
                    manifest={manifest}
                    removedFromPrevious={removedFromPrevious}
                    previousVCode={previousVCode}
                    readOnly={readOnly}
                    onAdd={addFeatureToManifest}
                    onRemove={removeFeatureFromManifest}
                    onChangeType={setItemChangeType}
                    onChangeNote={setItemChangeNote}
                  />
                </div>
              )}
            </WorkflowDetailCard>
          )}
          {tab === 'defects' && (
            <WorkflowDetailCard title={`关联缺陷 · ${releaseDefects.length} 条`}>
              <WorkflowRecordTable
                emptyText="该正式版本未关联缺陷"
                rows={releaseDefects}
                onRowClick={(id) => navigate(`/product-agent/p/${productId}/defect/${id}`)}
                columns={defectDetailColumns()}
              />
            </WorkflowDetailCard>
          )}
        </>
      ) : tab === 'basic' ? (
        <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-5">
          {isNew ? (
            <>
              <Field label="产品负责人（申领人）*">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    {showOwnerPicker
                      ? <UserSearchSelect value={ownerId} onChange={setOwnerId} placeholder="搜索 MAP 账户" />
                      : <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white">{currentUser?.displayName ?? ownerId}</div>}
                  </div>
                  {!readOnly && (
                    <button type="button" onClick={() => setShowOwnerPicker(true)} aria-label="更换产品负责人"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 hover:border-cyan-400/40 hover:text-cyan-200">
                      <Plus size={16} />
                    </button>
                  )}
                </div>
              </Field>
              {!temporary && (
                <>
                  <Field label="立项号 *">
                    <Select value={initiationId} onChange={(e) => setInitiationId(e.target.value)} disabled={readOnly}>
                      <option value="">请选择</option>
                      {approved.map((i) => <option key={i.id} value={i.id}>{i.tCode} · {i.planName}</option>)}
                    </Select>
                  </Field>
                  {selectedInitiation && (
                    <InfoBox>
                      <b>方案：</b>{selectedInitiation.planName}<br />
                      <b>级别：</b>{SCALE_LABEL[selectedInitiation.versionType]}<br />
                      <b>关联需求：</b>{inheritedRequirementIds.length} 条（在「需求」标签页查看与追加）
                    </InfoBox>
                  )}
                </>
              )}
              {temporary && (
                <InfoBox>临时优化需求请在「需求」标签页选择要上线的需求条目。</InfoBox>
              )}
              <Field label="项目组成员 *"><MemberChecks members={members} selected={teamIds} onChange={setTeamIds} /></Field>
              <Field label="上线日期 *"><Input type="date" value={releaseAt} onChange={(e) => setReleaseAt(e.target.value)} /></Field>
              <Field label="当前开放品牌"><Input value={openBrandScope} onChange={(e) => setOpenBrandScope(e.target.value)} placeholder="上线全域开放" /></Field>
              <InfoBox>确认后自动审批并生成正式版本号，随后必须补充上线公告地址才能完成上线。</InfoBox>
            </>
          ) : null}
        </div>
      ) : tab === 'requirements' ? (
        <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-5">
          {isNew ? (
            temporary ? (
              <Field label="选择要上线的需求 *">
                <RequirementChecks requirements={requirements} selected={extraIds} onChange={setExtraIds} />
              </Field>
            ) : (
              <>
                <RequirementSummary title="立项继承需求（只读）" requirements={inheritedRequirements} emptyText="所选立项暂未关联需求" />
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs text-white/50">追加需求</span>
                    <button type="button" onClick={() => setShowRequirementPicker((v) => !v)} aria-label="搜索并新增需求"
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/60 hover:border-cyan-400/40 hover:text-cyan-200">
                      <Plus size={14} />
                    </button>
                  </div>
                  {selectedAdditionalRequirements.length > 0
                    ? <div className="mb-2 flex flex-wrap gap-2">{selectedAdditionalRequirements.map((r) =>
                        <span key={r.id} className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-xs text-cyan-100">
                          {r.requirementNo} {r.title}
                          <button type="button" onClick={() => setExtraIds((ids) => ids.filter((id) => id !== r.id))} className="text-cyan-100/55 hover:text-cyan-100"><X size={12} /></button>
                        </span>)}
                    </div>
                    : <div className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-xs text-white/35">点击右侧 + 搜索并选择需要追加的需求</div>}
                  {showRequirementPicker && (
                    <RequirementChecks requirements={additionalRequirements} selected={extraIds} onChange={setExtraIds} />
                  )}
                </div>
              </>
            )
          ) : null}
        </div>
      ) : (
        <FeatureManifestPanel
          navigate={navigate}
          productId={productId}
          features={features}
          featureById={featureById}
          manifest={manifest}
          removedFromPrevious={removedFromPrevious}
          previousVCode={previousVCode}
          readOnly={readOnly}
          onAdd={addFeatureToManifest}
          onRemove={removeFeatureFromManifest}
          onChangeType={setItemChangeType}
          onChangeNote={setItemChangeNote}
        />
      )}

      {message && <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">{message}</div>}

      <div className="flex justify-end gap-2 border-t border-white/10 pt-4">
        {isRecordDetail ? (
          canCompleteRelease ? (
            <>
              <SecondaryButton onClick={() => navigate(-1)}>取消</SecondaryButton>
              {!readOnly && (
                <SecondaryButton onClick={() => void saveManifest()} disabled={busy || manifestInvalid}>
                  保存功能清单
                </SecondaryButton>
              )}
              <PrimaryButton onClick={() => void complete()} disabled={busy || !announcementUrl.trim()}>
                完成上线
              </PrimaryButton>
            </>
          ) : (
            <SecondaryButton onClick={() => navigate(-1)}>返回</SecondaryButton>
          )
        ) : (
          <>
            <SecondaryButton onClick={() => navigate(-1)}>取消</SecondaryButton>
            {isNew ? (
              <PrimaryButton
                onClick={() => void saveNew()}
                disabled={busy || basicInvalid || manifestInvalid}
              >
                {busy ? <><Loader2 size={14} className="animate-spin" /> 处理中...</> : '确认并获取正式版本号'}
              </PrimaryButton>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function FeatureManifestPanel({
  navigate,
  productId,
  features,
  featureById,
  manifest,
  removedFromPrevious,
  previousVCode,
  readOnly,
  onAdd,
  onRemove,
  onChangeType,
  onChangeNote,
}: {
  navigate: ReturnType<typeof useNavigate>;
  productId: string;
  features: Feature[];
  featureById: Map<string, Feature>;
  manifest: ReleaseFeatureItem[];
  removedFromPrevious: ReleaseFeatureItem[];
  previousVCode: string | null;
  readOnly: boolean;
  onAdd: (featureId: string) => void;
  onRemove: (featureId: string) => void;
  onChangeType: (featureId: string, changeType: FeatureChangeType) => void;
  onChangeNote: (featureId: string, changeNote: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const inManifest = useMemo(() => new Set(manifest.map((m) => m.featureId)), [manifest]);
  const available = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return features.filter((f) => {
      if (inManifest.has(f.id)) return false;
      if (!keyword) return true;
      return `${f.featureNo} ${f.title}`.toLowerCase().includes(keyword);
    });
  }, [features, inManifest, query]);

  return (
    <div className="flex flex-col gap-4">
      {previousVCode && (
        <InfoBox>
          已继承上一正式版本 <b className="font-mono text-cyan-200">{previousVCode}</b> 的功能清单。请标注本版相对上一版的变更（新增 / 优化 / 废弃）。
        </InfoBox>
      )}
      {!readOnly && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-white/50">纳入功能</span>
          <button type="button" onClick={() => setShowPicker((v) => !v)}
            className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs text-white/65 hover:border-cyan-400/40 hover:text-cyan-200">
            <Plus size={14} /> 添加功能
          </button>
        </div>
      )}
      {showPicker && !readOnly && (
        <div className="rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="relative mb-2">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索功能编号或标题"
              className="w-full rounded-lg border border-white/10 bg-black/20 py-2 pl-9 pr-3 text-xs text-white outline-none placeholder:text-white/25 focus:border-cyan-400/50" />
          </div>
          <div className="max-h-48 overflow-auto">
            {available.length === 0
              ? <div className="py-4 text-center text-xs text-white/30">没有可添加的功能</div>
              : available.map((f) => (
                  <button key={f.id} type="button" onClick={() => onAdd(f.id)}
                    className="flex w-full items-start gap-2 rounded px-2 py-2 text-left text-xs hover:bg-white/5">
                    <span className="font-mono text-cyan-200/80">{f.featureNo}</span>
                    <span className="text-white/70">{f.title}</span>
                  </button>
                ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {manifest.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-white/35">
            功能清单为空。{previousVCode ? '上一版无记录时' : '首次上线需'}手动添加功能，或先在「功能」库中创建功能条目。
          </div>
        ) : manifest.map((item) => {
          const feature = featureById.get(item.featureId);
          return (
            <ManifestRow
              key={item.featureId}
              featureNo={feature?.featureNo ?? item.featureId}
              title={feature?.title ?? '未知功能'}
              requirementCount={feature?.requirementIds.length ?? 0}
              item={item}
              readOnly={readOnly}
              onOpen={() => navigate(`/product-agent/p/${productId}/feature/${item.featureId}`)}
              onChangeType={onChangeType}
              onChangeNote={onChangeNote}
              onRemove={onRemove}
            />
          );
        })}
      </div>

      {removedFromPrevious.length > 0 && (
        <div>
          <div className="mb-2 text-xs text-white/45">相对上一版移除（{removedFromPrevious.length}）</div>
          <div className="flex flex-col gap-2 opacity-80">
            {removedFromPrevious.map((item) => {
              const feature = featureById.get(item.featureId);
              return (
                <div key={item.featureId} className="flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2.5">
                  <ChangeBadge changeType="deprecated" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white/75 truncate">{feature?.title ?? item.featureId}</div>
                    <div className="text-[11px] font-mono text-white/35">{feature?.featureNo}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ManifestRow({
  featureNo,
  title,
  requirementCount,
  item,
  readOnly,
  onOpen,
  onChangeType,
  onChangeNote,
  onRemove,
}: {
  featureNo: string;
  title: string;
  requirementCount: number;
  item: ReleaseFeatureItem;
  readOnly: boolean;
  onOpen?: () => void;
  onChangeType: (featureId: string, changeType: FeatureChangeType) => void;
  onChangeNote: (featureId: string, changeNote: string) => void;
  onRemove: (featureId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <ChangeBadge changeType={item.changeType} />
        <div className="min-w-0 flex-1">
          {onOpen ? (
            <button type="button" onClick={onOpen} className="text-left text-sm text-cyan-200/90 truncate hover:underline">{title}</button>
          ) : (
            <div className="text-sm text-white/85 truncate">{title}</div>
          )}
          <div className="text-[11px] text-white/35 font-mono mt-0.5">{featureNo} · 实现需求 {requirementCount}</div>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-1">
            {(['unchanged', 'modified', 'added', 'deprecated'] as FeatureChangeType[]).map((type) => (
              <button key={type} type="button" onClick={() => onChangeType(item.featureId, type)}
                className={`rounded px-1.5 py-0.5 text-[10px] border ${item.changeType === type ? CHANGE_BADGE_CLASS[type] : 'border-white/10 text-white/35 hover:bg-white/5'}`}>
                {FEATURE_CHANGE_LABEL[type]}
              </button>
            ))}
            <button type="button" onClick={() => onRemove(item.featureId)} className="ml-1 text-white/35 hover:text-red-300" aria-label="移除">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      {!readOnly && item.changeType !== 'unchanged' && (
        <input value={item.changeNote ?? ''} onChange={(e) => onChangeNote(item.featureId, e.target.value)}
          placeholder="变更说明（可选）"
          className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-white/25 focus:border-cyan-400/40" />
      )}
      {readOnly && item.changeNote && <div className="mt-1.5 text-xs text-white/45">{item.changeNote}</div>}
    </div>
  );
}

function ChangeBadge({ changeType }: { changeType: FeatureChangeType }) {
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${CHANGE_BADGE_CLASS[changeType]}`}>
      {FEATURE_CHANGE_LABEL[changeType]}
    </span>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`border-b-2 px-4 py-2.5 text-sm ${active ? 'border-cyan-400 text-cyan-200' : 'border-transparent text-white/40 hover:text-white/60'}`}>
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label><span className="mb-1.5 block text-xs text-white/50">{label}</span>{children}</label>;
}
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-400/50" />;
}
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className="w-full rounded-lg border border-white/10 bg-[#111318] px-3 py-2 text-sm text-white outline-none">{props.children}</select>;
}
function InfoBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-white/55">{children}</div>;
}
function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-40">{props.children}</button>;
}
function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/65 disabled:opacity-40">{props.children}</button>;
}

function RequirementChecks({ requirements, selected, onChange }: {
  requirements: Requirement[]; selected: string[]; onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return requirements;
    return requirements.filter((r) =>
      r.id.toLowerCase().includes(keyword)
      || r.requirementNo.toLowerCase().includes(keyword)
      || r.title.toLowerCase().includes(keyword));
  }, [query, requirements]);
  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-black/15">
      <div className="border-b border-white/10 p-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索需求 ID 或标题"
            className="w-full rounded-md border border-white/10 bg-black/20 py-2 pl-9 pr-3 text-xs text-white outline-none placeholder:text-white/25 focus:border-cyan-400/50" />
        </div>
      </div>
      <div className="max-h-48 overflow-auto p-2">
        {filtered.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-xs hover:bg-white/5">
            <input type="checkbox" className="mt-0.5 accent-cyan-400" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
            <span className="min-w-0">
              <span className="block font-mono text-cyan-200/80">{r.requirementNo}</span>
              <span className="mt-0.5 block break-words text-white/70">{r.title}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function RequirementSummary({ title, requirements, emptyText }: {
  title: string; requirements: Requirement[]; emptyText: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/15 p-3">
      <div className="mb-2 text-xs text-white/50">{title}</div>
      {requirements.length === 0
        ? <div className="text-xs text-white/35">{emptyText}</div>
        : <div className="space-y-1.5">{requirements.map((r) => (
            <div key={r.id} className="rounded-md bg-white/[0.04] px-2.5 py-2 text-xs text-white/70">
              <span className="mr-2 font-mono text-cyan-200">{r.requirementNo}</span>{r.title}
            </div>))}</div>}
    </div>
  );
}

function MemberChecks({ members, selected, onChange }: {
  members: ProductMember[]; selected: string[]; onChange: (ids: string[]) => void;
}) {
  return (
    <div className="max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/15 p-2">
      {members.length === 0
        ? <div className="p-2 text-xs text-white/30">暂无可选成员</div>
        : members.map((m) => (
            <label key={m.userId} className="flex cursor-pointer gap-2 rounded px-2 py-1.5 text-xs text-white/65 hover:bg-white/5">
              <input type="checkbox" className="accent-cyan-400" checked={selected.includes(m.userId)}
                onChange={() => onChange(selected.includes(m.userId) ? selected.filter((id) => id !== m.userId) : [...selected, m.userId])} />
              {m.displayName}
            </label>))}
    </div>
  );
}

export function ReleaseDetailShell({
  productId,
  releaseId,
  isNew,
}: {
  productId: string;
  releaseId: string;
  isNew: boolean;
}) {
  const navigate = useNavigate();
  return (
    <div className="h-screen min-h-0 flex flex-col bg-[#0f1014]">
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-white/8">
        <button onClick={() => navigate(-1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-white/60 hover:bg-white/5 hover:text-white" title="返回">
          <ArrowLeft size={16} />
        </button>
        <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-200">正式版本</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="w-full px-5 xl:px-8 py-5">
          <ReleaseWorkflowDetail productId={productId} releaseId={releaseId} isNew={isNew} />
        </div>
      </div>
    </div>
  );
}
