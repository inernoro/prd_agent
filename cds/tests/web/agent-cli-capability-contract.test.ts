import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const cliPath = path.resolve(process.cwd(), '../.claude/skills/cds/cli/cdscli.py');
const cliSource = fs.readFileSync(cliPath, 'utf8');
const cliVersion = cliSource.match(/^VERSION\s*=\s*["']([^"']+)["']/m)?.[1];

function help(...args: string[]): string {
  const result = spawnSync('python3', [cliPath, ...args, '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

describe('CDS Agent CLI 能力契约', () => {
  it('MongoDB CLI 绑定项目、数据库和结构化输入，待批退出 3，拒绝错库和任意动作', () => {
    expect(help('db', 'mongo-write')).toContain('--input-file');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mongo-cli-'));
    const input = path.join(dir, 'write.json');
    const script = `
import importlib.util, sys
spec=importlib.util.spec_from_file_location('cli',sys.argv[1]); cli=importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
def call(method,path,body=None,**kwargs):
 if path.startswith('/api/branches/'):
  return {'branch':{'projectId':'p1'}}
 assert path=='/api/cds-system/operator/request'
 assert body=={'opId':'database.mongo','args':{'projectId':'p1','branchId':'b1','resourceId':'infra:mongo','write':{'database':'qa','action':'insertOne','collection':'items','document':{'_id':'qa1'}}}}
 return {'request':{'id':'mongo1','opId':'database.mongo','status':'pending'}}
cli._call=call
sys.argv=['cdscli','db','mongo-write','b1','infra:mongo','--project','p1','--database','qa','--input-file',sys.argv[2]]
cli.main()
`;
    const run = () => spawnSync('python3', ['-c', script, cliPath, input], { encoding: 'utf8', env: { ...process.env, CDS_HOST: 'https://cds.example.test', CDS_PROJECT_KEY: 'cdsp_contract_secret', AI_ACCESS_KEY: '', CDS_PROJECT_ID: '' } });
    try {
      fs.writeFileSync(input, JSON.stringify({ database: 'qa', action: 'insertOne', collection: 'items', document: { _id: 'qa1' } }));
      const pending = run(); expect(pending.status, pending.stderr).toBe(3); expect(JSON.parse(pending.stdout).data.status).toBe('pending');
      fs.writeFileSync(input, JSON.stringify({ database: 'other', action: 'insertOne' })); expect(run().status).toBe(2);
      fs.writeFileSync(input, JSON.stringify({ action: 'eval' })); expect(run().status).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('数据库 CLI 生成项目绑定的具体 SQL 待批请求，不能把待批准报告成执行完成', () => {
    expect(help('db')).toContain('execute');
    expect(help('db', 'execute')).toContain('--sql-file');
    const script = `
import importlib.util, sys, json
spec=importlib.util.spec_from_file_location('cli',sys.argv[1]); cli=importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
def call(method,path,body=None,**kwargs):
 if path.startswith('/api/branches/'):
  return {'branch':{'projectId':'p1'}}
 assert method=='POST' and path=='/api/cds-system/operator/request'
 assert body=={'opId':'database.sql','args':{'projectId':'p1','branchId':'b1','resourceId':'infra:mysql','sql':'UPDATE sample SET n=1; UPDATE sample SET n=2'}}
 return {'request':{'id':'request1','opId':'database.sql','status':'pending'}}
cli._call=call
sys.argv=['cdscli','db','execute','b1','infra:mysql','--project',sys.argv[2],'--sql','UPDATE sample SET n=1; UPDATE sample SET n=2']
cli.main()
`;
    const env = { ...process.env, CDS_HOST: 'https://cds.example.test', CDS_PROJECT_KEY: 'cdsp_contract_secret', AI_ACCESS_KEY: '', CDS_PROJECT_ID: '' };
    const pending = spawnSync('python3', ['-c', script, cliPath, 'p1'], { encoding: 'utf8', env });
    expect(pending.status, pending.stderr).toBe(3);
    expect(JSON.parse(pending.stdout).data.status).toBe('pending');
    expect(pending.stdout).not.toContain('cdsp_contract_secret');
    const mismatch = spawnSync('python3', ['-c', script, cliPath, 'p2'], { encoding: 'utf8', env });
    expect(mismatch.status).toBe(2);
    expect(JSON.parse(mismatch.stdout).error).toContain('分支不属于指定项目');
  });

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
    expect(cliVersion).toBeTruthy();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-version-manifest-'));
    const copiedCli = path.join(tempDir, 'skills', 'cds', 'cli', 'cdscli.py');
    const manifestPath = path.join(tempDir, 'skills', 'cds', 'cli', 'cds-skill-manifest.json');
    const skills = ['cds', 'cds-project-scan', 'cds-deploy-pipeline', 'cds-release', 'preview-url'];
    try {
      fs.mkdirSync(path.dirname(copiedCli), { recursive: true });
      fs.copyFileSync(cliPath, copiedCli);
      fs.writeFileSync(manifestPath, JSON.stringify({ format: 'agent-skills', version: cliVersion, skills }));
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
      expect(payload.data.version).toBe(cliVersion);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
