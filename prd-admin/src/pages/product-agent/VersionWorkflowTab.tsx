import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { CheckCircle2, Download, HelpCircle, Loader2, Plus, Search, Upload, X } from 'lucide-react';
import {
  approveInitiation, completeRelease, createInitiation, decideInitiation,
  listInitiations, listProductMembers, listVersionApplicationProducts, listReleases, getOverviewReleases,
  syncInitiationReview, updateInitiation, listProductVersionReviewSources, parseProductVersionMessage,
  type VersionApplicationProduct,
} from '@/services/real/productAgent';
import { uploadAttachment } from '@/services/real/aiToolbox';
import {
  createSubmission, getDimensions, getResultStreamUrl, type ReviewDimensionScore,
} from '@/services/real/reviewAgent';
import { useSseStream } from '@/lib/useSseStream';
import {
  InitiationReviewLivePanel,
  computeInitiationReviewProgress,
  type InitiationReviewStage,
  type ProcessLogEntry,
} from './InitiationReviewLivePanel';
import { hasRecoverableSseOutcome, waitForSubmissionDone } from './initiationReviewFinish';
import { getUserCards } from '@/services/real/teams';
import { useAuthStore } from '@/stores/authStore';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useProductListScope } from '@/lib/productListScope';
import { loadProductVersionList, mergeVersionListSnapshot } from '@/lib/productVersionList';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { ItemSearchSelect } from '@/components/ItemSearchSelect';
import { toProductOptions } from './comboboxOptions';
import type { ProductInitiation, ProductMember, ProductRelease, Requirement } from './types';
import { formatVersionBasicDate, formatVersionTrainingMinutes, resolveVersionProductLabel } from './versionBasicInfoCatalog';
import { SelectionActionBar, ListTableSelectionCell, useOverviewTableSelection } from './selectableList';
import {
  ListSelectionHeaderCell,
  LIST_HEADER_HOVER_GROUP,
  LIST_SELECTION_COL_WIDTH,
  listSelectionRowClass,
  type TableSelectionProps,
} from './listSelection';
import { TrackedFilterToggle } from './TrackedFilterToggle';
import { OVERVIEW_LIST_SEARCH_BOX } from './listFilter';
import { filterByTracked } from './productRecordTrackStorage';
import { InitiationMeetingRoundsEditor } from './InitiationWorkflowPanel';
import {
  formatInitiationReviewScore,
  isMeetingResultPending,
} from './initiationWorkflowUtils';
import { ProductVersionMessagePaste } from './ProductVersionMessagePaste';
import type { VersionRegistrationMessageParseResult } from '@/services/real/versionRegistration';
import { VersionCopyActions } from './VersionCopyActions';
import { ReleaseApplicationDialog } from './ReleaseWorkflowDetail';
import { VersionWorkflowImportDialog } from './VersionWorkflowImportDialog';
import { LegacyVersionArchive } from './LegacyVersionArchive';
import { downloadListCsv } from './listExport';
import { initiationExportConfig, releaseExportConfig, VERSION_WORKFLOW_STATUS_LABEL as STATUS_LABEL } from './versionWorkflowExport';

type MainTab = 'release' | 'initiation';
type RecordScope = 'mine' | 'all';
const SCALE_LABEL = { major: '大版本', medium: '中版本', minor: '小版本' } as const;

export function VersionWorkflowTab({ productId: initialProductId = '', isAdmin = false }: { productId?: string; isAdmin?: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { productId, setProductId } = useProductListScope(initialProductId);
  const currentUserId = useAuthStore((state) => state.user?.userId);
  const tab: MainTab = searchParams.get('versionTab') === 'initiation' ? 'initiation' : 'release';
  const [products, setProducts] = useState<VersionApplicationProduct[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [initiations, setInitiations] = useState<ProductInitiation[]>([]);
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [requirementNames, setRequirementNames] = useState<Map<string, string>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [auxiliaryError, setAuxiliaryError] = useState('');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [dialog, setDialog] = useState<'initiation' | 'release' | 'temporary' | null>(null);
  const [actionProductId, setActionProductId] = useState('');
  const [importKind, setImportKind] = useState<MainTab | null>(null);
  const [archive, setArchive] = useState<'legacy' | 'snapshots' | null>(null);
  const [retrySeed, setRetrySeed] = useState<ProductInitiation | null>(null);
  const [meetingFillItem, setMeetingFillItem] = useState<ProductInitiation | null>(null);
  const [recordScope, setRecordScope] = useState<RecordScope>('all');
  const [releaseOwnerId, setReleaseOwnerId] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const requestSequence = useRef(0);
  const loadedScope = useRef('');
  const productNames = useMemo(() => new Map(products.map((product) => [product.id, product.name])), [products]);
  const productName = productNames.get(productId) ?? '';
  const internalExport = initiationExportConfig(productId || '全部产品', productName, names, productNames);
  const formalExport = releaseExportConfig(productId || '全部产品', productName, names, [], productNames, requirementNames);

  useEffect(() => {
    let active = true;
    setCatalogLoaded(false);
    setCatalogError('');
    void listVersionApplicationProducts().then((result) => {
      if (!active) return;
      if (result.success) setProducts(result.data.items);
      else setCatalogError(result.error?.message ?? '产品目录加载失败，请重试。');
      setCatalogLoaded(true);
    }).catch(() => {
      if (!active) return;
      setCatalogError('产品目录加载失败，请重试。');
      setCatalogLoaded(true);
    });
    return () => { active = false; };
  }, [catalogAttempt]);

  const reload = useCallback(async () => {
    if (!catalogLoaded || catalogError) return;
    const sequence = ++requestSequence.current;
    const isCurrent = () => requestSequence.current === sequence;
    setLoading(true);
    setLoadError('');
    setAuxiliaryError('');
    const ids = productId ? products.filter((product) => product.id === productId).map((product) => product.id) : products.map((product) => product.id);
    const scope = `${tab}:${ids.join(',')}`;
    if (loadedScope.current !== scope) {
      loadedScope.current = scope;
      setInitiations([]); setReleases([]); setRequirementNames(new Map());
    }
    setProgress({ completed: 0, total: ids.length });
    const options = {
      isCurrent,
      onProgress: (completed: number, total: number) => {
        if (isCurrent()) setProgress({ completed, total });
      },
    };
    if (tab === 'initiation') {
      const result = await loadProductVersionList(ids, (id) => listInitiations(id, 'all'), {
        ...options,
        onItems: (items) => { if (isCurrent()) setInitiations((previous) => mergeVersionListSnapshot(previous, items)); },
      });
      if (!isCurrent()) return;
      setInitiations((previous) => mergeVersionListSnapshot(previous.filter((item) => result.failedProductIds.includes(item.productId)), result.items));
      if (result.failedProductIds.length) setLoadError(`有 ${result.failedProductIds.length} 个产品的内部版本加载失败，当前结果不完整，请重试。`);
    } else {
      // 需求名称是辅助展示，不阻塞版本记录和操作入口。
      void getOverviewReleases().then((overview) => {
        if (!isCurrent()) return;
        if (!overview.success) { setAuxiliaryError('关联需求名称加载失败，版本记录仍可查看，请重试。'); return; }
        const titles = new Map<string, string>();
        overview.data.items.forEach((row) => {
          row.requirementIds.forEach((id, index) => {
            if (row.requirementTitles[index]) titles.set(id, row.requirementTitles[index]);
          });
        });
        setRequirementNames(titles);
      }).catch(() => { if (isCurrent()) setAuxiliaryError('关联需求名称加载失败，版本记录仍可查看，请重试。'); });
      const result = await loadProductVersionList(ids, (id) => listReleases(id, 'all'), {
        ...options,
        onItems: (items) => { if (isCurrent()) setReleases((previous) => mergeVersionListSnapshot(previous, items)); },
      });
      if (!isCurrent()) return;
      setReleases((previous) => mergeVersionListSnapshot(previous.filter((item) => result.failedProductIds.includes(item.productId)), result.items));
      if (result.failedProductIds.length) setLoadError(`有 ${result.failedProductIds.length} 个产品的正式版本加载失败，当前结果不完整，请重试。`);
    }
    setLoading(false);
  }, [catalogLoaded, catalogError, products, productId, tab]);

  useEffect(() => {
    void reload();
    return () => { requestSequence.current += 1; };
  }, [reload]);

  useEffect(() => {
    let active = true;
    const ids = Array.from(new Set(tab === 'release'
      ? releases.flatMap((item) => [item.createdBy, item.ownerId, ...item.teamMemberIds].filter((id): id is string => Boolean(id)))
      : initiations.flatMap((item) => [item.createdBy, item.primaryOwnerId].filter((id): id is string => Boolean(id)))));
    if (!ids.length) { setNames(new Map()); return; }
    void getUserCards(ids).then((result) => {
      if (active && result.success) setNames(new Map(result.data.items.map((user) => [user.userId, user.displayName])));
    });
    return () => { active = false; };
  }, [initiations, releases, tab]);

  useEffect(() => {
    if (searchParams.get('versionAction') !== 'apply') return;
    setActionProductId(productId);
    setDialog(searchParams.get('versionTab') === 'initiation' ? 'initiation' : 'release');
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('versionAction');
      return next;
    }, { replace: true });
  }, [productId, searchParams, setSearchParams]);

  const setTab = (value: MainTab) => {
    setStatusFilter('');
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('versionTab', value);
      return next;
    }, { replace: true });
  };
  const openApplication = (kind: 'initiation' | 'release' | 'temporary') => {
    setActionProductId(productId);
    setDialog(kind);
  };
  const visibleInitiations = useMemo(() => filterByTracked(
    initiations.filter((item) => (!productId || item.productId === productId)
      && (recordScope === 'all' || item.createdBy === currentUserId)
      && matchesRecord(item, query, statusFilter)),
    trackedOnly, 'initiation', (item) => ({ productId: item.productId, recordId: item.id }),
  ), [initiations, productId, recordScope, currentUserId, query, statusFilter, trackedOnly]);
  const visibleReleases = useMemo(() => filterByTracked(
    releases.filter((item) => (!productId || item.productId === productId)
      && (!releaseOwnerId || item.ownerId === releaseOwnerId)
      && matchesRecord(item, query, statusFilter)),
    trackedOnly, 'release', (item) => ({ productId: item.productId, recordId: item.id }),
  ), [releases, productId, releaseOwnerId, query, statusFilter, trackedOnly]);
  const statuses = useMemo(() => Array.from(new Set(
    (tab === 'release' ? releases : initiations)
      .filter((item) => !productId || item.productId === productId).map((item) => item.status),
  )), [initiations, releases, productId, tab]);
  const selectedProductUnavailable = catalogLoaded && !catalogError && Boolean(productId) && !productNames.has(productId);
  const listLoading = !catalogLoaded || loading;
  const dialogTitle = dialog === 'initiation' ? '申领内部版本号' : dialog === 'temporary' ? '临时优化需求' : '申领正式版本号';

  return <div className="flex h-full min-h-0 flex-col gap-5">
    <div className="flex shrink-0 border-b border-token-subtle">
      <Tab active={tab === 'release'} onClick={() => setTab('release')}>正式版本</Tab>
      <Tab active={tab === 'initiation'} onClick={() => setTab('initiation')}>内部版本</Tab>
    </div>
    <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div role="group" aria-label="按产品筛选版本" className="w-56">
          <ItemSearchSelect value={productId} onChange={setProductId} options={toProductOptions(products)}
            placeholder={productId && !productName ? '正在加载产品…' : '输入产品名称或编号搜索'}
            clearOptionLabel="全部产品" uiSize="sm" countUnit="个产品" />
        </div>
        <RecordToolbar query={query} onQueryChange={setQuery}
          scope={recordScope} onScopeChange={setRecordScope}
          ownerId={tab === 'release' ? releaseOwnerId : undefined}
          onOwnerChange={tab === 'release' ? setReleaseOwnerId : undefined}
          status={statusFilter} onStatusChange={setStatusFilter} statuses={statuses}
          trackedOnly={trackedOnly} onTrackedOnlyChange={setTrackedOnly} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && <Secondary disabled={!catalogLoaded || Boolean(catalogError) || selectedProductUnavailable} onClick={() => setImportKind(tab)}><Upload size={14} />导入历史{tab === 'release' ? '正式' : '内部'}版本</Secondary>}
        <Secondary disabled={listLoading || Boolean(catalogError) || Boolean(loadError) || (tab === 'release' ? visibleReleases : visibleInitiations).length === 0}
          onClick={() => tab === 'release'
            ? downloadListCsv(formalExport.filename, formalExport.headers, visibleReleases.map(formalExport.mapRow))
            : downloadListCsv(internalExport.filename, internalExport.headers, visibleInitiations.map(internalExport.mapRow))}><Download size={14} />导出{tab === 'release' ? '正式' : '内部'}版本</Secondary>
        <Primary disabled={!catalogLoaded || Boolean(catalogError) || selectedProductUnavailable} onClick={() => openApplication(tab)}><Plus size={14} />申领{tab === 'release' ? '正式' : '内部'}版本号</Primary>
        {tab === 'release' && <Secondary disabled={!catalogLoaded || Boolean(catalogError) || selectedProductUnavailable} onClick={() => openApplication('temporary')}>临时优化需求</Secondary>}
        {tab === 'release' && <span title="月度常规计划外、紧急且工作量较小的优化，无需 T 号，沿用既有自动审批规则。" className="text-token-muted"><HelpCircle size={15} /></span>}
      </div>
    </div>
    <div className="flex shrink-0 gap-3 text-xs text-token-muted">
      <button type="button" onClick={() => setArchive('legacy')} className="hover-text-primary">查看旧登记记录</button>
      <button type="button" onClick={() => setArchive('snapshots')} className="hover-text-primary">查看历史存档</button>
    </div>
    {(catalogError || loadError || auxiliaryError || selectedProductUnavailable) && <div role="alert" className="shrink-0 rounded-lg border border-token-subtle bg-token-nested p-3 text-sm text-token-secondary">
      {catalogError || (selectedProductUnavailable ? '所选产品不存在或无权访问，请清除产品筛选后重试。' : [loadError, auxiliaryError].filter(Boolean).join(' '))}
      {!selectedProductUnavailable && <button type="button" className="ml-3 text-[color:var(--accent-fg-blue)] hover:underline" onClick={() => catalogError ? setCatalogAttempt((value) => value + 1) : void reload()}>重试</button>}
    </div>}
    {listLoading && !catalogError && <p role="status" className="flex shrink-0 items-center gap-2 text-xs text-token-secondary"><MapSpinner size={14} />{!catalogLoaded ? '正在读取产品目录，表格已就绪…' : `正在补充版本记录（${progress.completed}/${progress.total} 个产品），已取得的记录会先显示…`}</p>}
    <div className="min-h-0 flex-1 overflow-auto" style={{ overscrollBehavior: 'contain' }}>
      {!catalogError && !selectedProductUnavailable && (tab === 'release'
          ? <ReleaseTable pending={listLoading || Boolean(loadError)} productId={productId} productName={productName} productNames={productNames} items={visibleReleases} requirementNames={requirementNames} names={names} onChanged={reload} currentUserId={currentUserId} />
          : <InitiationTable pending={listLoading || Boolean(loadError)} productId={productId} productName={productName} productNames={productNames} items={visibleInitiations} names={names} currentUserId={currentUserId} onRetryReview={setRetrySeed} onFillMeeting={setMeetingFillItem} onChanged={reload} />)}
    </div>
    {dialog === 'temporary' && !actionProductId && <Modal compact title={dialogTitle} onClose={() => setDialog(null)} width="max-w-lg">
      <p className="mb-4 text-sm text-token-secondary">请选择本次申领所属的产品，列表筛选不会改变。</p>
      <ItemSearchSelect value="" onChange={setActionProductId} options={toProductOptions(products)} placeholder="输入产品名称或编号搜索" countUnit="个产品" />
    </Modal>}
    {dialog === 'initiation' && <InitiationApplication productId={actionProductId} applicationProducts={products} onClose={() => setDialog(null)} onChanged={reload} />}
    {dialog === 'release' && <ReleaseApplicationDialog productId="" applicationProducts={products} onClose={() => setDialog(null)} onChanged={reload} />}
    {dialog === 'temporary' && actionProductId && <ReleaseApplicationDialog productId={actionProductId} temporary onClose={() => setDialog(null)} onChanged={reload} />}
    {importKind && isAdmin && <VersionWorkflowImportDialog kind={importKind} products={products} fixedProductId={productId || undefined}
      onClose={() => setImportKind(null)} onImported={async () => { setImportKind(null); await reload(); }} />}
    {archive && <Modal title={archive === 'legacy' ? '全域旧登记记录（只读）' : '全域历史存档'} onClose={() => setArchive(null)} width="max-w-6xl">
      <LegacyVersionArchive kind={tab === 'release' ? 'formal' : 'internal'} isAdmin={isAdmin} mode={archive} />
    </Modal>}
    {retrySeed && <InitiationApplication productId={retrySeed.productId} seed={retrySeed} onClose={() => setRetrySeed(null)} onChanged={async () => { setRetrySeed(null); await reload(); }} />}
    {meetingFillItem && <Modal title="会议结果" onClose={() => setMeetingFillItem(null)} width="max-w-2xl">
      <InitiationMeetingRoundsEditor initiation={meetingFillItem} editable={meetingFillItem.createdBy === currentUserId}
        onSaved={async () => { setMeetingFillItem(null); await reload(); }} />
    </Modal>}
  </div>;
}

function InitiationApplication({ productId, applicationProducts, seed, onClose, onChanged }: {
  productId: string; seed?: ProductInitiation; onClose: () => void; onChanged: () => Promise<void>;
  applicationProducts?: VersionApplicationProduct[];
}) {
  const [applicationProductId, setApplicationProductId] = useState(productId);
  const memberProductId = seed?.productId ?? applicationProductId;
  const [members, setMembers] = useState<ProductMember[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setMembers(null);
    setError('');
    if (!memberProductId) { setMembers([]); return; }
    void listProductMembers(memberProductId).then((result) => {
      if (!active) return;
      if (result.success) setMembers(result.data.members);
      else setError(result.error?.message ?? '产品成员加载失败，请重试。');
    }).catch(() => { if (active) setError('产品成员加载失败，请重试。'); });
    return () => { active = false; };
  }, [memberProductId, attempt]);
  const memberNotice = memberProductId && !members ? <div className="mb-3">
    {error ? <div role="alert" className="text-sm text-token-secondary">{error}<button type="button" className="ml-2 hover:underline" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>
      : <p role="status" className="flex items-center gap-2 text-xs text-token-secondary"><MapSpinner size={14} />正在加载可选成员，可以先填写基础信息…</p>}
  </div> : null;
  return <InitiationWizard key={seed?.id ?? 'new'} productId={memberProductId} applicationProducts={applicationProducts}
    onApplicationProductChange={applicationProducts ? setApplicationProductId : undefined}
    requirements={[]} members={members ?? []} seed={seed} onClose={onClose} onChanged={onChanged} memberNotice={memberNotice} />;
}

export function InitiationWizard({ productId, applicationProducts, onApplicationProductChange, members, onClose, onChanged, seed, memberNotice }: {
  memberNotice?: ReactNode;
  productId: string;
  applicationProducts?: VersionApplicationProduct[];
  onApplicationProductChange?: (productId: string) => void;
  requirements: Requirement[];
  members: ProductMember[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  /** 评审未通过时重新发起：预填基础信息并直接进入 Agent 评审步骤 */
  seed?: ProductInitiation;
}) {
  const permissions = useAuthStore((state) => state.permissions ?? []);
  const isRoot = useAuthStore((state) => state.isRoot);
  const canUseProduct = hasEffectivePermission(permissions, 'product-agent.use', isRoot);
  const isRetry = Boolean(seed);
  const wizardTitle = seed?.status === 'decision_pending'
    ? '继续立项决策'
    : isRetry
      ? '重新发起立项'
      : '申领内部版本号';
  const [step, setStep] = useState(() => {
    if (seed?.status === 'review_failed') return 2;
    if (seed?.status === 'decision_pending') return 3;
    return 1;
  });
  const [item, setItem] = useState<ProductInitiation | null>(seed ?? null);
  const [projectType, setProjectType] = useState<'standard' | 'custom'>(seed?.projectType ?? 'standard');
  const [customerSource, setCustomerSource] = useState(seed?.customerSource ?? '');
  const [demandSource, setDemandSource] = useState(seed?.demandSource ?? '');
  const [linkedProductId, setLinkedProductId] = useState(seed?.linkedProductId ?? productId);
  const [catalogProducts, setCatalogProducts] = useState<VersionApplicationProduct[]>([]);
  const [planName, setPlanName] = useState(seed?.planName ?? '');
  const planNameRef = useRef(planName);
  planNameRef.current = planName;
  const [plannedProjectAt, setPlannedProjectAt] = useState(seed?.plannedProjectAt ? formatVersionBasicDate(seed.plannedProjectAt) : '');
  const [needUiDesign, setNeedUiDesign] = useState(seed ? (seed.needUiDesign == null ? '' : seed.needUiDesign ? 'yes' : 'no') : 'no');
  const [isAiPoc, setIsAiPoc] = useState(seed ? (seed.isAiPoc == null ? '' : seed.isAiPoc ? 'yes' : 'no') : 'yes');
  const [remark, setRemark] = useState(seed?.remark ?? '');
  const [reviewSubmissionId, setReviewSubmissionId] = useState(seed?.reviewSubmissionId ?? '');
  const [reviewSources, setReviewSources] = useState<Array<{ id: string; title: string }>>([]);
  const [canUseAllReviews, setCanUseAllReviews] = useState(false);
  const reviewApplicationSequence = useRef(0);
  const [reviewApplicationMatching, setReviewApplicationMatching] = useState(false);
  const [versionType, setVersionType] = useState<'major' | 'medium' | 'minor'>(seed?.versionType ?? 'minor');
  const [file, setFile] = useState<File | null>(null);
  const [meeting, setMeeting] = useState(false);
  const [meetingAt, setMeetingAt] = useState('');
  const [meetingDraftCount, setMeetingDraftCount] = useState(seed?.meetingDraftCount ?? 1);
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [issuedCode, setIssuedCode] = useState('');
  const [reviewStage, setReviewStage] = useState<InitiationReviewStage>('idle');
  const [processLogs, setProcessLogs] = useState<ProcessLogEntry[]>([]);
  const [dimensionScores, setDimensionScores] = useState<ReviewDimensionScore[]>([]);
  const [totalScore, setTotalScore] = useState<number | null>(null);
  const [reviewPassed, setReviewPassed] = useState<boolean | null>(null);
  const [adjustmentLog, setAdjustmentLog] = useState<string[]>([]);
  const [expectedDimCount, setExpectedDimCount] = useState(0);
  const logSeq = useRef(0);
  const streamErrorRef = useRef<string | null>(null);
  const sseOutcomeRef = useRef({ hasResult: false, dimensionCount: 0, streamDone: false });

  const appendLog = useCallback((text: string) => {
    logSeq.current += 1;
    const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setProcessLogs((prev) => [...prev, { id: `${Date.now()}-${logSeq.current}`, at, text }]);
  }, []);

  const sse = useSseStream<ReviewDimensionScore>({
    url: '',
    itemEvent: 'dimension_score',
    onItem: (item) => {
      setDimensionScores((prev) => {
        const existing = prev.find((d) => d.key === item.key);
        const next = existing ? prev.map((d) => (d.key === item.key ? item : d)) : [...prev, item];
        sseOutcomeRef.current.dimensionCount = next.length;
        return next;
      });
      appendLog(`维度「${item.name}」：${item.score}/${item.maxScore}`);
    },
    onPhase: (msg) => {
      if (msg) appendLog(msg);
    },
    onEvent: {
      result: (data: unknown) => {
        const d = data as { totalScore: number; isPassed: boolean };
        sseOutcomeRef.current.hasResult = true;
        setTotalScore(d.totalScore);
        setReviewPassed(d.isPassed);
        appendLog(`汇总得分 ${d.totalScore}/100，${d.isPassed ? '通过' : '未通过'}`);
      },
      adjustment_log: (data: unknown) => {
        const d = data as { entries?: string[] };
        if (Array.isArray(d.entries) && d.entries.length > 0) {
          setAdjustmentLog(d.entries);
          appendLog(`系统兜底调整 ${d.entries.length} 项`);
        }
      },
    },
    onError: (msg) => {
      streamErrorRef.current = msg;
      appendLog(`评审流异常：${msg}`);
    },
    onDone: () => {
      sseOutcomeRef.current.streamDone = true;
      appendLog('评审流已结束');
    },
  });

  const reviewRunning = reviewStage !== 'idle';
  const progressPercent = useMemo(
    () => computeInitiationReviewProgress(reviewStage, dimensionScores.length, expectedDimCount),
    [reviewStage, dimensionScores.length, expectedDimCount],
  );

  useEffect(() => {
    if (applicationProducts) return;
    void listVersionApplicationProducts().then((res) => { if (res.success) setCatalogProducts(res.data.items); });
  }, [applicationProducts]);

  useEffect(() => {
    void listProductVersionReviewSources().then((res) => {
      if (res.success) {
        setReviewSources(res.data.items);
        setCanUseAllReviews(res.data.canUseAllReviews);
      }
    });
  }, []);

  useEffect(() => {
    if (step !== 2) return;
    void getDimensions().then((res) => {
      if (res.success) {
        setExpectedDimCount(res.data.dimensions.filter((d) => d.isActive).length);
      }
    });
  }, [step]);

  useEffect(() => {
    if (!item) onApplicationProductChange?.(linkedProductId);
  }, [item, linkedProductId, onApplicationProductChange]);

  const availableProducts = applicationProducts ?? catalogProducts;
  // 新建时以表单所选应用作为接口所属产品；既有记录仍沿用原归属和权限边界。
  const canSelectApplication = canUseProduct || Boolean(applicationProducts && !item);
  const productOptions = useMemo(
    () => toProductOptions(canSelectApplication ? availableProducts : availableProducts.filter((product) => product.id === productId)),
    [canSelectApplication, availableProducts, productId],
  );
  const productOptionsRef = useRef(productOptions);
  productOptionsRef.current = productOptions;

  useEffect(() => () => { reviewApplicationSequence.current += 1; }, []);

  const cancelReviewApplicationLookup = () => {
    reviewApplicationSequence.current += 1;
    setReviewApplicationMatching(false);
  };

  const chooseReviewSource = (id: string) => {
    const sequence = ++reviewApplicationSequence.current;
    setReviewSubmissionId(id);
    setLinkedProductId('');
    setReviewApplicationMatching(false);
    const source = reviewSources.find((entry) => entry.id === id);
    if (!source) return;
    setPlanName(source.title);
    setMessage('');
    setReviewApplicationMatching(true);
    void parseProductVersionMessage('internal', `产品立项方案名称：${source.title}`).then((response) => {
      if (sequence !== reviewApplicationSequence.current) return;
      if (!response.success) {
        setMessage('暂时无法识别方案所属应用，请手动选择所属应用后继续。');
        return;
      }
      const applicationId = response.data.result.matchedApplicationId;
      if (applicationId && productOptionsRef.current.some((option) => option.id === applicationId)) setLinkedProductId(applicationId);
    }).catch(() => {
      if (sequence === reviewApplicationSequence.current) setMessage('暂时无法识别方案所属应用，请手动选择所属应用后继续。');
    }).finally(() => {
      if (sequence === reviewApplicationSequence.current) setReviewApplicationMatching(false);
    });
  };

  const basePayload = () => ({
    linkedProductId,
    projectType,
    customerSource: projectType === 'custom' ? customerSource : undefined,
    demandSource: demandSource.trim(),
    planName,
    planUrl: item?.planUrl ?? undefined,
    requirementDescription: item?.requirementDescription ?? undefined,
    projectMemberNames: item?.projectMemberNames,
    plannedProjectAt: plannedProjectAt ? new Date(`${plannedProjectAt}T00:00:00+08:00`).toISOString() : undefined,
    needUiDesign: needUiDesign === 'yes',
    isAiPoc: isAiPoc === 'yes',
    developmentStatus: item?.developmentStatus,
    remark: remark.trim() || undefined,
    reviewSubmissionId: reviewSubmissionId || undefined,
    versionType,
    requirementIds: item?.requirementIds ?? [],
  });

  const goPrevStep = () => {
    if (step <= 1 || reviewRunning || busy) return;
    setMessage('');
    setStep((s) => s - 1);
  };

  const saveStep1 = async () => {
    if (!linkedProductId.trim()) return setMessage('请选择所属应用');
    if (!planName.trim()) return setMessage('请填写方案名称');
    if (projectType === 'custom' && !customerSource.trim()) return setMessage('请填写客户来源');
    if (!demandSource.trim()) return setMessage('请填写需求来源');
    if (!plannedProjectAt) return setMessage('请填写计划立项时间');
    if (!needUiDesign || !isAiPoc) return setMessage('请选择 UI 设计和 AI POC 状态');
    setBusy(true);
    const payload = basePayload();
    const editable = item && ['draft', 'review_pending', 'review_failed', 'decision_pending'].includes(item.status);
    const res = editable && item
      ? await updateInitiation(item.id, payload)
      : await createInitiation(applicationProducts ? linkedProductId : productId, payload);
    setBusy(false);
    if (!res.success) return setMessage(res.error?.message ?? '保存失败');
    setItem(res.data); setStep(res.data.reviewPassed ? 3 : 2); setMessage('');
  };
  const runReview = async () => {
    if (!file || !item) return setMessage('请先上传方案文件');
    setBusy(true);
    setMessage('');
    setDimensionScores([]);
    setTotalScore(null);
    setReviewPassed(null);
    setAdjustmentLog([]);
    setProcessLogs([]);
    sse.reset();
    streamErrorRef.current = null;
    sseOutcomeRef.current = { hasResult: false, dimensionCount: 0, streamDone: false };

    setReviewStage('uploading');
    appendLog(`开始上传：${file.name}`);
    const uploaded = await uploadAttachment(file);
    if (!uploaded.success) {
      setBusy(false);
      setReviewStage('idle');
      return setMessage(uploaded.error?.message ?? '上传失败');
    }
    appendLog('方案文件上传成功');

    setReviewStage('submitting');
    appendLog('正在创建 Agent 评审任务…');
    const submitted = await createSubmission(planName, uploaded.data.attachmentId);
    if (!submitted.success) {
      setBusy(false);
      setReviewStage('idle');
      return setMessage(submitted.error?.message ?? '提交评审失败');
    }
    const submissionId = submitted.data.submission.id;
    appendLog(`评审任务已创建（${submissionId.slice(0, 8)}…）`);

    setReviewStage('streaming');
    appendLog('连接评审流，等待 Agent 分析打分…');
    await sse.start({ url: getResultStreamUrl(submissionId) });

    const outcome = sseOutcomeRef.current;
    const recoverable = hasRecoverableSseOutcome(outcome);

    if (streamErrorRef.current && !recoverable) {
      setBusy(false);
      setReviewStage('idle');
      return setMessage(streamErrorRef.current);
    }
    if (streamErrorRef.current && recoverable) {
      appendLog('评审结果已从流中获取，忽略连接异常并继续同步…');
    }

    if (!outcome.hasResult && !outcome.streamDone) {
      appendLog('确认服务端评审状态…');
      const waited = await waitForSubmissionDone(submissionId);
      if (!waited.ok && !recoverable) {
        setBusy(false);
        setReviewStage('idle');
        return setMessage(waited.message);
      }
      if (!waited.ok && recoverable) {
        appendLog(`详情查询失败（${waited.message}），仍尝试同步立项…`);
      }
    }

    setReviewStage('syncing');
    appendLog('正在同步评审结果到立项记录…');
    const synced = await syncInitiationReview(item.id, submissionId);
    setBusy(false);
    setReviewStage('idle');
    if (!synced.success) {
      if (recoverable) {
        return setMessage(`评审已完成，但同步立项失败：${synced.error?.message ?? '未知错误'}。请刷新页面或联系管理员。`);
      }
      return setMessage(synced.error?.message ?? '同步评审结果失败');
    }
    setItem(synced.data);
    appendLog('立项记录已更新');
    if (synced.data.reviewPassed) {
      setStep(3);
      setMessage('评审通过，可以提交立项决策。');
    } else {
      setMessage(`评审未通过，得分 ${synced.data.reviewScore ?? 0}。请修改方案后重新立项。`);
    }
  };
  const submitDecision = async () => {
    if (!item) return;
    setBusy(true);
    const res = await decideInitiation(item.id, {
      reviewMeetingRequired: meeting,
      expectedMeetingAt: meeting && meetingAt ? new Date(meetingAt).toISOString() : undefined,
      primaryOwnerId: meeting ? undefined : ownerId,
      meetingDraftCount: meeting ? meetingDraftCount : undefined,
    });
    setBusy(false);
    if (!res.success) return setMessage(res.error?.message ?? '提交失败');
    await onChanged();
    setItem(res.data);
    if (res.data.tCode) {
      setIssuedCode(res.data.tCode);
      try {
        await navigator.clipboard.writeText(res.data.tCode);
        setMessage('立项号已生成并自动复制。');
      } catch {
        setMessage('立项号已生成；浏览器未允许自动复制，请点击复制编号。');
      }
    } else {
      onClose();
    }
  };

  const applyParsedMessage = (parsed: VersionRegistrationMessageParseResult) => {
    cancelReviewApplicationLookup();
    if (parsed.projectType) setProjectType(parsed.projectType);
    if (parsed.versionType) setVersionType(parsed.versionType);
    if (parsed.demandSource) setDemandSource(parsed.demandSource);
    if (parsed.planName) {
      setPlanName(parsed.planName);
      const match = reviewSources.find((source) => source.title.replace(/\s+/g, '') === parsed.planName?.replace(/\s+/g, ''));
      if (match) setReviewSubmissionId(match.id);
      const productMatches = availableProducts.filter((product) =>
        (canSelectApplication || product.id === productId) && product.name.trim() && parsed.planName?.includes(product.name.trim()));
      if (parsed.matchedApplicationId && availableProducts.some((product) => product.id === parsed.matchedApplicationId && (canSelectApplication || product.id === productId))) setLinkedProductId(parsed.matchedApplicationId);
      else if (productMatches.length === 1) setLinkedProductId(productMatches[0].id);
    }
    if (parsed.plannedProjectAt) setPlannedProjectAt(parsed.plannedProjectAt.slice(0, 10));
    if (parsed.needUiDesign != null) setNeedUiDesign(parsed.needUiDesign ? 'yes' : 'no');
    if (parsed.isAiPoc != null) setIsAiPoc(parsed.isAiPoc ? 'yes' : 'no');
    if (parsed.remark) setRemark(parsed.remark);
  };

  return <Modal title={wizardTitle} onClose={onClose} width="max-w-3xl">
    {memberNotice}
    <Stepper step={step} />
    {step === 1 && <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ProductVersionMessagePaste kind="internal" onParsed={applyParsedMessage} />
      <Field label="已通过的产品评审记录（选填，可跳过重复评审）" full>
        <Select value={reviewSubmissionId} onChange={(event) => chooseReviewSource(event.target.value)}>
          <option value="">新上传方案并进行 Agent 评审</option>
          {reviewSources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
        </Select>
        <p className="mt-1.5 text-xs text-token-muted">{canUseAllReviews ? '申领测试已开启：可选择所有人的已通过方案。' : '仅可选择本人提交的已通过方案。'}每个评审方案只能申领一个 T，每个 T 只能申领一个 V。</p>
      </Field>
      <Field label="项目类别"><Select value={projectType} onChange={(e) => setProjectType(e.target.value as typeof projectType)}><option value="standard">非定制</option><option value="custom">定制</option></Select></Field>
      {projectType === 'custom' && <Field label="客户来源 *"><Input value={customerSource} onChange={(e) => setCustomerSource(e.target.value)} /></Field>}
      <Field label="所属应用 *" full>
        <ItemSearchSelect
          value={linkedProductId}
          onChange={(id) => { cancelReviewApplicationLookup(); setLinkedProductId(id); }}
          options={productOptions}
          placeholder="搜索应用名称或编号"
          countUnit="个应用"
          emptyText="暂无可选应用"
        />
        {reviewApplicationMatching && <p role="status" className="mt-1.5 flex items-center gap-2 text-xs text-token-muted"><MapSpinner size={14} />正在识别方案所属应用，也可手动选择。</p>}
      </Field>
      <Field label="方案名称 *"><Input value={planName} onChange={(e) => { cancelReviewApplicationLookup(); setPlanName(e.target.value); }} onBlur={() => {
        const sequence = reviewApplicationSequence.current;
        const entered = planName;
        if (!entered.trim()) return;
        void parseProductVersionMessage('internal', `产品立项方案名称：${entered}`).then((response) => {
          if (sequence !== reviewApplicationSequence.current || !response.success || !response.data.result.planName || planNameRef.current !== entered) return;
          const parsed = response.data.result;
          setPlanName((previous) => previous === entered ? parsed.planName! : previous);
        }).catch(() => { /* 提交时仍由同一服务端规则清洗，不因预览失败丢失输入。 */ });
      }} /></Field>
      <Field label="版本级别"><Select value={versionType} onChange={(e) => setVersionType(e.target.value as typeof versionType)}>{Object.entries(SCALE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      <Field label="需求来源 *"><Input value={demandSource} onChange={(e) => setDemandSource(e.target.value)} placeholder="例如：内部、客户名称" /></Field>
      <Field label="计划立项时间 *"><Input type="date" value={plannedProjectAt} onChange={(e) => setPlannedProjectAt(e.target.value)} /></Field>
      <Field label="是否需要 UI 设计 *"><Select value={needUiDesign} onChange={(e) => setNeedUiDesign(e.target.value)}><option value="">请选择</option><option value="yes">是</option><option value="no">否</option></Select></Field>
      <Field label="是否属于 AI POC 项目 *"><Select value={isAiPoc} onChange={(e) => setIsAiPoc(e.target.value)}><option value="">请选择</option><option value="yes">是</option><option value="no">否</option></Select></Field>
      <Field label="备注" full><textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} className="w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none focus:border-cyan-400/50" /></Field>
    </div>}
    {step === 2 && <div className="space-y-4">
      {!reviewRunning && (
        <label className="flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-cyan-400/35 bg-cyan-400/5 text-center">
          <Upload className="mb-3 text-cyan-300" size={28} /><span className="text-sm text-token-secondary">{file ? file.name : '拖动或点击上传方案文件'}</span>
          <span className="mt-1 text-xs text-token-muted">PDF、Word、Markdown、TXT、Excel、PPT</span>
          <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      )}
      {reviewRunning && file && (
        <div className="rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-secondary">
          方案文件：<span className="text-token-primary">{file.name}</span>
        </div>
      )}
      {reviewRunning && (
        <InitiationReviewLivePanel
          stage={reviewStage}
          ssePhase={sse.phase}
          phaseMessage={sse.phaseMessage}
          progressPercent={progressPercent}
          logs={processLogs}
          typing={sse.typing}
          dimensionScores={dimensionScores}
          totalScore={totalScore}
          isPassed={reviewPassed}
          adjustmentLog={adjustmentLog}
          expectedDimCount={expectedDimCount}
        />
      )}
      {!reviewRunning && item?.reviewScore != null && <Score score={item.reviewScore} passed={item.reviewPassed === true} />}
    </div>}
    {step === 3 && issuedCode && item ? <div className="space-y-3 rounded-xl border border-cyan-400/30 bg-cyan-400/5 p-4">
      <p className="text-sm text-token-primary">立项号：<span className="font-mono font-semibold">{issuedCode}</span></p>
      <VersionCopyActions kind="initiation" id={item.id} code={issuedCode} />
    </div> : null}
    {step === 3 && !issuedCode && <div className="space-y-4">
      <Field label="是否需要开评审会"><Select value={meeting ? 'yes' : 'no'} onChange={(e) => setMeeting(e.target.value === 'yes')}><option value="no">不需要</option><option value="yes">需要</option></Select></Field>
      {meeting ? <>
        <Field label="预计评审会时间 *"><Input type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} /></Field>
        <Field label="计划召开稿次 *">
          <Select value={String(meetingDraftCount)} onChange={(e) => setMeetingDraftCount(Number(e.target.value))}>
            <option value="1">1 稿（仅第一稿）</option>
            <option value="2">2 稿（第一稿 + 第二稿）</option>
            <option value="3">3 稿（第一稿 + 第二稿 + 第三稿）</option>
          </Select>
        </Field>
        <Info>提交后立即获取 T 立项号。线下各稿会议时间与是否通过请在立项详情中后续回填。</Info>
      </> : <>
        <Field label="产品主负责人 *"><Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="">请选择</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
        <Info>提交后流转给主负责人，负责人同意后生成 T 立项号。</Info>
      </>}
    </div>}
    {message && <div className="mt-4 rounded-lg bg-token-nested px-3 py-2 text-xs text-token-secondary">{message}</div>}
    <div className="mt-6 flex items-center justify-between gap-2">
      <div>
        {step > 1 && (
          <Secondary onClick={goPrevStep} disabled={busy || reviewRunning}>上一步</Secondary>
        )}
      </div>
      <div className="flex gap-2">
        <Secondary onClick={onClose} disabled={reviewRunning}>取消</Secondary>
      {step === 1 && <Primary onClick={saveStep1} disabled={busy || !linkedProductId.trim()}>{busy ? '保存中...' : '下一步'}</Primary>}
      {step === 2 && (
        <Primary onClick={runReview} disabled={busy || !file}>
          {reviewRunning && <Loader2 size={14} className="animate-spin" />}
          {reviewRunning ? '评审进行中…' : '上传并打分'}
        </Primary>
      )}
      {step === 3 && !issuedCode && <Primary onClick={submitDecision} disabled={busy || (meeting ? !meetingAt : !ownerId)}>提交立项</Primary>}
      </div>
    </div>
  </Modal>;
}

function InitiationTable({ productId, productName, productNames, items, names, currentUserId, onRetryReview, onFillMeeting, onChanged, pending }: {
  pending?: boolean;
  productId: string;
  productName: string;
  productNames: ReadonlyMap<string, string>;
  items: ProductInitiation[];
  names: ReadonlyMap<string, string>;
  currentUserId?: string;
  onRetryReview: (item: ProductInitiation) => void;
  onFillMeeting: (item: ProductInitiation) => void;
  onChanged: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const openDetail = (item: ProductInitiation) => navigate(`/product-agent/p/${item.productId}/initiation/${item.id}`);
  const { selection, exportSelected, tableSelection } = useOverviewTableSelection(items, initiationExportConfig(productId || '全部产品', productName, names, productNames));
  return (
    <>
      <SelectionActionBar mode="export" selection={selection} onExport={exportSelected} />
      <Table headers={['产品', '项目类别', '立项号', '版本类别', '产品立项方案名称', '需求来源', '项目需求描述', '所属部门', '产品负责人', '第一稿\n会议时间', '第二稿\n会议时间', '第三稿\n会议时间', '立项时间\n（三稿通过）', '计划立项时间', '是否需要UI设计', '是否 AI POC', '方案地址', '开发状态', '备注', 'Agent\n评审', '操作']} selection={tableSelection}>
        {items.map((item) => {
          const isOwner = item.createdBy === currentUserId;
          const showRetryReview = isOwner && item.status === 'review_failed';
          const showFillMeeting = isOwner && isMeetingResultPending(item);
          const reviewScoreText = formatInitiationReviewScore(item);
          return (
        <tr key={item.id} className={listSelectionRowClass('border-t border-token-subtle cursor-pointer hover-bg-soft')} onClick={() => openDetail(item)}>
          <ListTableSelectionCell selection={tableSelection} id={item.id} />
          <Td>{resolveVersionProductLabel(item, productNames.get(item.productId) ?? productName)}</Td>
      <Td>{item.projectType === 'custom' ? `定制项目${item.customerSource ? ` · ${item.customerSource}` : ''}` : '非定制项目'}</Td>
      <Td mono>{item.tCode
        ? <button type="button" onClick={(e) => { e.stopPropagation(); openDetail(item); }} className="text-cyan-300 hover:underline">{item.tCode}</button>
        : '-'}</Td>
      <Td>{SCALE_LABEL[item.versionType]}</Td>
      <Td><button type="button" onClick={(e) => { e.stopPropagation(); openDetail(item); }} className="text-left text-cyan-300 hover:underline">{item.planName}</button></Td>
      <Td>{item.demandSource || '-'}</Td>
      <Td>{item.requirementDescription || '-'}</Td><Td>{item.departmentName || '-'}</Td>
      <Td>
        <div>{item.ownerName || names.get(item.primaryOwnerId ?? item.createdBy) || item.legacyData?.['产品负责人'] || item.primaryOwnerId || item.createdBy || '-'}</div>
        {item.primaryOwnerId === currentUserId && item.status === 'owner_pending' && <button onClick={async (event) => { event.stopPropagation(); const result = await approveInitiation(item.id); if (result.success) await onChanged(); }} className="mt-1 text-cyan-300">负责人同意</button>}
      </Td>
      <Td>{formatDate(item.firstDraftMeetingAt)}</Td><Td>{formatDate(item.secondDraftMeetingAt)}</Td><Td>{formatDate(item.thirdDraftMeetingAt)}</Td>
      <Td>{formatDate(item.projectAt)}</Td><Td>{formatDate(item.plannedProjectAt)}</Td><Td>{formatBool(item.needUiDesign)}</Td><Td>{formatBool(item.isAiPoc)}</Td>
      <Td>{item.planUrl ? <a href={item.planUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="text-cyan-300">查看方案</a> : '-'}</Td>
      <Td>{item.developmentStatus || '待开发'}</Td><Td>{item.remark || '-'}</Td>
      <Td>
        {reviewScoreText === '-' ? (
          <span className="text-token-muted">-</span>
        ) : (
          <span className={
            item.reviewPassed === true ? 'text-emerald-300'
              : item.reviewPassed === false ? 'text-rose-300'
                : 'text-token-secondary'
          }>{reviewScoreText}</span>
        )}
      </Td>
      <Td onClick={(e) => e.stopPropagation()}>
        {(showRetryReview || showFillMeeting) ? (
          <div className="flex flex-col items-start gap-1">
            {showRetryReview && (
              <button type="button" onClick={() => onRetryReview(item)} className="text-amber-200 hover:underline">重新发起立项</button>
            )}
            {showFillMeeting && (
              <button type="button" onClick={() => onFillMeeting(item)} className="text-cyan-300 hover:underline">会议结果</button>
            )}
          </div>
        ) : null}
      </Td>
    </tr>
          );
        })}{items.length === 0 && <Empty cols={21}>{pending ? '记录尚未完整读取，请查看上方进度或错误提示。' : '暂无立项记录'}</Empty>}
      </Table>
    </>
  );
}

function ReleaseTable({ productId, productName, productNames, items, requirementNames, names, onChanged, currentUserId, pending }: {
  pending?: boolean;
  productId: string;
  productName: string;
  productNames: ReadonlyMap<string, string>;
  items: ProductRelease[];
  requirementNames: ReadonlyMap<string, string>;
  names: ReadonlyMap<string, string>;
  onChanged: () => Promise<void>;
  currentUserId?: string;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const openRelease = (item: ProductRelease) => navigate(`/product-agent/p/${item.productId}/release/${item.id}`);
  const openInitiation = (item: ProductRelease) => navigate(`/product-agent/p/${item.productId}/initiation/${item.initiationId}`);
  const { selection, exportSelected, tableSelection } = useOverviewTableSelection(items, releaseExportConfig(productId || '全部产品', productName, names, [], productNames, requirementNames));
  return <>
    <SelectionActionBar mode="export" selection={selection} onExport={exportSelected} />
    <Table headers={['产品', '正式版本号', '内部版本号', '项目类别', '版本类别', '产品立项方案名称', '需求来源', '所属部门', '产品负责人（申领人）', '项目组成员', '方案地址', '上线日期', '预计培训时长', '是否全域开放', '当前开放品牌', '关联需求', '上线公告地址', '状态']} selection={tableSelection}>
    {items.map((item) => <tr key={item.id} className={listSelectionRowClass('border-t border-token-subtle align-top cursor-pointer hover-bg-soft')} onClick={() => openRelease(item)}>
      <ListTableSelectionCell selection={tableSelection} id={item.id} />
      <Td>{resolveVersionProductLabel(item, productNames.get(item.productId) ?? productName)}</Td>
      <Td mono><button type="button" onClick={(e) => { e.stopPropagation(); openRelease(item); }} className="text-cyan-300 hover:underline">{item.vCode}</button></Td>
      <Td mono>{item.initiationId && item.tCode
        ? <button type="button" onClick={(e) => { e.stopPropagation(); openInitiation(item); }} className="text-cyan-300 hover:underline">{item.tCode}</button>
        : (item.tCode ?? '临时优化需求')}</Td>
      <Td>{item.projectType === 'custom' ? '定制项目' : '非定制项目'}</Td><Td>{SCALE_LABEL[item.versionType]}</Td>
      <Td><button type="button" onClick={(e) => { e.stopPropagation(); openRelease(item); }} className="text-left text-cyan-300 hover:underline">{item.planName}</button></Td>
      <Td>{item.demandSource || '-'}</Td>
      <Td>{item.departmentName || '-'}</Td><Td>{item.ownerName || names.get(item.ownerId ?? '') || item.legacyData?.['产品负责人'] || item.ownerId || '-'}</Td>
      <Td>{(item.projectMemberNames?.length ? item.projectMemberNames : item.teamMemberIds.map((id) => names.get(id) ?? id)).join('、')}</Td>
      <Td>{item.planUrl ? <a href={item.planUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="text-cyan-300">查看方案</a> : '-'}</Td>
      <Td>{formatDate(item.plannedReleaseAt)}</Td>
      <Td>{formatVersionTrainingMinutes(item.plannedTrainingMinutes)}</Td>
      <Td>{formatBool(item.isGlobalOpen)}</Td>
      <Td>{item.openBrandScope || '上线全域开放'}</Td><Td>{item.requirementIds.map((id) => requirementNames.get(id) ?? id).join('、') || '-'}</Td>
      <Td onClick={(e) => e.stopPropagation()}>{item.status === 'announcement_pending' ? item.ownerId === currentUserId && editing === item.id ? <div className="flex min-w-64 gap-1"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="粘贴公告地址" /><button onClick={async () => { const r = await completeRelease(item.id, url); if (r.success) { setEditing(null); setUrl(''); await onChanged(); } }} className="rounded bg-cyan-400 px-2 text-slate-950">完成</button></div>
        : item.ownerId !== currentUserId ? <span className="text-token-muted">待申请人填写</span> : <div className="flex gap-2"><a href="https://sso.baklib.com/" target="_blank" rel="noreferrer" className="text-cyan-300">去发布公告</a><button onClick={() => setEditing(item.id)} className="text-token-secondary">填写地址</button></div>
        : item.announcementUrl ? <a className="text-cyan-300" href={item.announcementUrl} target="_blank" rel="noreferrer">查看公告</a> : '-'}</Td>
      <Td><Status value={item.status} /></Td>
    </tr>)}{items.length === 0 && <Empty cols={18}>{pending ? '记录尚未完整读取，请查看上方进度或错误提示。' : '暂无上线记录'}</Empty>}
  </Table>
  </>;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : '-';
}

function formatBool(value?: boolean | null) {
  return value == null ? '-' : value ? '是' : '否';
}

function matchesRecord(
  item: ProductInitiation | ProductRelease,
  query: string,
  status: string,
) {
  if (status && item.status !== status) return false;
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  return Object.values(item).some((value) => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.some((entry) => String(entry).toLowerCase().includes(keyword));
    if (typeof value === 'object') return false;
    return String(value).toLowerCase().includes(keyword);
  });
}

function RecordToolbar({ query, onQueryChange, scope, onScopeChange, ownerId, onOwnerChange, status, onStatusChange, statuses, trackedOnly, onTrackedOnlyChange }: {
  query: string;
  onQueryChange: (value: string) => void;
  scope?: RecordScope;
  onScopeChange?: (value: RecordScope) => void;
  ownerId?: string;
  onOwnerChange?: (value: string) => void;
  status: string;
  onStatusChange: (value: string) => void;
  statuses: string[];
  trackedOnly?: boolean;
  onTrackedOnlyChange?: (value: boolean) => void;
}) {
  const filterClassName = 'h-8 rounded-lg border border-token-subtle bg-[#111318] px-3 text-xs text-token-secondary outline-none focus:border-cyan-400/50';
  return <div className="flex flex-wrap items-center gap-2">
    <div className={OVERVIEW_LIST_SEARCH_BOX}>
      <Search size={14} className="shrink-0 text-token-muted" />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索版本号、方案名称等"
        className="min-w-0 flex-1 bg-transparent text-xs text-token-primary outline-none placeholder-token-muted"
      />
    </div>
    {onOwnerChange
      ? <div className="h-8 w-52">
          <UserSearchSelect value={ownerId ?? ''} onChange={onOwnerChange} placeholder="全部负责人" showAllOption allOptionLabel="全部负责人" uiSize="sm" />
        </div>
      : <select
          aria-label="记录范围"
          value={scope}
          onChange={(event) => onScopeChange?.(event.target.value as RecordScope)}
          className={filterClassName}
        >
          <option value="mine">我的申请</option>
          <option value="all">全部申请</option>
        </select>}
    <select
      aria-label="状态"
      value={status}
      onChange={(event) => onStatusChange(event.target.value)}
      className={filterClassName}
    >
      <option value="">全部状态</option>
      {statuses.map((value) => <option key={value} value={value}>{STATUS_LABEL[value] ?? value}</option>)}
    </select>
    {onTrackedOnlyChange && <TrackedFilterToggle active={trackedOnly ?? false} onChange={onTrackedOnlyChange} />}
  </div>;
}

function Stepper({ step }: { step: number }) { return <div className="mb-6 flex">{['基础信息', 'Agent 评审', '立项决策'].map((label, i) => <div key={label} className="flex flex-1 items-center last:flex-none"><div className={`flex items-center gap-2 text-xs ${step >= i + 1 ? 'text-cyan-300' : 'text-token-muted'}`}><span className={`flex h-7 w-7 items-center justify-center rounded-full border ${step > i + 1 ? 'border-cyan-400 bg-cyan-400 text-slate-950' : step === i + 1 ? 'border-cyan-400' : 'border-token-subtle'}`}>{step > i + 1 ? <CheckCircle2 size={15} /> : i + 1}</span>{label}</div>{i < 2 && <div className={`mx-3 h-px flex-1 ${step > i + 1 ? 'bg-cyan-400' : 'bg-token-nested'}`} />}</div>)}</div>; }
function Modal({ title, onClose, width, children, compact = false }: { title: string; onClose: () => void; width: string; children: React.ReactNode; compact?: boolean }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`flex w-full ${width} flex-col rounded-2xl border border-token-subtle bg-[#15171c]`}
        style={{ height: compact ? 'auto' : 'min(90vh, 760px)', maxHeight: '90vh' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 justify-between border-b border-token-subtle px-6 py-4">
          <h3 className="text-base font-semibold text-token-primary">{title}</h3>
          <button onClick={onClose} className="text-token-muted hover-text-primary" aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) { return <label className={full ? 'md:col-span-2' : ''}><span className="mb-1.5 block text-xs text-token-secondary">{label}</span>{children}</label>; }
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className="w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none placeholder-token-muted focus:border-cyan-400/50" />; }
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className="surface-tone-dark w-full rounded-lg border border-token-subtle bg-[#111318] px-3 py-2 text-sm text-token-primary outline-none">{props.children}</select>; }
function Primary(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-40">{props.children}</button>; }
function Secondary(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-xs text-token-secondary">{props.children}</button>; }
function Tab({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) { return <button onClick={onClick} className={`border-b-2 px-4 py-3 text-sm ${active ? 'border-cyan-400 text-cyan-200' : 'border-transparent text-token-muted'}`}>{children}</button>; }
function Table({ headers, children, selection }: {
  headers: string[];
  children: ReactNode;
  selection?: TableSelectionProps;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-token-subtle">
      <table className="w-full min-w-[900px] text-left text-xs">
        {selection ? (
          <colgroup>
            <col style={{ width: LIST_SELECTION_COL_WIDTH }} />
          </colgroup>
        ) : null}
        <thead className="bg-token-nested text-token-muted">
          <tr className={LIST_HEADER_HOVER_GROUP}>
            {selection ? (
              <ListSelectionHeaderCell
                allSelected={selection.allSelected}
                indeterminate={selection.indeterminate}
                onToggleAll={selection.onToggleAll}
              />
            ) : null}
            {headers.map((h) => <th key={h} className="whitespace-pre-line px-3 py-3 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Td({ children, mono, onClick, className }: { children: React.ReactNode; mono?: boolean; onClick?: React.MouseEventHandler<HTMLTableCellElement>; className?: string }) {
  return <td className={`max-w-64 px-3 py-3 text-token-secondary ${mono ? 'font-mono text-cyan-200' : ''} ${className ?? ''}`} onClick={onClick}>{children}</td>;
}
function Empty({ cols, children }: { cols: number; children: React.ReactNode }) { return <tr><td colSpan={cols} className="px-3 py-12 text-center text-token-muted">{children}</td></tr>; }
function Status({ value }: { value: string }) { const good = value === 'approved' || value === 'released'; return <span className={`rounded-full border px-2 py-0.5 ${good ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'}`}>{STATUS_LABEL[value] ?? value}</span>; }
function Info({ children }: { children: React.ReactNode }) { return <div className="rounded-lg border border-token-subtle bg-token-nested p-3 text-xs leading-5 text-token-secondary">{children}</div>; }
function Score({ score, passed }: { score: number; passed: boolean }) { return <div className={`rounded-xl border p-5 text-center ${passed ? 'border-emerald-400/25 bg-emerald-400/10' : 'border-red-400/25 bg-red-400/10'}`}><div className={`text-4xl font-semibold ${passed ? 'text-emerald-300' : 'text-red-300'}`}>{score}</div><div className="mt-1 text-sm text-token-secondary">{passed ? '评审通过' : '评审未通过'}</div></div>; }
