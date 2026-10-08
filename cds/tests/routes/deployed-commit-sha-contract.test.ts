/**
 * 部署台账必须记「实际落地的 commit」，不是「被请求的 commit」
 *（Codex PR #1275 四轮 P2）。
 *
 * webhook 带 requestCommitSha=A、而 origin 已前进到 B 时：
 *   - `entry.githubCommitSha` **有意**停在 A（该字段被 check-run / release 复用，
 *     显式请求时不跟随 HEAD）；
 *   - 但 `pull()` 是硬 reset 到分支 HEAD，真正构建并部署的是 B。
 *
 * opLog 早就用 pulledSha 记对了，run 与 DeploymentVersion 却照抄 entry —— 于是
 * 部署审计挂在一份**从未被部署过**的代码上；更糟的是 `findReusable` 也按这个 sha
 * 查，可能把 A 的构建产物复用给 B。
 *
 * 这条链路在 route handler 深处、依赖 worktree/docker/多服务编排，单测无法真实驱动，
 * 因此这里退而做**结构契约守卫**：凡是在 pull 之后写 run / version 的地方，一律不得
 * 再引用 `entry.githubCommitSha`。回归时若有人把它改回去，这条测试会红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../../src/routes/branches.ts', import.meta.url), 'utf8');

/** 取某个锚点之后 span 个字符的片段（用于把断言限定在一个调用块内）。 */
function blockAfter(anchor: string, span = 420): string {
  const i = src.indexOf(anchor);
  expect(i, `找不到锚点: ${anchor.slice(0, 60)}`).toBeGreaterThan(-1);
  return src.slice(i, i + span);
}

describe('部署 run / version 记录实际落地的 SHA', () => {
  it('两条部署路径都算出了 deployedCommitSha', () => {
    // 必须是 let：极速版拉不到镜像时 runService 会自动回退源码编译，那一刻落地的
    // commit 从「镜像锁定的 sha」变成 pull 到的 HEAD，只能事后由回调修正（六轮 P2）。
    expect(src).toContain('let deployedCommitSha = selectedDeploymentVersion?.commitSha');
    expect(src).toContain('deployedCommitSha = isSourcePull ? pulledSha : entry.githubCommitSha;');
    expect(src).toContain('let deployedCommitSha: string | undefined = entry.githubCommitSha;');
  });

  it('自动回退源码编译时，两条路径都会把 deployedCommitSha 改口径（六轮 P2）', () => {
    // 回退发生在 runService 内部（container.ts 的 sourceFallbackProfile 分支），
    // 路由侧只能靠 onSourceCompileFallback 回调得知；不改口径的话，run/version/opLog
    // 会记成镜像锁定的 sha，而实际编译部署的是 worktree HEAD。
    const hooks = src.split('onSourceCompileFallback: async () => {').slice(1);
    expect(hooks.length, '两条部署路径各有一个回退钩子').toBe(2);
    for (const body of hooks) {
      const block = body.slice(0, 600);
      expect(block).toContain('deployedCommitSha =');
      expect(block).toContain('deriveCommitMeta(entry,');
    }
  });

  /*
   * 方案甲（2026-10-08 mdimp）：两条部署路径都要把刚 pull 到的提交传给 runService，
   * 让极速版先试它的 CI 镜像；用上了就把记录改成那个提交。删掉任一处接线，容器层的
   * 单测照样全绿，只是线上又回到「按旧提交找镜像 → 回退宿主编译」——所以在这里钉住。
   */
  it('两条部署路径都把 pull 到的提交传给极速版，用上了就改记录（方案甲）', () => {
    const passes = src.split('latestCommitSha: ').slice(1).filter((body) => !body.startsWith('options.'));
    expect(passes.length, '整分支部署与单服务部署各传一次').toBe(2);
    // 显式点名提交时不改目标：整分支看 requestCommitSha，单服务看 profileRequestCommitSha
    expect(passes[0].slice(0, 200)).toContain('!requestCommitSha');
    expect(passes[1].slice(0, 200)).toContain('profileRequestCommitSha ? undefined');
    const hooks = src.split('onLatestCommitImage: (sha) => {').slice(1);
    expect(hooks.length).toBe(2);
    for (const body of hooks) {
      const block = body.slice(0, 300);
      expect(block).toContain('deployedCommitSha = sha;');
      expect(block).toContain('deriveCommitMeta(entry, sha)');
    }
    expect(src).toContain('latestCommitSha: options.latestCommitSha,');
    expect(src).toContain('onLatestCommitImage: options.onLatestCommitImage,');
  });

  const runAnchors = [
    "advanceDeploymentRun(deploymentRun?.id, 'building', {\n        phase: 'build',\n        message: selectedDeploymentVersion",
    "advanceDeploymentRun(deploymentRun?.id, 'building', {\n        phase: 'build',\n        message: `源码准备完成，开始构建 ${profile.name}`",
    "advanceDeploymentRun(deploymentRun?.id, 'verifying', {\n        phase: 'ready',",
    "advanceDeploymentRun(deploymentRun?.id, 'running', {\n          phase: 'complete',\n          message: smokeOk",
    "advanceDeploymentRun(deploymentRun?.id, 'running', {\n          phase: 'complete',\n          message: `${profile.name} 部署完成并通过就绪检查`",
  ];

  it('pull 之后的每个 run 状态流转都用 deployedCommitSha', () => {
    for (const anchor of runAnchors) {
      const block = blockAfter(anchor);
      expect(block, anchor.slice(0, 50)).toContain('commitSha: deployedCommitSha,');
      expect(block, anchor.slice(0, 50)).not.toContain('commitSha: entry.githubCommitSha,');
    }
  });

  const versionAnchors = [
    // 只针对 **pull 之后** 那次复用查找（8 空格缩进）。pull 之前还有一次按
    // requestCommitSha 查找不可变版本的路径，那是「用户点名要 A 的产物」的另一种
    // 语义，本就该用 requestCommitSha，不在本契约范围内。
    '        const reusable = deploymentVersionService.findReusable({',
    'selectedDeploymentVersion = deploymentVersionService.create({',
    'const version = deploymentVersionService.create({',
  ];

  it('不可变版本的查找与创建同样用 deployedCommitSha（否则会把 A 的产物复用给 B）', () => {
    for (const anchor of versionAnchors) {
      const block = blockAfter(anchor);
      expect(block, anchor.slice(0, 50)).toContain('commitSha: deployedCommitSha,');
      expect(block, anchor.slice(0, 50)).not.toContain('commitSha: entry.githubCommitSha,');
    }
  });
});
