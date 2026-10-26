/**
 * 正式版本申领仅填基础信息；详情和临时优化保留原关联页签。
 * 路由：/product-agent/p/:productId/release/:id（id=new 为新建）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, Search, X } from 'lucide-react';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { loadProductVersionList } from '@/lib/productVersionList';
import { ReleasePlanPicker } from './ReleasePlanPicker';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { getUserCards } from '@/services/real/teams';
import {
  completeRelease,
  createRelease,
  checkReleaseHistory,
  type VersionReleaseHistoryCheck,
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
  type VersionApplicationProduct,
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
import { ProductVersionMessagePaste } from './ProductVersionMessagePaste';
import { useVersionPlanName } from './useVersionPlanName';
import type { VersionRegistrationMessageParseResult } from '@/services/real/productVersionRegistry';
import { VersionCopyActions } from './VersionCopyActions';
import { mergeMemberIds, type PastedMemberMatch } from './releaseMemberMatching';
import { useReleasePastedMembers } from './useReleasePastedMembers';

const SCALE_LABEL = { major: '大版本', medium: '中版本', minor: '小版本' } as const;
const STATUS_LABEL: Record<string, string> = {
  announcement_pending: '待完成上线',
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
  unchanged: 'border-token-subtle bg-token-nested text-token-muted',
};

type DetailTab = 'basic' | 'requirements' | 'manifest' | 'defects';

export function ReleaseWorkflowDetail({
  productId,
  releaseId,
  isNew,
  onClose,
  onCreated,
  temporary: temporaryOverride,
  availableInitiations,
  applicationProducts,
  onApplicationProductChange,
  planLoading,
  planError,
  planProgress,
  onRetryPlans,
}: {
  productId: string;
  releaseId: string;
  isNew: boolean;
  onClose?: () => void;
  onCreated?: (release: ProductRelease, autoCopied: boolean) => void;
  temporary?: boolean;
  availableInitiations?: ProductInitiation[];
  applicationProducts?: VersionApplicationProduct[];
  onApplicationProductChange?: (productId: string) => void;
  planLoading?: boolean;
  planError?: string;
  planProgress?: { completed: number; total: number };
  onRetryPlans?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const issuedState = location.state as { issuedCode?: string; autoCopied?: boolean } | null;
  const [searchParams] = useSearchParams();
  const temporary = temporaryOverride ?? searchParams.get('temporary') === '1';
  const goBack = () => { if (onClose) onClose(); else navigate(-1); };
  const currentUser = useAuthStore((state) => state.user);
  const permissions = useAuthStore((state) => state.permissions ?? []);
  const isRoot = useAuthStore((state) => state.isRoot);
  const canUseProduct = hasEffectivePermission(permissions, 'product-agent.use', isRoot);

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
  const loadSequence = useRef(0);

  const [initiationId, setInitiationId] = useState('');
  const [pastedPlanCandidates, setPastedPlanCandidates] = useState<string[]>([]);
  const [pastedInitiations, setPastedInitiations] = useState<ProductInitiation[]>([]);
  const [planMatchHint, setPlanMatchHint] = useState('');
  const [ownerId, setOwnerId] = useState(currentUser?.userId ?? '');
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [showRequirementPicker, setShowRequirementPicker] = useState(false);
  const [teamIds, setTeamIds] = useState<string[]>(currentUser?.userId ? [currentUser.userId] : []);
  const addTeamMembers = useCallback((ids: string[]) => setTeamIds((previous) => mergeMemberIds(previous, ids)), []);
  const pastedMembers = useReleasePastedMembers(isNew && !temporary, addTeamMembers);
  const [releaseAt, setReleaseAt] = useState('');
  const [trainingMinutes, setTrainingMinutes] = useState('');
  const [projectType, setProjectType] = useState<'standard' | 'custom'>('standard');
  const [versionType, setVersionType] = useState<'major' | 'medium' | 'minor'>('minor');
  const planNameDraft = useVersionPlanName();
  const planName = planNameDraft.value;
  const [planUrl, setPlanUrl] = useState('');
  const [demandSource, setDemandSource] = useState('');
  const [requirementDescription, setRequirementDescription] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [projectMembers, setProjectMembers] = useState('');
  const [contractParty, setContractParty] = useState('');
  const [remark, setRemark] = useState('');
  const [isGlobalOpen, setIsGlobalOpen] = useState('');
  const [openBrandScope, setOpenBrandScope] = useState('上线全域开放');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const historyScope = JSON.stringify([productId, initiationId, planName]);
  const historyScopeRef = useRef(historyScope);
  historyScopeRef.current = historyScope;
  const [historyReview, setHistoryReview] = useState<{ scope: string; check: VersionReleaseHistoryCheck; confirmed: boolean } | null>(null);

  const approved = useMemo(
    () => [...new Map([...(availableInitiations ?? initiations), ...pastedInitiations].map((item) => [item.id, item])).values()].filter((item) => item.status === 'approved' && item.tCode),
    [initiations, availableInitiations, pastedInitiations],
  );
  const selectedInitiation = approved.find((item) => item.id === initiationId);
  // 正式申领项目类别以所选T记录为准；临时优化沿用表单类别。
  const effectiveProjectType = !temporary && selectedInitiation ? selectedInitiation.projectType : projectType;
  const effectiveGlobalOpen = temporary ? isGlobalOpen : effectiveProjectType === 'standard' ? 'yes' : 'no';
  const editableOpenBrandScope = !temporary && openBrandScope === '上线全域开放' ? '' : openBrandScope;
  const effectiveOpenBrandScope = temporary ? openBrandScope : effectiveGlobalOpen === 'yes'
    ? '上线全域开放' : editableOpenBrandScope.trim() || '非全域开放';
  const featureById = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const readOnly = !isNew && release?.status === 'released';

  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    if (isNew) {
      setInitiations([]); setRequirements([]); setMembers([]); setFeatures([]); setTracedDefects([]);
      setManifest([]); setBaselineManifest([]); setPreviousReleaseId(null); setPreviousVCode(null);
      if (!productId) { setLoading(false); return; }
      if (!temporary) {
        const [initRes, memRes] = await Promise.all([
          listInitiations(productId, 'all'), listProductMembers(productId),
        ]);
        if (sequence !== loadSequence.current) return;
        if (initRes.success) setInitiations(initRes.data.items);
        if (memRes.success) setMembers(memRes.data.members);
        setLoading(false);
        return;
      }
    }
    const [initRes, reqRes, memRes, featRes, defRes] = await Promise.all([
      listInitiations(productId, 'all'),
      listRequirements(productId),
      listProductMembers(productId),
      listFeatures(productId),
      listTracedDefects(productId),
    ]);
    if (sequence !== loadSequence.current) return;
    if (initRes.success) setInitiations(initRes.data.items);
    if (reqRes.success) setRequirements(reqRes.data.items);
    if (memRes.success) setMembers(memRes.data.members);
    if (featRes.success) setFeatures(featRes.data.items);
    if (defRes.success) setTracedDefects(defRes.data.items);

    if (isNew) {
      const inheritRes = await getInheritReleaseManifest(productId);
      if (sequence !== loadSequence.current) return;
      if (inheritRes.success) {
        setPreviousReleaseId(inheritRes.data.previousReleaseId);
        setPreviousVCode(inheritRes.data.previousVCode ?? null);
        const items = inheritRes.data.items ?? [];
        setManifest(items);
        setBaselineManifest(items);
      } else setLoadError(inheritRes.error?.message ?? '应用版本资料加载失败，请重试。');
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
  }, [isNew, productId, releaseId, temporary]);

  useEffect(() => {
    const request = reload();
    const sequence = loadSequence.current;
    void request.catch(() => {
      if (sequence !== loadSequence.current) return;
      setLoadError('应用资料加载失败，请重新选择方案或应用后重试。'); setLoading(false);
    });
    return () => { loadSequence.current += 1; };
  }, [reload]);

  useEffect(() => {
    if (currentUser?.userId && !ownerId) setOwnerId(currentUser.userId);
  }, [currentUser?.userId, ownerId]);

  useEffect(() => {
    if (!isNew || !ownerId) return;
    setTeamIds((previous) => previous.includes(ownerId) ? previous : [ownerId, ...previous]);
  }, [isNew, ownerId]);

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

  const { workflow: reqWorkflow } = useEffectiveWorkflow('requirement', productId, canUseProduct && Boolean(productId));
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

  const changeApplication = (id: string) => {
    if (!onApplicationProductChange) return;
    if (id !== productId) {
      setExtraIds([]); setShowRequirementPicker(false);
      if (temporary) setTeamIds(ownerId ? [ownerId] : []);
      setManifest([]); setBaselineManifest([]); setPreviousReleaseId(null); setPreviousVCode(null);
      setRequirements([]); setFeatures([]); setMembers([]); setTracedDefects([]);
      setLoading(Boolean(id));
    }
    onApplicationProductChange(id);
  };
  const chooseInitiation = (id: string, matchedSource?: ProductInitiation) => {
    setPastedPlanCandidates([]); setPlanMatchHint('');
    setInitiationId(id);
    const source = matchedSource ?? approved.find((item) => item.id === id);
    if (onApplicationProductChange) {
      changeApplication(source?.productId ?? '');
    }
    if (!source) {
      planNameDraft.setSource(''); setPlanUrl(''); setDemandSource(''); setRequirementDescription('');
      setDepartmentName(''); setOwnerName('');
      if (temporary) setProjectMembers('');
      return;
    }
    setProjectType(source.projectType);
    setVersionType(source.versionType);
    planNameDraft.setSource(source.planName);
    setPlanUrl(source.planUrl ?? '');
    setDemandSource(source.demandSource ?? '');
    setRequirementDescription(source.requirementDescription ?? '');
    setDepartmentName(source.departmentName ?? '');
    setOwnerName(source.ownerName ?? '');
    if (temporary) setProjectMembers((source.projectMemberNames ?? []).join('、'));
  };

  const applyParsedMessage = (parsed: VersionRegistrationMessageParseResult, editVersion?: number) => {
    const parsedInitiations = parsed.initiationCandidates ?? [];
    const source = !temporary && parsed.matchedInitiationId ? parsedInitiations.find((item) => item.id === parsed.matchedInitiationId)
      ?? approved.find((item) => item.id === parsed.matchedInitiationId) : undefined;
    if (!temporary && (parsed.planName || parsed.tCode) && planNameDraft.isCurrentEdit(editVersion)) {
      setPastedInitiations(parsedInitiations);
      const candidates = parsed.candidateInitiationIds ?? [];
      setPastedPlanCandidates(candidates);
      if (source) {
        chooseInitiation(source.id, source);
        setPlanMatchHint(`已匹配立项 ${source.tCode}，按已有方案资料回填。`);
      } else if (candidates.length) {
        setInitiationId(''); changeApplication(parsed.matchedApplicationId ?? '');
        setPlanMatchHint(`匹配到 ${candidates.length} 个相近方案，请选择正确立项。`);
      } else {
        setInitiationId('');
        changeApplication(parsed.matchedApplicationId ?? '');
        setPlanMatchHint('未找到匹配的 T 记录，识别内容已保留。请先在内部版本页面完成 T 号申领，再选择对应方案。');
      }
    }
    if (!source) {
      if (parsed.projectType) setProjectType(parsed.projectType);
      if (parsed.versionType) setVersionType(parsed.versionType);
      if (parsed.demandSource) setDemandSource(parsed.demandSource);
      if (parsed.planUrl) setPlanUrl(parsed.planUrl);
      if (parsed.requirementDescription) setRequirementDescription(parsed.requirementDescription);
      if (parsed.departmentName) setDepartmentName(parsed.departmentName);
    }
    if (parsed.planName) planNameDraft.setPasted(parsed.planName, editVersion);
    if (!source && parsed.ownerName) {
      setOwnerName(parsed.ownerName);
      const matchedOwner = members.find((member) => member.displayName === parsed.ownerName);
      if (matchedOwner) setOwnerId(matchedOwner.userId);
    }
    if (parsed.projectMemberNames?.length) {
      if (!temporary) pastedMembers.identify(parsed.projectMemberNames);
      else {
        setProjectMembers(parsed.projectMemberNames.join('、'));
        const matchedIds = members.filter((member) => parsed.projectMemberNames?.includes(member.displayName)).map((member) => member.userId);
        if (matchedIds.length) setTeamIds(matchedIds);
      }
    }
    if (parsed.plannedReleaseAt) setReleaseAt(parsed.plannedReleaseAt.slice(0, 10));
    if (parsed.plannedTrainingMinutes != null) setTrainingMinutes(String(parsed.plannedTrainingMinutes));
    if (temporary && parsed.isGlobalOpen != null) setIsGlobalOpen(parsed.isGlobalOpen ? 'yes' : 'no');
  };

  const saveNew = async () => {
    if (!temporary && !planName.trim()) {
      setMessage('请填写产品方案名称');
      return;
    }
    if (pastedMembers.pendingCount > 0) {
      setMessage('正在匹配企微成员，请稍候并核对名单后申领。');
      return;
    }
    if (loadError || loading || !productId || (!temporary && selectedInitiation?.productId !== productId)) {
      setMessage('请先选择已通过且已取得 T 号的方案。');
      return;
    }
    if (!releaseAt || trainingMinutes.trim() === '' || !Number.isInteger(Number(trainingMinutes)) || Number(trainingMinutes) < 0 || Number(trainingMinutes) > 2147483647) {
      setMessage('请填写上线日期和预计培训时长（非负整数分钟）');
      return;
    }
    setBusy(true);
    setMessage('');
    let historyConfirmationToken: string | undefined;
    if (!temporary) {
      const checked = await checkReleaseHistory(productId, {
        initiationId,
        planName: planName.trim() || undefined,
      });
      if (historyScopeRef.current !== historyScope) {
        setBusy(false); setMessage('方案或应用已变化，请重新核对后申领。'); return;
      }
      if (!checked.success) {
        setBusy(false); setMessage(checked.error.message); return;
      }
      if (checked.data.blocked) {
        setBusy(false); setHistoryReview({ scope: historyScope, check: checked.data, confirmed: false });
        setMessage(checked.data.message); return;
      }
      if (checked.data.needsConfirmation) {
        if (!historyReview?.confirmed || historyReview.scope !== historyScope
            || historyReview.check.confirmationToken !== checked.data.confirmationToken) {
          setBusy(false); setHistoryReview({ scope: historyScope, check: checked.data, confirmed: false });
          setMessage(checked.data.message); return;
        }
        historyConfirmationToken = checked.data.confirmationToken ?? undefined;
      }
    }
    const res = await createRelease(productId, {
      historyConfirmationToken,
      initiationId: temporary ? undefined : initiationId,
      isTemporaryOptimization: temporary,
      planName: temporary ? temporaryPlanName : planName.trim() || undefined,
      ownerId,
      openBrandScope: effectiveOpenBrandScope,
      isGlobalOpen: effectiveGlobalOpen === '' ? undefined : effectiveGlobalOpen === 'yes',
      demandSource: demandSource.trim() || undefined,
      planUrl: planUrl.trim() || undefined,
      departmentName: departmentName.trim() || undefined,
      ownerName: temporary ? ownerName.trim() || undefined : undefined,
      ...(temporary ? {
        projectMemberNames: projectMembers.split(/[、,，;；]/).map((name) => name.trim()).filter(Boolean),
        requirementDescription: requirementDescription.trim() || undefined,
        contractParty: contractParty.trim() || undefined,
      } : {}),
      remark: remark.trim() || undefined,
      projectType: effectiveProjectType,
      versionType,
      additionalRequirementIds: temporary ? extraIds : undefined,
      teamMemberIds: teamIds,
      plannedReleaseAt: new Date(`${releaseAt}T00:00:00+08:00`).toISOString(),
      plannedTrainingMinutes: Number(trainingMinutes),
      previousReleaseId: temporary ? previousReleaseId ?? undefined : undefined,
      featureManifest: temporary ? activeManifest : undefined,
    });
    setBusy(false);
    if (!res.success) {
      setMessage(res.error?.message ?? '申领失败');
      return;
    }
    let autoCopied = false;
    try {
      await navigator.clipboard.writeText(res.data.vCode);
      autoCopied = true;
    } catch {
      // 详情页保留手动复制入口。
    }
    if (onCreated) onCreated(res.data, autoCopied);
    else navigate(`/product-agent/p/${productId}/release/${res.data.id}`, { replace: true, state: { issuedCode: res.data.vCode, autoCopied } });
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
    const res = await completeRelease(release.id);
    setBusy(false);
    if (!res.success) setMessage(res.error?.message ?? '完成上线失败');
    else setRelease(res.data);
  };

  const basicInvalid = loading || Boolean(loadError) || !productId || !ownerId || !releaseAt || trainingMinutes.trim() === '' || !Number.isInteger(Number(trainingMinutes)) || Number(trainingMinutes) < 0 || Number(trainingMinutes) > 2147483647 || !effectiveGlobalOpen || pastedMembers.pendingCount > 0 || teamIds.length === 0
    || (!temporary && selectedInitiation?.productId !== productId)
    || (temporary ? extraIds.length === 0 : !initiationId || !planName.trim());
  const manifestInvalid = activeManifest.length === 0;
  const releaseDisplayTitle = useMemo(() => {
    if (!release) return '正式版本';
    return release.vCode?.trim()
      || release.legacyData?.['正式版本号']?.trim()
      || release.planName?.trim()
      || '正式版本';
  }, [release]);

  if (loading && !isNew) return <MapSectionLoader text="正在加载版本详情…" />;

  if (!isNew && !release) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <div className="text-sm text-token-secondary">{loadError || '未找到上线记录'}</div>
        <button
          type="button"
          onClick={goBack}
          className="rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-xs text-token-secondary hover-bg-soft"
        >
          返回
        </button>
      </div>
    );
  }

  const ownerField = <Field label="产品负责人 *">
    <UserSearchSelect value={ownerId} onChange={setOwnerId} selectedUser={ownerId === currentUser?.userId ? currentUser : undefined} placeholder="搜索并选择产品负责人" />
  </Field>;
  const memberField = <div role="group" aria-label="项目组成员">
    <span className="mb-2 block text-xs text-token-secondary">项目组成员 *</span>
    <MemberChecks compact={!temporary} members={members} selected={teamIds} onChange={setTeamIds} pastedMatches={pastedMembers.matches} onChoosePasted={pastedMembers.choose} />
  </div>;
  const scheduleFields = <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
    <Field label="上线日期 *"><Input type="date" value={releaseAt} onChange={(e) => setReleaseAt(e.target.value)} /></Field>
    <Field label="预计培训时长（分钟）*"><Input type="number" min={0} max={2147483647} step={1} value={trainingMinutes} onChange={(e) => setTrainingMinutes(e.target.value)} placeholder="填写分钟数，例如 30" /></Field>
    <Field label="是否全域开放">{temporary
      ? <Select value={isGlobalOpen} onChange={(e) => setIsGlobalOpen(e.target.value)}><option value="">请选择</option><option value="yes">是</option><option value="no">否</option></Select>
      : <span className="block py-2 text-sm text-token-secondary">{effectiveGlobalOpen === 'yes' ? '是（非定制项目）' : '否（定制项目）'}</span>}</Field>
    <Field label="当前开放品牌">{!temporary && effectiveGlobalOpen === 'yes'
      ? <span className="block py-2 text-sm text-token-secondary">上线全域开放</span>
      : <Input value={editableOpenBrandScope} onChange={(e) => setOpenBrandScope(e.target.value)} placeholder={temporary ? '上线全域开放' : '填写本次开放的品牌'} />}</Field>
  </div>;
  const supplementaryFields = <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
    {!temporary && <div className="sm:col-span-2"><Field label="产品方案名称 *"><Input value={planName} onChange={(e) => planNameDraft.setManual(e.target.value)} placeholder="可粘贴识别、自动回填或手动修改" /></Field></div>}
    <Field label="需求来源"><Input value={demandSource} onChange={(e) => setDemandSource(e.target.value)} /></Field>
    <Field label="所属部门"><Input value={departmentName} onChange={(e) => setDepartmentName(e.target.value)} /></Field>
    <div className="sm:col-span-2"><Field label="方案地址"><Input value={planUrl} onChange={(e) => setPlanUrl(e.target.value)} placeholder="https://" /></Field></div>
    {temporary && <Field label="产品负责人名称"><Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></Field>}
    {temporary && <Field label="项目组成员名称"><Input value={projectMembers} onChange={(e) => setProjectMembers(e.target.value)} placeholder="企微通知中的姓名，用顿号分隔" /></Field>}
    {temporary && <Field label="合同签订方"><Input value={contractParty} onChange={(e) => setContractParty(e.target.value)} /></Field>}
    {temporary && <Field label="项目需求描述"><textarea value={requirementDescription} onChange={(e) => setRequirementDescription(e.target.value)} rows={3} className="w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none focus:border-cyan-400/50" /></Field>}
    <div className="sm:col-span-2"><Field label="备注"><textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} className="w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none focus:border-cyan-400/50" /></Field></div>
  </div>;

  return (
    <div className="flex flex-col gap-4">
      {loading && isNew && <p role="status" className="flex items-center gap-2 text-xs text-token-secondary"><MapSpinner size={14} />正在回填所属应用的需求、成员和版本资料，可以先填写基础信息…</p>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className={onClose ? 'sr-only' : 'text-lg font-semibold text-token-primary'}>
            {isNew ? (temporary ? '临时优化需求上线' : '申领正式版本号') : releaseDisplayTitle}
          </h1>
          {!isNew && release && (
            <p className="mt-1 text-xs text-token-muted">
              {release.planName} · {SCALE_LABEL[release.versionType]} · {STATUS_LABEL[release.status] ?? release.status}
              {release.sourceType === 'import' ? ' · 历史导入' : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isNew && release?.status === 'announcement_pending' && (
            <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-xs text-[color:var(--accent-fg-amber)]">
              待完成上线
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

      {!isNew && release && <>
        {issuedState?.issuedCode === release.vCode && (
          <p role="status" className="rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-3 py-2 text-sm text-token-secondary">
            {release.vCode} 已生成{issuedState?.autoCopied ? '并自动复制' : '；浏览器未允许自动复制，可使用下方按钮'}。
          </p>
        )}
        <VersionCopyActions kind="release" id={release.id} code={release.vCode} />
      </>}

      {(!isNew || temporary) && <div className="flex border-b border-token-subtle">
        <TabButton active={tab === 'basic'} onClick={() => setTab('basic')}>基础信息</TabButton>
        <TabButton active={tab === 'requirements'} onClick={() => setTab('requirements')}>
          需求
          {(isNew
            ? (temporary ? extraIds.length : inheritedRequirementIds.length + extraIds.length)
            : releaseRequirements.length) > 0 && (
            <span className="ml-1.5 rounded-full bg-cyan-400/20 px-1.5 text-[10px] text-[color:var(--accent-fg-blue)]">
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
            <span className="ml-1.5 rounded-full bg-cyan-400/20 px-1.5 text-[10px] text-[color:var(--accent-fg-blue)]">
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
              <span className="ml-1.5 rounded-full bg-red-400/20 px-1.5 text-[10px] text-[color:var(--accent-fg-danger)]">{releaseDefects.length}</span>
            )}
          </TabButton>
        )}
      </div>}

      {isRecordDetail ? (
        <>
          {tab === 'basic' && (
            <WorkflowDetailCard title="基础信息">
              <WorkflowAttributeTable rows={releaseBasicRows} />
              {linkedInitiation && (
                <div className="mt-4 border-t border-token-subtle pt-3 text-xs text-token-muted">
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
                onRowClick={canUseProduct ? (id) => navigate(`/product-agent/p/${productId}/requirement/${id}`) : undefined}
                columns={requirementDetailColumns(reqWorkflow)}
              />
            </WorkflowDetailCard>
          )}
          {tab === 'manifest' && (
            <WorkflowDetailCard title={`功能清单 · ${releaseLinkedFeatures.length} 条`}>
              <WorkflowRecordTable
                emptyText="该正式版本下还没有功能记录"
                rows={releaseLinkedFeatures}
                onRowClick={canUseProduct ? (id) => navigate(`/product-agent/p/${productId}/feature/${id}`) : undefined}
                columns={featureDetailColumns()}
              />
              {canCompleteRelease && (
                <div className="mt-4 border-t border-token-subtle pt-4">
                  <FeatureManifestPanel
                    navigate={navigate}
                    canOpenProductDetails={canUseProduct}
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
                onRowClick={canUseProduct ? (id) => navigate(`/product-agent/p/${productId}/defect/${id}`) : undefined}
                columns={defectDetailColumns()}
              />
            </WorkflowDetailCard>
          )}
        </>
      ) : tab === 'basic' || (isNew && !temporary) ? (
        <div className={isNew && !temporary ? 'space-y-6' : 'space-y-4 rounded-xl border border-token-subtle bg-token-nested p-5'}>
          {isNew ? (
            <>
              <ProductVersionMessagePaste kind="formal" onParsed={applyParsedMessage} getPlanNameEditVersion={planNameDraft.getEditVersion} />
              {temporary ? <>
                {ownerField}
                <InfoBox>临时优化需求请在「需求」标签页选择要上线的需求条目。</InfoBox>
                {memberField}
                {supplementaryFields}
                {scheduleFields}
              </> : <>
                <section aria-label="申领信息" className="space-y-4">
                  <h2 className="text-sm font-semibold text-token-primary">申领信息</h2>
                  <div className="space-y-2">
                      <Field label={applicationProducts ? '所属方案 *' : '立项号 *'}>
                        {applicationProducts ? <ReleasePlanPicker plans={pastedPlanCandidates.length ? approved.filter((item) => pastedPlanCandidates.includes(item.id)) : approved} products={applicationProducts} value={initiationId} onChange={chooseInitiation} loading={planLoading} error={planError} progress={planProgress} onRetry={onRetryPlans} /> : <Select value={initiationId} onChange={(e) => chooseInitiation(e.target.value)} disabled={readOnly}>
                          <option value="">请选择</option>
                          {approved.map((i) => <option key={i.id} value={i.id}>{i.planName}</option>)}
                        </Select>}
                      </Field>
                      {selectedInitiation && <div aria-label="方案关联信息" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-token-muted">
                        <span>已匹配立项 {selectedInitiation.tCode}</span>
                        <span role="status">{applicationProducts?.find((product) => product.id === productId)?.name ?? selectedInitiation.appName}</span>
                        <span>{effectiveProjectType === 'standard' ? '非定制' : '定制'}</span><span>{SCALE_LABEL[versionType]}</span>
                      </div>}
                    {planMatchHint && !selectedInitiation && <p role="status" className="text-xs leading-5 text-token-secondary">{planMatchHint}
                      {pastedPlanCandidates.length > 0 && <button type="button" className="ml-2 hover:underline" onClick={() => { setPastedPlanCandidates([]); setPlanMatchHint(''); }}>查看全部方案</button>}
                    </p>}
                  </div>
                  {ownerField}
                  {memberField}
                </section>
                <section aria-label="上线安排" className="space-y-4 border-t border-token-subtle pt-5">
                  <h2 className="text-sm font-semibold text-token-primary">上线安排</h2>
                  {scheduleFields}
                </section>
                <details className="border-t border-token-subtle pt-4">
                  <summary className="cursor-pointer text-sm text-token-secondary">补充资料<span className="ml-2 text-xs text-token-muted">方案资料、需求来源、备注</span></summary>
                  <div className="pt-4">{supplementaryFields}</div>
                </details>
              </>}
              <p className="text-xs leading-5 text-token-muted">确认后自动生成正式版本号并完成上线，无需人工审批。</p>
            </>
          ) : null}
        </div>
      ) : tab === 'requirements' ? (
        <div className="space-y-4 rounded-xl border border-token-subtle bg-token-nested p-5">
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
                    <span className="text-xs text-token-secondary">追加需求</span>
                    <button type="button" onClick={() => setShowRequirementPicker((v) => !v)} aria-label="搜索并新增需求"
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-token-subtle bg-token-nested text-token-secondary hover:border-cyan-400/40 hover:text-cyan-200">
                      <Plus size={14} />
                    </button>
                  </div>
                  {selectedAdditionalRequirements.length > 0
                    ? <div className="mb-2 flex flex-wrap gap-2">{selectedAdditionalRequirements.map((r) =>
                        <span key={r.id} className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-xs text-[color:var(--accent-fg-blue)]">
                          {r.requirementNo} {r.title}
                          <button type="button" onClick={() => setExtraIds((ids) => ids.filter((id) => id !== r.id))} className="text-cyan-100/55 hover:text-cyan-100"><X size={12} /></button>
                        </span>)}
                    </div>
                    : <div className="rounded-lg border border-dashed border-token-subtle px-3 py-3 text-xs text-token-muted-faint">点击右侧 + 搜索并选择需要追加的需求</div>}
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
          canOpenProductDetails={canUseProduct}
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

      {isNew && !temporary && historyReview?.scope === historyScope && historyReview.check.needsConfirmation && (
        <section aria-label="历史 T/V 对照人工确认" className="space-y-2 rounded-lg border border-token-subtle bg-token-nested p-3 text-xs text-token-secondary">
          <p>以下历史 V 方案名称相近，但没有明确 T 号对照，请先人工核对：</p>
          {historyReview.check.candidates.map((candidate) => <p key={candidate.id} className="break-words">{candidate.vCode}：{candidate.planName}</p>)}
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={historyReview.confirmed} onChange={(event) => setHistoryReview({ ...historyReview, confirmed: event.target.checked })} />
            <span>我已核对，以上历史 V 均不是本次 T 的方案，确认后再次点击申领。若属于同一方案，请查看原 V 号，不要重复申领。</span>
          </label>
        </section>
      )}
      {message && <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-[color:var(--accent-fg-danger)]">{message}</div>}
      {loadError && <div role="alert" className="rounded-lg border border-token-subtle bg-token-nested p-3 text-sm text-token-secondary">{loadError}</div>}

      <div className={isNew && !temporary ? 'sticky bottom-0 z-10 flex justify-end gap-2 border-t border-token-subtle py-3' : 'flex justify-end gap-2 border-t border-token-subtle pt-4'} style={isNew && !temporary ? { background: 'var(--bg-elevated)' } : undefined}>
        {isRecordDetail ? (
          canCompleteRelease ? (
            <>
              <SecondaryButton onClick={goBack}>取消</SecondaryButton>
              {!readOnly && (
                <SecondaryButton onClick={() => void saveManifest()} disabled={busy || manifestInvalid}>
                  保存功能清单
                </SecondaryButton>
              )}
              <PrimaryButton onClick={() => void complete()} disabled={busy}>
                完成上线
              </PrimaryButton>
            </>
          ) : (
            <SecondaryButton onClick={goBack}>返回</SecondaryButton>
          )
        ) : (
          <>
            <SecondaryButton onClick={goBack}>取消</SecondaryButton>
            {isNew ? (
              <PrimaryButton
                onClick={() => void saveNew()}
                disabled={busy || basicInvalid || (temporary && manifestInvalid)}
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
  canOpenProductDetails,
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
  canOpenProductDetails: boolean;
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
          <span className="text-xs text-token-secondary">纳入功能</span>
          <button type="button" onClick={() => setShowPicker((v) => !v)}
            className="flex h-8 items-center gap-1 rounded-lg border border-token-subtle bg-token-nested px-2.5 text-xs text-token-secondary hover:border-cyan-400/40 hover:text-cyan-200">
            <Plus size={14} /> 添加功能
          </button>
        </div>
      )}
      {showPicker && !readOnly && (
        <div className="rounded-xl border border-token-subtle bg-token-nested p-3">
          <div className="relative mb-2">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-token-muted-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索功能编号或标题"
              className="w-full rounded-lg border border-token-subtle bg-token-nested py-2 pl-9 pr-3 text-xs text-token-primary outline-none placeholder-token-muted focus:border-cyan-400/50" />
          </div>
          <div className="max-h-48 overflow-auto">
            {available.length === 0
              ? <div className="py-4 text-center text-xs text-token-muted-faint">没有可添加的功能</div>
              : available.map((f) => (
                  <button key={f.id} type="button" onClick={() => onAdd(f.id)}
                    className="flex w-full items-start gap-2 rounded px-2 py-2 text-left text-xs hover-bg-soft">
                    <span className="font-mono text-cyan-200/80">{f.featureNo}</span>
                    <span className="text-token-secondary">{f.title}</span>
                  </button>
                ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {manifest.length === 0 ? (
          <div className="rounded-xl border border-dashed border-token-subtle px-4 py-10 text-center text-sm text-token-muted-faint">
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
              onOpen={canOpenProductDetails ? () => navigate(`/product-agent/p/${productId}/feature/${item.featureId}`) : undefined}
              onChangeType={onChangeType}
              onChangeNote={onChangeNote}
              onRemove={onRemove}
            />
          );
        })}
      </div>

      {removedFromPrevious.length > 0 && (
        <div>
          <div className="mb-2 text-xs text-token-muted">相对上一版移除（{removedFromPrevious.length}）</div>
          <div className="flex flex-col gap-2 opacity-80">
            {removedFromPrevious.map((item) => {
              const feature = featureById.get(item.featureId);
              return (
                <div key={item.featureId} className="flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2.5">
                  <ChangeBadge changeType="deprecated" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-token-primary truncate">{feature?.title ?? item.featureId}</div>
                    <div className="text-[11px] font-mono text-token-muted-faint">{feature?.featureNo}</div>
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
    <div className="rounded-lg border border-token-subtle bg-token-nested px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <ChangeBadge changeType={item.changeType} />
        <div className="min-w-0 flex-1">
          {onOpen ? (
            <button type="button" onClick={onOpen} className="text-left text-sm text-cyan-200/90 truncate hover:underline">{title}</button>
          ) : (
            <div className="text-sm text-token-primary truncate">{title}</div>
          )}
          <div className="text-[11px] text-token-muted-faint font-mono mt-0.5">{featureNo} · 实现需求 {requirementCount}</div>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-1">
            {(['unchanged', 'modified', 'added', 'deprecated'] as FeatureChangeType[]).map((type) => (
              <button key={type} type="button" onClick={() => onChangeType(item.featureId, type)}
                className={`rounded px-1.5 py-0.5 text-[10px] border ${item.changeType === type ? CHANGE_BADGE_CLASS[type] : 'border-token-subtle text-token-muted-faint hover-bg-soft'}`}>
                {FEATURE_CHANGE_LABEL[type]}
              </button>
            ))}
            <button type="button" onClick={() => onRemove(item.featureId)} className="ml-1 text-token-muted-faint hover:text-red-300" aria-label="移除">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      {!readOnly && item.changeType !== 'unchanged' && (
        <input value={item.changeNote ?? ''} onChange={(e) => onChangeNote(item.featureId, e.target.value)}
          placeholder="变更说明（可选）"
          className="mt-2 w-full rounded-md border border-token-subtle bg-token-nested px-2.5 py-1.5 text-xs text-token-primary outline-none placeholder-token-muted focus:border-cyan-400/40" />
      )}
      {readOnly && item.changeNote && <div className="mt-1.5 text-xs text-token-muted">{item.changeNote}</div>}
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
    <button onClick={onClick} className={`border-b-2 px-4 py-2.5 text-sm ${active ? 'border-cyan-400 text-cyan-200' : 'border-transparent text-token-muted hover-text-primary'}`}>
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-xs text-token-secondary">{label}</span>{children}</label>;
}
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none placeholder-token-muted focus:border-cyan-400/50" />;
}
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className="w-full rounded-lg border border-token-subtle bg-token-card px-3 py-2 text-sm text-token-primary outline-none">{props.children}</select>;
}
function InfoBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-token-subtle bg-token-nested p-3 text-xs leading-5 text-token-secondary">{children}</div>;
}
function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-40">{props.children}</button>;
}
function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-xs text-token-secondary disabled:opacity-40">{props.children}</button>;
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
    <div className="overflow-hidden rounded-lg border border-token-subtle bg-token-nested">
      <div className="border-b border-token-subtle p-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-token-muted-faint" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索需求 ID 或标题"
            className="w-full rounded-md border border-token-subtle bg-token-nested py-2 pl-9 pr-3 text-xs text-token-primary outline-none placeholder-token-muted focus:border-cyan-400/50" />
        </div>
      </div>
      <div className="max-h-48 overflow-auto p-2">
        {filtered.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-xs hover-bg-soft">
            <input type="checkbox" className="mt-0.5 accent-cyan-400" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
            <span className="min-w-0">
              <span className="block font-mono text-cyan-200/80">{r.requirementNo}</span>
              <span className="mt-0.5 block break-words text-token-secondary">{r.title}</span>
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
    <div className="rounded-lg border border-token-subtle bg-token-nested p-3">
      <div className="mb-2 text-xs text-token-secondary">{title}</div>
      {requirements.length === 0
        ? <div className="text-xs text-token-muted-faint">{emptyText}</div>
        : <div className="space-y-1.5">{requirements.map((r) => (
            <div key={r.id} className="rounded-md bg-token-nested px-2.5 py-2 text-xs text-token-secondary">
              <span className="mr-2 font-mono text-cyan-200">{r.requirementNo}</span>{r.title}
            </div>))}</div>}
    </div>
  );
}

function MemberChecks({ members, selected, onChange, pastedMatches, onChoosePasted, compact = false }: {
  members: ProductMember[]; selected: string[]; onChange: (ids: string[]) => void;
  pastedMatches: PastedMemberMatch[]; onChoosePasted: (name: string, userId: string) => void;
  compact?: boolean;
}) {
  const currentUser = useAuthStore((state) => state.user);
  const [extraNames, setExtraNames] = useState<Map<string, string>>(new Map());
  const extraIds = useMemo(() => {
    const knownIds = new Set(members.map((member) => member.userId));
    return selected.filter((id) => !knownIds.has(id));
  }, [members, selected]);
  useEffect(() => {
    if (extraIds.length === 0) return;
    let active = true;
    void getUserCards(extraIds).then((result) => {
      if (active && result.success) setExtraNames(new Map(result.data.items.map((user) => [user.userId, user.displayName])));
    });
    return () => { active = false; };
  }, [extraIds]);
  const memberName = (id: string) => members.find((member) => member.userId === id)?.displayName
    || (id === currentUser?.userId ? currentUser?.displayName : extraNames.get(id)) || id;
  const availableMembers = members.filter((member) => !selected.includes(member.userId));
  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <section aria-label="已选项目成员" className={compact ? 'space-y-2' : 'rounded-lg border border-token-subtle bg-token-nested p-3'}>
        <div className="mb-2 text-xs font-medium text-token-secondary">已选成员（{selected.length}）</div>
        {selected.length === 0
          ? <p className="py-2 text-xs text-token-muted">尚未选择成员，请在下方搜索添加。</p>
          : <div role="list" className="flex min-h-0 flex-wrap items-start gap-2" style={{ maxHeight: 200, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              {selected.map((id) => <div role="listitem" key={id} className="inline-flex max-w-full items-center gap-1 rounded-md border border-token-subtle py-0.5 pl-2.5 pr-0.5">
                <span title={memberName(id)} className="min-w-0 truncate text-xs text-token-primary">{memberName(id)}</span>
                <button type="button" aria-label={`移除成员 ${memberName(id)}`} title={`移除成员 ${memberName(id)}`} onClick={() => onChange(selected.filter((value) => value !== id))} className="inline-flex shrink-0 items-center justify-center rounded p-1.5 text-token-muted hover-bg-soft hover:text-[color:var(--semantic-danger-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                  <X size={12} aria-hidden="true" />
                </button>
              </div>)}
            </div>}
      </section>
      <section aria-label="添加项目成员" className={compact ? 'space-y-2' : 'rounded-lg border border-token-subtle bg-token-nested p-3'}>
        <div className="mb-2 text-xs font-medium text-token-secondary">添加成员</div>
        {pastedMatches.length > 0 && <div aria-live="polite" className="mb-3 space-y-2 text-xs text-token-secondary">
          <p className="flex items-center gap-2">{pastedMatches.some((item) => item.status === 'pending') && <MapSpinner size={14} />}
            企微成员已匹配 {pastedMatches.filter((item) => item.userId && selected.includes(item.userId)).length}/{pastedMatches.length} 人
          </p>
          {pastedMatches.filter((item) => item.status !== 'matched').map((item) => <div key={item.name} className="space-y-1">
            {item.status === 'pending' ? <p>正在查找“{item.name}”…</p>
              : item.status === 'ambiguous' || item.status === 'limited' ? <>
                <label htmlFor={`pasted-member-${item.name}`}>“{item.name}”{item.status === 'limited' ? '搜索结果较多，请确认或使用完整姓名搜索' : '对应多位成员，请选择'}</label>
                {item.candidates.length > 0 && <Select id={`pasted-member-${item.name}`} value="" onChange={(event) => onChoosePasted(item.name, event.target.value)}>
                  <option value="">请选择成员</option>
                  {item.candidates.map((user) => <option key={user.userId} value={user.userId}>{user.displayName}（@{user.username}）</option>)}
                </Select>}
              </> : <p>{item.status === 'error' ? `“${item.name}”匹配失败` : `未找到“${item.name}”`}，请在下方搜索添加。</p>}
          </div>)}
        </div>}
        <UserSearchSelect value="" onChange={(id) => { if (id && !selected.includes(id)) onChange([...selected, id]); }} placeholder="搜索姓名，添加其他项目成员" uiSize="sm" />
        {availableMembers.length > 0 && <div className="mt-3 flex flex-wrap gap-2" style={{ maxHeight: 160, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {availableMembers.map((member) => <button key={member.userId} type="button" onClick={() => onChange([...selected, member.userId])} className="inline-flex items-center gap-1 rounded-md border border-token-subtle px-2.5 py-1.5 text-xs text-token-secondary hover-bg-soft">
            <Plus size={12} />添加 {member.displayName}
          </button>)}
        </div>}
      </section>
    </div>
  );
}

export function ReleaseApplicationDialog({ productId, onClose, onChanged, temporary = false, applicationProducts }: {
  productId: string;
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
  temporary?: boolean;
  applicationProducts?: VersionApplicationProduct[];
}) {
  const [issued, setIssued] = useState<{ release: ProductRelease; autoCopied: boolean } | null>(null);
  const planBased = !temporary && Boolean(applicationProducts);
  const [applicationProductId, setApplicationProductId] = useState(planBased ? '' : productId);
  const [planSources, setPlanSources] = useState<ProductInitiation[]>([]);
  const [plansLoading, setPlansLoading] = useState(planBased);
  const [plansError, setPlansError] = useState('');
  const [plansAttempt, setPlansAttempt] = useState(0);
  const [planProgress, setPlanProgress] = useState({ completed: 0, total: 0 });
  useEffect(() => {
    if (!planBased || !applicationProducts) return;
    let active = true;
    setPlansLoading(true); setPlansError('');
    void loadProductVersionList(applicationProducts.map((product) => product.id), (id) => listInitiations(id, 'all'), {
      isCurrent: () => active,
      onProgress: (completed, total) => { if (active) setPlanProgress({ completed, total }); },
      onItems: (items) => { if (active) setPlanSources(items); },
    }).then((result) => {
      if (!active) return;
      if (result.failedProductIds.length) setPlansError(`有 ${result.failedProductIds.length} 个应用的方案加载失败，请重试后选择。`);
      setPlanSources(result.items);
      setPlansLoading(false);
    }).catch(() => { if (active) { setPlansError('方案加载失败，请重试。'); setPlansLoading(false); } });
    return () => { active = false; };
  }, [applicationProducts, planBased, plansAttempt]);
  const close = () => {
    onClose();
    if (issued) void onChanged?.();
  };
  return <Dialog
    open
    onOpenChange={(open) => { if (!open) close(); }}
    title={issued ? '正式版本申领结果' : temporary ? '临时优化需求上线' : '申领正式版本号'}
    maxWidth={960}
    contentStyle={{ height: 'min(780px, calc(100dvh - 64px))', maxHeight: 'calc(100dvh - 64px)' }}
    content={<div style={{ maxHeight: 'min(700px, calc(100dvh - 144px))', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' }}>
      {issued && <p role="status" className="mb-3 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-3 py-2 text-sm text-token-secondary">
        {issued.release.vCode} 已生成{issued.autoCopied ? '并自动复制' : '，可在下方手动复制'}。
      </p>}
      <ReleaseWorkflowDetail
        key={issued?.release.id ?? 'new'}
        productId={issued?.release.productId ?? applicationProductId}
        availableInitiations={issued || !planBased ? undefined : planSources}
        planLoading={!issued && plansLoading}
        planError={plansError}
        planProgress={planProgress}
        onRetryPlans={() => setPlansAttempt((attempt) => attempt + 1)}
        applicationProducts={issued || !planBased ? undefined : applicationProducts}
        onApplicationProductChange={issued || !planBased ? undefined : setApplicationProductId}
        releaseId={issued?.release.id ?? 'new'}
        isNew={!issued}
        temporary={temporary}
        onClose={close}
        onCreated={(release, autoCopied) => setIssued({ release, autoCopied })}
      />
    </div>}
  />;
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
    <div className="h-screen min-h-0 flex flex-col bg-token-card">
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-token-subtle">
        <button onClick={() => navigate(-1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-token-subtle text-token-secondary hover-bg-soft hover-text-primary" title="返回">
          <ArrowLeft size={16} />
        </button>
        <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-xs text-[color:var(--accent-fg-success)]">正式版本</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="w-full px-5 xl:px-8 py-5">
          <ReleaseWorkflowDetail productId={productId} releaseId={releaseId} isNew={isNew} />
        </div>
      </div>
    </div>
  );
}
