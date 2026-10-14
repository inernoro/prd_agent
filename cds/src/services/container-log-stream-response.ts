import type { Request, Response } from 'express';
import type { ContainerService } from './container.js';
import type { StateService } from './state.js';
import type { BranchEntry, ServiceState } from '../types.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { normalizeLogText } from './server-event-log-store.js';
import { maskSecrets } from './secret-masker.js';
import { BoundedLogTail } from './bounded-log-tail.js';
import { BoundedSseWriter } from './bounded-sse-writer.js';

/** 路由完成鉴权和分支/服务资格校验之后，按同一有界链路发送和归档日志。 */
export function serveContainerLogStream(req: Request, res: Response, deps: {
  containerService: ContainerService; stateService: StateService; branch: BranchEntry; service: ServiceState;
  mask: boolean; serverEventLogStore?: ServerEventLogSink | null;
}): void {
  const { branch, service } = deps;
  const tail = new BoundedLogTail();
  let handle: AbortController | undefined; let archived = false;
  const archive = (): void => {
    if (archived) return; archived = true;
    if (!tail.getStats().retainedBytes) { tail.clear(); return; }
    const logs = maskSecrets(tail.text(), { mask: deps.mask });
    tail.clear();
    try {
      deps.stateService.appendContainerLogArchive(branch.id, {
        projectId: branch.projectId, profileId: service.profileId, containerName: service.containerName,
        hostPort: service.hostPort, status: service.status, source: 'container-logs-stream', masked: deps.mask, logs,
      });
      deps.serverEventLogStore?.record({
        category: 'container', severity: 'info', source: 'container-logs-stream', action: 'container.logs.stream-closed',
        message: `container log stream closed for ${service.containerName}`, projectId: branch.projectId, branchId: branch.id,
        profileId: service.profileId, containerName: service.containerName, status: service.status,
        logs: normalizeLogText(logs, 200), details: { masked: deps.mask, hostPort: service.hostPort },
      });
      deps.stateService.save();
    } catch {
      try { deps.serverEventLogStore?.record({ category: 'container', severity: 'warn', source: 'container-logs-stream', action: 'container.logs.archive-failed', message: '日志尾部保存未确认，请查看容器日志并稍后重试。', branchId: branch.id, projectId: branch.projectId }); } catch { /* 响应收尾不因诊断存储异常中断 */ }
    }
  };
  const writer = new BoundedSseWriter(res, reason => {
    handle?.abort(); archive();
    try { deps.serverEventLogStore?.record({ category: 'container', severity: 'warn', source: 'container-logs-stream', action: 'container.logs.stream-backpressure', message: reason, branchId: branch.id, projectId: branch.projectId }); } catch { /* 丢弃慢连接不阻止其他查看者 */ }
  });
  // 响应关闭才是SSE查看者离开；请求body读完不能作为断开证据。
  res.on('close', () => { writer.dispose(); handle?.abort(); archive(); });
  res.flushHeaders?.();
  handle = deps.containerService.streamLogs(service.containerName, chunk => {
    tail.append(chunk); return writer.send('log', { chunk });
  }, result => {
    archive();
    if (result && result.reason !== 'closed') {
      const message = result.reason === 'capacity' ? '日志读取容量暂满，请稍后重新打开日志。'
        : result.reason === 'cleanup' ? '日志读取清理尚未确认，请稍后重试并查看诊断。' : '日志读取暂不可用，请稍后重新打开日志。';
      writer.send('log', { chunk: `${message}\n` }); writer.send('error', { message });
    }
    writer.end();
  }, 200, JSON.stringify([branch.projectId || '', branch.id, service.profileId]));
  if (res.destroyed || res.writableEnded) handle.abort();
}
