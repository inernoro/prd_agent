import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { CheckCircle2, Download, FileText, HelpCircle, Plus, Search, Upload, X } from 'lucide-react';
import {
  completeRelease, createInitiation, decideInitiation,
  listVersionApplicationProducts, getWorkflowInitiations, getWorkflowReleases,
  syncInitiationReview, updateInitiation, listProductVersionReviewSources, parseProductVersionMessage,
  getInitiationPlanDefaults,
  type VersionApplicationProduct, type WorkflowVersionRecord,
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
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { InitiationDeleteAction } from '@/components/product-agent/InitiationDeleteAction';
import { VersionDebugClearButton } from '@/components/product-agent/VersionDebugClearButton';
import { useProductListScope } from '@/lib/productListScope';
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
import { useVersionPlanName } from './useVersionPlanName';
import type { VersionRegistration, VersionRegistrationMessageParseResult } from '@/services/real/productVersionRegistry';
import { VersionCopyActions } from './VersionCopyActions';
import { ReleaseApplicationDialog } from './ReleaseWorkflowDetail';
import { VersionWorkflowImportDialog } from './VersionWorkflowImportDialog';
import { LegacyVersionDetail } from './LegacyVersionDetail';
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
  const [initiations, setInitiations] = useState<WorkflowVersionRecord<ProductInitiation>[]>([]);
  const [releases, setReleases] = useState<WorkflowVersionRecord<ProductRelease>[]>([]);
  const [requirementNames, setRequirementNames] = useState<Map<string, string>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadedTabs, setLoadedTabs] = useState({ initiation: false, release: false });
  const [dialog, setDialog] = useState<'initiation' | 'release' | 'temporary' | null>(null);
  const [actionProductId, setActionProductId] = useState('');
  const [importKind, setImportKind] = useState<MainTab | null>(null);
  const [legacyDetail, setLegacyDetail] = useState<VersionRegistration | null>(null);
  const [retrySeed, setRetrySeed] = useState<ProductInitiation | null>(null);
  const [meetingFillItem, setMeetingFillItem] = useState<ProductInitiation | null>(null);
  const [recordScope, setRecordScope] = useState<RecordScope>('all');
  const [releaseOwnerId, setReleaseOwnerId] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const requestSequence = useRef(0);
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
    const sequence = ++requestSequence.current;
    const isCurrent = () => requestSequence.current === sequence;
    setLoading(true);
    setLoadError('');
    try {
      if (tab === 'initiation') {
        const result = await getWorkflowInitiations();
        if (!isCurrent()) return;
        if (!result.success) { setLoadError(result.error?.message ?? '内部版本读取失败，请重试。'); return; }
        setInitiations(result.data.items.map(({ record, legacyRegistration }) => ({ ...record, legacyRegistration })));
      } else {
        const result = await getWorkflowReleases();
        if (!isCurrent()) return;
        if (!result.success) { setLoadError(result.error?.message ?? '正式版本读取失败，请重试。'); return; }
        setReleases(result.data.items.map(({ record, legacyRegistration }) => ({ ...record, legacyRegistration })));
        setRequirementNames(new Map(Object.entries(result.data.requirementNames)));
      }
      setLoadedTabs((previous) => ({ ...previous, [tab]: true }));
    } catch {
      if (isCurrent()) setLoadError('版本记录读取失败，请重试；已显示的记录予以保留。');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [tab]);

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
  const listLoading = loading || !loadedTabs[tab];
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
            placeholder="输入产品名称或编号搜索"
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
        {isAdmin && <VersionDebugClearButton key={tab} kind={tab === 'initiation' ? 'internal' : 'formal'} onChanged={reload} />}
        {isAdmin && <Secondary disabled={!catalogLoaded || Boolean(catalogError) || selectedProductUnavailable} onClick={() => setImportKind(tab)}><Upload size={14} />导入历史{tab === 'release' ? '正式' : '内部'}版本</Secondary>}
        <Secondary disabled={listLoading || Boolean(catalogError) || Boolean(loadError) || (tab === 'release' ? visibleReleases : visibleInitiations).length === 0}
          onClick={() => tab === 'release'
            ? downloadListCsv(formalExport.filename, formalExport.headers, visibleReleases.map(formalExport.mapRow))
            : downloadListCsv(internalExport.filename, internalExport.headers, visibleInitiations.map(internalExport.mapRow))}><Download size={14} />导出{tab === 'release' ? '正式' : '内部'}版本</Secondary>
        <Primary disabled={!catalogLoaded || Boolean(catalogError) || selectedProductUnavailable} onClick={() => openApplication(tab)}><Plus size={14} />申领{tab === 'release' ? '正式' : '内部'}版本号</Primary>
        {tab === 'release' && <Secondary disabled={!catalogLoaded || Boolean(catalogError) || selectedProductUnavailable} onClick={() => openApplication('temporary')}>临时优化需求</Secondary>}
        {tab === 'release' && <span title="月度常规计划外、紧急且工作量较小的优化，无需 T 号，确认后自动发号。" className="text-token-muted"><HelpCircle size={15} /></span>}
      </div>
    </div>
    {(catalogError || loadError || selectedProductUnavailable) && <div role="alert" className="shrink-0 rounded-lg border border-token-subtle bg-token-nested p-3 text-sm text-token-secondary">
      {catalogError || (selectedProductUnavailable ? '所选产品不存在或无权访问，请清除产品筛选后重试。' : loadError)}
      {!selectedProductUnavailable && <button type="button" className="ml-3 text-[color:var(--accent-fg-blue)] hover:underline" onClick={() => catalogError ? setCatalogAttempt((value) => value + 1) : void reload()}>重试</button>}
    </div>}
    <div className="min-h-0 flex-1 overflow-auto" style={{ overscrollBehavior: 'contain' }}>
      {!selectedProductUnavailable && (tab === 'release'
          ? <ReleaseTable pending={listLoading || Boolean(loadError)} productId={productId} productName={productName} productNames={productNames} items={visibleReleases} requirementNames={requirementNames} names={names} onChanged={reload} currentUserId={currentUserId} onOpenLegacy={setLegacyDetail} />
          : <InitiationTable pending={listLoading || Boolean(loadError)} productId={productId} productName={productName} productNames={productNames} items={visibleInitiations} names={names} currentUserId={currentUserId} onRetryReview={setRetrySeed} onFillMeeting={setMeetingFillItem} onChanged={reload} onOpenLegacy={setLegacyDetail} />)}
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
    {legacyDetail && <Modal title="历史版本详情（只读）" onClose={() => setLegacyDetail(null)} width="max-w-2xl">
      <LegacyVersionDetail record={legacyDetail} />
    </Modal>}
    {retrySeed && <InitiationApplication productId={retrySeed.productId} seed={retrySeed} onClose={() => setRetrySeed(null)} onChanged={reload} />}
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
  return <InitiationWizard key={seed?.id ?? 'new'} productId={seed?.productId ?? applicationProductId} applicationProducts={applicationProducts}
    onApplicationProductChange={applicationProducts ? setApplicationProductId : undefined}
    requirements={[]} members={[]} seed={seed} onClose={onClose} onChanged={onChanged} />;
}

export function InitiationWizard({ productId, applicationProducts, onApplicationProductChange, onClose, onChanged, seed }: {
  productId: string;
  applicationProducts?: VersionApplicationProduct[];
  onApplicationProductChange?: (productId: string) => void;
  requirements: Requirement[];
  members: ProductMember[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  /** 失败或中断后继续同一立项，保留填写内容与历次评审。 */
  seed?: ProductInitiation;
}) {
  const permissions = useAuthStore((state) => state.permissions ?? []);
  const isRoot = useAuthStore((state) => state.isRoot);
  const canUseProduct = hasEffectivePermission(permissions, 'product-agent.use', isRoot);
  const isRetry = Boolean(seed);
  const wizardTitle = seed?.tCode ? '修改内部版本资料' : seed?.status === 'decision_pending'
    ? '继续立项决策'
    : isRetry
      ? '重新发起立项'
      : '申领内部版本号';
  const formId = useId();
  const [sourceMode, setSourceMode] = useState<'existing' | 'upload'>(seed && !seed.reviewPassed ? 'upload' : 'existing');
  const [item, setItem] = useState<ProductInitiation | null>(seed ?? null);
  const [projectType, setProjectType] = useState<'standard' | 'custom'>(seed?.projectType ?? 'standard');
  const [customerSource, setCustomerSource] = useState(seed?.customerSource ?? '');
  const [demandSource, setDemandSource] = useState(seed?.demandSource ?? '');
  const [linkedProductId, setLinkedProductId] = useState(seed?.linkedProductId ?? productId);
  const [catalogProducts, setCatalogProducts] = useState<VersionApplicationProduct[]>([]);
  const planNameDraft = useVersionPlanName(seed?.planName ?? '');
  const planName = planNameDraft.value;
  const [plannedProjectAt, setPlannedProjectAt] = useState(seed?.plannedProjectAt ? formatVersionBasicDate(seed.plannedProjectAt) : '');
  const [needUiDesign, setNeedUiDesign] = useState(seed ? (seed.needUiDesign == null ? '' : seed.needUiDesign ? 'yes' : 'no') : 'no');
  const [isAiPoc, setIsAiPoc] = useState(seed ? (seed.isAiPoc == null ? '' : seed.isAiPoc ? 'yes' : 'no') : 'yes');
  const [remark, setRemark] = useState(seed?.remark ?? '');
  const [reviewSubmissionId, setReviewSubmissionId] = useState(seed?.reviewPassed ? seed.reviewSubmissionId ?? '' : '');
  const [reviewSources, setReviewSources] = useState<Array<{ id: string; title: string; fileName: string }>>([]);
  const [reviewSourcesLoaded, setReviewSourcesLoaded] = useState(false);
  const [reviewSourcesError, setReviewSourcesError] = useState('');
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [canUseAllReviews, setCanUseAllReviews] = useState(false);
  const reviewApplicationSequence = useRef(0);
  const [reviewApplicationMatching, setReviewApplicationMatching] = useState(false);
  const [versionType, setVersionType] = useState<'major' | 'medium' | 'minor'>(seed?.versionType ?? 'minor');
  const [file, setFile] = useState<File | null>(null);
  const [meeting, setMeeting] = useState(seed?.reviewMeetingRequired ?? false);
  const [meetingDraftCount, setMeetingDraftCount] = useState(seed?.meetingDraftCount ?? 1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [sourceRejection, setSourceRejection] = useState<{ title: string; message: string } | null>(null);
  const editingIssued = Boolean(seed?.tCode);
  const submittingRef = useRef(false);
  const [draftDefaultsPending, setDraftDefaultsPending] = useState(false);
  const reviewPanelRef = useRef<HTMLDivElement>(null);
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
  const issuedCode = item?.tCode ?? '';
  const completed = !editingIssued && Boolean(issuedCode);
  const sourceFileName = reviewSources.find((source) => source.id === reviewSubmissionId)?.fileName;
  const planFileName = sourceMode === 'upload'
    ? file?.name ?? item?.reviewAttempts?.slice(-1)[0]?.planFileName ?? undefined
    : sourceFileName ?? item?.reviewAttempts?.slice(-1)[0]?.planFileName ?? undefined;
  const progressPercent = useMemo(
    () => computeInitiationReviewProgress(reviewStage, dimensionScores.length, expectedDimCount),
    [reviewStage, dimensionScores.length, expectedDimCount],
  );

  useEffect(() => {
    if (reviewRunning) reviewPanelRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [reviewRunning]);

  useEffect(() => {
    if (applicationProducts) return;
    void listVersionApplicationProducts().then((res) => { if (res.success) setCatalogProducts(res.data.items); });
  }, [applicationProducts]);

  useEffect(() => {
    let active = true;
    setReviewSourcesError('');
    void listProductVersionReviewSources().then((res) => {
      if (!active) return;
      if (res.success) {
        setReviewSources(res.data.items);
        setCanUseAllReviews(res.data.canUseAllReviews);
      } else setReviewSourcesError('已有方案暂时无法读取，请重试或上传新方案。');
      setReviewSourcesLoaded(true);
    }).catch(() => {
      if (active) { setReviewSourcesError('已有方案暂时无法读取，请重试或上传新方案。'); setReviewSourcesLoaded(true); }
    });
    return () => { active = false; };
  }, [sourceAttempt]);

  useEffect(() => {
    if (sourceMode !== 'upload') return;
    void getDimensions().then((res) => {
      if (res.success) {
        setExpectedDimCount(res.data.dimensions.filter((d) => d.isActive).length);
      }
    }).catch(() => { /* 维度数仅用于进度展示，不阻断提交。 */ });
  }, [sourceMode]);

  useEffect(() => {
    if (completed || busy) return;
    let active = true;
    setDraftDefaultsPending(true);
    const timer = window.setTimeout(() => {
      void getInitiationPlanDefaults(planName, planFileName).then((res) => {
        if (active && res.success) setMeetingDraftCount(res.data.meetingDraftCount);
      }).catch(() => { /* 预览失败不阻断填写，保存时由同一服务端规则确认。 */ })
        .finally(() => { if (active) setDraftDefaultsPending(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [planName, planFileName, busy, completed]);

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
    planNameDraft.setSource(source.title);
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

  const chooseSourceMode = (mode: 'existing' | 'upload') => {
    if (item || busy) return;
    cancelReviewApplicationLookup();
    setSourceMode(mode);
    setMessage('');
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
    reviewMeetingRequired: meeting,
    primaryOwnerId: item?.primaryOwnerId ?? undefined,
    planFileName,
    needUiDesign: editingIssued && !needUiDesign ? item?.needUiDesign ?? undefined : needUiDesign === 'yes',
    isAiPoc: editingIssued && !isAiPoc ? item?.isAiPoc ?? undefined : isAiPoc === 'yes',
    developmentStatus: item?.developmentStatus,
    remark: remark.trim() || undefined,
    reviewSubmissionId: item?.reviewSubmissionId || (sourceMode === 'existing' ? reviewSubmissionId || undefined : undefined),
    versionType,
    requirementIds: item?.requirementIds ?? [],
  });

  const runReview = async (saved: ProductInitiation): Promise<ProductInitiation> => {
    setDimensionScores([]);
    setTotalScore(null);
    setReviewPassed(null);
    setAdjustmentLog([]);
    setProcessLogs([]);
    sse.reset();
    streamErrorRef.current = null;
    sseOutcomeRef.current = { hasResult: false, dimensionCount: 0, streamDone: false };

    let submissionId = saved.reviewSubmissionId;
    if (sourceMode === 'upload' && file) {
      setReviewStage('uploading');
      appendLog(`开始上传：${file.name}`);
      const uploaded = await uploadAttachment(file);
      if (!uploaded.success) throw new Error(uploaded.error?.message ?? '上传失败，请重新选择文件后重试。');
      appendLog('方案文件上传成功');

      setReviewStage('submitting');
      appendLog('正在创建 Agent 评审任务…');
      const submitted = await createSubmission(planName, uploaded.data.attachmentId);
      if (!submitted.success) throw new Error(submitted.error?.message ?? '提交评审失败，请重试。');
      submissionId = submitted.data.submission.id;
      // 先关联任务，再等待流：断线后仍能从原立项恢复，不丢失填写内容。
      const linked = await syncInitiationReview(saved.id, submissionId);
      if (!linked.success) throw new Error(linked.error?.message ?? '评审任务关联失败，请查看评审记录后重试。');
      setItem(linked.data);
      appendLog('评审任务已关联到当前立项');
    }
    if (!submissionId) throw new Error('请选择方案文件后重试。');

    setReviewStage('streaming');
    appendLog('连接评审流，等待 Agent 分析打分…');
    await sse.start({ url: getResultStreamUrl(submissionId) });

    const outcome = sseOutcomeRef.current;
    const recoverable = hasRecoverableSseOutcome(outcome);

    if (streamErrorRef.current && !recoverable) {
      throw new Error(streamErrorRef.current);
    }
    if (streamErrorRef.current && recoverable) {
      appendLog('评审结果已从流中获取，忽略连接异常并继续同步…');
    }

    if (!outcome.hasResult && !outcome.streamDone) {
      appendLog('确认服务端评审状态…');
      const waited = await waitForSubmissionDone(submissionId);
      if (!waited.ok && !recoverable) {
        throw new Error(waited.message);
      }
      if (!waited.ok && recoverable) {
        appendLog(`详情查询失败（${waited.message}），仍尝试同步立项…`);
      }
    }

    setReviewStage('syncing');
    appendLog('正在同步评审结果到立项记录…');
    const synced = await syncInitiationReview(saved.id, submissionId);
    if (!synced.success) {
      if (recoverable) {
        throw new Error(`评审已完成，但同步立项失败：${synced.error?.message ?? '未知错误'}。请从当前记录继续。`);
      }
      throw new Error(synced.error?.message ?? '同步评审结果失败，请从当前记录继续。');
    }
    setItem(synced.data);
    appendLog('立项记录已更新');
    return synced.data;
  };
  const submitDecision = async (reviewed: ProductInitiation) => {
    if (reviewed.reviewPassed !== true) return;
    const res = await decideInitiation(reviewed.id, {
      reviewMeetingRequired: meeting,
      expectedMeetingAt: meeting ? reviewed.plannedProjectAt ?? undefined : undefined,
      meetingDraftCount: meeting ? reviewed.meetingDraftCount ?? 1 : undefined,
    });
    if (!res.success) throw new Error(res.error?.message ?? '提交失败，请从当前记录继续。');
    setItem(res.data);
    if (res.data.tCode) {
      try {
        await navigator.clipboard.writeText(res.data.tCode);
        setMessage('立项号已生成并自动复制。');
      } catch {
        setMessage('立项号已生成；浏览器未允许自动复制，请点击复制编号。');
      }
    } else {
      setMessage('尚未取得 T 立项号，填写内容已保存，请刷新原记录查看发号结果。');
    }
  };

  const confirmApplication = async () => {
    if (submittingRef.current || completed) return;
    if (!linkedProductId.trim()) return setMessage('请选择所属应用');
    if (!editingIssued && sourceMode === 'existing' && !reviewSubmissionId && !item?.reviewPassed) return setMessage('请选择一个已有方案，或切换到上传新方案。');
    if (!editingIssued && sourceMode === 'upload' && !file && !item?.reviewPassed
      && !(item?.status === 'review_pending' && item.reviewSubmissionId)) return setMessage('请在当前页面选择方案文件。');
    if (!planName.trim()) return setMessage('请填写方案名称');
    if (projectType === 'custom' && !customerSource.trim()) return setMessage('请填写客户来源');
    if (!editingIssued && !demandSource.trim()) return setMessage('请填写需求来源');
    if (!editingIssued && !plannedProjectAt) return setMessage('请填写计划立项时间');
    if (!editingIssued && (!needUiDesign || !isAiPoc)) return setMessage('请选择 UI 设计和 AI POC 状态');

    submittingRef.current = true;
    cancelReviewApplicationLookup();
    setBusy(true);
    setMessage('');
    let hasSavedRecord = Boolean(item);
    try {
      // 全部填写项先落在原记录上，失败重试不会另建一条立项。
      const payload = basePayload();
      const saved = item
        ? await updateInitiation(item.id, payload)
        : await createInitiation(applicationProducts ? linkedProductId : productId, payload);
      if (!saved.success) {
        const rejectionTitle = INITIATION_SOURCE_REJECTION_TITLES[saved.error?.code ?? ''];
        if (rejectionTitle) {
          setSourceRejection({ title: rejectionTitle, message: saved.error.message });
          return;
        }
        throw new Error(saved.error?.message ?? '填写内容保存失败，请重试。');
      }
      hasSavedRecord = true;
      setItem(saved.data);
      setMeetingDraftCount(saved.data.meetingDraftCount ?? 1);
      if (editingIssued) {
        setMessage('基础资料已保存，原 T 号、评审及下游关联保持不变。');
        return;
      }
      const reviewed = saved.data.reviewPassed && (sourceMode === 'existing' || !file) ? saved.data : await runReview(saved.data);
      if (reviewed.reviewPassed !== true) {
        setMessage(reviewed.reviewPassed === false
          ? `评审未通过${reviewed.reviewScore == null ? '' : `，得分 ${reviewed.reviewScore}`}，未生成 T 号。填写内容及本次评审记录已保存，修改方案后可继续。`
          : '评审尚未完成，暂未生成 T 号。填写内容及当前任务已保存，可从原记录继续。');
        return;
      }
      setFile(null);
      await submitDecision(reviewed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '处理未完成，请重试。';
      setMessage(`${reason}${hasSavedRecord ? ' 已保存填写内容，请从当前记录继续，不要重复新建。' : ''}`);
    } finally {
      setReviewStage('idle');
      setBusy(false);
      submittingRef.current = false;
      if (hasSavedRecord) {
        try { await onChanged(); } catch { /* 保存结果不依赖列表刷新；原记录可再次打开。 */ }
      }
    }
  };

  const applyParsedMessage = (parsed: VersionRegistrationMessageParseResult, editVersion?: number) => {
    cancelReviewApplicationLookup();
    if (parsed.projectType) setProjectType(parsed.projectType);
    if (parsed.versionType) setVersionType(parsed.versionType);
    if (parsed.demandSource) setDemandSource(parsed.demandSource);
    if (parsed.planName && planNameDraft.isCurrentEdit(editVersion)) {
      planNameDraft.setPasted(parsed.planName, editVersion);
      const match = reviewSources.find((source) => source.title.replace(/\s+/g, '') === parsed.planName?.replace(/\s+/g, ''));
      if (match && !item && sourceMode === 'existing') setReviewSubmissionId(match.id);
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

  const sourceOptions = reviewSources.map((source) => ({ id: source.id, label: source.title, searchExtra: source.fileName }));
  if (item?.reviewPassed && item.reviewSubmissionId && !sourceOptions.some((option) => option.id === item.reviewSubmissionId)) {
    sourceOptions.unshift({ id: item.reviewSubmissionId, label: item.planName, searchExtra: planFileName ?? '' });
  }
  const confirmationLabel = editingIssued ? '保存修改' : sourceMode === 'upload' && (!item?.reviewPassed || file)
    ? '确认并评审，通过后自动申领' : '确认申领';

  return <Dialog
    open
    onOpenChange={(open) => { if (!open && !submittingRef.current) onClose(); }}
    title={wizardTitle}
    description={editingIssued ? '修改基础资料，保留原编号、评审和历史记录，不重新发号。' : '一次填写并确认，无需人工审批。带 * 为必填，其余为选填；评审未通过不发号，已填内容会保留。'}
    maxWidth={920}
    contentStyle={{ height: 'min(94vh, 960px)', maxHeight: '94vh' }}
    actions={<>
      {!completed && <span className="mr-auto hidden text-xs text-token-muted sm:block">{editingIssued ? '仅修改资料，不重新发号' : '评审通过后自动发放 T 号，无需人工审批'}</span>}
      <Button size="sm" onClick={onClose} disabled={busy}>{completed ? '完成' : '取消'}</Button>
      {!completed && <Button size="sm" variant="primary" type="submit" form={formId} disabled={busy || !linkedProductId.trim()}>
        {busy && <MapSpinner size={14} />}{busy ? (reviewRunning ? '评审中，通过后自动继续…' : '正在保存并提交…') : confirmationLabel}
      </Button>}
    </>}
    content={<div className="space-y-5">
      {completed ? <section className="space-y-3 rounded-md border border-token-subtle bg-token-nested p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-token-primary"><CheckCircle2 size={18} />内部版本号已生成</div>
        {issuedCode && item && <><p className="text-sm text-token-primary">立项号：<span className="font-mono font-semibold">{issuedCode}</span></p><VersionCopyActions kind="initiation" id={item.id} code={issuedCode} /></>}
      </section> : <form id={formId} onSubmit={(event) => { event.preventDefault(); void confirmApplication(); }} aria-busy={busy}>
        <fieldset disabled={busy} className="min-w-0 space-y-5 border-0 p-0">
          <section hidden={editingIssued} className="space-y-3" aria-labelledby={`${formId}-source`}>
            <h4 id={`${formId}-source`} className="text-sm font-semibold text-token-primary">方案来源 <span className="text-xs font-normal text-token-muted">两种方式，任选其一</span></h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3" style={{ borderColor: sourceMode === 'existing' ? 'var(--accent-primary)' : 'var(--border-subtle)', background: sourceMode === 'existing' ? 'var(--bg-input)' : undefined }}>
                <input type="radio" name={`${formId}-mode`} checked={sourceMode === 'existing'} onChange={() => chooseSourceMode('existing')} disabled={Boolean(item)} style={{ accentColor: 'var(--accent-primary)' }} className="mt-0.5" />
                <span><span className="block text-sm font-medium text-token-primary">选择已有方案</span><span className="mt-1 block text-xs text-token-secondary">浏览已有方案，无需重新上传；确认时校验评审和申领状态</span></span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3" style={{ borderColor: sourceMode === 'upload' ? 'var(--accent-primary)' : 'var(--border-subtle)', background: sourceMode === 'upload' ? 'var(--bg-input)' : undefined }}>
                <input type="radio" name={`${formId}-mode`} checked={sourceMode === 'upload'} onChange={() => chooseSourceMode('upload')} disabled={Boolean(item)} style={{ accentColor: 'var(--accent-primary)' }} className="mt-0.5" />
                <span><span className="block text-sm font-medium text-token-primary">上传新方案</span><span className="mt-1 block text-xs text-token-secondary">现在选择文件，确认后评审，通过后自动继续申领</span></span>
              </label>
            </div>
            {sourceMode === 'existing' ? <div className="space-y-2">
              <Field label="已有方案 *">
                <ItemSearchSelect value={reviewSubmissionId} onChange={chooseReviewSource} options={sourceOptions} disabled={busy || Boolean(item)} placeholder="搜索方案名称或文件名" countUnit="个方案" emptyText={reviewSourcesLoaded ? '暂无可查看的方案，请选择上传新方案' : '正在读取已有方案'} />
              </Field>
              <p className="text-xs leading-5 text-token-secondary">{canUseAllReviews ? '当前可查看所有人的方案。' : '显示本人全部方案。'}不按评审或申领状态隐藏，确认时校验。每个方案仅能申领一个 T，每个 T 仅能申领一个 V。</p>
              {!item && reviewSourcesLoaded && !reviewSourcesError && sourceOptions.length === 0 && <Button size="sm" onClick={() => chooseSourceMode('upload')}>暂无已有方案，改为上传新方案</Button>}
              {reviewSourcesError && <div className="flex items-center gap-2 text-xs text-token-secondary"><span>{reviewSourcesError}</span><button type="button" onClick={() => setSourceAttempt((value) => value + 1)} className="underline">重试</button></div>}
            </div> : <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-token-subtle bg-token-nested p-4 focus-within:ring-1 focus-within:ring-[var(--border-focus)]" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!busy) setFile(event.dataTransfer.files[0] ?? null); }}>
                {file ? <FileText size={24} className="shrink-0 text-token-secondary" /> : <Upload size={24} className="shrink-0 text-token-secondary" />}
                <span className="min-w-0"><span className="block break-all text-sm font-medium text-token-primary">{file ? file.name : '方案文件 *：点击选择或拖放到这里'}</span><span className="mt-1 block text-xs text-token-secondary">{file ? '文件已选择；确认后上传并评审，点击可更换' : '支持 PDF、Word、Markdown、TXT、Excel、PPT，无需进入下一页'}</span></span>
                <input type="file" aria-label="方案文件" className="sr-only" accept=".pdf,.doc,.docx,.md,.txt,.xls,.xlsx,.ppt,.pptx" onChange={(event) => { setFile(event.target.files?.[0] ?? null); event.target.value = ''; }} />
              </label>
              {planFileName && !file && <p className="text-xs text-token-secondary">上次方案文件：{planFileName}。{item?.reviewPassed ? '评审已通过，无需重复上传。' : item?.status === 'review_pending' ? '可继续当前评审，或选择新文件。' : '修改后在此选择文件，填写内容无需重填。'}</p>}
            </div>}
            {item && !completed && <p className="text-xs text-token-muted">正在继续已保存的立项，方案来源不变；修改后仍保存到同一条记录。</p>}
          </section>

          <section className="space-y-3 border-t border-token-subtle pt-4" aria-labelledby={`${formId}-basic`}>
            <h4 id={`${formId}-basic`} className="text-sm font-semibold text-token-primary">基础信息</h4>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {!editingIssued && <ProductVersionMessagePaste kind="internal" onParsed={applyParsedMessage} getPlanNameEditVersion={planNameDraft.getEditVersion} />}
              <Field label="所属应用 *" full>
                <ItemSearchSelect value={linkedProductId} onChange={(id) => { cancelReviewApplicationLookup(); setLinkedProductId(id); }} options={productOptions} disabled={busy || editingIssued} placeholder="搜索应用名称或编号" countUnit="个应用" emptyText="暂无可选应用" />
                {reviewApplicationMatching && <p role="status" className="mt-1.5 flex items-center gap-2 text-xs text-token-muted"><MapSpinner size={14} />正在识别方案所属应用，也可手动选择。</p>}
              </Field>
              <Field label="方案名称 *" full><InitiationInput value={planName} onChange={(e) => { cancelReviewApplicationLookup(); planNameDraft.setManual(e.target.value); }} /></Field>
              <Field label="项目类别"><InitiationSelect value={projectType} onChange={(e) => setProjectType(e.target.value as typeof projectType)}><option value="standard">非定制</option><option value="custom">定制</option></InitiationSelect></Field>
              <Field label="版本级别"><InitiationSelect disabled={editingIssued} value={versionType} onChange={(e) => setVersionType(e.target.value as typeof versionType)}>{Object.entries(SCALE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</InitiationSelect></Field>
              {projectType === 'custom' && <Field label="客户来源 *"><InitiationInput value={customerSource} onChange={(e) => setCustomerSource(e.target.value)} /></Field>}
              <Field label="需求来源 *"><InitiationInput value={demandSource} onChange={(e) => setDemandSource(e.target.value)} placeholder="例如：内部、客户名称" /></Field>
              <Field label="是否需要 UI 设计 *"><InitiationSelect value={needUiDesign} onChange={(e) => setNeedUiDesign(e.target.value)}><option value="">请选择</option><option value="yes">是</option><option value="no">否</option></InitiationSelect></Field>
              <Field label="是否属于 AI POC 项目 *"><InitiationSelect value={isAiPoc} onChange={(e) => setIsAiPoc(e.target.value)}><option value="">请选择</option><option value="yes">是</option><option value="no">否</option></InitiationSelect></Field>
              <Field label="备注（选填）" full><textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} className={INITIATION_CONTROL_CLASS} /></Field>
            </div>
          </section>

          <section className="space-y-3 border-t border-token-subtle pt-4" aria-labelledby={`${formId}-decision`}>
            <h4 id={`${formId}-decision`} className="text-sm font-semibold text-token-primary">立项安排</h4>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="是否需要开评审会"><InitiationSelect disabled={editingIssued} value={meeting ? 'yes' : 'no'} onChange={(e) => setMeeting(e.target.value === 'yes')}><option value="no">不需要</option><option value="yes">需要</option></InitiationSelect></Field>
              <div className="grid grid-cols-1 gap-4 md:col-span-2 md:grid-cols-2">
                <Field label="计划立项时间 *"><InitiationInput type="date" value={plannedProjectAt} onChange={(e) => setPlannedProjectAt(e.target.value)} />{meeting && <span className="mt-1 block text-xs text-token-muted">同时作为预计评审会时间，无需重复填写。</span>}</Field>
                {meeting && <Field label="计划召开稿次（自动识别）"><output className="block rounded-md border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary">{draftDefaultsPending && !busy ? '正在识别，未标注时默认第一稿' : `${['', '第一稿', '第二稿', '第三稿'][meetingDraftCount] ?? '第一稿'}${meetingDraftCount > 1 ? `（计划共 ${meetingDraftCount} 稿）` : '（默认）'}`}</output><span className="mt-1 block text-xs text-token-muted">按方案名称或文件名中的明确稿次识别，不按版本号或评审次数推断。</span></Field>}
              </div>
            </div>
            <p className="text-xs leading-5 text-token-secondary">{editingIssued ? `当前立项号：${issuedCode}。所属应用、版本级别和原会议安排保持不变，仅保存资料修改。` : <>Agent 评审通过后自动发放 T 号，无需人工审批。{meeting && '线下各稿会议结果在详情中后续回填。'}评审未通过不发号，已填写内容和历次评审记录都会保留。</>}</p>
          </section>
        </fieldset>
      </form>}

      {reviewRunning && <div ref={reviewPanelRef}><InitiationReviewLivePanel stage={reviewStage} ssePhase={sse.phase} phaseMessage={sse.phaseMessage} progressPercent={progressPercent} logs={processLogs} typing={sse.typing} dimensionScores={dimensionScores} totalScore={totalScore} isPassed={reviewPassed} adjustmentLog={adjustmentLog} expectedDimCount={expectedDimCount} /></div>}
      {!reviewRunning && !completed && item?.reviewScore != null && <p className="text-sm text-token-secondary">上次 Agent 评审：{item.reviewScore} 分，{item.reviewPassed ? '已通过，可继续申领' : '未通过，填写记录已保留'}。</p>}
      {!reviewRunning && item?.reviewAttempts && item.reviewAttempts.length > 0 && <details className="border-t border-token-subtle pt-3 text-xs text-token-secondary"><summary className="cursor-pointer">已保存的评审记录（{item.reviewAttempts.length} 次）</summary><ul className="mt-2 space-y-2">{item.reviewAttempts.map((attempt) => <li key={attempt.id}>{`第 ${attempt.attemptNo} 次：${attempt.planFileName ?? '方案'}，${attempt.reviewPassed == null ? '待完成' : attempt.reviewPassed ? '通过' : '未通过'}${attempt.reviewScore == null ? '' : `，${attempt.reviewScore} 分`}`}</li>)}</ul></details>}
      {message && <div role="status" aria-live="polite" className="rounded-md border border-token-subtle bg-token-nested px-3 py-2 text-xs leading-5 text-token-secondary">{message}</div>}
      {sourceRejection && <Dialog open onOpenChange={(open) => { if (!open) setSourceRejection(null); }} zIndex={110}
        title={sourceRejection.title} content={<div className="space-y-2 text-sm text-token-secondary"><p className="break-words font-medium text-token-primary">{planName}</p><p>{sourceRejection.message}</p><p>填写内容已保留，可返回修改。</p></div>}
        actions={<Button size="sm" onClick={() => setSourceRejection(null)}>返回修改</Button>} />}
    </div>}
  />;
}

const INITIATION_CONTROL_CLASS = 'w-full rounded-md border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none placeholder-token-muted focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]';
const INITIATION_SOURCE_REJECTION_TITLES: Record<string, string> = {
  REVIEW_ALREADY_REGISTERED: '该方案已有申领记录',
  REVIEW_NOT_PASSED: '该方案评审未通过',
  REVIEW_NOT_READY: '该方案评审尚未完成',
};
function InitiationInput(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={INITIATION_CONTROL_CLASS} />; }
function InitiationSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className={INITIATION_CONTROL_CLASS}>{props.children}</select>; }

function InitiationTable({ productId, productName, productNames, items, names, currentUserId, onRetryReview, onFillMeeting, onChanged, pending, onOpenLegacy }: {
  pending?: boolean;
  productId: string;
  productName: string;
  productNames: ReadonlyMap<string, string>;
  items: WorkflowVersionRecord<ProductInitiation>[];
  names: ReadonlyMap<string, string>;
  currentUserId?: string;
  onRetryReview: (item: ProductInitiation) => void;
  onFillMeeting: (item: ProductInitiation) => void;
  onOpenLegacy: (record: VersionRegistration) => void;
  onChanged: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const openDetail = (item: WorkflowVersionRecord<ProductInitiation>) => item.legacyRegistration
    ? onOpenLegacy(item.legacyRegistration)
    : navigate(`/product-agent/p/${item.productId}/initiation/${item.id}`);
  const { selection, exportSelected, tableSelection } = useOverviewTableSelection(items, initiationExportConfig(productId || '全部产品', productName, names, productNames));
  return (
    <>
      <SelectionActionBar mode="export" selection={selection} onExport={exportSelected} />
      <Table headers={['产品', '项目类别', '立项号', '版本类别', '产品立项方案名称', '需求来源', '项目需求描述', '所属部门', '产品负责人', '第一稿\n会议时间', '第二稿\n会议时间', '第三稿\n会议时间', '立项时间\n（三稿通过）', '计划立项时间', '是否需要UI设计', '是否 AI POC', '方案地址', '开发状态', '备注', 'Agent\n评审', '操作']} selection={tableSelection}>
        {items.map((item) => {
          const isOwner = !item.legacyRegistration && item.createdBy === currentUserId;
          const showRetryReview = isOwner && ['draft', 'review_pending', 'review_failed', 'decision_pending'].includes(item.status);
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
        {item.legacyRegistration && <button type="button" onClick={() => onOpenLegacy(item.legacyRegistration!)} className="text-token-secondary hover:underline">历史详情</button>}
        {isOwner && item.tCode && <button type="button" onClick={() => onRetryReview(item)} className="text-token-secondary hover:underline">修改资料</button>}
        {isOwner && item.tCode && <InitiationDeleteAction id={item.id} code={item.tCode} canDelete={item.canDelete} onDeleted={onChanged} />}
        {(showRetryReview || showFillMeeting) ? (
          <div className="flex flex-col items-start gap-1">
            {showRetryReview && (
              <button type="button" onClick={() => onRetryReview(item)} className="text-amber-200 hover:underline">{item.status === 'review_failed' ? '修改并重新评审' : '继续申领'}</button>
            )}
            {showFillMeeting && (
              <button type="button" onClick={() => onFillMeeting(item)} className="text-cyan-300 hover:underline">会议结果</button>
            )}
          </div>
        ) : null}
      </Td>
    </tr>
          );
        })}{items.length === 0 && !pending && <Empty cols={21}>暂无立项记录</Empty>}
      </Table>
    </>
  );
}

function ReleaseTable({ productId, productName, productNames, items, requirementNames, names, onChanged, currentUserId, pending, onOpenLegacy }: {
  pending?: boolean;
  productId: string;
  productName: string;
  productNames: ReadonlyMap<string, string>;
  items: WorkflowVersionRecord<ProductRelease>[];
  requirementNames: ReadonlyMap<string, string>;
  names: ReadonlyMap<string, string>;
  onChanged: () => Promise<void>;
  currentUserId?: string;
  onOpenLegacy: (record: VersionRegistration) => void;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const openRelease = (item: WorkflowVersionRecord<ProductRelease>) => item.legacyRegistration
    ? onOpenLegacy(item.legacyRegistration)
    : navigate(`/product-agent/p/${item.productId}/release/${item.id}`);
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
      <Td>{item.openBrandScope || (item.isGlobalOpen === true ? '上线全域开放' : '-')}</Td><Td>{item.requirementIds.map((id) => requirementNames.get(id) ?? id).join('、') || '-'}</Td>
      <Td onClick={(e) => e.stopPropagation()}>{!item.legacyRegistration && item.status === 'announcement_pending' ? item.ownerId === currentUserId && editing === item.id ? <div className="flex min-w-64 gap-1"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="粘贴公告地址" /><button onClick={async () => { const r = await completeRelease(item.id, url); if (r.success) { setEditing(null); setUrl(''); await onChanged(); } }} className="rounded bg-cyan-400 px-2 text-slate-950">完成</button></div>
        : item.ownerId !== currentUserId ? <span className="text-token-muted">待申请人填写</span> : <div className="flex gap-2"><a href="https://sso.baklib.com/" target="_blank" rel="noreferrer" className="text-cyan-300">去发布公告</a><button onClick={() => setEditing(item.id)} className="text-token-secondary">填写地址</button></div>
        : item.announcementUrl ? <a className="text-cyan-300" href={item.announcementUrl} target="_blank" rel="noreferrer">查看公告</a> : '-'}</Td>
      <Td><Status value={item.status} /></Td>
    </tr>)}{items.length === 0 && !pending && <Empty cols={18}>暂无上线记录</Empty>}
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
