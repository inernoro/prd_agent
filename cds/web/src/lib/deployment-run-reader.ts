import type { DeploymentRunSummary } from '@/components/deployment/DeploymentRunLedger';
import { branchScopedDeploymentRuns } from './deployment-run-list';

export interface DeploymentRunSnapshot {
  runs: DeploymentRunSummary[];
  unavailable: boolean;
}

/** One session, one flight. Polls are scheduled after settlement, never accumulated. */
export function createDeploymentRunReader({ projectId, branchId, request, onChange }: {
  projectId: string;
  branchId: string;
  request: (signal: AbortSignal) => Promise<unknown>;
  onChange: (snapshot: DeploymentRunSnapshot) => void;
}) {
  let alive = true, polling = false;
  let lastGood: DeploymentRunSummary[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: { promise: Promise<void>; controller: AbortController; poll: boolean; cancel: () => void } | undefined;

  function clearPoll() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function schedulePoll() {
    clearPoll();
    if (alive && polling && !flight) timer = setTimeout(() => { timer = undefined; void refresh(true); }, 2_000);
  }
  function refresh(poll = false): Promise<void> {
    if (!alive) return Promise.resolve();
    if (flight) return flight.promise;
    clearPoll();
    const controller = new AbortController();
    let resolve!: () => void, settled = false;
    const promise = new Promise<void>(ok => { resolve = ok; });
    const mine = { promise, controller, poll, cancel: () => { controller.abort(); finish(); } };
    const current = () => alive && !settled && flight === mine;
    function finish() {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (flight === mine) { flight = undefined; schedulePoll(); }
      resolve();
    }
    const deadline = setTimeout(() => {
      if (!current()) return;
      controller.abort(); onChange({ runs: lastGood, unavailable: true }); finish();
    }, 30_000);
    flight = mine;
    void Promise.resolve().then(() => current() ? request(controller.signal) : undefined).then(value => {
      if (!current()) return;
      const rows = branchScopedDeploymentRuns(value, projectId, branchId);
      if (rows !== null) lastGood = rows;
      onChange({ runs: lastGood, unavailable: rows === null });
    }, () => {
      if (current()) onChange({ runs: lastGood, unavailable: true });
    }).finally(finish);
    return promise;
  }
  return {
    refresh: () => refresh(),
    setPolling(enabled: boolean) {
      if (!alive || polling === enabled) return;
      polling = enabled;
      if (enabled) schedulePoll();
      else { clearPoll(); if (flight?.poll) flight.cancel(); }
    },
    dispose() {
      if (!alive) return;
      alive = false; polling = false; clearPoll(); flight?.cancel();
    },
  };
}
