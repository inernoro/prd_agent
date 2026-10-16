import type { BranchEntry, DeploymentRun, IShellExecutor, ServiceState } from '../types.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';

export interface FailureLogEvidence {
  status: 'run-window' | 'outside-run' | 'missing' | 'unverified' | 'unavailable';
  reason: string;
  runId?: string;
  containerId?: string;
}

/** 只读取已登记的不可变容器身份及本轮时间窗；缺证时不把旧日志当作新部署根因。 */
export async function collectFailureLogEvidence(shell: IShellExecutor, input: {
  branch: BranchEntry; profileId: string; service: ServiceState; run?: DeploymentRun; local: boolean;
}): Promise<{ tailLines: string[]; evidence: FailureLogEvidence }> {
  const { branch, profileId, run, local } = input;
  const runtime = input.service.pendingRuntime || input.service;
  const containerId = runtime.containerId;
  const ref = containerId || runtime.containerName;
  const start = Date.parse(run?.startedAt || '');
  const end = run?.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const outcome = (status: FailureLogEvidence['status'], reason: string) => ({
    tailLines: [] as string[], evidence: { status, reason, runId: run?.id } satisfies FailureLogEvidence,
  });
  if (!local) return outcome('unavailable', '服务不在已确认的本机执行器，未用本机日志推断远端故障');
  if (!run || run.branchId !== branch.id || run.projectId !== (branch.projectId || 'default')
    || run.profileId && run.profileId !== profileId || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return outcome('unverified', '缺少与该服务匹配的部署运行及时间范围');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(ref)) return outcome('unverified', '容器引用无效');
  // 不读取完整 Config/Env；名称只用于确认容器缺失，日志必须使用登记过的完整 ID。
  const format = '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"project":{{json (index .Config.Labels "cds.project.id")}},"branch":{{json (index .Config.Labels "cds.branch.id")}},"profile":{{json (index .Config.Labels "cds.profile.id")}}}';
  try {
    const inspected = await shell.exec(`docker inspect --format ${shellQuote(format)} ${shellQuote(ref)}`,
      { timeout: 5000, executionLane: 'observation' });
    if (inspected.exitCode !== 0) return /No such (?:container|object):/i.test(`${inspected.stdout}\n${inspected.stderr}`)
      ? outcome('missing', '当前登记的容器不存在；缺失原因尚未确认')
      : outcome('unavailable', '容器身份查询失败，未将查询错误当作应用日志');
    const inspectedRuntime = JSON.parse(inspected.stdout);
    if (!containerId || !/^[a-f0-9]{64}$/.test(containerId) || inspectedRuntime?.id !== containerId
      || inspectedRuntime.project !== (branch.projectId || '_unknown')
      || inspectedRuntime.branch !== branch.id || inspectedRuntime.profile !== profileId) {
      return outcome('unverified', '容器不可变身份或项目、分支、服务归属无法确认');
    }
    const started = Date.parse(inspectedRuntime.startedAt);
    if (!Number.isFinite(started) || started < start || started > end) {
      return outcome('outside-run', '容器启动时间不在本轮部署范围，未采纳历史日志');
    }
    const since = new Date(start).toISOString();
    const until = new Date(end).toISOString();
    const logs = await shell.exec(`docker logs --timestamps --since ${shellQuote(since)} --until ${shellQuote(until)} --tail 30 ${shellQuote(containerId)}`,
      { timeout: 7000, executionLane: 'observation' });
    if (logs.exitCode !== 0) return /No such (?:container|object):/i.test(`${logs.stdout}\n${logs.stderr}`)
      ? outcome('missing', '核验后的容器已消失，未回退读取同名新容器')
      : outcome('unavailable', '本轮日志读取失败，未将查询错误当作应用日志');
    const tailLines = `${logs.stdout}\n${logs.stderr}`.split('\n').filter(line => {
      const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/);
      const at = timestamp ? Date.parse(timestamp[1]) : NaN;
      return Number.isFinite(at) && at >= start && at <= end;
    }).slice(-30);
    return { tailLines, evidence: { status: 'run-window', reason: '日志已按登记容器 ID、归属和部署时间范围核验', runId: run.id, containerId } };
  } catch {
    return outcome('unavailable', '容器身份或日志读取不可用，未推断应用故障');
  }
}
