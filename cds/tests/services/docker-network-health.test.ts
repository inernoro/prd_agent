import { describe, expect, it } from 'vitest';
import { DockerNetworkHealthService } from '../../src/services/docker-network-health.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

describe('DockerNetworkHealthService', () => {
  it('统计分支网络状态并识别可清理候选', async () => {
    const mock = new MockShellExecutor();
    mock.addResponsePattern(/docker network ls --format '\{\{\.Name\}\}'/, () => ({
      stdout: [
        'bridge',
        'cds-br-empty',
        'cds-br-stopped',
        'cds-br-running',
        'cds-proj-prd-agent',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-empty'/, () => ({
      stdout: '{}\n',
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-stopped'/, () => ({
      stdout: JSON.stringify({ stopped1: { Name: 'stopped-one' }, stopped2: { Name: 'stopped-two' } }),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-running'/, () => ({
      stdout: JSON.stringify({ running1: { Name: 'running-one' }, stopped3: { Name: 'stopped-three' } }),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'stopped1' 'stopped2'/, () => ({
      stdout: 'stopped1 false\nstopped2 false\n',
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'running1' 'stopped3'/, () => ({
      stdout: 'running1 true\nstopped3 false\n',
      stderr: '',
      exitCode: 0,
    }));

    const result = await new DockerNetworkHealthService(mock).collect();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.counts.branchNetworks).toBe(3);
    expect(result.counts.projectNetworks).toBe(1);
    expect(result.counts.emptyBranchNetworks).toBe(1);
    expect(result.counts.stoppedOnlyBranchNetworks).toBe(1);
    expect(result.counts.runningBranchNetworks).toBe(1);
    expect(result.counts.stoppedOnlyContainers).toBe(3);
    expect(result.cleanupCandidates.empty).toEqual(['cds-br-empty']);
    expect(result.cleanupCandidates.stoppedOnly).toEqual([{ name: 'cds-br-stopped', containers: 2 }]);
    expect(result.runningNetworks).toEqual(['cds-br-running']);
    expect(result.risk.level).toBe('ok');
  });

  it('网络数量接近默认地址池时返回 critical 风险', async () => {
    const mock = new MockShellExecutor();
    const names = Array.from({ length: 28 }, (_, idx) => `cds-br-${idx}`);
    mock.addResponsePattern(/docker network ls --format '\{\{\.Name\}\}'/, () => ({
      stdout: names.join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-\d+'/,
      () => ({ stdout: '{}\n', stderr: '', exitCode: 0 }));

    const result = await new DockerNetworkHealthService(mock).collect();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.counts.branchNetworks).toBe(28);
    expect(result.risk.level).toBe('critical');
    expect(result.cleanupCandidates.empty).toHaveLength(28);
  });

  it('docker network ls 失败时返回可读错误', async () => {
    const mock = new MockShellExecutor();
    mock.addResponsePattern(/docker network ls --format '\{\{\.Name\}\}'/, () => ({
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      exitCode: 1,
    }));

    const result = await new DockerNetworkHealthService(mock).collect();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('Cannot connect');
  });
});
