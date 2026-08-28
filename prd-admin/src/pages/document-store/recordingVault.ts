/**
 * 录音数据保险箱（IndexedDB，best-effort）——录音期间每个音频分片实时落库，
 * 只有云端归档已可用才清除。页面崩溃 / 忘记关闭 / 网络断开 / 标签页被杀，
 * 已录内容都能在下次进入知识库时恢复并继续转录，不丢数据。
 *
 * 结构：
 *   meta   store：{ id, mime, startedAt }        —— 一次录音一条
 *   chunks store：{ key 自增, sessionId, blob }   —— 分片逐条追加（避免整条记录反复重写）
 *
 * 所有 API 静默容错：IndexedDB 不可用（隐私模式等）时录音功能照常，只是没有保险。
 */

const DB_NAME = 'map-recording-vault';
const DB_VERSION = 1;
const META_STORE = 'meta';
const CHUNK_STORE = 'chunks';

export type VaultSessionMeta = {
  id: string;
  mime: string;
  startedAt: number;
  /** 录音发生时所在的知识库（恢复时只在同库提示，避免笔记落错库） */
  storeId?: string;
  /** 服务端已接管完成流程；恢复时必须先查询该会话，禁止直接重传整文件。 */
  serverUploadSessionId?: string;
  /** 汇总信息（listSessions 时计算） */
  bytes: number;
  chunkCount: number;
};

type StoredVaultSessionMeta = Omit<VaultSessionMeta, 'bytes' | 'chunkCount'>;

type VaultServerStatus =
  | { success: true; data: { status: 'uploading' | 'completing' | 'completed' | 'cancelled' } }
  | { success: false; error: { code: string } }
  | null;

type VaultServerCompletion =
  | {
      success: true;
      data?: {
        archivePending?: boolean;
        deferredTranscriptionRunId?: string | null;
      };
    }
  | { success: false; error: { code: string } }
  | null;

export type VaultServerRecoveryDecision = 'completed' | 'keep-protected' | 'recover-local';

/**
 * 已进入服务端完成流程的会话需要重放幂等完成请求。completed 用于取回已落库条目，
 * uploading 覆盖“绑定已持久化、首个完成请求尚未认领”的崩溃窗口，completing
 * 用于在旧完成租约失效后重新领取，completed 用于取回已落库条目。
 */
export function shouldRetryVaultServerCompletion(status: VaultServerStatus): boolean {
  return status?.success === true
    && (status.data.status === 'uploading'
      || status.data.status === 'completing'
      || status.data.status === 'completed');
}

/**
 * 服务端接管后的恢复决策 SSOT。只有服务端明确未持有可恢复结果时才允许整文件重传；
 * 网络未知与瞬时服务错误始终保留本地保险文件和服务端会话绑定。
 */
export function decideVaultServerRecovery(
  status: VaultServerStatus,
  completion: VaultServerCompletion = null,
): VaultServerRecoveryDecision {
  if (!status) return 'keep-protected';
  if (!status.success) {
    return ['NOT_FOUND', 'SESSION_NOT_FOUND', 'SESSION_EXPIRED'].includes(status.error.code)
      ? 'recover-local'
      : 'keep-protected';
  }
  // 完成请求是幂等的：即使调用前读取到的是 completing，成功响应也必须优先收敛终态。
  if (completion?.success && shouldRetryVaultServerCompletion(status)) return 'completed';
  if (status.data.status === 'cancelled') return 'recover-local';
  if (completion?.success === false && [
    'NOT_FOUND',
    'SESSION_NOT_FOUND',
    'SESSION_EXPIRED',
  ].includes(completion.error.code)) {
    return 'recover-local';
  }
  // completed 且条目已被明确删除时，后端以 INVALID_FORMAT 表示该终态不可复用。
  // uploading / completing 的同码可能只是另一完成请求刚刚抢到租约，必须继续保护。
  if (status.data.status === 'completed'
      && completion?.success === false
      && completion.error.code === 'INVALID_FORMAT') {
    return 'recover-local';
  }
  return 'keep-protected';
}

/** 服务端恢复成功后，归档中的延迟转写仍需接回页面现有后台观察器。 */
export function deferredRunIdForRecoveredVaultCompletion(
  completion: VaultServerCompletion,
): string | null {
  if (!completion?.success) return null;
  return completion.data?.deferredTranscriptionRunId?.trim() || null;
}

export type UploadedRecordingFollowUp =
  | { kind: 'watch-deferred-run'; runId: string }
  | { kind: 'wait-for-archive' }
  | { kind: 'open-transcription' };

/**
 * 录音完成响应的后续动作 SSOT。服务端返回固定延迟任务时，该任务已经拥有完整音频
 * 转写责任，不论对象归档是否仍 pending，前端都只能观察它，不能再创建第二个任务。
 */
export function decideUploadedRecordingFollowUp(
  archivePending: boolean,
  _liveTranscriptReady: boolean,
  deferredTranscriptionRunId?: string | null,
): UploadedRecordingFollowUp {
  const runId = deferredTranscriptionRunId?.trim();
  if (runId) return { kind: 'watch-deferred-run', runId };
  // 待归档音频还没有可播放的云端地址。即使实时原文已就绪，也应停留在同一
  // 音频结果页等待归档，不能重新打开上传/转录流程制造第二次处理的错觉。
  if (archivePending) return { kind: 'wait-for-archive' };
  return { kind: 'open-transcription' };
}

/** 多段保险箱录音可能同时恢复；观察队列必须保留全部任务并对重入去重。 */
export function enqueueBackgroundTranscriptionRun(
  current: string[],
  runId: string,
): string[] {
  const normalized = runId.trim();
  if (!normalized || current.includes(normalized)) return current;
  return [...current, normalized];
}

export interface BackgroundTranscriptionSource {
  entryId: string;
  vaultSessionId?: string;
}

/**
 * 将抽屉异步返回的 runId 与条目绑定。entry 和 runId 无论谁先返回，调用方都可在
 * 第二个值到达时补齐映射，后台看护因而始终能够按 entry 查询服务端最新任务。
 */
export function bindBackgroundTranscriptionSource(
  sources: Map<string, BackgroundTranscriptionSource>,
  runId: string | null | undefined,
  source: BackgroundTranscriptionSource | null | undefined,
): boolean {
  const normalizedRunId = runId?.trim();
  const normalizedEntryId = source?.entryId.trim();
  if (!normalizedRunId || !source || !normalizedEntryId) return false;
  sources.set(normalizedRunId, { ...source, entryId: normalizedEntryId });
  return true;
}

/**
 * 刷新或重新进入录音结果页时，根据服务端最近一次 run 恢复后台看护。
 * 只接管真正处于在途状态的任务，终态 run 不应让页面永久显示“处理中”。
 */
export function recoverableBackgroundTranscriptionRunId(
  run: {
    id?: string | null;
    status?: string | null;
    heartbeatAt?: string | null;
    startedAt?: string | null;
    createdAt?: string | null;
    automaticRetryNextAt?: string | null;
  } | null | undefined,
  nowMs = Date.now(),
): string | null {
  const runId = run?.id?.trim();
  if (!runId || !isTranscriptionInflight(run?.status)) return null;
  if (isStalledBackgroundTranscriptionRun(run, nowMs)) return null;
  return runId;
}

/**
 * 这条 run 还在跑吗。
 *
 * 后端的枚举是 publishing / queued / running / done / failed / cancelled，
 * 「跑完了」有三种写法，判据只认「还在跑」那三种——反过来枚举终态，
 * 一旦后端加一个新的终态名，轮询就会永远停不下来（形状 1：判据比它该管的范围窄）。
 * 三处轮询共用这一个判定：抄第二份就会各自漂移（形状 3）。
 */
export function isTranscriptionInflight(status: string | null | undefined): boolean {
  const s = status?.trim().toLowerCase();
  return s === 'publishing' || s === 'queued' || s === 'running';
}

export const BACKGROUND_TRANSCRIPTION_STALLED_MS = 60 * 60 * 1000;

/** Worker 超过一小时没有心跳，不能继续向用户保证它仍会自行完成。 */
export function isStalledBackgroundTranscriptionRun(
  run: {
    status?: string | null;
    heartbeatAt?: string | null;
    startedAt?: string | null;
    createdAt?: string | null;
    automaticRetryNextAt?: string | null;
  } | null | undefined,
  nowMs = Date.now(),
): boolean {
  const status = run?.status?.trim().toLowerCase();
  if (status !== 'publishing' && status !== 'queued' && status !== 'running') return false;
  // 定时自动重试的 queued run 以实际计划时间为基准。CreatedAt 可能是数小时前，
  // 不能在退避窗口尚未到达时把一条合法任务误判成失联。
  const timestamp = Date.parse(
    status === 'queued' && run?.automaticRetryNextAt
      ? run.automaticRetryNextAt
      : run?.heartbeatAt ?? run?.startedAt ?? run?.createdAt ?? '',
  );
  return Number.isFinite(timestamp) && nowMs - timestamp > BACKGROUND_TRANSCRIPTION_STALLED_MS;
}

/** 直查失败时只接受同一 runId 的条目最新任务，避免永久等待或串到后来新建的任务。 */
export function selectObservedBackgroundTranscriptionRun<T extends {
  id?: string | null;
  status?: string | null;
}>(
  runId: string,
  directRun: T | null | undefined,
  latestEntryRun: T | null | undefined,
): T | null {
  const latestStatus = latestEntryRun?.status?.trim().toLowerCase();
  if (latestEntryRun?.id === runId
      && (latestStatus === 'done' || latestStatus === 'failed' || latestStatus === 'cancelled')) {
    return latestEntryRun;
  }
  if (directRun) return directRun;
  return latestEntryRun?.id === runId ? latestEntryRun : null;
}

export type BackgroundRunLookupDecision<T> =
  | { kind: 'observe'; run: T }
  | { kind: 'keep-watching' }
  | {
      kind: 'retire-watcher';
      reason: 'access-lost' | 'run-missing' | 'superseded' | 'lookup-unavailable' | 'stalled-run';
      replacementRun: T | null;
    };

const PERMANENT_RUN_LOOKUP_ERRORS = new Set([
  'UNAUTHORIZED',
  'PERMISSION_DENIED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RUN_NOT_FOUND',
  'AGENT_RUN_NOT_FOUND',
]);

/**
 * 后台任务看护的收敛决策。旧 run 已删除、权限已变化或已被同条目的新 run 取代时，
 * 必须撤销旧 watcher；临时网络错误最多保留有限轮次，避免“后台处理中”永久挂住。
 */
export function decideBackgroundRunLookup<T extends {
  id?: string | null;
  status?: string | null;
  heartbeatAt?: string | null;
  startedAt?: string | null;
  createdAt?: string | null;
  automaticRetryNextAt?: string | null;
}>(args: {
  runId: string;
  directRun: T | null | undefined;
  directErrorCode?: string | null;
  latestEntryRun: T | null | undefined;
  latestLookupSucceeded: boolean;
  consecutiveFailures: number;
  maxTransientFailures?: number;
  nowMs?: number;
}): BackgroundRunLookupDecision<T> {
  const latestId = args.latestEntryRun?.id?.trim();
  // 同一条目已经有更新的任务时，即使旧 run 仍能直查到 running，也必须撤销旧看护。
  if (args.latestLookupSucceeded && latestId && latestId !== args.runId) {
    const replacementRun = args.latestEntryRun ?? null;
    if (isStalledBackgroundTranscriptionRun(replacementRun, args.nowMs)) {
      return { kind: 'retire-watcher', reason: 'stalled-run', replacementRun };
    }
    return { kind: 'retire-watcher', reason: 'superseded', replacementRun };
  }
  const observed = selectObservedBackgroundTranscriptionRun(
    args.runId,
    args.directRun,
    args.latestEntryRun,
  );
  if (observed) {
    if (isStalledBackgroundTranscriptionRun(observed, args.nowMs)) {
      return { kind: 'retire-watcher', reason: 'stalled-run', replacementRun: null };
    }
    return { kind: 'observe', run: observed };
  }

  const code = args.directErrorCode?.trim().toUpperCase() ?? '';
  if (code === 'UNAUTHORIZED' || code === 'PERMISSION_DENIED' || code === 'FORBIDDEN') {
    return { kind: 'retire-watcher', reason: 'access-lost', replacementRun: null };
  }
  if (PERMANENT_RUN_LOOKUP_ERRORS.has(code)) {
    return { kind: 'retire-watcher', reason: 'run-missing', replacementRun: null };
  }

  const maxFailures = Math.max(1, args.maxTransientFailures ?? 12);
  if (args.consecutiveFailures >= maxFailures) {
    return { kind: 'retire-watcher', reason: 'lookup-unavailable', replacementRun: null };
  }
  return { kind: 'keep-watching' };
}

export type BackgroundTranscriptionBannerCopy = { title: string; detail: string };

/** 当前失败条目与其他在途录音分开表述，禁止同屏看起来既失败又处理中。 */
export function describeBackgroundTranscriptionBanner(args: {
  selectedEntryId?: string | null;
  selectedHasFailure: boolean;
  runs: Array<{ entryId?: string | null; title?: string | null }>;
  /**
   * 当前这条录音的进度是否已经由正文里的三阶段卡在讲。
   * 是的话横幅就不该再说一遍——同屏两处讲同一件事，还各讲一半
   * （横幅只有一句话、卡里有阶段和百分比），用户不知道该信哪个。
   * 此时横幅只负责「**其它**录音也在跑」，一条都没有就整个消失。
   */
  currentRunHasInlineCard?: boolean;
}): BackgroundTranscriptionBannerCopy | null {
  if (args.runs.length === 0) return null;
  const selectedId = args.selectedEntryId?.trim();
  if (args.currentRunHasInlineCard && selectedId) {
    const others = args.runs.filter((run) => run.entryId !== selectedId);
    if (others.length === 0) return null;
    return describeBackgroundTranscriptionBanner({
      selectedEntryId: args.selectedEntryId,
      selectedHasFailure: args.selectedHasFailure,
      runs: others,
    });
  }
  const currentIsRunning = !args.selectedHasFailure
    && Boolean(selectedId)
    && args.runs.some((run) => run.entryId === selectedId);
  const titles = args.runs
    .map((run) => run.title?.trim())
    .filter((title): title is string => Boolean(title));
  const uniqueTitles = [...new Set(titles)];
  const titleList = uniqueTitles.slice(0, 2).map((title) => `“${title}”`).join('、');
  const overflow = uniqueTitles.length > 2 ? `等 ${args.runs.length} 条录音` : '';

  if (args.selectedHasFailure) {
    return {
      title: `其他录音正在后台处理${args.runs.length > 1 ? `（${args.runs.length} 条）` : ''}`,
      detail: titleList
        ? `${titleList}${overflow}仍在继续；当前录音已经失败，可单独点击重试。`
        : `知识库中另有 ${args.runs.length} 条录音仍在继续；当前录音已经失败，可单独点击重试。`,
    };
  }
  if (currentIsRunning) {
    return {
      title: args.runs.length > 1 ? `当前录音和另外 ${args.runs.length - 1} 条正在后台处理` : '当前录音正在后台处理',
      detail: '已恢复进度看护，完成后本页会自动更新；可以继续查看其他内容。',
    };
  }
  return {
    title: `其他录音正在后台处理${args.runs.length > 1 ? `（${args.runs.length} 条）` : ''}`,
    detail: titleList
      ? `${titleList}${overflow}仍在继续，完成后本页会自动更新。`
      : `知识库中另有 ${args.runs.length} 条录音仍在继续，完成后本页会自动更新。`,
  };
}

/** 串行轮询器：只有上一轮 Promise 完成后才安排下一轮，慢请求不会叠出并发风暴。 */
export function startSerialBackgroundPoller(
  poll: () => Promise<void>,
  delayMs: number,
): () => void {
  let stopped = false;
  let timer: number | null = null;
  const tick = async () => {
    try {
      await poll();
    } finally {
      if (!stopped) timer = globalThis.setTimeout(() => { void tick(); }, delayMs) as unknown as number;
    }
  };
  timer = globalThis.setTimeout(() => { void tick(); }, delayMs) as unknown as number;
  return () => {
    stopped = true;
    if (timer !== null) globalThis.clearTimeout(timer);
  };
}

/**
 * 最近一次转录如果是失败告终，页面必须留下痕迹。
 *
 * 在途 run 由上面那条恢复看护接管，成功 run 会长出笔记；只有失败 run 两头不沾——
 * 关掉抽屉或刷新之后，整屏又退回「把录音转成文字」，用户根本看不出刚才跑过、更看不出为什么没成。
 * 「我不清楚是好了还是坏了」就是从这个缝里漏出来的。
 *
 * 只认失败态；诊断块（后端追加的 [diagnostic] JSON）给的是排障细节，不是给用户看的，截掉。
 */
/**
 * 失败说明的四个字段，对齐设计稿 S5/S6 的硬约束「失败对象必须含
 * code / 时间 / 仍可用能力 / 重试方式，UI 逐条渲染」。
 *
 * 「仍可用能力」不进这个结构：它是**恒真**的一句（音频已经安全落库，播放和下载
 * 从来不受转录失败影响），由 UI 直接写死更诚实——放进判据会让人以为它有条件。
 * 这里只给机器判定得出来的三项，外加自动重试的结构化事实。
 */
export type FailedTranscriptionNotice = {
  reason: string;
  at: string | null;
  /** 机器可判定的失败类别（如 ERR_CODEC）；上游没给就为 null，UI 此时不编一个出来 */
  code: string | null;
  /** 已自动重试次数；后端没下发按 0 计 */
  automaticRetryCount: number;
  /** 下一次自动重试的时刻；为 null 表示自动重试已耗尽，轮到用户手动重试 */
  automaticRetryNextAt: string | null;
  /**
   * 已经生成出来的那几句原文。
   *
   * 稿面 cap-S10 对「排队超过一小时」这一档的核心承诺是「原文完成的部分现在就能读」——
   * 那是把「等太久」从焦虑变成「我还能干点什么」的唯一落点。此前这条说明只带
   * 原因/时间/次数三样，正文里那半篇原文明明在 run 上，却在这里被丢掉了，
   * 于是界面只能说「播放、下载音频」，那句承诺没有兑现处。
   */
  partialTranscript: string[];
  /**
   * 挂掉的是哪一样。空表示整条转录失败；给了名字（「词云」「会议纪要」）表示
   * 只有这一样衍生产物失败——那一档原文与播放都还在，界面不该讲成全盘失败
   * （稿面 v2-S6 / cap-S7 / cap-S8 画的都是这一种）。
   */
  target?: string | null;
};

/** 后台失联（心跳停了）不是上游报的失败，是我们自己判出来的一类；
 *  它同样要凑齐四个字段，否则这条路径上的界面又退回「只有一句话」。
 *  code 用我们自己的分类 RUN_STALLED —— 这是判据算出来的，不是替上游编的。 */
export function stalledTranscriptionNotice(
  at: string | null,
  partialTranscript: string[] = [],
): FailedTranscriptionNotice {
  return {
    // 措辞是安抚不是报错：这一档多半是排队久了，不是坏了。旧文案「不能确认仍会
    // 自行完成。请点击重试」把等待叙述成故障，判分与产品方都点了这一处。
    reason: '后台转录已经排队超过一小时还没轮到。录音与音频都在，等不及可以点重试重新排队。',
    at,
    code: 'RUN_STALLED',
    automaticRetryCount: 0,
    automaticRetryNextAt: null,
    partialTranscript,
  };
}

export function describeFailedTranscription(
  run: {
    status?: string | null;
    errorMessage?: string | null;
    failureCode?: string | null;
    endedAt?: string | null;
    updatedAt?: string | null;
    createdAt?: string | null;
    automaticRetryCount?: number | null;
    automaticRetryNextAt?: string | null;
    transcriptText?: string | null;
  } | null | undefined,
): FailedTranscriptionNotice | null {
  if (run?.status?.trim().toLowerCase() !== 'failed') return null;
  const raw = (run.errorMessage ?? '').split('[diagnostic]')[0].trim();
  const code = run.failureCode?.trim();
  return {
    reason: raw || '转录失败，原因未知',
    at: (run.endedAt ?? run.updatedAt ?? run.createdAt ?? null),
    code: code ? code : null,
    automaticRetryCount: Math.max(0, run.automaticRetryCount ?? 0),
    automaticRetryNextAt: run.automaticRetryNextAt?.trim() || null,
    partialTranscript: splitPartialTranscript(run.transcriptText),
  };
}

/** run 上的原文是一整块文本；界面只摆前几句，多了会把失败说明淹掉。 */
export function splitPartialTranscript(text: string | null | undefined, max = 3): string[] {
  return (text ?? '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, max);
}

/**
 * 整篇原文有多少句。切句口径与 splitPartialTranscript 同源，只是不截断——
 * 界面上那句「原文 N 句」数的是整篇，拿预览数组的长度去数会永远停在 2、3 句。
 */
export function countTranscriptSentences(text: string | null | undefined): number {
  return splitPartialTranscript(text, Number.MAX_SAFE_INTEGER).length;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const chunks = db.createObjectStore(CHUNK_STORE, { autoIncrement: true });
          chunks.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function txDone(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** 开始一次录音会话：登记 meta。返回是否成功（失败也不影响录音本身）。 */
export async function vaultStartSession(id: string, mime: string, storeId?: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ id, mime, startedAt: Date.now(), storeId });
    const ok = await txDone(tx);
    db.close();
    return ok;
  } catch {
    db.close();
    return false;
  }
}

/** 录音中切换目标知识库时同步更新保险箱归属，崩溃恢复不会回到旧库。 */
export async function vaultUpdateSessionStore(id: string, storeId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const current = await new Promise<StoredVaultSessionMeta | null>((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (current) store.put({ ...current, storeId });
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}

/**
 * 记录服务端已经接管完成流程。该标记让页面恢复时先查询同一个幂等会话，
 * 避免弱网下把本地保险文件再次上传成第二条录音。
 */
export async function vaultMarkServerCompletion(id: string, serverUploadSessionId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const current = await new Promise<StoredVaultSessionMeta | null>((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (current) store.put({ ...current, serverUploadSessionId });
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}

/** 服务端明确未接管时解除保护，之后才允许走本地整文件恢复。 */
export async function vaultClearServerCompletion(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const current = await new Promise<StoredVaultSessionMeta | null>((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (current) {
      const next = { ...current };
      delete next.serverUploadSessionId;
      store.put(next);
    }
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}

/** 追加一个音频分片（逐条插入，不重写既有数据） */
/**
 * 追加一片到本机保险箱。**返回它到底写没写进去**。
 *
 * 仍然是 best-effort（永不抛，录音不能因为落盘失败而中断），但「失败」这件事必须
 * 说出来：调用方要靠它决定界面还能不能挂「已保护 · 无丢失」。此前它返回 void 并把
 * 异常全吞掉，于是调用方接的 `.catch` 根本不会触发——凭据照样是绿的，而分片
 * 只在内存里（Codex 连续两轮指到这里：先是吞异常，再是「你那个 catch 接不到」）。
 */
export async function vaultAppendChunk(sessionId: string, blob: Blob): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    tx.objectStore(CHUNK_STORE).add({ sessionId, blob });
    const ok = await txDone(tx);
    return ok;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** 列出所有滞留的录音会话（按开始时间倒序） */
export async function vaultListSessions(): Promise<VaultSessionMeta[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction([META_STORE, CHUNK_STORE], 'readonly');
    const metas: StoredVaultSessionMeta[] = await new Promise((resolve) => {
      const req = tx.objectStore(META_STORE).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    });
    const result: VaultSessionMeta[] = [];
    for (const m of metas) {
      const chunks: { blob: Blob }[] = await new Promise((resolve) => {
        const req = tx.objectStore(CHUNK_STORE).index('sessionId').getAll(m.id);
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = () => resolve([]);
      });
      result.push({
        ...m,
        bytes: chunks.reduce((acc, c) => acc + (c.blob?.size ?? 0), 0),
        chunkCount: chunks.length,
      });
    }
    db.close();
    return result.filter(s => s.chunkCount > 0).sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    db.close();
    return [];
  }
}

/** 把某个会话的分片拼回音频 File（供恢复后直接进转录链路） */
export async function vaultLoadSessionFile(id: string): Promise<File | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction([META_STORE, CHUNK_STORE], 'readonly');
    const meta: { id: string; mime: string; startedAt: number } | undefined = await new Promise((resolve) => {
      const req = tx.objectStore(META_STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
    // IDB 自增 key 保证 getAll 按插入序返回，分片顺序即录制顺序
    const chunks: { blob: Blob }[] = await new Promise((resolve) => {
      const req = tx.objectStore(CHUNK_STORE).index('sessionId').getAll(id);
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    });
    db.close();
    if (!meta || chunks.length === 0) return null;
    const mime = (meta.mime || 'audio/webm').split(';')[0];
    const ext = mime.includes('mp4') ? '.m4a' : mime.includes('ogg') ? '.ogg' : '.webm';
    const d = new Date(meta.startedAt);
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `录音 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}${ext}`;
    return new File([new Blob(chunks.map(c => c.blob), { type: mime })], name, { type: mime });
  } catch {
    db.close();
    return null;
  }
}

/** 删除会话（上传成功后 / 用户放弃恢复时调用） */
export async function vaultDeleteSession(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    const idx = tx.objectStore(CHUNK_STORE).index('sessionId');
    const keysReq = idx.getAllKeys(id);
    keysReq.onsuccess = () => {
      for (const key of keysReq.result ?? []) tx.objectStore(CHUNK_STORE).delete(key);
    };
    await txDone(tx);
  } catch { /* best-effort */ }
  db.close();
}

/**
 * 失败卡该说什么 —— 按失败类别分档。
 *
 * 为什么要分档：同一张「上次转文字没成功」把三种完全不同的处境说成了一句话。
 *   - 后台失联一小时：任务多半还在排队，用户需要的是「可以走开」，
 *     而旧文案说「不能确认仍会自行完成」，读起来像坏了（稿面 cap-S10）。
 *   - 整段没有人声：重试同一段音频不会有别的结果，用户需要的是先播一遍确认，
 *     而旧文案让他「点重试」（稿面 v2-S4）。
 *   - 编码不支持等真失败：旧文案本来就对（稿面 v2-S5）。
 *
 * 抽成纯函数而不是写在卡里：这三档的差别是**判据**，判据要能被单测钉住；
 * 写在 JSX 里只能靠肉眼看截图，而截图看不出「换一个 failureCode 会不会走错档」。
 *
 * 产品方 2026-08-26 裁定：一小时那一档**保留重试按钮**（它是用户唯一的恢复出口），
 * 只改文案与陪伴，不动「超时判失败」的判定逻辑，也不新增完成通知订阅。
 */
export type FailurePresentation = {
  title: string;
  /** 抬头第二行：一句话说清什么没丢 */
  subtitle: string;
  /** 「下一步」那一行 */
  nextStep: string;
  /**
   * 卡面的语义色调。稿面给四种处境各画了一种面孔：真失败是红/粉错误面、
   * 自动重试与排队是暖琥珀的「在动，别急」、没听到人声是克制的中性白。
   * 此前四张卡共用同一套中性壳 + 同一枚警告三角，用户**看不出这是哪一种**——
   * 四份独立判分都各自指到了这同一处根因。
   */
  tone: 'danger' | 'retrying' | 'queued' | 'neutral';
  /** 图标语义：转圈箭头代表「后台在动」，闹钟代表「在排队」，划掉的麦克风代表「没听到人声」 */
  icon: 'alert' | 'retry' | 'clock' | 'mic-off';
  /**
   * 「仍可用」那一行的枚举。
   *
   * 它此前是卡里写死的一句「播放、下载音频」——于是**衍生产物**失败（词云/纪要挂了、
   * 原文好好的）时，界面把「局部失败」讲成了「全盘失败」：用户读不到原文、编辑、搜索
   * 其实一样能用（稿面 v2-S6 / cap-S7 / cap-S8 都把这几项点了名）。
   * 现在按真实可用性算：有没有原文、有没有纪要，决定这一行列几项。
   */
  stillWorks: string;
  /**
   * 这一档该给哪些出口，**第一项是主操作**。
   * 稿面把主操作画在底部按钮组的首位；此前实现把「重试」固定钉在卡头右上，
   * 于是「没人声」那一档的主操作成了一个自己文案都说没用的重试
   * （v2-S4 / v2-S5 / cap-S10 三份判分各自指到这处）。
   */
  actions: FailureAction[];
};

/**
 * 失败卡的出口种类。
 * `notify` / `support` 是稿面 cap-S10「排队超一小时」那一档的两颗；
 * `copyTranscript` 是 cap-S8 的兜底自救（纪要没生成出来，先把原文拿走自己整理）。
 */
export type FailureAction =
  | 'retry' | 'download' | 'play' | 'rerecord' | 'copyTranscript' | 'notify' | 'support';

/** 后端把「整段没有有效语音」分成两个 code，UI 该给同一档 */
const NO_SPEECH_CODES = new Set(['ASR_NO_SPEECH', 'ASR_ALL_CANDIDATES_NO_SPEECH']);

/**
 * 后端每条 run 的自动重试预算。
 *
 * 它在后端是 `DocumentRecordingArchiveWorker.MaxDeferredTranscriptionAutomaticRetries`，
 * 接口里没有下发，所以这里只能存一份副本——**同一个判断存两份就会漂**
 * （predicate-and-wiring-discipline 形状 3）。守卫在
 * `__tests__/automaticRetryLimit.test.ts`：它直接读那个 .cs 文件，两边对不上就红。
 */
export const AUTOMATIC_RETRY_LIMIT = 3;

/**
 * 「仍可用」那一行：按**这一刻真实存在的东西**算，不照抄稿面的枚举。
 * 没有原文时说「原文不受影响」是一句假话——那正是把用户骗一次的成本最高的地方。
 */
function describeStillWorks(opts: {
  hasTranscript?: boolean;
  hasSummary?: boolean;
  /** 这一刻挂掉的那一样。它**必须**从可用清单里剔掉，否则就是自己打自己的脸 */
  target?: string;
}): string {
  if (!opts.hasTranscript) return '播放、下载音频（音频不受转录失败影响）';
  const abilities = ['播放', '原文', '编辑', '搜索', '跳播', '词云', '问答'];
  if (opts.hasSummary) abilities.push('纪要');
  /*
    挂掉的那一样不能出现在「仍可用」里。
    上一版把「纪要」写死进清单，于是「会议纪要生成失败」的卡上紧跟着一句
    「纪要都不受影响」——三份判分各记了一次「状态表达自相矛盾」。
    整理与纪要是同一件事的两个说法，所以两个词都要过滤。
  */
  const failed = (opts.target ?? '').trim();
  const aliases = failed
    ? [failed, ...(/纪要|整理|摘要/.test(failed) ? ['纪要'] : []), ...(/词云/.test(failed) ? ['词云'] : [])]
    : [];
  const usable = abilities.filter(item => !aliases.some(alias => alias.includes(item) || item.includes(alias)));
  return `${usable.join('、')}都不受影响`;
}

export function describeFailurePresentation(
  notice: FailedTranscriptionNotice,
  opts: {
    waitingAutoRetry: boolean;
    retryLabel?: string;
    hasPartialTranscript?: boolean;
    /**
     * 挂掉的是哪一样。为空表示整条转录失败；给了名字（如「词云」「会议纪要」）表示
     * 只有这一样衍生产物失败，原文与播放都还在——稿面 v2-S6 / cap-S7 / cap-S8
     * 画的都是这一种，而不是整段转录失败。
     */
    target?: string | null;
    /** 这一刻原文在不在（决定「仍可用」怎么写，也决定给不给「复制原文」这个出口） */
    hasTranscript?: boolean;
    /** 纪要在不在 */
    hasSummary?: boolean;
    /** 这段录音有多长（稿面 v2-S4 / cap-S10 都把它编进正文，让用户判断值不值得等） */
    durationLabel?: string | null;
  } = { waitingAutoRetry: false },
): FailurePresentation {
  const target = opts.target?.trim() || '';
  const stillWorks = describeStillWorks({ ...opts, target });
  // 自动重试还没耗尽：这一档压过所有类别——正在自愈的时候不该让用户做任何事
  if (opts.waitingAutoRetry) {
    return {
      title: target ? `${target}生成失败，正在自动重试` : '转录失败，正在自动重试',
      subtitle: '录音还在，没有丢',
      stillWorks,
      actions: [],
      // 分母是后端那条自动重试预算：没有它，用户读不出「还剩几次机会」
      // （稿面 v2-S6 / cap-S7 写的是「第 2 / 3 次」）。
      nextStep: `第 ${notice.automaticRetryCount + 1} / ${AUTOMATIC_RETRY_LIMIT} 次自动重试将在 ${opts.retryLabel ?? '稍后'}开始，无需操作`,
      tone: 'retrying',
      icon: 'retry',
    };
  }
  const code = (notice.code ?? '').trim().toUpperCase();
  if (code === 'RUN_STALLED') {
    return {
      title: '处理已超过一小时',
      subtitle: '录音已经安全保存，任务还在排队',
      /*
        稿面 cap-S10 这一档的主张是「你可以走开，好了会叫你」，而且必须有一颗真的按钮
        兜着（见 actions 里的 notify）。但兜得住的只有「这一页开着」这一档——通知是这一屏
        观察到 run 转终态时用浏览器通知发的，没有 service worker、也没有服务端订阅，
        页面一关就没人再看着了。所以这句话只能承诺到这里：**可以走开，但别关这一页**。
        此前它写的是「就可以关掉这一页」，那是一句兑现不了的承诺（Codex 第十三轮 P1）。
        录音时长也编进来：等三个小时和等三分钟，用户的决定完全不同。
      */
      nextStep: `${opts.durationLabel ? `这段 ${opts.durationLabel} 的录音仍在排队。` : ''}${
        opts.hasPartialTranscript ? '已经生成的部分原文可以先读；' : ''
      }点「完成后通知我」就可以走开，完成时会弹一条系统通知（这一页先别关）；等不及就点「重试」重新排队`,
      tone: 'queued',
      icon: 'clock',
      stillWorks,
      // 稿面 cap-S10 的主操作是「完成后通知我」——这一档用户要的不是再排一次队，
      // 是「我可以走开，好了叫我」。重试降为第三顺位。
      actions: ['notify', 'support', 'retry'],
    };
  }
  if (NO_SPEECH_CODES.has(code)) {
    return {
      title: '没有检测到有效语音',
      /*
        稿面 v2-S4 在这里给了两样：**这段录音有多长**、以及**里面到底是什么**。
        前者让用户判断值不值得重录，后者让「为什么判成没有语音」落地。
        措辞写成「常见于」而不是断言环境噪声——上游只告诉我们「没识别到人声」，
        没告诉我们那段声音是什么，照抄稿面那句断言就是编一个我们不知道的事实。
      */
      subtitle: `${opts.durationLabel ? `这段 ${opts.durationLabel} 的录音` : '这段录音'}里几乎没有可识别的人声（常见于环境噪声或音量过低）。音频已保留，可以直接播放确认`,
      nextStep: '先播一遍确认这段录音里有没有人声。确实没有就重新录一次——同一段音频重试不会有别的结果',
      tone: 'neutral',
      icon: 'mic-off',
      stillWorks,
      // 这一档**不给重试**：同一段音频重试不会有别的结果，摆一颗重试就是自相矛盾
      actions: ['play', 'rerecord'],
    };
  }
  return {
    title: target ? `${target}生成失败` : '转录失败',
    subtitle: '录音还在，没有丢',
    nextStep: opts.hasTranscript
      ? '点「重试」；若反复失败，可转码后重新上传，或先复制原文自行整理'
      : '点「重试」；若反复失败，可转码后重新上传',
    tone: 'danger',
    icon: 'alert',
    stillWorks,
    // 有原文时兜底出口是「复制原文」（自己整理去），没有原文才退回「下载音频」
    actions: opts.hasTranscript ? ['retry', 'copyTranscript'] : ['retry', 'download'],
  };
}
