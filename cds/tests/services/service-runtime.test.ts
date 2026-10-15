import { describe, expect, it } from 'vitest';
import { runtimeRef, servingRuntime, serviceRuntimeRefs } from '../../src/services/service-runtime.js';
import { resolveBranchUpstream } from '../../src/services/proxy.js';
import type { BranchEntry, ServiceState } from '../../src/types.js';

describe('部署入口运行身份', () => {
  it.each(['building', 'starting', 'error', 'running'] as const)('新服务%s时保留同一服务旧入口，不切到新端口或兄弟服务', status => {
    const service: ServiceState = { profileId: 'web', containerName: 'new-web', hostPort: 10002, status,
      servingRuntime: { containerName: 'old-web', hostPort: 10001, deployedImage: 'old@sha256:test' } };
    const branch = { services: { web: service, other: { profileId: 'other', containerName: 'other', hostPort: 10003, status: 'running' } } } as BranchEntry;
    expect(resolveBranchUpstream(branch, 'web')).toBe('http://127.0.0.1:10001');
    delete service.servingRuntime;
    expect(resolveBranchUpstream(branch, 'web')).toBe(status === 'running' ? 'http://127.0.0.1:10002' : null);
  });
  it('主动停止后不复活旧入口，运行身份不复制日志或私有扩展', () => {
    const service: ServiceState = { profileId: 'api', containerName: 'new-api', hostPort: 10002, status: 'stopped', buildLog: 'private log',
      servingRuntime: { containerName: 'old-api', hostPort: 10001 } };
    expect(servingRuntime(service)).toBeNull();
    expect(runtimeRef(service)).not.toHaveProperty('buildLog');
  });
  it('同名身份只列一次，新旧与保留端口都可用于容量及生命周期处理', () => {
    const service: ServiceState = { profileId: 'api', containerName: 'current', hostPort: 10001, status: 'starting',
      pendingRuntime: { containerName: 'pending', hostPort: 10003 }, servingRuntime: { containerName: 'old', hostPort: 10002 },
      retainedRuntimes: [{ containerName: 'old', hostPort: 10002 }] };
    expect(serviceRuntimeRefs(service).map(runtime => runtime.hostPort).sort()).toEqual([10001, 10002, 10003]);
  });
  it('新一轮预留把候选置idle时，已确认旧入口仍可服务；显式停止仍禁用', () => {
    const svc: ServiceState = { profileId: 'api', containerName: 'candidate', hostPort: 10002, status: 'idle',
      servingRuntime: { containerName: 'old', hostPort: 10001, containerId: 'a'.repeat(64) } };
    expect(servingRuntime(svc)?.containerName).toBe('old');
    svc.status = 'stopping'; expect(servingRuntime(svc)).toBeNull();
    svc.status = 'stopped'; expect(servingRuntime(svc)).toBeNull();
  });

});
