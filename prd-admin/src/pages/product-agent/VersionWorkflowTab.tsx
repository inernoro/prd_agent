import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { CheckCircle2, HelpCircle, Loader2, Plus, Search, Upload, X } from 'lucide-react';
import {
  approveInitiation, completeRelease, createInitiation, decideInitiation,
  listInitiations, listProductMembers, listProducts, listReleases, listRequirements,
  syncInitiationReview, updateInitiation, getProduct,
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
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { ItemSearchSelect } from '@/components/ItemSearchSelect';
import { toProductOptions } from './comboboxOptions';
import type { ProductInitiation, ProductMember, ProductRelease, Product, Requirement } from './types';
import { resolveVersionProductLabel } from './versionBasicInfoCatalog';
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

type MainTab = 'release' | 'initiation';
type RecordScope = 'mine' | 'all';
const SCALE_LABEL = { major: '大版本', medium: '中版本', minor: '小版本' } as const;
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', review_pending: 'Agent 评审中', review_failed: '评审未通过',
  decision_pending: '待确认评审方式', owner_pending: '待负责人同意', approved: '已取得立项号',
  announcement_pending: '待填写上线公告', released: '已上线',
};

export function VersionWorkflowTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const currentUserId = useAuthStore((state) => state.user?.userId);
  const [tab, setTab] = useState<MainTab>('release');
  const [initiations, setInitiations] = useState<ProductInitiation[]>([]);
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [members, setMembers] = useState<ProductMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<'initiation' | null>(null);
  const [retrySeed, setRetrySeed] = useState<ProductInitiation | null>(null);
  const [meetingFillItem, setMeetingFillItem] = useState<ProductInitiation | null>(null);
  const [recordScope, setRecordScope] = useState<RecordScope>('mine');
  const [releaseOwnerId, setReleaseOwnerId] = useState(currentUserId ?? '');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [productName, setProductName] = useState('');

  useEffect(() => {
    void getProduct(productId).then((res) => {
      if (res.success) setProductName(res.data.name);
    });
  }, [productId]);

  useEffect(() => {
    if (currentUserId && !releaseOwnerId) setReleaseOwnerId(currentUserId);
  }, [currentUserId, releaseOwnerId]);

  const reload = useCallback(async () => {
    setLoading(true);
    const [i, r, req, mem] = await Promise.all([
      listInitiations(productId, recordScope),
      listReleases(productId, releaseOwnerId === currentUserId ? 'mine' : 'all', releaseOwnerId),
      listRequirements(productId),
      listProductMembers(productId),
    ]);
    if (i.success) setInitiations(i.data.items);
    if (r.success) setReleases(r.data.items);
    if (req.success) setRequirements(req.data.items);
    if (mem.success) setMembers(mem.data.members);
    setLoading(false);
  }, [currentUserId, productId, recordScope, releaseOwnerId]);

  useEffect(() => { void reload(); }, [reload]);
  const approved = useMemo(
    () => initiations.filter((item) => item.status === 'approved' && item.tCode && item.createdBy === currentUserId),
    [currentUserId, initiations],
  );
  const filteredInitiations = useMemo(
    () => initiations.filter((item) => matchesRecord(item, query, statusFilter)),
    [initiations, query, statusFilter],
  );
  const filteredReleases = useMemo(
    () => releases.filter((item) => matchesRecord(item, query, statusFilter)),
    [releases, query, statusFilter],
  );
  const visibleInitiations = useMemo(
    () => filterByTracked(filteredInitiations, trackedOnly, 'initiation', (item) => ({ productId, recordId: item.id })),
    [filteredInitiations, trackedOnly, productId],
  );
  const visibleReleases = useMemo(
    () => filterByTracked(filteredReleases, trackedOnly, 'release', (item) => ({ productId, recordId: item.id })),
    [filteredReleases, trackedOnly, productId],
  );
  const statuses = useMemo(
    () => Array.from(new Set((tab === 'release' ? releases : initiations).map((item) => item.status))),
    [initiations, releases, tab],
  );
  useEffect(() => { setStatusFilter(''); }, [tab]);
  if (loading) return <div className="py-16 text-center text-sm text-white/40">正在加载版本流程...</div>;

  return <div className="flex flex-col gap-5">
    <div className="flex border-b border-white/10">
      <Tab active={tab === 'release'} onClick={() => setTab('release')}>正式版本</Tab>
      <Tab active={tab === 'initiation'} onClick={() => setTab('initiation')}>内部版本</Tab>
    </div>
    {tab === 'release' ? <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RecordToolbar query={query} onQueryChange={setQuery} ownerId={releaseOwnerId} onOwnerChange={setReleaseOwnerId}
          status={statusFilter} onStatusChange={setStatusFilter} statuses={statuses}
          trackedOnly={trackedOnly} onTrackedOnlyChange={setTrackedOnly} />
        <div className="flex flex-wrap items-center gap-2">
          <Primary onClick={() => navigate(`/product-agent/p/${productId}/release/new`)} disabled={approved.length === 0}><Plus size={14} />申领正式版本号</Primary>
          <button onClick={() => navigate(`/product-agent/p/${productId}/release/new?temporary=1`)} className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">临时优化需求</button>
          <span className="group relative"><HelpCircle size={15} className="cursor-help text-white/35" />
            <span className="invisible absolute right-0 top-6 z-20 w-72 rounded-lg border border-white/10 bg-[#181a20] p-3 text-xs leading-5 text-white/65 shadow-xl group-hover:visible">
              月度常规计划外、紧急且工作量较小的优化。产品工作量原则上不超过 3 天，研发不超过 5 天；无需 T 号，按小版本自动审批。
            </span>
          </span>
        </div>
      </div>
      <ReleaseTable productId={productId} productName={productName} items={visibleReleases} requirements={requirements} members={members} onChanged={reload} readOnly={releaseOwnerId !== currentUserId} />
    </> : <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RecordToolbar query={query} onQueryChange={setQuery} scope={recordScope} onScopeChange={setRecordScope}
          status={statusFilter} onStatusChange={setStatusFilter} statuses={statuses}
          trackedOnly={trackedOnly} onTrackedOnlyChange={setTrackedOnly} />
        <div className="flex gap-2">
          <Primary onClick={() => setDialog('initiation')}><Plus size={14} />立项</Primary>
        </div>
      </div>
      <InitiationTable
        productId={productId}
        productName={productName}
        items={visibleInitiations}
        members={members}
        currentUserId={currentUserId}
        onRetryReview={setRetrySeed}
        onFillMeeting={setMeetingFillItem}
        onChanged={reload}
        readOnly={recordScope === 'all'}
      />
    </>}
    {dialog === 'initiation' && <InitiationWizard productId={productId} requirements={requirements} members={members} onClose={() => setDialog(null)} onChanged={reload} />}
    {retrySeed && (
      <InitiationWizard
        productId={productId}
        requirements={requirements}
        members={members}
        seed={retrySeed}
        onClose={() => setRetrySeed(null)}
        onChanged={async () => { setRetrySeed(null); await reload(); }}
      />
    )}
    {meetingFillItem && (
      <Modal title="会议结果" onClose={() => setMeetingFillItem(null)} width="max-w-2xl">
        <InitiationMeetingRoundsEditor
          initiation={meetingFillItem}
          editable={meetingFillItem.createdBy === currentUserId}
          onSaved={async () => {
            setMeetingFillItem(null);
            await reload();
          }}
        />
      </Modal>
    )}
  </div>;
}

export function InitiationWizard({ productId, requirements, members, onClose, onChanged, seed }: {
  productId: string;
  requirements: Requirement[];
  members: ProductMember[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  /** 评审未通过时重新发起：预填基础信息并直接进入 Agent 评审步骤 */
  seed?: ProductInitiation;
}) {
  const isRetry = Boolean(seed);
  const wizardTitle = seed?.status === 'decision_pending'
    ? '继续立项决策'
    : isRetry
      ? '重新发起立项'
      : '发起立项';
  const [step, setStep] = useState(() => {
    if (seed?.status === 'review_failed') return 2;
    if (seed?.status === 'decision_pending') return 3;
    return 1;
  });
  const [item, setItem] = useState<ProductInitiation | null>(seed ?? null);
  const [projectType, setProjectType] = useState<'standard' | 'custom'>(seed?.projectType ?? 'standard');
  const [customerSource, setCustomerSource] = useState(seed?.customerSource ?? '');
  const [linkedProductId, setLinkedProductId] = useState(seed?.linkedProductId ?? productId);
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const [planName, setPlanName] = useState(seed?.planName ?? '');
  const [planUrl, setPlanUrl] = useState(seed?.planUrl ?? '');
  const [versionType, setVersionType] = useState<'major' | 'medium' | 'minor'>(seed?.versionType ?? 'minor');
  const [requirementIds, setRequirementIds] = useState<string[]>(seed?.requirementIds ?? []);
  const [file, setFile] = useState<File | null>(null);
  const [meeting, setMeeting] = useState(false);
  const [meetingAt, setMeetingAt] = useState('');
  const [meetingDraftCount, setMeetingDraftCount] = useState(seed?.meetingDraftCount ?? 1);
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
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
    void listProducts({ pageSize: 200 }).then((res) => {
      if (res.success) setCatalogProducts(res.data.items);
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

  const productOptions = useMemo(() => toProductOptions(catalogProducts), [catalogProducts]);

  const basePayload = () => ({
    linkedProductId,
    projectType,
    customerSource: projectType === 'custom' ? customerSource : undefined,
    planName,
    planUrl: planUrl.trim() || undefined,
    versionType,
    requirementIds,
  });

  const goPrevStep = () => {
    if (step <= 1 || reviewRunning || busy) return;
    setMessage('');
    setStep((s) => s - 1);
  };

  const saveStep1 = async () => {
    if (!linkedProductId.trim()) return setMessage('请选择产品');
    if (!planName.trim()) return setMessage('请填写方案名称');
    if (projectType === 'custom' && !customerSource.trim()) return setMessage('请填写客户来源');
    setBusy(true);
    const payload = basePayload();
    const editable = item && ['draft', 'review_pending', 'review_failed', 'decision_pending'].includes(item.status);
    const res = editable && item
      ? await updateInitiation(item.id, payload)
      : await createInitiation(productId, payload);
    setBusy(false);
    if (!res.success) return setMessage(res.error?.message ?? '保存失败');
    setItem(res.data); setStep(2); setMessage('');
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
    await onChanged(); onClose();
  };

  return <Modal title={wizardTitle} onClose={onClose} width="max-w-3xl">
    <Stepper step={step} />
    {step === 1 && <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="项目类别"><Select value={projectType} onChange={(e) => setProjectType(e.target.value as typeof projectType)}><option value="standard">非定制</option><option value="custom">定制</option></Select></Field>
      {projectType === 'custom' && <Field label="客户来源 *"><Input value={customerSource} onChange={(e) => setCustomerSource(e.target.value)} /></Field>}
      <Field label="产品 *" full>
        <ItemSearchSelect
          value={linkedProductId}
          onChange={setLinkedProductId}
          options={productOptions}
          placeholder="搜索产品名称或编号"
          countUnit="个产品"
          emptyText="暂无产品"
        />
      </Field>
      <Field label="方案名称 *"><Input value={planName} onChange={(e) => setPlanName(e.target.value)} /></Field>
      <Field label="方案地址"><Input value={planUrl} onChange={(e) => setPlanUrl(e.target.value)} placeholder="https://（选填）" /></Field>
      <Field label="版本级别"><Select value={versionType} onChange={(e) => setVersionType(e.target.value as typeof versionType)}>{Object.entries(SCALE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      <Field label="关联需求" full>
        <RequirementChecks requirements={requirements} selected={requirementIds} onChange={setRequirementIds} />
      </Field>
    </div>}
    {step === 2 && <div className="space-y-4">
      {!reviewRunning && (
        <label className="flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-cyan-400/35 bg-cyan-400/5 text-center">
          <Upload className="mb-3 text-cyan-300" size={28} /><span className="text-sm text-white/75">{file ? file.name : '拖动或点击上传方案文件'}</span>
          <span className="mt-1 text-xs text-white/35">PDF、Word、Markdown、TXT、Excel、PPT</span>
          <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      )}
      {reviewRunning && file && (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/70">
          方案文件：<span className="text-white/90">{file.name}</span>
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
    {step === 3 && <div className="space-y-4">
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
    {message && <div className="mt-4 rounded-lg bg-white/5 px-3 py-2 text-xs text-white/60">{message}</div>}
    <div className="mt-6 flex items-center justify-between gap-2">
      <div>
        {step > 1 && (
          <Secondary onClick={goPrevStep} disabled={busy || reviewRunning}>上一步</Secondary>
        )}
      </div>
      <div className="flex gap-2">
        <Secondary onClick={onClose} disabled={reviewRunning}>取消</Secondary>
      {step === 1 && <Primary onClick={saveStep1} disabled={busy}>{busy ? '保存中...' : '下一步'}</Primary>}
      {step === 2 && (
        <Primary onClick={runReview} disabled={busy || !file}>
          {reviewRunning && <Loader2 size={14} className="animate-spin" />}
          {reviewRunning ? '评审进行中…' : '上传并打分'}
        </Primary>
      )}
      {step === 3 && <Primary onClick={submitDecision} disabled={busy || (meeting ? !meetingAt : !ownerId)}>提交立项</Primary>}
      </div>
    </div>
  </Modal>;
}

function InitiationTable({ productId, productName, items, members, currentUserId, onRetryReview, onFillMeeting, onChanged, readOnly }: {
  productId: string;
  productName: string;
  items: ProductInitiation[];
  members: ProductMember[];
  currentUserId?: string;
  onRetryReview: (item: ProductInitiation) => void;
  onFillMeeting: (item: ProductInitiation) => void;
  onChanged: () => Promise<void>;
  readOnly: boolean;
}) {
  const navigate = useNavigate();
  const names = useMemo(() => new Map(members.map((m) => [m.userId, m.displayName])), [members]);
  const openDetail = (id: string) => navigate(`/product-agent/p/${productId}/initiation/${id}`);
  const { selection, exportSelected, tableSelection } = useOverviewTableSelection(items, {
    filename: `initiations-${productId}.csv`,
    headers: ['立项号', '方案', '版本类别', '状态'],
    mapRow: (i) => [i.tCode ?? '', i.planName, SCALE_LABEL[i.versionType], STATUS_LABEL[i.status] ?? i.status],
  });
  return (
    <>
      <SelectionActionBar mode="export" selection={selection} onExport={exportSelected} />
      <Table headers={['产品', '项目类别', '立项号', '版本类别', '产品立项方案名称', '项目需求描述', '所属部门', '产品负责人', '第一稿\n会议时间', '第二稿\n会议时间', '第三稿\n会议时间', '立项时间\n（三稿通过）', '是否需要UI设计', '方案地址', '开发状态', '备注', 'Agent\n评审', '操作']} selection={tableSelection}>
        {items.map((item) => {
          const isOwner = !readOnly && item.createdBy === currentUserId;
          const showRetryReview = isOwner && item.status === 'review_failed';
          const showFillMeeting = isOwner && isMeetingResultPending(item);
          const reviewScoreText = formatInitiationReviewScore(item);
          return (
        <tr key={item.id} className={listSelectionRowClass('border-t border-white/5 cursor-pointer hover:bg-white/[0.03]')} onClick={() => openDetail(item.id)}>
          <ListTableSelectionCell selection={tableSelection} id={item.id} />
          <Td>{resolveVersionProductLabel(item, productName)}</Td>
      <Td>{item.projectType === 'custom' ? `定制项目${item.customerSource ? ` · ${item.customerSource}` : ''}` : '非定制项目'}</Td>
      <Td mono>{item.tCode
        ? <button type="button" onClick={(e) => { e.stopPropagation(); openDetail(item.id); }} className="text-cyan-300 hover:underline">{item.tCode}</button>
        : '-'}</Td>
      <Td>{SCALE_LABEL[item.versionType]}</Td>
      <Td><button type="button" onClick={(e) => { e.stopPropagation(); openDetail(item.id); }} className="text-left text-cyan-300 hover:underline">{item.planName}</button></Td>
      <Td>{item.requirementDescription || '-'}</Td><Td>{item.departmentName || '-'}</Td>
      <Td>
        <div>{names.get(item.primaryOwnerId ?? item.createdBy) ?? item.legacyData?.['产品负责人'] ?? item.primaryOwnerId ?? item.createdBy ?? '-'}</div>
        {!readOnly && item.status === 'owner_pending' && <button onClick={async () => { await approveInitiation(item.id); await onChanged(); }} className="mt-1 text-cyan-300">负责人同意</button>}
      </Td>
      <Td>{formatDate(item.firstDraftMeetingAt)}</Td><Td>{formatDate(item.secondDraftMeetingAt)}</Td><Td>{formatDate(item.thirdDraftMeetingAt)}</Td>
      <Td>{formatDate(item.projectAt)}</Td><Td>{formatBool(item.needUiDesign)}</Td>
      <Td>{item.planUrl ? <a href={item.planUrl} target="_blank" rel="noreferrer" className="text-cyan-300">查看方案</a> : '-'}</Td>
      <Td>{item.developmentStatus || '待开发'}</Td><Td>{item.remark || '-'}</Td>
      <Td>
        {reviewScoreText === '-' ? (
          <span className="text-white/35">-</span>
        ) : (
          <span className={
            item.reviewPassed === true ? 'text-emerald-300'
              : item.reviewPassed === false ? 'text-rose-300'
                : 'text-white/70'
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
        })}{items.length === 0 && <Empty cols={18}>暂无立项记录</Empty>}
      </Table>
    </>
  );
}

function ReleaseTable({ productId, productName, items, requirements, members, onChanged, readOnly }: {
  productId: string;
  productName: string;
  items: ProductRelease[]; requirements: Requirement[]; members: ProductMember[]; onChanged: () => Promise<void>; readOnly: boolean;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [directoryNames, setDirectoryNames] = useState<Map<string, string>>(new Map());
  const names = useMemo(() => {
    const result = new Map(directoryNames);
    members.forEach((member) => result.set(member.userId, member.displayName));
    return result;
  }, [directoryNames, members]);
  const reqNames = useMemo(() => new Map(requirements.map((r) => [r.id, r.title])), [requirements]);

  useEffect(() => {
    const ids = Array.from(new Set(items.flatMap((item) => [item.ownerId, ...item.teamMemberIds]).filter(Boolean))) as string[];
    if (ids.length === 0) return;
    let cancelled = false;
    void getUserCards(ids).then((response) => {
      if (cancelled || !response.success) return;
      setDirectoryNames(new Map(response.data.items.map((user) => [user.userId, user.displayName])));
    });
    return () => { cancelled = true; };
  }, [items]);
  const openRelease = (id: string) => navigate(`/product-agent/p/${productId}/release/${id}`);
  const openInitiation = (id: string) => navigate(`/product-agent/p/${productId}/initiation/${id}`);
  const { selection, exportSelected, tableSelection } = useOverviewTableSelection(items, {
    filename: `releases-${productId}.csv`,
    headers: ['正式版本号', '内部版本号', '方案', '状态'],
    mapRow: (i) => [i.vCode, i.tCode ?? '临时优化', i.planName, STATUS_LABEL[i.status] ?? i.status],
  });
  return <>
    <SelectionActionBar mode="export" selection={selection} onExport={exportSelected} />
    <Table headers={['产品', '正式版本号', '内部版本号', '项目类别', '版本类别', '产品立项方案名称', '所属部门', '产品负责人（申领人）', '项目组成员', '方案地址', '上线日期', '当前开放品牌', '需求来源', '上线公告地址', '状态']} selection={tableSelection}>
    {items.map((item) => <tr key={item.id} className={listSelectionRowClass('border-t border-white/5 align-top cursor-pointer hover:bg-white/[0.03]')} onClick={() => openRelease(item.id)}>
      <ListTableSelectionCell selection={tableSelection} id={item.id} />
      <Td>{resolveVersionProductLabel(item, productName)}</Td>
      <Td mono><button type="button" onClick={(e) => { e.stopPropagation(); openRelease(item.id); }} className="text-cyan-300 hover:underline">{item.vCode}</button></Td>
      <Td mono>{item.initiationId && item.tCode
        ? <button type="button" onClick={(e) => { e.stopPropagation(); openInitiation(item.initiationId!); }} className="text-cyan-300 hover:underline">{item.tCode}</button>
        : (item.tCode ?? '临时优化需求')}</Td>
      <Td>{item.projectType === 'custom' ? '定制项目' : '非定制项目'}</Td><Td>{SCALE_LABEL[item.versionType]}</Td>
      <Td><button type="button" onClick={(e) => { e.stopPropagation(); openRelease(item.id); }} className="text-left text-cyan-300 hover:underline">{item.planName}</button></Td>
      <Td>{item.departmentName || '-'}</Td><Td>{names.get(item.ownerId ?? '') ?? item.legacyData?.['产品负责人'] ?? item.ownerId ?? '-'}</Td>
      <Td>{item.teamMemberIds.map((id) => names.get(id) ?? id).join('、')}</Td>
      <Td>{item.planUrl ? <a href={item.planUrl} target="_blank" rel="noreferrer" className="text-cyan-300">查看方案</a> : '-'}</Td>
      <Td>{formatDate(item.plannedReleaseAt)}</Td>
      <Td>{item.openBrandScope || '上线全域开放'}</Td><Td>{item.requirementIds.map((id) => reqNames.get(id) ?? id).join('、') || '-'}</Td>
      <Td onClick={(e) => e.stopPropagation()}>{item.status === 'announcement_pending' ? !readOnly && editing === item.id ? <div className="flex min-w-64 gap-1"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="粘贴公告地址" /><button onClick={async () => { const r = await completeRelease(item.id, url); if (r.success) { setEditing(null); setUrl(''); await onChanged(); } }} className="rounded bg-cyan-400 px-2 text-slate-950">完成</button></div>
        : readOnly ? <span className="text-white/35">待申请人填写</span> : <div className="flex gap-2"><a href="https://sso.baklib.com/" target="_blank" rel="noreferrer" className="text-cyan-300">去发布公告</a><button onClick={() => setEditing(item.id)} className="text-white/50">填写地址</button></div>
        : item.announcementUrl ? <a className="text-cyan-300" href={item.announcementUrl} target="_blank" rel="noreferrer">查看公告</a> : '-'}</Td>
      <Td><Status value={item.status} /></Td>
    </tr>)}{items.length === 0 && <Empty cols={15}>暂无上线记录</Empty>}
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
  const filterClassName = 'h-8 rounded-lg border border-white/10 bg-[#111318] px-3 text-xs text-white/75 outline-none focus:border-cyan-400/50';
  return <div className="flex flex-wrap items-center gap-2">
    <div className={OVERVIEW_LIST_SEARCH_BOX}>
      <Search size={14} className="shrink-0 text-white/35" />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索版本号、方案名称等"
        className="min-w-0 flex-1 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/35"
      />
    </div>
    {onOwnerChange
      ? <div className="h-8 w-52">
          <UserSearchSelect value={ownerId ?? ''} onChange={onOwnerChange} placeholder="产品负责人" showAllOption={false} uiSize="sm" />
        </div>
      : <select
          aria-label="记录范围"
          value={scope}
          onChange={(event) => onScopeChange?.(event.target.value as RecordScope)}
          className={filterClassName}
        >
          <option value="mine">我的申请</option>
          <option value="all">全部成员（只读）</option>
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

function Stepper({ step }: { step: number }) { return <div className="mb-6 flex">{['基础信息', 'Agent 评审', '立项决策'].map((label, i) => <div key={label} className="flex flex-1 items-center last:flex-none"><div className={`flex items-center gap-2 text-xs ${step >= i + 1 ? 'text-cyan-300' : 'text-white/30'}`}><span className={`flex h-7 w-7 items-center justify-center rounded-full border ${step > i + 1 ? 'border-cyan-400 bg-cyan-400 text-slate-950' : step === i + 1 ? 'border-cyan-400' : 'border-white/15'}`}>{step > i + 1 ? <CheckCircle2 size={15} /> : i + 1}</span>{label}</div>{i < 2 && <div className={`mx-3 h-px flex-1 ${step > i + 1 ? 'bg-cyan-400' : 'bg-white/10'}`} />}</div>)}</div>; }
function Modal({ title, onClose, width, children }: { title: string; onClose: () => void; width: string; children: React.ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`flex w-full ${width} flex-col rounded-2xl border border-white/10 bg-[#15171c]`}
        style={{ height: 'min(90vh, 760px)', maxHeight: '90vh' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 justify-between border-b border-white/10 px-6 py-4">
          <h3 className="text-base font-semibold text-white/90">{title}</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6" style={{ minHeight: 0, overscrollBehavior: 'contain' }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) { return <label className={full ? 'md:col-span-2' : ''}><span className="mb-1.5 block text-xs text-white/50">{label}</span>{children}</label>; }
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-400/50" />; }
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className="w-full rounded-lg border border-white/10 bg-[#111318] px-3 py-2 text-sm text-white outline-none">{props.children}</select>; }
function RequirementChecks({ requirements, selected, onChange }: {
  requirements: Requirement[]; selected: string[]; onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return requirements;
    return requirements.filter((requirement) =>
      requirement.id.toLocaleLowerCase().includes(keyword)
      || requirement.requirementNo.toLocaleLowerCase().includes(keyword)
      || requirement.title.toLocaleLowerCase().includes(keyword));
  }, [query, requirements]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((selectedId) => selectedId !== id) : [...selected, id]);
  };

  return <div className="overflow-hidden rounded-lg border border-white/10 bg-black/15">
    <div className="border-b border-white/10 p-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索需求 ID 或标题"
          className="w-full rounded-md border border-white/10 bg-black/20 py-2 pl-9 pr-3 text-xs text-white outline-none placeholder:text-white/25 focus:border-cyan-400/50"
        />
      </div>
      <div className="mt-1.5 px-1 text-[11px] text-white/35">
        已选择 {selected.length} 条，共 {requirements.length} 条
      </div>
    </div>
    <div className="max-h-48 overflow-auto p-2">
      {filtered.length === 0 ? <div className="p-3 text-center text-xs text-white/30">未找到匹配的需求</div> : filtered.map((requirement) =>
        <label key={requirement.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-xs hover:bg-white/5">
          <input
            type="checkbox"
            className="mt-0.5 accent-cyan-400"
            checked={selected.includes(requirement.id)}
            onChange={() => toggle(requirement.id)}
          />
          <span className="min-w-0">
            <span className="block font-mono text-cyan-200/80">{requirement.requirementNo}</span>
            <span className="mt-0.5 block break-words text-white/70">{requirement.title}</span>
          </span>
        </label>)}
    </div>
  </div>;
}
function Primary(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-40">{props.children}</button>; }
function Secondary(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/65">{props.children}</button>; }
function Tab({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) { return <button onClick={onClick} className={`border-b-2 px-4 py-3 text-sm ${active ? 'border-cyan-400 text-cyan-200' : 'border-transparent text-white/40'}`}>{children}</button>; }
function Table({ headers, children, selection }: {
  headers: string[];
  children: ReactNode;
  selection?: TableSelectionProps;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full min-w-[900px] text-left text-xs">
        {selection ? (
          <colgroup>
            <col style={{ width: LIST_SELECTION_COL_WIDTH }} />
          </colgroup>
        ) : null}
        <thead className="bg-white/[0.035] text-white/40">
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
  return <td className={`max-w-64 px-3 py-3 text-white/65 ${mono ? 'font-mono text-cyan-200' : ''} ${className ?? ''}`} onClick={onClick}>{children}</td>;
}
function Empty({ cols, children }: { cols: number; children: React.ReactNode }) { return <tr><td colSpan={cols} className="px-3 py-12 text-center text-white/30">{children}</td></tr>; }
function Status({ value }: { value: string }) { const good = value === 'approved' || value === 'released'; return <span className={`rounded-full border px-2 py-0.5 ${good ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'}`}>{STATUS_LABEL[value] ?? value}</span>; }
function Info({ children }: { children: React.ReactNode }) { return <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-white/55">{children}</div>; }
function Score({ score, passed }: { score: number; passed: boolean }) { return <div className={`rounded-xl border p-5 text-center ${passed ? 'border-emerald-400/25 bg-emerald-400/10' : 'border-red-400/25 bg-red-400/10'}`}><div className={`text-4xl font-semibold ${passed ? 'text-emerald-300' : 'text-red-300'}`}>{score}</div><div className="mt-1 text-sm text-white/65">{passed ? '评审通过' : '评审未通过'}</div></div>; }
