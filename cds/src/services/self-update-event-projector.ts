// Self-update 事件投影器
//
// 把 self.status snapshot 中 activeSelfUpdate / lastSelfUpdate 字段的变化,
// 投影成目标文档定义的 self.update.{started,step,done,failed} 事件,推到同一个
// cds-events bus 上。
//
// 为什么这样做:
//   self-update / self-force-sync 路由(branches.ts)有 15+ 个 sendSSE / step
//   触发点,每处都加 bus.publish 既零散又容易漏。而每次 step / 错误都会调
//   broadcastSelfStatus() → selfStatusCache.enqueueRefresh('webhook') →
//   bus.publish('self.status', snapshot)。因此只需订阅 self.status,跟踪
//   activeSelfUpdate / lastSelfUpdate 的状态机变化,就能完整生成 update 事件。
//
// 状态机:
//   none           → activeSelfUpdate=null & no recent lastSelfUpdate
//   active         → activeSelfUpdate != null
//   done           → activeSelfUpdate=null & lastSelfUpdate.status=success
//   failed         → activeSelfUpdate=null & lastSelfUpdate.status=failed
//                     (或 status=aborted)
//
// 触发的事件:
//   none → active                  : self.update.started
//   active (step 字段变化)         : self.update.step
//   active → done(status=success) : self.update.done
//   active → failed (status≠success): self.update.failed

import { cdsEventsBus, type CdsEventEnvelope } from './cds-events-bus.js';
import type { SelfStatusSnapshot } from './self-status-cache.js';

interface ActiveSelfUpdateLike {
  startedAt: string;
  branch: string;
  trigger: string;
  actor?: string;
  step?: string;
  logTail?: Array<{ ts: string; level: string; text: string }>;
}

interface LastSelfUpdateLike {
  ts: string;
  branch?: string;
  status?: 'success' | 'failed' | 'aborted' | 'deferred';
  trigger?: string;
  durationMs?: number;
  actor?: string;
}

interface ProjectorState {
  activeStartedAt: string | null;
  activeStep: string | null;
  lastSeenLastUpdateTs: string | null;
}

let installed = false;

export function installSelfUpdateEventProjector(): void {
  if (installed) return;
  installed = true;

  const state: ProjectorState = {
    activeStartedAt: null,
    activeStep: null,
    lastSeenLastUpdateTs: null,
  };

  cdsEventsBus.subscribe((envelope: CdsEventEnvelope) => {
    if (envelope.type !== 'self.status') return;
    const snapshot = envelope.data as SelfStatusSnapshot;
    if (!snapshot) return;

    const active = snapshot.activeSelfUpdate as ActiveSelfUpdateLike | null;
    const last = snapshot.lastSelfUpdate as LastSelfUpdateLike | null;

    // ── 转换 1: none → active ⇒ self.update.started ─────────────────
    if (active && (!state.activeStartedAt || state.activeStartedAt !== active.startedAt)) {
      state.activeStartedAt = active.startedAt;
      state.activeStep = active.step ?? null;
      cdsEventsBus.publish('self.update.started', {
        startedAt: active.startedAt,
        branch: active.branch,
        trigger: active.trigger,
        actor: active.actor,
        step: active.step,
      });
      return;
    }

    // ── 转换 2: active step 变更 ⇒ self.update.step ─────────────────
    if (active && state.activeStartedAt === active.startedAt) {
      if ((active.step ?? null) !== state.activeStep) {
        state.activeStep = active.step ?? null;
        cdsEventsBus.publish('self.update.step', {
          startedAt: active.startedAt,
          branch: active.branch,
          step: active.step,
          // 末尾 5 行 logTail 给前端 toast 用 — 完整日志靠 self-update-history
          logTail: (active.logTail ?? []).slice(-5),
        });
      }
      return;
    }

    // ── 转换 3: active → null + 出现新的 lastSelfUpdate ⇒ done / failed ───
    if (!active && state.activeStartedAt && last && last.ts !== state.lastSeenLastUpdateTs) {
      const startedAt = state.activeStartedAt;
      state.activeStartedAt = null;
      state.activeStep = null;
      state.lastSeenLastUpdateTs = last.ts;
      if (last.status === 'success') {
        cdsEventsBus.publish('self.update.done', {
          startedAt,
          finishedAt: last.ts,
          branch: last.branch,
          trigger: last.trigger,
          durationMs: last.durationMs,
          actor: last.actor,
        });
      } else {
        cdsEventsBus.publish('self.update.failed', {
          startedAt,
          finishedAt: last.ts,
          branch: last.branch,
          trigger: last.trigger,
          status: last.status, // failed / aborted / deferred
          durationMs: last.durationMs,
          actor: last.actor,
        });
      }
      return;
    }

    // 维护"已看到的最新 last 时间戳"作为后续判定基准
    if (last && last.ts && state.lastSeenLastUpdateTs !== last.ts && !active) {
      state.lastSeenLastUpdateTs = last.ts;
    }
  });
}
