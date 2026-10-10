export interface PendingDeployDispatchResult {
  outcome: 'completed' | 'accepted' | 'failed' | 'cancelled' | 'unknown';
  reason: 'deployment_completed' | 'deployment_failed' | 'deployment_error' | 'deployment_cancelled' | 'request_accepted'
    | 'http_rejected' | 'response_timeout' | 'observation_timeout' | 'transport_error'
    | 'terminal_missing' | 'invalid_terminal' | 'frame_too_large';
  httpStatus?: number;
  deploymentRunId?: string;
}

function runId(value: unknown): string | undefined {
  return typeof value === 'string' && /^dr_[a-zA-Z0-9_.-]{1,120}$/.test(value) ? value : undefined;
}

/** Observe one internal replay. Transport uncertainty never authorizes a retry or executor cancellation. */
export async function observePendingDeployDispatch(
  url: string,
  init: RequestInit,
  options: { fetch?: typeof fetch; headersTimeoutMs?: number; observationTimeoutMs?: number; maxFrameBytes?: number } = {},
): Promise<PendingDeployDispatchResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timeoutMarker = Symbol('timeout');
  const deadline = (ms: number): Promise<typeof timeoutMarker> => new Promise(resolve => {
    timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(timeoutMarker); }, ms);
    timer.unref?.();
  });
  const result = (outcome: PendingDeployDispatchResult['outcome'], reason: PendingDeployDispatchResult['reason'],
    deploymentRunId?: string): PendingDeployDispatchResult => ({ outcome, reason,
      ...(response ? { httpStatus: response.status } : {}), ...(deploymentRunId ? { deploymentRunId } : {}) });
  try {
    const responseDeadline = deadline(options.headersTimeoutMs ?? 5000);
    const responsePromise = (options.fetch ?? fetch)(url, { ...init, signal: controller.signal, redirect: 'error' });
    // A transport that settles after the deadline must not leave an unread body open.
    void responsePromise.then(late => { if (timedOut) void late.body?.cancel().catch(() => {}); }, () => {});
    const first = await Promise.race([responsePromise, responseDeadline]);
    if (first === timeoutMarker) return result('unknown', 'response_timeout');
    if (timer) clearTimeout(timer);
    response = first;
    if (!response.ok) return result('failed', 'http_rejected');
    if (!response.body) return result('unknown', 'terminal_missing');
    reader = response.body.getReader();
    // One timer owns at most one current read waiter. Racing every read against
    // the same pending deadline retains a reaction per chunk until that deadline.
    let wakeReadOnTimeout: (() => void) | undefined;
    timer = setTimeout(() => {
      timedOut = true;
      wakeReadOnTimeout?.();
      controller.abort();
    }, options.observationTimeoutMs ?? 30 * 60_000);
    timer.unref?.();
    const readNext = (): Promise<ReadableStreamReadResult<Uint8Array> | typeof timeoutMarker> => {
      if (timedOut) return Promise.resolve(timeoutMarker);
      return new Promise((resolve, reject) => {
        wakeReadOnTimeout = () => resolve(timeoutMarker);
        reader!.read().then(chunk => { wakeReadOnTimeout = undefined; resolve(chunk); },
          error => { wakeReadOnTimeout = undefined; reject(error); });
      });
    };
    const maxBytes = options.maxFrameBytes ?? 256 * 1024;
    const jsonResponse = (response.headers.get('Content-Type') || '').includes('application/json') || response.status === 202;
    const decoder = new TextDecoder();
    let buffer = '';
    const classify = (value: unknown, event?: string): PendingDeployDispatchResult => {
      const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      if (event === 'error') return data.operationStatus === 'cancelled'
        ? result('cancelled', 'deployment_cancelled', runId(data.runId))
        : result('failed', 'deployment_error', runId(data.runId));
      if (data.operationStatus != null && data.operationStatus !== 'merged' && data.operationStatus !== 'joined') return result('unknown', 'invalid_terminal');
      if (data.ok === false) return result('failed', 'deployment_failed', runId(data.runId));
      if (data.ok !== true) return result('unknown', 'invalid_terminal');
      if (data.operationStatus === 'merged' || data.operationStatus === 'joined') {
        // The merged placeholder header is cancelled; only an explicit actual run can be associated.
        return result('accepted', 'request_accepted', runId(data.deploymentRunId));
      }
      if (event !== 'complete') return result('unknown', 'invalid_terminal');
      return result('completed', 'deployment_completed', runId(data.runId) || runId(response?.headers.get('X-CDS-Deployment-Run-Id')));
    };
    for (;;) {
      const chunk = await readNext();
      if (chunk === timeoutMarker) return result('unknown', 'observation_timeout');
      if (chunk.done) {
        buffer += decoder.decode();
        if (jsonResponse && Buffer.byteLength(buffer) <= maxBytes) {
          try { return classify(JSON.parse(buffer)); } catch { return result('unknown', 'invalid_terminal'); }
        }
        return result('unknown', 'terminal_missing');
      }
      // A single transport chunk may contain many frames or an oversized line.
      // Decode bounded pieces, rather than copying the whole chunk into a string.
      for (let offset = 0; offset < chunk.value.byteLength; offset += 16 * 1024) {
        buffer += decoder.decode(chunk.value.subarray(offset, offset + 16 * 1024), { stream: true });
        if (!jsonResponse) {
          for (;;) {
            const separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
            if (!separator) break;
            const frame = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            if (Buffer.byteLength(frame) > maxBytes) return result('unknown', 'frame_too_large');
            let event = ''; const data: string[] = [];
            for (const line of frame.split(/\r\n|\n|\r/)) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (event === 'error') {
              try { return classify(JSON.parse(data.join('\n')), event); } catch { return result('failed', 'deployment_error'); }
            }
            if (event === 'complete') {
              try { return classify(JSON.parse(data.join('\n')), event); } catch { return result('unknown', 'invalid_terminal'); }
            }
          }
        }
        if (Buffer.byteLength(buffer) > maxBytes) return result('unknown', 'frame_too_large');
      }
    }
  } catch {
    return result('unknown', timedOut ? (response ? 'observation_timeout' : 'response_timeout') : 'transport_error');
  } finally {
    if (timer) clearTimeout(timer);
    // Closing the observation socket does not stop the background branch operation.
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* a timed-out read may still be settling */ }
    } else if (response) void response.body?.cancel().catch(() => {});
  }
}
