import { describe, expect, it } from 'vitest';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { admittedArtifactProfile, inspectDeploymentArtifacts } from '../../src/services/artifact-admission.js';
import type { BuildProfile } from '../../src/types.js';

const target = 'b'.repeat(40);
const image = `ghcr.io/owned/worker:sha-${target}`;
const id = `sha256:${'c'.repeat(64)}`;
const digest = `ghcr.io/owned/worker@${id}`;
const profile = (role: string): BuildProfile => ({ id: role, name: role, dockerImage: image, workDir: '.', command: '',
  containerPort: 3000, prebuiltImage: true });
function fixture() {
  const shell = new MockShellExecutor();
  shell.addResponsePattern(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'x86_64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker pull/, () => ({ stdout: 'pulled', stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: id, RepoDigests: [digest], Os: 'linux', Architecture: 'amd64',
    Config: { Labels: { 'org.opencontainers.image.revision': target } } }]), stderr: '', exitCode: 0 }));
  return shell;
}

describe('完整预构建产物准入', () => {
  it('共用镜像的四个逻辑角色只核验一次，并以固定内容启动而不保留源码回退', async () => {
    const shell = fixture(); const roles = ['generation', 'code-return', 'product-batch', 'common'];
    const result = await inspectDeploymentArtifacts(shell, roles.map(profile), target);
    expect(result.state).toBe('ready'); expect(result.artifacts[0].profileIds).toEqual(roles);
    expect(shell.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(1);
    expect(shell.commands.filter(command => command.startsWith('docker image inspect'))).toHaveLength(1);
    const original = { ...profile('common'), fallbackImage: 'old:tag', sourceFallbackProfile: { ...profile('source'), command: 'build', prebuiltImage: false } };
    expect(admittedArtifactProfile(original, result)).toMatchObject({ dockerImage: digest, localArtifact: true, fallbackImage: undefined, sourceFallbackProfile: undefined });
    expect(original.dockerImage).toBe(image); expect(original.fallbackImage).toBe('old:tag');
  });

  it('最后一个必需镜像不存在时，整轮保持等待而不发布部分准入', async () => {
    const shell = fixture();
    shell.addResponsePatternFirst(/docker pull .*web/, () => ({ stdout: '', stderr: 'manifest unknown', exitCode: 1 }));
    const result = await inspectDeploymentArtifacts(shell, [profile('api'), { ...profile('web'), dockerImage: `ghcr.io/owned/web:sha-${target}` }], target);
    expect(result).toMatchObject({ state: 'waiting', reason: 'missing', profileIds: ['web'], artifacts: [] });
    expect(shell.commands.some(command => /docker (run|rm)|database|network create/.test(command))).toBe(false);
  });

  it.each([
    ['unauthorized: authentication required', 'access-denied'],
    ['denied: requested access to the resource is denied', 'access-denied'],
    ['manifest unknown', 'missing'],
    ['TLS handshake timeout', 'verification-unavailable'],
  ])('拉取失败%s与其他原因区分', async (stderr, reason) => {
    const shell = fixture(); shell.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr, exitCode: 1 }));
    expect(await inspectDeploymentArtifacts(shell, [profile('api')], target)).toMatchObject({ state: 'waiting', reason });
  });

  it.each([
    [{ Id: id, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': 'a'.repeat(40) } } }, 'revision-mismatch'],
    [{ Id: id, Os: 'linux', Architecture: 'arm64', Config: { Labels: { 'org.opencontainers.image.revision': target } } }, 'platform-mismatch'],
    [{ Id: 'mutable-reference', Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': target } } }, 'verification-unavailable'],
  ])('镜像标签可拉取仍不能代替实际revision/平台/固定内容核验', async (metadata, reason) => {
    const shell = fixture(); shell.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([metadata]), stderr: '', exitCode: 0 }));
    expect(await inspectDeploymentArtifacts(shell, [profile('api')], target)).toMatchObject({ state: 'waiting', reason });
  });

  it('执行器本地产物策略也核验提交、平台和内容ID，不依赖RepoDigest或local标记猜版本', async () => {
    const shell = fixture(); shell.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: id, Os: 'linux', Architecture: 'amd64',
      Config: { Labels: { 'org.opencontainers.image.revision': target } } }]), stderr: '', exitCode: 0 }));
    const result = await inspectDeploymentArtifacts(shell, [{ ...profile('api'), localArtifact: true }], target, () => {}, { inspectLocalArtifacts: true });
    expect(result).toMatchObject({ state: 'ready', artifacts: [{ image: id, revision: target, platform: 'linux/amd64' }] });
    expect(shell.commands.filter(cmd => cmd.startsWith('docker pull '))).toEqual([]);
  });

  it('短提交或未展开镜像保持未知，不去拉旧目标镜像', async () => {
    const shell = fixture();
    expect(await inspectDeploymentArtifacts(shell, [profile('api')], 'abc1234')).toMatchObject({ state: 'waiting', reason: 'target-unresolved' });
    expect(await inspectDeploymentArtifacts(shell, [{ ...profile('api'), dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}' }], target))
      .toMatchObject({ state: 'waiting', reason: 'image-unresolved' });
    expect(shell.commands).toEqual([]);
  });

  it('命令结束后资格已失效，不能返回ready或猜成普通等待', async () => {
    const shell = fixture(); let current = true;
    shell.addResponsePatternFirst(/docker pull/, () => { current = false; return { stdout: '', stderr: '', exitCode: 0 }; });
    await expect(inspectDeploymentArtifacts(shell, [profile('api')], target, () => { if (!current) throw new Error('superseded'); })).rejects.toThrow('superseded');
    expect(shell.commands.filter(command => command.startsWith('docker image inspect'))).toHaveLength(0);
  });
});
