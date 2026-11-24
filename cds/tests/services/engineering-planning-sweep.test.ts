import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineeringPlanningService, FileEngineeringPlanningStore } from '../../src/services/engineering-planning.js';
import { startPlanningSweep } from '../../src/services/engineering-planning-sweep.js';
import type { PlanningActor, PlanningDebt } from '../../src/shared/engineering-planning.js';

const writer: PlanningActor = { kind: 'human', id: 'planner', label: '项目负责人', permissions: ['read', 'write'] };
const start = Date.parse('2026-11-27T21:59:59.999Z');
const expectedCutoff = '2026-11-27T22:00:00.000Z';
const scheduledProjects = ['fixture-alpha', 'fixture-beta'];

describe('engineering planning scheduled recorded-removal sweep', () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('catches up only through the latest 06:00 Shanghai cutoff and stops with the app', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const sweep = vi.fn(async (_project: string, _through: Date) => {});
    stop = startPlanningSweep({ projects: () => scheduledProjects, sweep, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep.mock.calls.map(([project, through]) => [project, through.toISOString()])).toEqual([
      [scheduledProjects[0], '2026-11-26T22:00:00.000Z'], [scheduledProjects[1], '2026-11-26T22:00:00.000Z'],
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep.mock.calls.slice(2).map(([project, through]) => [project, through.toISOString()])).toEqual([
      [scheduledProjects[0], expectedCutoff], [scheduledProjects[1], expectedCutoff],
    ]);
    await stop();
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(sweep).toHaveBeenCalledTimes(4);
  });

  it('retries a failed project without repeating successful projects in the same run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(expectedCutoff));
    const warn = vi.fn();
    let fail = true;
    const sweep = vi.fn(async (project: string, _through: Date) => {
      if (project === scheduledProjects[0] && fail) {
        fail = false;
        throw new Error('fixture store unavailable');
      }
    });
    stop = startPlanningSweep({ projects: () => scheduledProjects, sweep, onError: warn });
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep.mock.calls.map(([project]) => project)).toEqual(scheduledProjects);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sweep.mock.calls.map(([project]) => project)).toEqual([...scheduledProjects, scheduledProjects[0]]);
  });

  it('commits only eligible recorded removals in the selected project once across processes and restarts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cds-planning-sweep-'));
    try {
      const store = new FileEngineeringPlanningStore(directory);
      let now = new Date('2026-11-20T21:00:00Z');
      const createService = () => new EngineeringPlanningService(new FileEngineeringPlanningStore(directory), () => now);
      const service = createService();
      async function setup(projectId: string, name: string, removal: boolean) {
        const debt = (await service.command(projectId, writer, {
          type: 'debt.create', requestId: `create-${name}`, title: `合成测试 ${name}`,
          source: { type: 'manual', ref: name },
        })).result as PlanningDebt;
        const bound = (await service.command(projectId, writer, {
          type: 'debt.anchor', requestId: `bind-${name}`, debtId: debt.id, expectedVersion: debt.version,
          anchor: { type: 'file', ref: `fixture/${name}.ts` }, reason: '明确绑定到合成模块',
        })).result as PlanningDebt;
        if (removal) await service.command(projectId, writer, {
          type: 'debt.anchor-missing', requestId: `missing-${name}`, debtId: debt.id, expectedVersion: bound.version,
          note: '登记已删除的合成功能', evidence: [{ type: 'change', label: '删除变更', url: 'https://example.com/fixture/pull/20' }],
        });
        return debt.id;
      }

      const firstProject = scheduledProjects[0];
      const secondProject = scheduledProjects[1];
      const closed = await setup(firstProject, 'eligible', true);
      const untouched = await setup(firstProject, 'no-record', false);
      const other = await setup(secondProject, 'outside', true);
      const sourceMissingId = await setup(firstProject, 'missing-provenance', true);
      const sourceMissing = (await service.debt(firstProject, sourceMissingId)).debt;
      if (sourceMissing.anchor?.status !== 'missing') throw new Error('Expected a pending removal fixture');
      const last = (await store.read(firstProject, 0)).at(-1)!;
      await store.append({ projectId: firstProject, revision: last.revision + 1, debts: [
        { ...sourceMissing, anchor: { ...sourceMissing.anchor, source: undefined } },
      ], decisions: [], plans: [], events: [], proposals: [] });
      now = new Date('2026-11-20T23:00:00Z');
      const waiting = await setup(firstProject, 'after-todays-cutoff', true);
      now = new Date('2026-11-28T10:00:00Z');
      const through = new Date(expectedCutoff);
      const before = await store.read(firstProject, 0);
      await Promise.all([service.sweepRecordedRemovals(firstProject, through), createService().sweepRecordedRemovals(firstProject, through)]);
      expect(await store.read(firstProject, 0)).toHaveLength(before.length + 1);
      const reloaded = createService();
      const detail = await reloaded.debt(firstProject, closed);
      expect(detail.debt).toMatchObject({ status: 'dropped', outcome: { kind: 'extinct', closedAt: '2026-11-27T21:00:00.000Z' } });
      expect(detail.events[0]).toMatchObject({ type: 'extinct', via: 'system', actor: { kind: 'system' }, at: now.toISOString() });
      expect(detail.events[0]).not.toHaveProperty('triggeredBy');
      await reloaded.sweepRecordedRemovals(firstProject, through);
      expect(await store.read(firstProject, 0)).toHaveLength(before.length + 1);
      expect((await reloaded.debt(firstProject, waiting)).debt).toMatchObject({ status: 'open', anchor: { status: 'missing' } });
      expect((await reloaded.debt(firstProject, untouched)).debt).toMatchObject({ status: 'open', anchor: { status: 'alive' } });
      expect((await reloaded.debt(firstProject, sourceMissingId)).debt).toMatchObject({ status: 'open', anchor: { status: 'missing' } });
      expect((await reloaded.debt(secondProject, other)).debt.status).toBe('open');
      await reloaded.sweepRecordedRemovals(firstProject, new Date('2026-11-28T22:00:00Z'));
      expect((await reloaded.debt(firstProject, waiting)).debt.status).toBe('open');
      now = new Date('2026-11-28T22:00:00Z');
      await reloaded.sweepRecordedRemovals(firstProject, now);
      expect((await reloaded.debt(firstProject, waiting)).debt.status).toBe('dropped');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
