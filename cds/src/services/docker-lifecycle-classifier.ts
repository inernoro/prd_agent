import type { ContainerLifecycleIntent } from './container-diagnostics.js';

export interface DockerLifecycleEventForClassification {
  action: string;
  containerName?: string;
  status?: string;
  exitCode?: number;
  oomKilled?: boolean;
  attrs: Record<string, string>;
  lifecycleIntent?: ContainerLifecycleIntent;
}

export interface DockerLifecycleClassification {
  source: 'crash' | 'system' | 'cds' | 'external' | 'oom';
  nextServiceStatus: 'error' | 'stopped';
  nextBranchStatus: 'error' | 'idle';
  reason: string;
  stopClass: string;
  unexpected: boolean;
}

export function classifyDockerLifecycleEvent(
  event: DockerLifecycleEventForClassification,
): DockerLifecycleClassification {
  const action = String(event.action || '').toLowerCase();
  const exitCode = Number.isFinite(event.exitCode) ? event.exitCode : undefined;
  const exitText = exitCode !== undefined ? ` exitCode=${exitCode}` : '';
  const oom = event.oomKilled ? ' OOMKilled=true' : '';
  const actor = event.attrs?.signal ? ` signal=${event.attrs.signal}` : '';
  const name = event.containerName || 'unknown-container';
  const intent = event.lifecycleIntent;
  const intentMeta = intent
    ? [
        intent.operation ? `operation=${intent.operation}` : '',
        intent.source ? `source=${intent.source}` : '',
        intent.requestId ? `requestId=${intent.requestId}` : '',
        intent.actor ? `actor=${intent.actor}` : '',
        intent.trigger ? `trigger=${intent.trigger}` : '',
      ].filter(Boolean).join(' ')
    : '';
  const intentText = intent
    ? `；已匹配 CDS 意图 ${intent.kind}：${intent.reason}${intentMeta ? `（${intentMeta}）` : ''}`
    : '';
  if (event.oomKilled || action === 'oom') {
    return {
      source: 'oom',
      nextServiceStatus: 'error',
      nextBranchStatus: 'error',
      reason: `容器被 OOM killer 杀死：${name}${exitText}${oom}`,
      stopClass: 'oom-kill',
      unexpected: true,
    };
  }
  if (intent) {
    return {
      source: 'cds',
      nextServiceStatus: 'stopped',
      nextBranchStatus: 'idle',
      reason: `CDS 生命周期操作导致容器停止：${name}${exitText}${actor}${intentText}`,
      stopClass: intent.kind,
      unexpected: false,
    };
  }
  if (action === 'die') {
    const normalExit = exitCode === 0 || exitCode === 143;
    const sigkill = exitCode === 137;
    return {
      source: normalExit ? 'system' : sigkill ? 'external' : 'crash',
      nextServiceStatus: normalExit ? 'stopped' : 'error',
      nextBranchStatus: normalExit ? 'idle' : 'error',
      reason: sigkill
        ? `容器收到 SIGKILL 后退出，但没有 OOMKilled 证据：${name}${exitText}${actor}；需对照 docker kill/stop/rm 事件和 CDS 意图判断来源`
        : `Docker die 事件：${name}${exitText}${oom}${actor}`,
      stopClass: normalExit ? 'normal-exit' : sigkill ? 'sigkill-no-oom-evidence' : 'process-exit-error',
      unexpected: !normalExit,
    };
  }
  if (action === 'kill') {
    return {
      source: 'external',
      nextServiceStatus: 'error',
      nextBranchStatus: 'error',
      reason: `容器被 docker kill/SIGKILL，但没有匹配到 CDS 停止/删除/重部署意图：${name}${exitText}${actor}`,
      stopClass: 'external-docker-kill',
      unexpected: true,
    };
  }
  return {
    source: 'system',
    nextServiceStatus: 'stopped',
    nextBranchStatus: 'idle',
    reason: `容器被 Docker destroy/remove：${name}${exitText}${oom}`,
    stopClass: 'docker-destroy-remove',
    unexpected: false,
  };
}
