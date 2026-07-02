import type { ExecResult, IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

export interface DockerNetworkReclaimResult {
  inspected: number;
  removed: number;
  detached: number;
}

export function isDockerNetworkAddressPoolExhausted(result: ExecResult): boolean {
  return combinedOutput(result).toLowerCase().includes('all predefined address pools have been fully subnetted');
}

export async function ensureDockerNetworkWithReclaim(
  shell: IShellExecutor,
  network: string,
  opts: { inspectTimeoutMs?: number; createTimeoutMs?: number } = {},
): Promise<void> {
  validateDockerNetworkName(network);
  const inspect = await shell.exec(`docker network inspect ${network}`, timeoutOpt(opts.inspectTimeoutMs));
  if (inspect.exitCode === 0) return;

  const create = await shell.exec(`docker network create ${network}`, timeoutOpt(opts.createTimeoutMs));
  if (create.exitCode === 0 || isDockerAlreadyExists(create)) return;

  if (!isDockerNetworkAddressPoolExhausted(create)) {
    throw new Error(`创建 Docker 网络 "${network}" 失败:\n${combinedOutput(create)}`);
  }

  const cleanup = await cleanupUnusedBranchNetworks(shell);
  const retry = await shell.exec(`docker network create ${network}`, timeoutOpt(opts.createTimeoutMs));
  if (retry.exitCode === 0 || isDockerAlreadyExists(retry)) return;

  const cleanupNote = `已清理 ${cleanup.removed} 个空闲分支网络、断开 ${cleanup.detached} 个停止容器后重试仍失败`;
  throw new Error(`创建 Docker 网络 "${network}" 失败:\n${combinedOutput(create)}\n\n${cleanupNote}:\n${combinedOutput(retry)}`);
}

export async function cleanupUnusedBranchNetworks(shell: IShellExecutor): Promise<DockerNetworkReclaimResult> {
  const listed = await shell.exec(`docker network ls --format '{{.Name}}'`);
  if (listed.exitCode !== 0 || !listed.stdout.trim()) return { inspected: 0, removed: 0, detached: 0 };

  let inspected = 0;
  let removed = 0;
  let detached = 0;
  const names = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('cds-br-'));

  for (const name of names) {
    inspected += 1;
    const inspect = await shell.exec(`docker network inspect --format='{{json .Containers}}' ${shellQuote(name)}`);
    if (inspect.exitCode !== 0) continue;
    const ids = parseNetworkContainerIds(inspect.stdout);
    if (ids.length > 0) {
      const states = await inspectNetworkContainerStates(shell, ids);
      if (states.length !== ids.length || states.some((s) => s.running)) continue;
      for (const id of ids) {
        const disconnected = await shell.exec(`docker network disconnect -f ${shellQuote(name)} ${shellQuote(id)}`);
        if (disconnected.exitCode === 0) detached += 1;
      }
    }

    const rm = await shell.exec(`docker network rm ${shellQuote(name)}`);
    if (rm.exitCode === 0) removed += 1;
  }

  return { inspected, removed, detached };
}

function validateDockerNetworkName(network: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network)) {
    throw new Error(`Docker network 名称非法：${network}`);
  }
}

function timeoutOpt(timeout?: number): { timeout: number } | undefined {
  return timeout ? { timeout } : undefined;
}

function isDockerAlreadyExists(result: ExecResult): boolean {
  return combinedOutput(result).toLowerCase().includes('already exists');
}

function parseNetworkContainerIds(raw: string): string[] {
  const text = raw.trim();
  if (!text || text === '{}' || text === 'null') return [];
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.keys(parsed).filter(Boolean);
  } catch {
    return [];
  }
}

async function inspectNetworkContainerStates(
  shell: IShellExecutor,
  ids: string[],
): Promise<Array<{ id: string; running: boolean }>> {
  if (ids.length === 0) return [];
  const quotedIds = ids.map((id) => shellQuote(id)).join(' ');
  const inspected = await shell.exec(`docker inspect --format='{{.Id}} {{.State.Running}}' ${quotedIds}`);
  if (inspected.exitCode !== 0) return [];
  return inspected.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, running] = line.split(/\s+/);
      return { id, running: running === 'true' };
    })
    .filter((state) => !!state.id);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
