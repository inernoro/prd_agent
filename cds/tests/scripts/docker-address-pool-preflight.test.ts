import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'cds/scripts/docker-address-pool-preflight.sh');

let tmpDir = '';
let originalPath = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-docker-preflight-'));
  originalPath = process.env.PATH || '';
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFakeDocker(body: string): void {
  const dockerPath = path.join(tmpDir, 'docker');
  fs.writeFileSync(dockerPath, body, { mode: 0o755 });
}

function runPreflight(extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${tmpDir}:${originalPath}`,
      ...extraEnv,
    },
  });
}

describe('docker-address-pool-preflight.sh', () => {
  it('默认模式下未配置 default-address-pools 只警告不阻断安装', () => {
    writeFakeDocker(`#!/usr/bin/env bash
if [ "$1" = "info" ] && [ "$2" = "--format" ]; then echo "[]"; exit 0; fi
if [ "$1" = "info" ]; then echo "Server Version: fake"; exit 0; fi
if [ "$1" = "network" ] && [ "$2" = "ls" ]; then
  echo "bridge"
  echo "cds-br-one"
  exit 0
fi
exit 1
`);

    const result = runPreflight();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('未检测到 Docker default-address-pools');
    expect(result.stderr).toContain('default-address-pools');
    expect(result.stdout).toContain('Docker bridge 网络数: 2');
  });

  it('strict 模式下网络数进入高风险区会失败', () => {
    const networks = Array.from({ length: 28 }, (_, index) => `cds-br-${index}`).join('\\n');
    writeFakeDocker(`#!/usr/bin/env bash
if [ "$1" = "info" ] && [ "$2" = "--format" ]; then echo "[]"; exit 0; fi
if [ "$1" = "info" ]; then echo "Server Version: fake"; exit 0; fi
if [ "$1" = "network" ] && [ "$2" = "ls" ]; then
  printf "${networks}\\n"
  exit 0
fi
exit 1
`);

    const result = runPreflight({ CDS_DOCKER_POOL_PREFLIGHT_STRICT: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('接近默认地址池经验上限');
  });

  it('检测到 default-address-pools 时通过并不打印扩容模板', () => {
    writeFakeDocker(`#!/usr/bin/env bash
if [ "$1" = "info" ] && [ "$2" = "--format" ]; then echo '[{"Base":"10.240.0.0/16","Size":24}]'; exit 0; fi
if [ "$1" = "info" ]; then echo "Server Version: fake"; exit 0; fi
if [ "$1" = "network" ] && [ "$2" = "ls" ]; then
  echo "bridge"
  exit 0
fi
exit 1
`);

    const result = runPreflight({ CDS_DOCKER_POOL_PREFLIGHT_STRICT: '1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Docker 地址池预检通过');
    expect(result.stderr).not.toContain('建议在 Docker daemon 中配置');
  });
});
