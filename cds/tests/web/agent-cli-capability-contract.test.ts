import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const cliPath = path.resolve(process.cwd(), '../.claude/skills/cds/cli/cdscli.py');
const cliSource = fs.readFileSync(cliPath, 'utf8');

function help(...args: string[]): string {
  const result = spawnSync('python3', [cliPath, ...args, '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

describe('CDS Agent CLI 能力契约', () => {
  it('提供提示词实际引用的认证摘要、Self 状态和环境变量元数据命令', () => {
    expect(help('auth')).toContain('inspect');
    expect(help('auth', 'inspect')).toContain('--strict');
    expect(help('self')).toContain('status');
    expect(help('env', 'get')).toContain('--metadata-only');
    expect(cliSource).toContain('def cmd_auth_inspect');
    expect(cliSource).toContain('def cmd_self_status');
    expect(cliSource).toContain('"/api/self-status"');
  });

  it('认证摘要只输出来源和作用域，不输出密钥值', () => {
    expect(cliSource).toContain('"hasProjectKey": bool(local.get("projectKey"))');
    expect(cliSource).toContain('"hasBootstrapKey": bool(local.get("bootstrapKey"))');
    expect(cliSource).not.toContain('"projectKey": local.get("projectKey")');
    expect(cliSource).not.toContain('"bootstrapKey": local.get("bootstrapKey")');
  });

  it('认证摘要真实执行时不会把环境中的密钥写到输出', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-auth-inspect-'));
    const secret = 'cdsp_contract_secret_must_not_leak';
    try {
      const result = spawnSync('python3', [cliPath, 'auth', 'inspect'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CDS_HOST: 'https://cds.example.test',
          CDS_PROJECT_ID: 'project-contract',
          CDS_PROJECT_KEY: secret,
          AI_ACCESS_KEY: '',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      const payload = JSON.parse(result.stdout);
      expect(payload.data).toMatchObject({
        source: 'explicit-env',
        host: 'https://cds.example.test',
        projectId: 'project-contract',
        keyKind: 'project',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('严格认证摘要在环境与仓库目标冲突时停止且保持脱敏', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-auth-conflict-'));
    const envSecret = 'cdsp_env_secret_must_not_leak';
    const localSecret = 'cdsp_local_secret_must_not_leak';
    try {
      fs.mkdirSync(path.join(tempDir, '.git'));
      fs.mkdirSync(path.join(tempDir, '.cds'));
      fs.writeFileSync(path.join(tempDir, '.cds', 'credentials.json'), JSON.stringify({
        version: 1,
        host: 'https://workspace.example.test',
        projectId: 'workspace-project',
        projectKey: localSecret,
      }));
      const result = spawnSync('python3', [cliPath, 'auth', 'inspect', '--strict'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CDS_HOST: 'https://environment.example.test',
          CDS_PROJECT_ID: 'environment-project',
          CDS_PROJECT_KEY: envSecret,
          AI_ACCESS_KEY: '',
        },
      });
      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain(envSecret);
      expect(result.stdout).not.toContain(localSecret);
      expect(result.stderr).not.toContain(envSecret);
      expect(result.stderr).not.toContain(localSecret);
      const payload = JSON.parse(result.stderr || result.stdout);
      expect(payload.error).toContain('凭据来源冲突');
      expect(payload.credentialSummary.conflicts).toEqual(
        expect.arrayContaining(['host', 'project', 'projectKeySource']),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('技能更新统一处理完整五技能包并保留回滚备份', () => {
    expect(cliSource).toContain(
      'bundle_skills = ["cds", "cds-project-scan", "cds-deploy-pipeline", "cds-release", "preview-url"]',
    );
    expect(cliSource).toContain('cds-bundle-');
    expect(cliSource).toContain('"skillsUpdated": bundle_skills');
    expect(cliSource).toContain('升级失败，已自动回滚');
  });

  it('version 能从导出包约定位置读取完整技能清单', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-version-manifest-'));
    const copiedCli = path.join(tempDir, 'skills', 'cds', 'cli', 'cdscli.py');
    const manifestPath = path.join(tempDir, 'skills', 'cds', 'cli', 'cds-skill-manifest.json');
    const skills = ['cds', 'cds-project-scan', 'cds-deploy-pipeline', 'cds-release', 'preview-url'];
    try {
      fs.mkdirSync(path.dirname(copiedCli), { recursive: true });
      fs.copyFileSync(cliPath, copiedCli);
      fs.writeFileSync(manifestPath, JSON.stringify({ format: 'agent-skills', version: '0.12.0', skills }));
      const result = spawnSync('python3', [copiedCli, 'version'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          CDS_HOST: '',
          CDS_PROJECT_ID: '',
          CDS_PROJECT_KEY: '',
          AI_ACCESS_KEY: '',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.manifest.skills).toEqual(skills);
      expect(payload.data.version).toBe('0.12.0');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
