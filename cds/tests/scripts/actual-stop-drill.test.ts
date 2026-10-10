import { describe, expect, it } from 'vitest';
import { assertOwnedStopContainer, assertStopCommandTarget, readStopReferenceSource, STOP_PROBE_PROGRAM } from '../../scripts/actual-stop-drill.js';

const owner = 'cds_stop_0123456789abcdef', name = `${owner}-api`;
function container() { return {
  Id: 'a'.repeat(64), Name: `/${name}`,
  Config: { Image: 'node:22-alpine', Labels: { 'cds.acceptance.owner': owner }, Cmd: ['node', '-e', STOP_PROBE_PROGRAM] },
  HostConfig: { NetworkMode: 'bridge', NanoCpus: 250000000, Memory: 134217728, PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1' }] } },
  NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] } },
}; }
describe('真实停止演练资源与命令保护', () => {
  it('完整读取超过默认输出上限的真实基线路由，拒绝其他源文件', () => {
    const bytes = readStopReferenceSource('src/routes/branches.ts');
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
    expect(bytes.toString()).toContain('export function createBranchRouter');
    expect(bytes.toString().trimEnd().endsWith('}')).toBe(true);
    expect(() => readStopReferenceSource('src/index.ts')).toThrow();
  });
  it('接受本次资源完整匹配，停止后保留声明但没有实际发布端口也可清理', () => {
    const target = container(); expect(() => assertOwnedStopContainer(target, owner, name)).not.toThrow();
    target.NetworkSettings.Ports = null as any; expect(() => assertOwnedStopContainer(target, owner, name)).not.toThrow();
  });
  it.each(['owner', 'name', 'image', 'cpu', 'memory', 'command', 'public-port'])('拒绝%s不匹配的容器', (field) => {
    const target = container();
    if (field === 'owner') target.Config.Labels['cds.acceptance.owner'] = 'another-owner';
    if (field === 'name') target.Name = '/shared-container';
    if (field === 'image') target.Config.Image = 'node:latest';
    if (field === 'cpu') target.HostConfig.NanoCpus = 0;
    if (field === 'memory') target.HostConfig.Memory = 0;
    if (field === 'command') target.Config.Cmd[2] = 'other-program';
    if (field === 'public-port') target.HostConfig.PortBindings['3000/tcp'][0].HostIp = '0.0.0.0';
    expect(() => assertOwnedStopContainer(target, owner, name)).toThrow();
  });
  it.each([`docker stop ${name}`, `docker restart ${name}`, `docker inspect '${name}'`, `docker inspect --format="{{.State.Running}}" ${name}`, `docker inspect --format="{{.State.Status}}|{{.State.ExitCode}}" ${name}`, `docker logs --timestamps --tail 500 '${name}'`,
    `docker exec ${name} sh -c "echo '[CDS-STOP] reason=用户手动停止 ts=2026-10-10T19:00:00.000Z' > /proc/1/fd/1 2>/dev/null"`])('允许精确的既有停止调用 %s', (command) => {
    expect(assertStopCommandTarget(command, [name])).toBe(name);
  });
  it.each([`docker stop shared-container`, `docker rm ${name}`, `docker stop ${name}; docker rm shared-container`, `docker inspect '${name}`, `docker inspect ${name}'`,
    `docker exec ${name} sh -c "echo '[CDS-STOP] reason=x; rm x ts=2026-10-10' > /proc/1/fd/1 2>/dev/null"`])('拒绝扩大范围或注入的命令 %s', (command) => {
    expect(() => assertStopCommandTarget(command, [name])).toThrow();
  });
});
