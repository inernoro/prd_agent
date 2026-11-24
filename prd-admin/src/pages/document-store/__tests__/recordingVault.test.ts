import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  decideUploadedRecordingFollowUp,
  decideBackgroundRunLookup,
  bindBackgroundTranscriptionSource,
  describeBackgroundTranscriptionBanner,
  decideVaultServerRecovery,
  deferredRunIdForRecoveredVaultCompletion,
  enqueueBackgroundTranscriptionRun,
  recoverableBackgroundTranscriptionRunId,
  isStalledBackgroundTranscriptionRun,
  isTranscriptionInflight,
  vaultAppendChunk,
  vaultStartSession,
  selectObservedBackgroundTranscriptionRun,
  shouldRetryVaultServerCompletion,
  startSerialBackgroundPoller,
} from '../recordingVault';

afterEach(() => {
  vi.useRealTimers();
});

describe('recording vault completion retry gate', () => {
  it('retries every non-terminal bound session, including pre-claim uploading', () => {
    expect(shouldRetryVaultServerCompletion({
      success: true,
      data: { status: 'completing' },
    })).toBe(true);
    expect(shouldRetryVaultServerCompletion({
      success: true,
      data: { status: 'completed' },
    })).toBe(true);
    expect(shouldRetryVaultServerCompletion({
      success: true,
      data: { status: 'uploading' },
    })).toBe(true);
    expect(shouldRetryVaultServerCompletion({
      success: true,
      data: { status: 'cancelled' },
    })).toBe(false);
    expect(shouldRetryVaultServerCompletion({
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe(false);
    expect(shouldRetryVaultServerCompletion(null)).toBe(false);
  });
});

describe('recording vault deferred transcription recovery', () => {
  it('watches a non-empty server-owned run regardless of archive state', () => {
    expect(deferredRunIdForRecoveredVaultCompletion({
      success: true,
      data: { archivePending: true, deferredTranscriptionRunId: ' run-1 ' },
    })).toBe('run-1');
    expect(deferredRunIdForRecoveredVaultCompletion({
      success: true,
      data: { archivePending: false, deferredTranscriptionRunId: 'run-1' },
    })).toBe('run-1');
    expect(deferredRunIdForRecoveredVaultCompletion({
      success: true,
      data: { archivePending: true, deferredTranscriptionRunId: ' ' },
    })).toBeNull();
    expect(deferredRunIdForRecoveredVaultCompletion(null)).toBeNull();
  });

  it.each([
    [false, false, ' run-1 ', { kind: 'watch-deferred-run', runId: 'run-1' }],
    [true, false, 'run-2', { kind: 'watch-deferred-run', runId: 'run-2' }],
    [true, true, 'run-3', { kind: 'watch-deferred-run', runId: 'run-3' }],
    [true, false, null, { kind: 'wait-for-archive' }],
    [true, true, null, { kind: 'wait-for-archive' }],
    [false, false, null, { kind: 'open-transcription' }],
    [false, true, null, { kind: 'open-transcription' }],
  ])(
    'selects one exclusive follow-up for archivePending=%s liveReady=%s runId=%s',
    (archivePending, liveTranscriptReady, runId, expected) => {
      expect(decideUploadedRecordingFollowUp(
        archivePending as boolean,
        liveTranscriptReady as boolean,
        runId as string | null,
      )).toEqual(expected);
    },
  );

  it('keeps multiple recovered runs while trimming and deduplicating replays', () => {
    const first = enqueueBackgroundTranscriptionRun([], ' run-1 ');
    const duplicate = enqueueBackgroundTranscriptionRun(first, 'run-1');
    const second = enqueueBackgroundTranscriptionRun(duplicate, 'run-2');

    expect(first).toEqual(['run-1']);
    expect(duplicate).toEqual(['run-1']);
    expect(second).toEqual(['run-1', 'run-2']);
    expect(enqueueBackgroundTranscriptionRun(second, ' ')).toEqual(second);
  });

  it('binds the entry source after either callback ordering, including ordinary uploads', () => {
    const sources = new Map<string, { entryId: string; vaultSessionId?: string }>();
    const ordinaryUpload = { entryId: ' entry-upload ' };
    const recordedUpload = { entryId: 'entry-recorded', vaultSessionId: 'vault-1' };

    expect(bindBackgroundTranscriptionSource(sources, null, ordinaryUpload)).toBe(false);
    expect(bindBackgroundTranscriptionSource(sources, ' run-upload ', ordinaryUpload)).toBe(true);
    expect(sources.get('run-upload')).toEqual({ entryId: 'entry-upload' });

    expect(bindBackgroundTranscriptionSource(sources, 'run-recorded', null)).toBe(false);
    expect(bindBackgroundTranscriptionSource(sources, 'run-recorded', recordedUpload)).toBe(true);
    expect(sources.get('run-recorded')).toEqual(recordedUpload);
  });

  it('recovers publishing, queued, or running runs after a page refresh', () => {
    expect(recoverableBackgroundTranscriptionRunId({ id: 'run-publishing', status: 'publishing' })).toBe('run-publishing');
    expect(recoverableBackgroundTranscriptionRunId({ id: ' run-1 ', status: 'queued' })).toBe('run-1');
    expect(recoverableBackgroundTranscriptionRunId({ id: 'run-2', status: 'RUNNING' })).toBe('run-2');
    expect(recoverableBackgroundTranscriptionRunId({ id: 'run-3', status: 'done' })).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId({ id: 'run-4', status: 'failed' })).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId({ id: ' ', status: 'running' })).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId(null)).toBeNull();
  });

  it('keeps a publishing marker watched across immediate and delayed recovery until it reaches a terminal state', () => {
    const publishing = {
      id: 'run-publishing-transition',
      status: 'publishing',
      createdAt: '2026-08-14T11:59:00Z',
    };
    expect(recoverableBackgroundTranscriptionRunId(
      publishing,
      Date.parse('2026-08-14T12:00:00Z'),
    )).toBe('run-publishing-transition');
    expect(recoverableBackgroundTranscriptionRunId(
      publishing,
      Date.parse('2026-08-14T12:00:02.500Z'),
    )).toBe('run-publishing-transition');

    for (const status of ['queued', 'running']) {
      expect(decideBackgroundRunLookup({
        runId: 'run-publishing-transition',
        directRun: { ...publishing, status },
        latestEntryRun: { ...publishing, status },
        latestLookupSucceeded: true,
        consecutiveFailures: 0,
        nowMs: Date.parse('2026-08-14T12:00:02.500Z'),
      })).toEqual({ kind: 'observe', run: { ...publishing, status } });
    }
    for (const status of ['done', 'failed']) {
      expect(recoverableBackgroundTranscriptionRunId({ ...publishing, status })).toBeNull();
      expect(decideBackgroundRunLookup({
        runId: 'run-publishing-transition',
        directRun: { ...publishing, status },
        latestEntryRun: { ...publishing, status },
        latestLookupSucceeded: true,
        consecutiveFailures: 0,
        nowMs: Date.parse('2026-08-14T12:00:02.500Z'),
      })).toEqual({ kind: 'observe', run: { ...publishing, status } });
    }
  });

  it('does not recover a run that has had no progress for over one hour', () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    const stale = { id: 'run-old', status: 'running', startedAt: '2026-08-14T10:59:59Z' };
    expect(isStalledBackgroundTranscriptionRun(stale, now)).toBe(true);
    expect(recoverableBackgroundTranscriptionRunId(stale, now)).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId({
      id: 'run-stalled-publishing',
      status: 'publishing',
      createdAt: '2026-08-14T10:00:00Z',
    }, now)).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId({
      id: 'run-fresh-publishing',
      status: 'publishing',
      createdAt: '2026-08-14T11:59:00Z',
    }, now)).toBe('run-fresh-publishing');
    expect(recoverableBackgroundTranscriptionRunId({
      id: 'run-fresh',
      status: 'running',
      startedAt: '2026-08-14T11:30:00Z',
    }, now)).toBe('run-fresh');
    expect(recoverableBackgroundTranscriptionRunId({
      id: 'run-long-but-alive',
      status: 'running',
      startedAt: '2026-08-14T08:00:00Z',
      heartbeatAt: '2026-08-14T11:59:50Z',
    }, now)).toBe('run-long-but-alive');
    expect(recoverableBackgroundTranscriptionRunId({
      id: 'run-scheduled-retry',
      status: 'queued',
      createdAt: '2026-08-14T08:00:00Z',
      automaticRetryNextAt: '2026-08-14T12:05:00Z',
    }, now)).toBe('run-scheduled-retry');
    expect(recoverableBackgroundTranscriptionRunId({
      id: 'run-expired-retry',
      status: 'queued',
      createdAt: '2026-08-14T08:00:00Z',
      automaticRetryNextAt: '2026-08-14T10:00:00Z',
    }, now)).toBeNull();
  });

  it('falls back only to the same server run when direct lookup fails', () => {
    const direct = { id: 'run-1', status: 'failed' };
    const matchingLatest = { id: 'run-1', status: 'done' };
    const newerDifferentRun = { id: 'run-2', status: 'running' };

    expect(selectObservedBackgroundTranscriptionRun('run-1', direct, matchingLatest)).toBe(matchingLatest);
    expect(selectObservedBackgroundTranscriptionRun('run-1', null, matchingLatest)).toBe(matchingLatest);
    expect(selectObservedBackgroundTranscriptionRun('run-1', null, newerDifferentRun)).toBeNull();
  });

  it('retires a watcher immediately when access is lost', () => {
    expect(decideBackgroundRunLookup({
      runId: 'run-1',
      directRun: null,
      directErrorCode: 'PERMISSION_DENIED',
      latestEntryRun: null,
      latestLookupSucceeded: false,
      consecutiveFailures: 1,
    })).toEqual({ kind: 'retire-watcher', reason: 'access-lost', replacementRun: null });
  });

  it('retires a missing old watcher and exposes a newer run as its replacement', () => {
    const replacement = { id: 'run-2', status: 'running' };
    expect(decideBackgroundRunLookup({
      runId: 'run-1',
      directRun: null,
      directErrorCode: 'NOT_FOUND',
      latestEntryRun: replacement,
      latestLookupSucceeded: true,
      consecutiveFailures: 1,
    })).toEqual({ kind: 'retire-watcher', reason: 'superseded', replacementRun: replacement });
  });

  it('observes the same terminal run returned by the entry fallback', () => {
    const terminal = { id: 'run-1', status: 'failed' };
    expect(decideBackgroundRunLookup({
      runId: 'run-1',
      directRun: null,
      directErrorCode: 'NOT_FOUND',
      latestEntryRun: terminal,
      latestLookupSucceeded: true,
      consecutiveFailures: 1,
    })).toEqual({ kind: 'observe', run: terminal });
  });

  it('retires an old run when the same entry has a newer own run even if direct lookup still says running', () => {
    const replacement = { id: 'run-new', status: 'queued', startedAt: '2026-08-14T11:59:00Z' };
    expect(decideBackgroundRunLookup({
      runId: 'run-old',
      directRun: { id: 'run-old', status: 'running', startedAt: '2026-08-14T11:58:00Z' },
      latestEntryRun: replacement,
      latestLookupSucceeded: true,
      consecutiveFailures: 0,
      nowMs: Date.parse('2026-08-14T12:00:00Z'),
    })).toEqual({ kind: 'retire-watcher', reason: 'superseded', replacementRun: replacement });
  });

  it('reports a stalled replacement instead of silently retiring the superseded watcher', () => {
    const replacement = {
      id: 'run-new-stalled',
      status: 'running',
      heartbeatAt: '2026-08-14T10:00:00Z',
    };
    expect(decideBackgroundRunLookup({
      runId: 'run-old',
      directRun: { id: 'run-old', status: 'running', heartbeatAt: '2026-08-14T11:59:00Z' },
      latestEntryRun: replacement,
      latestLookupSucceeded: true,
      consecutiveFailures: 0,
      nowMs: Date.parse('2026-08-14T12:00:00Z'),
    })).toEqual({ kind: 'retire-watcher', reason: 'stalled-run', replacementRun: replacement });
  });

  it('reports a queued replacement whose automatic retry window expired over one hour ago', () => {
    const replacement = {
      id: 'run-new-expired-retry',
      status: 'queued',
      createdAt: '2026-08-14T08:00:00Z',
      automaticRetryNextAt: '2026-08-14T10:30:00Z',
    };
    expect(decideBackgroundRunLookup({
      runId: 'run-old',
      directRun: null,
      directErrorCode: 'NOT_FOUND',
      latestEntryRun: replacement,
      latestLookupSucceeded: true,
      consecutiveFailures: 1,
      nowMs: Date.parse('2026-08-14T12:00:00Z'),
    })).toEqual({ kind: 'retire-watcher', reason: 'stalled-run', replacementRun: replacement });
  });

  it('retires a directly readable run that has stopped progressing for over one hour', () => {
    expect(decideBackgroundRunLookup({
      runId: 'run-old',
      directRun: { id: 'run-old', status: 'running', heartbeatAt: '2026-08-14T10:00:00Z' },
      latestEntryRun: { id: 'run-old', status: 'running', heartbeatAt: '2026-08-14T10:00:00Z' },
      latestLookupSucceeded: true,
      consecutiveFailures: 0,
      nowMs: Date.parse('2026-08-14T12:00:00Z'),
    })).toEqual({ kind: 'retire-watcher', reason: 'stalled-run', replacementRun: null });
  });

  it('bounds transient lookup failures instead of showing processing forever', () => {
    expect(decideBackgroundRunLookup({
      runId: 'run-1',
      directRun: null,
      directErrorCode: 'REQUEST_REJECTED',
      latestEntryRun: null,
      latestLookupSucceeded: false,
      consecutiveFailures: 1,
    })).toEqual({ kind: 'keep-watching' });
    expect(decideBackgroundRunLookup({
      runId: 'run-1',
      directRun: null,
      directErrorCode: 'SERVER_UNAVAILABLE',
      latestEntryRun: null,
      latestLookupSucceeded: false,
      consecutiveFailures: 11,
      maxTransientFailures: 12,
    })).toEqual({ kind: 'keep-watching' });
    expect(decideBackgroundRunLookup({
      runId: 'run-1',
      directRun: null,
      directErrorCode: 'SERVER_UNAVAILABLE',
      latestEntryRun: null,
      latestLookupSucceeded: false,
      consecutiveFailures: 12,
      maxTransientFailures: 12,
    })).toEqual({ kind: 'retire-watcher', reason: 'lookup-unavailable', replacementRun: null });
  });

  it('never overlaps slow polling requests and stops scheduling after cleanup', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst: () => void = () => { throw new Error('first poll did not start'); };
    let calls = 0;
    const stop = startSerialBackgroundPoller(async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (calls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      inFlight -= 1;
    }, 5000);

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);

    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls).toBe(2);
  });

  it('labels another running recording separately from the selected failed recording', () => {
    expect(describeBackgroundTranscriptionBanner({
      selectedEntryId: 'entry-a',
      selectedHasFailure: true,
      runs: [{ entryId: 'entry-b', title: '客户访谈' }],
    })).toEqual({
      title: '其他录音正在后台处理',
      detail: '“客户访谈”仍在继续；当前录音已经失败，可单独点击重试。',
    });
  });

  it('identifies when the selected recording itself is the one being processed', () => {
    expect(describeBackgroundTranscriptionBanner({
      selectedEntryId: 'entry-a',
      selectedHasFailure: false,
      runs: [{ entryId: 'entry-a', title: '项目会议' }],
    })?.title).toBe('当前录音正在后台处理');
  });
});

describe('recording vault server recovery decision', () => {
  it('keeps local audio protected for unknown network and transient server errors', () => {
    expect(decideVaultServerRecovery(null)).toBe('keep-protected');
    expect(decideVaultServerRecovery({
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe('keep-protected');
  });

  it('keeps local audio protected while the server is completing', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completing' },
    })).toBe('keep-protected');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completing' },
    }, {
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe('keep-protected');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completing' },
    }, {
      success: false,
      error: { code: 'INVALID_FORMAT' },
    })).toBe('keep-protected');
  });

  it('accepts a successful idempotent completion after observing a completing lease', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completing' },
    }, { success: true })).toBe('completed');
  });

  it('deletes the vault only after the completed entry is recovered', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completed' },
    }, { success: true })).toBe('completed');
  });

  it('keeps protection when a completed session has only a transient response failure', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completed' },
    }, null)).toBe('keep-protected');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completed' },
    }, {
      success: false,
      error: { code: 'SERVER_ERROR' },
    })).toBe('keep-protected');
  });

  it('replays uploading completion and keeps protection while its outcome is unknown', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'uploading' },
    })).toBe('keep-protected');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'uploading' },
    }, { success: true })).toBe('completed');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'uploading' },
    }, {
      success: false,
      error: { code: 'INVALID_FORMAT' },
    })).toBe('keep-protected');
  });

  it('allows local recovery only after an explicit terminal or missing-session result', () => {
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'cancelled' },
    })).toBe('recover-local');
    expect(decideVaultServerRecovery({
      success: false,
      error: { code: 'SESSION_EXPIRED' },
    })).toBe('recover-local');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'uploading' },
    }, {
      success: false,
      error: { code: 'NOT_FOUND' },
    })).toBe('recover-local');
    expect(decideVaultServerRecovery({
      success: true,
      data: { status: 'completed' },
    }, {
      success: false,
      error: { code: 'NOT_FOUND' },
    })).toBe('recover-local');
  });
});

describe('describeBackgroundTranscriptionBanner · 与正文三阶段卡的分工', () => {
  const run = (entryId: string, title: string) => ({ entryId, title });

  it('当前录音的进度已由正文卡在讲时，横幅不再重复说一遍', () => {
    expect(describeBackgroundTranscriptionBanner({
      selectedEntryId: 'e1',
      selectedHasFailure: false,
      runs: [run('e1', '录音 A')],
      currentRunHasInlineCard: true,
    })).toBeNull();
  });

  it('但其它录音仍在跑时照说不误——那件事正文卡管不着', () => {
    const copy = describeBackgroundTranscriptionBanner({
      selectedEntryId: 'e1',
      selectedHasFailure: false,
      runs: [run('e1', '录音 A'), run('e2', '录音 B')],
      currentRunHasInlineCard: true,
    });
    expect(copy?.title).toContain('其他录音');
    expect(copy?.detail).toContain('录音 B');
    expect(copy?.detail).not.toContain('录音 A');
  });

  it('没有正文卡时行为不变（旧路径不受影响）', () => {
    expect(describeBackgroundTranscriptionBanner({
      selectedEntryId: 'e1',
      selectedHasFailure: false,
      runs: [run('e1', '录音 A')],
    })?.title).toBe('当前录音正在后台处理');
  });
});

/*
 * 三处轮询共用这一个「还在跑吗」。判据只认在途的三种状态：反过来枚举终态的话，
 * 后端哪天加一个新的终态名，轮询就永远停不下来（形状 1），而且抄成三份必然漂移（形状 3）。
 */
describe('isTranscriptionInflight', () => {
  it('后端枚举里的三种在途状态都算在跑', () => {
    for (const s of ['publishing', 'queued', 'running']) expect(isTranscriptionInflight(s)).toBe(true);
    expect(isTranscriptionInflight('  Running ')).toBe(true);
  });

  it('终态与未知状态都不算在跑', () => {
    for (const s of ['done', 'failed', 'cancelled', '', '  ', 'whatever-new-terminal']) {
      expect(isTranscriptionInflight(s)).toBe(false);
    }
    expect(isTranscriptionInflight(null)).toBe(false);
    expect(isTranscriptionInflight(undefined)).toBe(false);
  });

  it('三处轮询都走这一个判定，没有第二份状态清单', () => {
    const dir = path.resolve(__dirname, '..');
    for (const file of ['RecordingProcessingPage.tsx', 'RecordingResultPage.tsx']) {
      const source = fs.readFileSync(path.join(dir, file), 'utf-8');
      expect(source).toContain('isTranscriptionInflight');
      // 就地再列一遍状态名 = 又抄了一份判据
      expect(source).not.toContain("=== 'publishing'");
    }
  });
});

/*
 * 本机保险箱是 best-effort：**永不抛**，但必须如实汇报写没写进去。
 * 此前它返回 void 并把异常全吞掉，调用方接的 .catch 因此永远不触发——
 * 界面照样挂着「已保护 · 无丢失」，而分片只在内存里。
 * 这两条钉的就是「失败说得出口」：node 环境没有 indexedDB，正好是不可用那一档。
 */
describe('本机保险箱失败时如实返回', () => {
  it('indexedDB 不可用时 vaultAppendChunk 返回 false，而不是静默成功', async () => {
    expect(typeof indexedDB).toBe('undefined');
    await expect(vaultAppendChunk('sess-1', new Blob(['x']))).resolves.toBe(false);
  });

  it('indexedDB 不可用时 vaultStartSession 返回 false', async () => {
    await expect(vaultStartSession('sess-1', 'audio/webm')).resolves.toBe(false);
  });

  it('失败时不抛异常——录音不能因为落盘失败而中断', async () => {
    await expect(vaultAppendChunk('sess-2', new Blob(['y']))).resolves.not.toThrow;
  });
});

