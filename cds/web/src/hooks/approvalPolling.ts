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
export function createApprovalPollingGate<T>(): { run: (read: () => Promise<T>) => Promise<RefreshResult<T>> } {
  let forbidden = false;
  let inFlight: Promise<RefreshResult<T>> | undefined;
  return {
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
