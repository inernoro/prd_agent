import { describe, expect, it } from 'vitest';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import {
  cleanupUnusedBranchNetworks,
  ensureDockerNetworkWithReclaim,
  isDockerNetworkAddressPoolExhausted,
} from '../../src/services/docker-network-reclaim.js';

describe('docker network reclaim', () => {
  it('detects Docker default address pool exhaustion', () => {
    expect(isDockerNetworkAddressPoolExhausted({
      stdout: '',
      stderr: 'Error response from daemon: all predefined address pools have been fully subnetted',
      exitCode: 1,
    })).toBe(true);
    expect(isDockerNetworkAddressPoolExhausted({ stdout: '', stderr: 'No such network', exitCode: 1 })).toBe(false);
  });

  it('reclaims unused branch networks and retries project network creation', async () => {
    const shell = new MockShellExecutor();
    let createAttempts = 0;

    shell.addResponsePattern(/^docker network inspect cds-proj-prd-agent$/, () => ({
      stdout: '',
      stderr: 'No such network',
      exitCode: 1,
    }));
    shell.addResponsePattern(/^docker network create cds-proj-prd-agent$/, () => {
      createAttempts += 1;
      if (createAttempts === 1) {
        return {
          stdout: '',
          stderr: 'Error response from daemon: all predefined address pools have been fully subnetted',
          exitCode: 1,
        };
      }
      return { stdout: 'network-id', stderr: '', exitCode: 0 };
    });
    shell.addResponsePattern(/docker network ls --format '\{\{\.Name\}\}'/, () => ({
      stdout: ['cds-br-empty', 'cds-br-stopped', 'cds-br-running', 'cds-proj-prd-agent'].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-empty'/, () => ({
      stdout: '{}',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-stopped'/, () => ({
      stdout: JSON.stringify({ stoppedcid: { Name: 'stopped' } }),
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-running'/, () => ({
      stdout: JSON.stringify({ runningcid: { Name: 'running' } }),
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'stoppedcid'/, () => ({
      stdout: 'stoppedcid false\n',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'runningcid'/, () => ({
      stdout: 'runningcid true\n',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network disconnect -f 'cds-br-stopped' 'stoppedcid'/, () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network rm 'cds-br-empty'/, () => ({ stdout: 'cds-br-empty', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/docker network rm 'cds-br-stopped'/, () => ({ stdout: 'cds-br-stopped', stderr: '', exitCode: 0 }));

    await ensureDockerNetworkWithReclaim(shell, 'cds-proj-prd-agent');

    expect(createAttempts).toBe(2);
    expect(shell.commands.some((cmd) => cmd.includes("docker network rm 'cds-br-empty'"))).toBe(true);
    expect(shell.commands.some((cmd) => cmd.includes("docker network disconnect -f 'cds-br-stopped' 'stoppedcid'"))).toBe(true);
    expect(shell.commands.some((cmd) => cmd.includes("docker network rm 'cds-br-stopped'"))).toBe(true);
    expect(shell.commands.some((cmd) => cmd.includes("docker network rm 'cds-br-running'"))).toBe(false);
    expect(shell.commands.some((cmd) => cmd.includes('docker network rm cds-proj-prd-agent'))).toBe(false);
  });

  it('reports cleanup counts for empty and stopped-only branch networks', async () => {
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker network ls --format '\{\{\.Name\}\}'/, () => ({
      stdout: ['bridge', 'cds-br-empty', 'cds-br-stopped', 'cds-br-running'].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-empty'/, () => ({
      stdout: '{}',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-stopped'/, () => ({
      stdout: JSON.stringify({ stoppedcid: { Name: 'stopped' } }),
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-running'/, () => ({
      stdout: JSON.stringify({ runningcid: { Name: 'running' } }),
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'stoppedcid'/, () => ({
      stdout: 'stoppedcid false\n',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'runningcid'/, () => ({
      stdout: 'runningcid true\n',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network disconnect -f 'cds-br-stopped' 'stoppedcid'/, () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));
    shell.addResponsePattern(/docker network rm 'cds-br-empty'/, () => ({ stdout: 'cds-br-empty', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/docker network rm 'cds-br-stopped'/, () => ({ stdout: 'cds-br-stopped', stderr: '', exitCode: 0 }));

    await expect(cleanupUnusedBranchNetworks(shell)).resolves.toEqual({
      inspected: 3,
      removed: 2,
      detached: 1,
    });
  });
});
