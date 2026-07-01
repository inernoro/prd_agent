import type { IShellExecutor } from '../types.js';

export type DockerNetworkRiskLevel = 'ok' | 'warn' | 'critical';
export type DockerBranchNetworkStatus = 'empty' | 'stopped-only' | 'running' | 'unknown';

export interface DockerNetworkHealthSummary {
  ok: true;
  timestamp: string;
  counts: {
    totalDockerNetworks: number;
    branchNetworks: number;
    projectNetworks: number;
    emptyBranchNetworks: number;
    stoppedOnlyBranchNetworks: number;
    runningBranchNetworks: number;
    unknownBranchNetworks: number;
    stoppedOnlyContainers: number;
  };
  softLimit: {
    userDefinedBridgeNetworks: number;
    source: string;
  };
  risk: {
    level: DockerNetworkRiskLevel;
    title: string;
    message: string;
  };
  cleanupCandidates: {
    empty: string[];
    stoppedOnly: Array<{ name: string; containers: number }>;
  };
  runningNetworks: string[];
  unknownNetworks: string[];
  suggestedDaemonJson: {
    defaultAddressPools: Array<{ base: string; size: number }>;
    note: string;
  };
}

export interface DockerNetworkHealthFailure {
  ok: false;
  timestamp: string;
  error: string;
}

export type DockerNetworkHealthResult = DockerNetworkHealthSummary | DockerNetworkHealthFailure;

interface NetworkInspection {
  name: string;
  status: DockerBranchNetworkStatus;
  containerIds: string[];
  stoppedContainers: number;
}

const DEFAULT_BRIDGE_SOFT_LIMIT = 30;

export class DockerNetworkHealthService {
  constructor(private readonly shell: IShellExecutor) {}

  async collect(): Promise<DockerNetworkHealthResult> {
    const timestamp = new Date().toISOString();
    const listed = await this.shell.exec("docker network ls --format '{{.Name}}'", { timeout: 10_000 });
    if (listed.exitCode !== 0) {
      return {
        ok: false,
        timestamp,
        error: trimError(listed.stderr || listed.stdout || 'docker network ls failed'),
      };
    }

    const names = splitLines(listed.stdout);
    const branchNetworks = names.filter((name) => name.startsWith('cds-br-')).sort();
    const projectNetworks = names.filter((name) => name.startsWith('cds-proj-')).sort();
    const inspections = await Promise.all(branchNetworks.map((name) => this.inspectBranchNetwork(name)));

    const empty = inspections.filter((item) => item.status === 'empty').map((item) => item.name);
    const stoppedOnly = inspections
      .filter((item) => item.status === 'stopped-only')
      .map((item) => ({ name: item.name, containers: item.containerIds.length }));
    const runningNetworks = inspections.filter((item) => item.status === 'running').map((item) => item.name);
    const unknownNetworks = inspections.filter((item) => item.status === 'unknown').map((item) => item.name);
    const stoppedOnlyContainers = inspections.reduce((sum, item) => sum + item.stoppedContainers, 0);

    const cleanupCount = empty.length + stoppedOnly.length;
    const risk = computeRisk(branchNetworks.length, cleanupCount);

    return {
      ok: true,
      timestamp,
      counts: {
        totalDockerNetworks: names.length,
        branchNetworks: branchNetworks.length,
        projectNetworks: projectNetworks.length,
        emptyBranchNetworks: empty.length,
        stoppedOnlyBranchNetworks: stoppedOnly.length,
        runningBranchNetworks: runningNetworks.length,
        unknownBranchNetworks: unknownNetworks.length,
        stoppedOnlyContainers,
      },
      softLimit: {
        userDefinedBridgeNetworks: DEFAULT_BRIDGE_SOFT_LIMIT,
        source: 'Docker 默认本地地址池的经验阈值；精确容量以 daemon.json default-address-pools 为准。',
      },
      risk,
      cleanupCandidates: { empty, stoppedOnly },
      runningNetworks,
      unknownNetworks,
      suggestedDaemonJson: {
        defaultAddressPools: [
          { base: '10.240.0.0/16', size: 24 },
          { base: '10.241.0.0/16', size: 24 },
        ],
        note: '示例配置。应用前必须确认不与宿主机、VPN、内网路由冲突；修改 daemon.json 后需要重启 Docker，会中断当前容器。',
      },
    };
  }

  private async inspectBranchNetwork(name: string): Promise<NetworkInspection> {
    const inspected = await this.shell.exec(
      `docker network inspect --format='{{json .Containers}}' ${shellQuote(name)}`,
      { timeout: 10_000 },
    );
    if (inspected.exitCode !== 0) {
      return { name, status: 'unknown', containerIds: [], stoppedContainers: 0 };
    }

    const containerIds = parseContainerIds(inspected.stdout);
    if (containerIds.length === 0) {
      return { name, status: 'empty', containerIds, stoppedContainers: 0 };
    }

    const states = await this.inspectContainerStates(containerIds);
    if (states.length === 0 || states.some((state) => state === 'unknown')) {
      return { name, status: 'unknown', containerIds, stoppedContainers: 0 };
    }
    if (states.some((state) => state === 'running')) {
      return {
        name,
        status: 'running',
        containerIds,
        stoppedContainers: states.filter((state) => state === 'stopped').length,
      };
    }
    return {
      name,
      status: 'stopped-only',
      containerIds,
      stoppedContainers: states.length,
    };
  }

  private async inspectContainerStates(containerIds: string[]): Promise<Array<'running' | 'stopped' | 'unknown'>> {
    const inspected = await this.shell.exec(
      `docker inspect --format='{{.Id}} {{.State.Running}}' ${containerIds.map(shellQuote).join(' ')}`,
      { timeout: 10_000 },
    );
    if (inspected.exitCode !== 0) return containerIds.map(() => 'unknown');
    const lines = splitLines(inspected.stdout);
    if (lines.length === 0) return containerIds.map(() => 'unknown');
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      const running = parts[parts.length - 1];
      if (running === 'true') return 'running';
      if (running === 'false') return 'stopped';
      return 'unknown';
    });
  }
}

function parseContainerIds(raw: string): string[] {
  const text = raw.trim();
  if (!text || text === '{}' || text === 'null') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.keys(parsed as Record<string, unknown>).filter(Boolean);
  } catch {
    return [];
  }
}

function computeRisk(branchNetworkCount: number, cleanupCandidateCount: number): DockerNetworkHealthSummary['risk'] {
  if (branchNetworkCount >= 28 || (branchNetworkCount >= 24 && cleanupCandidateCount > 0)) {
    return {
      level: 'critical',
      title: '接近 Docker 默认地址池上限',
      message: '分支网络数量已经进入高风险区，下一次部署可能再次触发 address pools exhausted。先清理空闲分支网络，再安排低峰扩容 Docker default-address-pools。',
    };
  }
  if (branchNetworkCount >= 20) {
    return {
      level: 'warn',
      title: '分支网络数量偏高',
      message: '当前还未到硬失败区，但继续增加分支预览会持续消耗 Docker bridge 子网。建议清理已停止分支，并准备地址池扩容窗口。',
    };
  }
  return {
    level: 'ok',
    title: 'Docker 分支网络容量正常',
    message: '当前分支网络数量低于默认地址池经验阈值。继续保留分支级隔离，避免跨分支 DNS 串流。',
  };
}

function splitLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function trimError(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
