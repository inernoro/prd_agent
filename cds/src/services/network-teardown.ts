import type { IShellExecutor } from '../types.js';
import { branchAppNetworkName } from './branch-network.js';

export interface NetworkTeardownState {
  getNetworkTeardowns(): Array<{ name: string; projectId: string }>;
  removeNetworkTeardown(name: string, projectId: string): void;
  getProjects(): Array<{ id: string; dockerNetwork?: string }>;
  getAllBranches(): Array<{ id: string }>;
}

/** 删除项目的网络补偿；不强拆端点、不 prune，按 inspect 得到的 ID 删除防止同名重建。 */
export async function processNetworkTeardowns(shell: IShellExecutor, state: NetworkTeardownState): Promise<void> {
  const owned = (name: string) => state.getProjects().some(p => p.dockerNetwork === name)
    || state.getAllBranches().some(b => branchAppNetworkName(b.id) === name);
  for (const item of state.getNetworkTeardowns()) {
    if (state.getProjects().some(p => p.id === item.projectId)) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(item.name)) continue;
    if (owned(item.name)) {
      state.removeNetworkTeardown(item.name, item.projectId);
      continue;
    }
    const result = await shell.exec(`docker network inspect ${item.name}`, { timeout: 10_000 });
    if (result.exitCode !== 0) {
      if (/No such network|network .* not found/i.test(result.stderr)) state.removeNetworkTeardown(item.name, item.projectId);
      continue;
    }
    let network: { Id?: string; Containers?: Record<string, unknown> };
    try { network = JSON.parse(result.stdout)[0]; } catch { continue; }
    if (!network || !/^[a-f0-9]{12,64}$/.test(network.Id || '') || !network.Containers
      || Object.keys(network.Containers).length || owned(item.name)) continue;
    // Docker 自身也拒绝删除仍带端点的网络，inspect 后接入容器的竞态不会影响业务。
    const removed = await shell.exec(`docker network rm ${network.Id}`, { timeout: 10_000 });
    if (removed.exitCode === 0) state.removeNetworkTeardown(item.name, item.projectId);
  }
}
