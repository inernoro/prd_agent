/*
 * 启动时把 CDS 自己插进监控——以代码初始化，不靠任何人手配。
 *
 * 为什么是「内置项目」而不是复用某个现成项目：监控是按项目走的，而 CDS 搬到一台
 * 新机器上时那里可能一个项目都没有。一个 id 固定的内置项目让这套监控在任何一台
 * 机器上都长得一样，也让「删了它下次启动又回来」成为定义好的行为，而不是意外。
 *
 * 端点地址走本机回环 `http://127.0.0.1:<port>`：探测器与 CDS 在同一个进程里，
 * 不经过公网也不依赖域名——迁移到没配 publicBaseUrl 的机器上照样能探。
 *
 * 幂等：项目在就不建，端点插了就不再插。启动时跑一次，多跑无副作用。
 */
import type { Project } from '../types.js';
import { SELF_CHECK_PATH } from './self-check-path.js';

/** 内置项目的固定 id。别的机器上也是它，所以监控 key 跨机器稳定。 */
export const SELF_PROJECT_ID = 'cds-self-monitor';
export const SELF_PROJECT_NAME = 'CDS 自身';

export interface SelfMonitoringState {
  getProjects(): Project[];
  addProject(project: Project): void;
  addMonitorEndpoint(projectId: string, url: string): boolean;
}

export function selfCheckUrl(port: number): string {
  return `http://127.0.0.1:${port}${SELF_CHECK_PATH}`;
}

/** 这条端点是不是内置的那条。前端据此不给它画「拔掉」。 */
export function isSelfCheckEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === SELF_CHECK_PATH && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

export interface SelfMonitoringOutcome {
  projectId: string;
  url: string;
  createdProject: boolean;
  addedEndpoint: boolean;
}

export function ensureSelfMonitoring(state: SelfMonitoringState, port: number, now: number): SelfMonitoringOutcome {
  const url = selfCheckUrl(port);
  const iso = new Date(now).toISOString();
  let createdProject = false;
  if (!state.getProjects().some((p) => p.id === SELF_PROJECT_ID)) {
    state.addProject({
      id: SELF_PROJECT_ID,
      slug: SELF_PROJECT_ID,
      name: SELF_PROJECT_NAME,
      description: 'CDS 用监控自发现协议监控自己：部署 / 构建 / 页面 / 探测器 / 接入 / 宿主 / 通知 / 自身。启动时自动建立，删掉下次启动会回来。',
      kind: 'manual',
      dockerNetwork: SELF_PROJECT_ID,
      legacyFlag: false,
      createdAt: iso,
      updatedAt: iso,
    });
    createdProject = true;
  }
  const before = state.getProjects().find((p) => p.id === SELF_PROJECT_ID)?.monitorEndpoints ?? [];
  const addedEndpoint = !before.includes(url) && state.addMonitorEndpoint(SELF_PROJECT_ID, url);
  return { projectId: SELF_PROJECT_ID, url, createdProject, addedEndpoint };
}
