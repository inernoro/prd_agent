#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = resolve(repoRoot, '.claude/skills/stable-smoke/reference/credential-registry.json');

export function classifyPreflightBlockers(blockers) {
  return {
    gatewayIdentityBlockers: blockers.filter((item) => item.includes('模型网关') && item.includes('身份')),
    deploymentBlockers: blockers.filter((item) => /提交|镜像|部署调度/.test(item)),
    productIdentityBlockers: blockers.filter((item) => item.includes('主应用') && item.includes('身份')),
  };
}

function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--json')) {
    process.stderr.write('仅支持 --json；该命令只输出脱敏诊断结果。\n');
    process.exitCode = 2;
    return;
  }

  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const runId = `auth-health-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const preflight = spawnSync('node', [
    'scripts/stable-smoke-run.mjs',
    '--preflight',
    '--cds-only',
    '--run-id', runId,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });

  const bindings = (registry.localBindings || [])
    .filter((item) => item.state !== 'deprecated')
    .map((item) => ({
      id: item.envKey,
      source: item.keychainService ? 'keychain' : 'registry',
      declaredState: item.state,
    }));
  const cdsHealthy = preflight.status === 0;
  const blockers = String(preflight.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2))
    .slice(0, 20);
  const {
    gatewayIdentityBlockers,
    deploymentBlockers,
    productIdentityBlockers,
  } = classifyPreflightBlockers(blockers);
  const result = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    verdict: cdsHealthy ? 'healthy' : 'blocked',
    secretPolicy: 'no-secret-values-or-fingerprints',
    checks: [
      {
        id: 'credential-registry',
        status: bindings.every((item) => item.declaredState === 'verified' || item.declaredState === 'active' || item.declaredState === 'provisioned')
          ? 'healthy'
          : 'conditional',
        summary: `${bindings.length} 项非废弃凭据绑定已纳入登记。`,
        recovery: '将 planned 或 degraded 项恢复并完成真实回读后更新登记状态。',
      },
      {
        id: 'cds-product-identity',
        status: productIdentityBlockers.length === 0 ? 'healthy' : 'blocked',
        summary: productIdentityBlockers.length === 0
          ? 'CDS 产品自动化身份预检已通过。'
          : 'CDS 产品自动化身份预检未通过。',
        recovery: productIdentityBlockers.length === 0
          ? '继续执行合成登录与业务回读。'
          : '同步 RSA 签名私钥、Key ID、服务端公钥与专用账号后按原路径复测。',
        blockers: productIdentityBlockers,
      },
      {
        id: 'llmgw-automation-identity',
        status: gatewayIdentityBlockers.length === 0 ? 'healthy' : 'blocked',
        summary: gatewayIdentityBlockers.length === 0
          ? 'LLMGW 自动化身份预检已通过。'
          : 'LLMGW 自动化身份预检未通过。',
        recovery: gatewayIdentityBlockers.length === 0
          ? '继续执行最小模型调用回读。'
          : '恢复 LLMGW 自动化账号授权并重新登录验证。',
        blockers: gatewayIdentityBlockers,
      },
      {
        id: 'cds-deployment-revision',
        status: deploymentBlockers.length === 0 ? 'healthy' : 'blocked',
        summary: deploymentBlockers.length === 0
          ? 'CDS 当前运行版本与本地目标一致。'
          : 'CDS 当前运行版本尚未同步到本地目标提交。',
        recovery: deploymentBlockers.length === 0
          ? '继续执行 CORE-009 可控 401 故障注入。'
          : '提交并推送后等待 CDS 镜像与全部运行服务切换到固定提交。',
        blockers: deploymentBlockers,
      },
    ],
    bindings,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!cdsHealthy) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
