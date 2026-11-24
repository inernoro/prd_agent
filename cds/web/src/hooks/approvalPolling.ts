import { ApiError } from '@/lib/api';

export interface ApprovalCapabilities {
  operator: boolean;
  accessRequests: boolean;
}

/** Human approval permission is server-authenticated, separate from legacy owner display metadata. */
export function canReadApproval(capabilities: ApprovalCapabilities | undefined, scope: keyof ApprovalCapabilities): boolean {
  return capabilities?.[scope] === true;
}

type RefreshResult<T> = { kind: 'ok'; data: T } | { kind: 'forbidden' };

/** One GET at a time; a 403 stops this component's snapshot/heartbeat/reconnect requests until remounted. */
export function createApprovalPollingGate<T>(): { run: (read: () => Promise<T>) => Promise<RefreshResult<T>>; runFresh: (read: () => Promise<T>) => Promise<RefreshResult<T>> } {
  let forbidden = false;
  let inFlight: Promise<RefreshResult<T>> | undefined;
  return {
    async runFresh(read) {
      // 未知写入结果必须由写入结束后新发出的 GET 核验；不能复用事前快照。
      if (inFlight) await inFlight.catch(() => undefined);
      return this.run(read);
    },
    run(read) {
      if (forbidden) return Promise.resolve({ kind: 'forbidden' });
      if (inFlight) return inFlight;
      inFlight = Promise.resolve().then(read).then((data): RefreshResult<T> => ({ kind: 'ok', data }))
        .catch((error: unknown): RefreshResult<T> => {
          if (error instanceof ApiError && error.status === 403) {
            forbidden = true;
            return { kind: 'forbidden' };
          }
          throw error;
        }).finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}

/** 保持正在审阅的请求；已暂缓的旧请求不得被 heartbeat 再次自动打开。 */
export function nextUnseenApproval<T extends { id: string }>(requests: T[], deferred: ReadonlySet<string>, currentId?: string): T | undefined {
  return requests.find(request => request.id === currentId) ?? requests.find(request => !deferred.has(request.id));
}
