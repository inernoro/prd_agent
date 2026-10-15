import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { admittedArtifactProfile, inspectDeploymentArtifacts, verifyArtifactAdmission } from '../../src/services/artifact-admission.js';
import { proveFallbackImage } from '../../src/services/prebuilt-reuse.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BuildProfile } from '../../src/types.js';
import { branchVersionFacts } from '../../src/services/running-version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const target = 'b'.repeat(40);
const actualRevision = 'a'.repeat(40);
const repository = 'ghcr.io/owned/api';
const primary = `${repository}:sha-${target}`;
const fallback = `${repository}:branch-main`;
const contentId = `sha256:${'c'.repeat(64)}`;
const fixedImage = `${repository}@${contentId}`;

describe('增量 CI 与完整产物准入的复用契约', () => {
  it('真实工作流对只改 admin 的 feature 提交跳过未变组件，不保证全部目标 SHA 镜像存在', () => {
    const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows/branch-image.yml'), 'utf8')) as {
      jobs: Record<string, { if?: string }>;
    };
    const inputs = {
      needs: { changes: { outputs: { api: 'false', admin: 'true', llmgw: 'false', llmgw_web: 'false',
        llmgw_serve: 'false', design_opendesign: 'false', same_as_main: 'false' } } },
      github: { ref: 'refs/heads/codex/only-admin-changed', event_name: 'push' },
    };
    const scheduled = ['api-image', 'admin-image', 'llmgw-image', 'llmgw-web-image',
      'llmgw-serve-image', 'design-opendesign-image'].filter(jobId => {
      const condition = workflow.jobs[jobId]?.if;
      expect(condition, `工作流缺少 ${jobId} 条件`).toBeTruthy();
      // 执行仓库真实的有限 job 条件，不在测试里复制一份“哪些组件要构建”的判据。
      const expression = condition!.replace(/^\s*\$\{\{\s*/, '').replace(/\s*\}\}\s*$/, '');
      return vm.runInNewContext(expression, inputs, { timeout: 100 });
    });
    expect(scheduled).toEqual(['admin-image']);
  });

  it('未变组件应在准入前复用已证明等价的固定内容，并保留镜像真实 revision', async () => {
    const shell = new MockShellExecutor();
    const profile: BuildProfile = { id: 'api', name: 'API', dockerImage: primary, fallbackImage: [fallback],
      buildScope: ['prd-api/**', '.github/workflows/branch-image.yml'], workDir: '.', command: '',
      containerPort: 8080, prebuiltImage: true };
    const comparisons: unknown[][] = [];
    const isComponentUnchangedSince = async (...args: [string, string, readonly string[]]) => {
      comparisons.push(args);
      return true;
    };
    shell.addResponsePattern(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }),
      stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/docker pull (.+)/, match => match[1].includes(primary)
      ? { stdout: '', stderr: 'manifest unknown', exitCode: 1 }
      : { stdout: 'pulled', stderr: '', exitCode: 0 });
    shell.addResponsePattern(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: contentId,
      RepoDigests: [fixedImage], Os: 'linux', Architecture: 'amd64',
      Config: { Labels: { 'org.opencontainers.image.revision': actualRevision } } }]), stderr: '', exitCode: 0 }));

    // 现成的等价证明零件已经接受该输入；完整准入不能在尝试它之前永久等待缺失的主镜像。
    await expect(proveFallbackImage({ revision: actualRevision, targetSha: target, buildScope: profile.buildScope,
      isComponentUnchangedSince })).resolves.toMatchObject({ accepted: true, reason: 'component-unchanged' });
    comparisons.length = 0;
    const options = { inspectLocalArtifacts: false, isComponentUnchangedSince };
    const admission = await inspectDeploymentArtifacts(shell, [profile], target, () => {}, options);
    expect(admission.state).toBe('ready');
    expect(comparisons).toEqual([[actualRevision, target, profile.buildScope]]);
    expect(admission).toMatchObject({ targetCommitSha: target, artifacts: [{ profileIds: ['api'],
      requestedImage: primary, image: fixedImage, revision: actualRevision, platform: 'linux/amd64' }] });
    const runtime = admittedArtifactProfile(profile, admission);
    expect(runtime.dockerImage).toBe(`${repository}:sha-${actualRevision}@${contentId}`);
    expect(runtime.dockerImage).not.toContain(`:sha-${target}@`);
    const rechecked = await inspectDeploymentArtifacts(shell, [runtime], target, () => {}, {
      inspectLocalArtifacts: true, isComponentUnchangedSince });
    expect(rechecked).toMatchObject({ state: 'ready', targetCommitSha: target, artifacts: [{ revision: actualRevision }] });
    expect(admittedArtifactProfile({ ...runtime, localArtifact: false }, rechecked).dockerImage).toBe(runtime.dockerImage);
    expect(branchVersionFacts({ githubCommitSha: target, services: {
      api: { profileId: 'api', status: 'running', deployedImage: runtime.dockerImage },
    } } as any)).toEqual({ runningCommitSha: actualRevision, targetCommitSha: target });
    expect(shell.commands.some(command => /docker (run|rm|create)|git worktree|database/.test(command))).toBe(false);
  });

  function reusable() {
    const shell = new MockShellExecutor();
    const profile: BuildProfile = { id: 'api', name: 'API', dockerImage: primary, fallbackImage: [fallback],
      buildScope: ['prd-api/**', '.github/workflows/branch-image.yml'], workDir: '.', command: '', containerPort: 8080, prebuiltImage: true };
    shell.addResponsePattern(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/docker pull (.+)/, match => ({ stdout: '', stderr: match[1].includes(primary) ? 'manifest unknown' : '',
      exitCode: match[1].includes(primary) ? 1 : 0 }));
    shell.addResponsePattern(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: contentId, RepoDigests: [fixedImage],
      Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': actualRevision } } }]), stderr: '', exitCode: 0 }));
    return { shell, profile };
  }

  it.each(['unauthorized: authentication required', 'TLS handshake timeout', 'Cannot connect to Docker daemon'])
  ('主目标%s不是明确缺失，不尝试回退', async stderr => {
    const { shell, profile } = reusable();
    shell.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr, exitCode: 1 }));
    const result = await inspectDeploymentArtifacts(shell, [profile], target, () => {}, { isComponentUnchangedSince: async () => true });
    expect(result.state).toBe('waiting');
    expect(shell.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(1);
  });

  it('主目标存在但OCI版本错误时不能借等价证明跳过精确目标身份检查', async () => {
    const { shell, profile } = reusable(); let compared = 0;
    shell.addResponsePatternFirst(/docker pull/, () => ({ stdout: 'present', stderr: '', exitCode: 0 }));
    expect(await inspectDeploymentArtifacts(shell, [profile], target, () => {}, {
      isComponentUnchangedSince: async () => { compared++; return true; },
    })).toMatchObject({ state: 'waiting', reason: 'revision-mismatch', artifacts: [] });
    expect(compared).toBe(0);
    expect(shell.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(1);
  });

  it('配置中跨仓库候选不被拉取，不能用另一服务产物填补缺失目标', async () => {
    const { shell, profile } = reusable(); profile.fallbackImage = ['ghcr.io/foreign/api:branch-main'];
    expect(await inspectDeploymentArtifacts(shell, [profile], target, () => {}, { isComponentUnchangedSince: async () => true }))
      .toMatchObject({ state: 'waiting', reason: 'missing', artifacts: [] });
    expect(shell.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(1);
  });

  it.each(['scope', 'history', 'changed', 'comparator'] as const)('缺%s不能证明旧产物适用于目标', async missing => {
    const { shell, profile } = reusable(); if (missing === 'scope') profile.buildScope = undefined;
    const result = await inspectDeploymentArtifacts(shell, [profile], target, () => {}, {
      isComponentUnchangedSince: missing === 'comparator' ? undefined : async () => {
        if (missing === 'history') throw new Error('history missing'); return false;
      } });
    expect(result).toMatchObject({ state: 'waiting', reason: 'revision-mismatch', artifacts: [] });
  });

  it('回退镜像平台错误不能借等价证明绕过或继续别的候选', async () => {
    const { shell, profile } = reusable(); profile.fallbackImage = [fallback, `${repository}:branch-other`];
    shell.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: contentId, RepoDigests: [fixedImage],
      Os: 'linux', Architecture: 'arm64', Config: { Labels: { 'org.opencontainers.image.revision': actualRevision } } }]), stderr: '', exitCode: 0 }));
    expect(await inspectDeploymentArtifacts(shell, [profile], target, () => {}, { isComponentUnchangedSince: async () => true }))
      .toMatchObject({ state: 'waiting', reason: 'platform-mismatch', artifacts: [] });
    expect(shell.commands.some(command => command.includes('branch-other'))).toBe(false);
  });

  it('Master对远端等价proof独立比较完整范围，不接受布尔或缩窄scope', async () => {
    const { shell, profile } = reusable();
    const admission = await inspectDeploymentArtifacts(shell, [profile], target, () => {}, { isComponentUnchangedSince: async () => true });
    let compared = 0;
    expect(await verifyArtifactAdmission([profile], target, admission, async (from, to, scope) => {
      compared++; expect([from, to, scope]).toEqual([actualRevision, target, profile.buildScope]); return true;
    }, () => {})).toBe(true);
    expect(compared).toBe(1);
    expect(await verifyArtifactAdmission([profile], target, admission, async () => false, () => {})).toBe(false);
    const fake = structuredClone(admission); delete fake.artifacts[0].proof;
    Object.assign(fake.artifacts[0], { accepted: true });
    expect(await verifyArtifactAdmission([profile], target, fake, async () => true, () => {})).toBe(false);
    fake.artifacts[0].proof = { kind: 'component-unchanged', buildScope: ['prd-api/only-one-file.cs'] };
    expect(await verifyArtifactAdmission([profile], target, fake, async () => true, () => {})).toBe(false);
  });

  it('相同镜像的不同角色逐个证明其完整scope，不能借第一个角色放行', async () => {
    const { shell, profile } = reusable(); const second = { ...profile, id: 'second', buildScope: ['llmgw/**'] };
    expect(await inspectDeploymentArtifacts(shell, [profile, second], target, () => {}, {
      isComponentUnchangedSince: async (_from, _to, scope) => scope[0] === 'prd-api/**',
    })).toMatchObject({ state: 'waiting', profileIds: ['second'], artifacts: [] });
    expect(shell.commands.filter(command => command.includes('docker pull'))).toHaveLength(2);
  });

  it('比较完成后的旧资格不能发布ready', async () => {
    const { shell, profile } = reusable(); let current = true;
    await expect(inspectDeploymentArtifacts(shell, [profile], target, () => { if (!current) throw new Error('superseded'); }, {
      isComponentUnchangedSince: async () => { current = false; return true; },
    })).rejects.toThrow('superseded');
  });
});
