import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('recovers only queued or running runs after a page refresh', () => {
    expect(recoverableBackgroundTranscriptionRunId({ id: ' run-1 ', status: 'queued' })).toBe('run-1');
    expect(recoverableBackgroundTranscriptionRunId({ id: 'run-2', status: 'RUNNING' })).toBe('run-2');
    expect(recoverableBackgroundTranscriptionRunId({ id: 'run-3', status: 'done' })).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId({ id: 'run-4', status: 'failed' })).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId({ id: ' ', status: 'running' })).toBeNull();
    expect(recoverableBackgroundTranscriptionRunId(null)).toBeNull();
  });

  it('does not recover a run that has had no progress for over one hour', () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    const stale = { id: 'run-old', status: 'running', startedAt: '2026-08-14T10:59:59Z' };
    expect(isStalledBackgroundTranscriptionRun(stale, now)).toBe(true);
    expect(recoverableBackgroundTranscriptionRunId(stale, now)).toBeNull();
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
    })).toEqual({ kind: 'retire-watcher', reason: 'superseded', replacementRun: replacement });
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
