import { describe, it, expect, beforeEach } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';

/**
 * waitForReadiness 容器活性早退（2026-07-16 队列堵死复盘）：
 * 部署期就绪探测下限可达 1200s，而探测期间调用方持着全局构建槽。容器早已
 * 崩溃却让槽位空等到超时，是 build-gate 吞吐被拖垮的病理路径之一。
 * 传 containerName 时每 ~5 轮探测 docker inspect 一次，连续两次 exited/dead/
 * 消失 → 立即 return false；不传 containerName 时行为与旧版一致。
 *
 * 探测目标端口用 127.0.0.1 的未监听端口（连接被拒，快速失败），时间由
 * probe.intervalSeconds=1 驱动，测试整体秒级。
 */

const makeConfig = (): CdsConfig => ({
  repoRoot: '/repo',
  worktreeBase: '/wt',
  masterPort: 9900,
  workerPort: 5500,
  dockerNetwork: 'cds-network',
  portStart: 10001,
  sharedEnv: {},
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
});

// 大概率无人监听的高位端口（连接立即 ECONNREFUSED）
const DEAD_PORT = 59321;
const CONTAINER = 'cds-test-liveness';
const INSPECT_RE = /^docker inspect --format="\{\{\.State\.Status\}\}\|\{\{\.State\.ExitCode\}\}" cds-test-liveness$/;

describe('waitForReadiness 容器活性早退', () => {
  let mock: MockShellExecutor;
  let service: ContainerService;

  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new ContainerService(mock, makeConfig());
  });

  it('连续两次 inspect 到 exited → 提前返回 false 并附崩溃日志', async () => {
    mock.addResponsePattern(INSPECT_RE, () => ({ stdout: 'exited|137', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/^docker logs/, () => ({ stdout: 'boom: OOMKilled', stderr: '', exitCode: 0 }));

    const output: string[] = [];
    const startedAt = Date.now();
    const ready = await service.waitForReadiness(
      DEAD_PORT,
      { noHttp: true, intervalSeconds: 1, timeoutSeconds: 20 },
      undefined,
      (chunk) => output.push(chunk),
      CONTAINER,
    );
    const elapsed = Date.now() - startedAt;

    expect(ready).toBe(false);
    // 第 10 轮（第二次 inspect）即退出，远早于 20s 超时
    expect(elapsed).toBeLessThan(16_000);
    expect(output.join('')).toContain('提前终止就绪等待');
    expect(output.join('')).toContain('boom: OOMKilled');
    expect(mock.commands.filter((c) => INSPECT_RE.test(c)).length).toBe(2);
  }, 30_000);

  it('单次 exited 抖动后恢复 running → 不早退，继续探测到超时', async () => {
    let inspectCalls = 0;
    mock.addResponsePattern(INSPECT_RE, () => {
      inspectCalls += 1;
      return inspectCalls === 1
        ? { stdout: 'exited|1', stderr: '', exitCode: 0 }
        : { stdout: 'running|0', stderr: '', exitCode: 0 };
    });

    const ready = await service.waitForReadiness(
      DEAD_PORT,
      { noHttp: true, intervalSeconds: 1, timeoutSeconds: 11 },
      undefined,
      undefined,
      CONTAINER,
    );

    expect(ready).toBe(false); // 端口始终没起来，最终按超时失败
    expect(inspectCalls).toBeGreaterThanOrEqual(2); // 复核过且未早退
  }, 30_000);

  it('不传 containerName → 完全不 inspect，行为与旧版一致', async () => {
    const ready = await service.waitForReadiness(
      DEAD_PORT,
      { noHttp: true, intervalSeconds: 1, timeoutSeconds: 3 },
    );
    expect(ready).toBe(false);
    expect(mock.commands.some((c) => c.startsWith('docker inspect'))).toBe(false);
  }, 30_000);
});
