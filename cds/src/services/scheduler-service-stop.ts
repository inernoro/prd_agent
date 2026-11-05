import type { ServiceState } from '../types.js';
import type { ContainerService } from './container.js';
import { serviceRuntimeRefs } from './service-runtime.js';

/** 停止失败恢复原状态并让降温重试；成功确认后才能释放实际驻留盘点。 */
export async function stopServiceForCooling(options: {
  service: ServiceState;
  container: Pick<ContainerService, 'stopRuntimeGroup'>;
  context: Parameters<ContainerService['stopRuntimeGroup']>[2];
  assertCurrent?: () => void;
  confirmedStopped?: (names: string[]) => void;
}): Promise<void> {
  const { service, container, context, assertCurrent } = options;
  const previous = service.status;
  const names = serviceRuntimeRefs(service).map(runtime => runtime.containerName);
  assertCurrent?.();
  service.status = 'stopping';
  try {
    await container.stopRuntimeGroup(service, '调度器降温（保留容器，可秒级唤醒）', context);
    assertCurrent?.();
  } catch (error) {
    let current = true;
    try { assertCurrent?.(); } catch { current = false; }
    if (current && service.status === 'stopping') service.status = previous;
    throw error;
  }
  service.status = 'stopped';
  options.confirmedStopped?.(names);
}
