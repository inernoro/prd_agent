import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { ContainerService, applyProfileOverride, resolveEffectiveProfile } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, BranchEntry, BuildProfile, BuildProfileOverride, ServiceState } from '../../src/types.js';

const makeConfig = (): CdsConfig => ({
  repoRoot: '/repo',
  worktreeBase: '/wt',
  masterPort: 9900,
  workerPort: 5500,
  dockerNetwork: 'cds-network',
  portStart: 10001,
  sharedEnv: {
    MONGODB_HOST: 'db:27017',
    REDIS_HOST: 'redis:6379',
  },
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
});

const makeEntry = (): BranchEntry => ({
  id: 'feature-a',
  branch: 'feature/a',
  worktreePath: '/wt/feature-a',
  services: {},
  status: 'idle',
  createdAt: '2026-02-12T00:00:00Z',
});

const makeProfile = (overrides?: Partial<BuildProfile>): BuildProfile => ({
  id: 'api',
  name: 'API',
  dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
  workDir: 'prd-api',
  command: 'dotnet restore && dotnet watch run',
  containerPort: 8080,
  ...overrides,
});

const makeService = (): ServiceState => ({
  profileId: 'api',
  containerName: 'cds-feature-a-api',
  hostPort: 10001,
  status: 'building',
});

describe('ContainerService', () => {
  let mock: MockShellExecutor;
  let service: ContainerService;

  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new ContainerService(mock, makeConfig());
  });

  describe('runService', () => {
    // waitForContainerAlive polls with real setTimeout delays (5×3s).
    // Stub it out for tests that don't specifically test health-check behavior.
    let aliveStub: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    });
    afterEach(() => { aliveStub?.mockRestore(); });

    it('should run docker container with correct mounts and env', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));

      // Spy on writeFileSync to capture the env file content
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      await service.runService({
        ...makeEntry(),
        githubCommitSha: '47c74c1f5aabbccddeeff0011223344556677889',
      }, makeProfile(), makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'));
      expect(runCmd).toBeDefined();
      expect(runCmd).toContain('--name cds-feature-a-api');
      expect(runCmd).toContain('--network cds-network');
      expect(runCmd).toContain('-p 10001:8080');
      expect(runCmd).toContain('-v "/wt/feature-a/prd-api":"/app"');
      expect(runCmd).toContain('--env-file');
      expect(runCmd).toContain('dotnet restore && dotnet watch run');

      // Should have CDS labels
      expect(runCmd).toContain('--label cds.managed=true');
      expect(runCmd).toContain('--label cds.type=app');
      expect(runCmd).toContain('--label cds.branch.id=feature-a');
      expect(runCmd).toContain('--label cds.profile.id=api');

      // Verify env file contents
      const envFileContent = writeSpy.mock.calls[0][1] as string;
      expect(envFileContent).toContain('Jwt__Secret=test-secret');
      expect(envFileContent).toContain('Jwt__Issuer=prdagent');
      expect(envFileContent).toContain('VITE_GIT_BRANCH=feature/a');
      expect(envFileContent).toContain('VITE_BUILD_ID=47c74c1f5aab');

      writeSpy.mockRestore();
    });

    it('project customEnv Jwt__Secret takes precedence over CDS global secret', async () => {
      // 跨项目穿透回归（2026-06-12）：换 CDS_JWT_SECRET 不得再覆盖
      // 显式配置了 Jwt__Secret 的项目容器
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid456', stderr: '', exitCode: 0 }));
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      await service.runService(
        makeEntry(), makeProfile(), makeService(),
        undefined, { Jwt__Secret: 'project-pinned-secret', OTHER: 'x' });

      const envFileContent = writeSpy.mock.calls[0][1] as string;
      expect(envFileContent).toContain('Jwt__Secret=project-pinned-secret');
      expect(envFileContent).not.toContain('Jwt__Secret=test-secret');
      // 未显式配置 Issuer 仍走全局兜底
      expect(envFileContent).toContain('Jwt__Issuer=prdagent');

      writeSpy.mockRestore();
    });

    it('records operationId on pre-run cleanup and docker run events', async () => {
      const records: Array<{ action: string; operationId?: string | null; details?: Record<string, unknown> }> = [];
      service = new ContainerService(mock, makeConfig(), undefined, {
        record(record) {
          records.push({ action: record.action, operationId: record.operationId, details: record.details });
        },
      });
      aliveStub?.mockRestore();
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));

      await service.runService({ ...makeEntry(), projectId: 'default' }, makeProfile(), makeService(), undefined, undefined, {
        requestId: 'req-123',
        operationId: 'op-123',
        actor: 'ai',
        trigger: 'manual',
      });

      expect(records.find((record) => record.action === 'app.pre-run-rm')?.operationId).toBe('op-123');
      expect(records.find((record) => record.action === 'app.run.started')?.operationId).toBe('op-123');
      expect(records.find((record) => record.action === 'app.pre-run-rm')?.details?.actor).toBe('ai');
      expect(records.find((record) => record.action === 'app.pre-run-rm')?.details?.trigger).toBe('manual');
    });

    it('should remove stale same branch/profile app containers before attaching service aliases', async () => {
      const records: Array<{
        action: string;
        projectId?: string | null;
        branchId?: string | null;
        profileId?: string | null;
        operationId?: string | null;
        details?: Record<string, unknown>;
      }> = [];
      service = new ContainerService(mock, makeConfig(), undefined, {
        record(record) {
          records.push({
            action: record.action,
            projectId: record.projectId,
            branchId: record.branchId,
            profileId: record.profileId,
            operationId: record.operationId,
            details: record.details,
          });
        },
      });
      aliveStub?.mockRestore();
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker ps -a --filter "label=cds\.managed=true" --filter "label=cds\.type=app"/, () => ({
        stdout: [
          'cds-feature-a-api',
          'cds-feature-a-api-old',
          'cds-other-branch-api',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker inspect --format=.*cds-feature-a-api-old/, () => ({
        stdout: 'feature-a|api|["api"]',
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker inspect --format=.*cds-other-branch-api/, () => ({
        stdout: 'feature-b|api|["api"]',
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));

      await service.runService({ ...makeEntry(), projectId: 'default' }, makeProfile(), makeService(), undefined, undefined, {
        requestId: 'req-stale',
        operationId: 'op-stale',
        actor: 'system:webhook',
        trigger: 'webhook',
      });

      const rmCommands = mock.commands.filter(c => c.includes('docker rm -f'));
      expect(rmCommands.some(c => c.includes("'cds-feature-a-api-old'"))).toBe(true);
      expect(rmCommands.some(c => c.includes("'cds-other-branch-api'"))).toBe(false);
      expect(rmCommands.some(c => c.includes('docker rm -f cds-feature-a-api'))).toBe(true);
      const staleRmIndex = mock.commands.findIndex(c => c.includes("docker rm -f 'cds-feature-a-api-old'"));
      const currentRmIndex = mock.commands.findIndex(c => c.includes('docker rm -f cds-feature-a-api'));
      expect(staleRmIndex).toBeGreaterThanOrEqual(0);
      expect(currentRmIndex).toBeGreaterThan(staleRmIndex);
      const staleRecord = records.find((record) => record.action === 'app.stale-alias-rm');
      expect(staleRecord?.projectId).toBe('default');
      expect(staleRecord?.branchId).toBe('feature-a');
      expect(staleRecord?.profileId).toBe('api');
      expect(staleRecord?.operationId).toBe('op-stale');
      expect(staleRecord?.details?.trigger).toBe('webhook');
    });

    it('should remove unlabeled stale network endpoints only for the same service container prefix', async () => {
      mock.addResponsePattern(/docker ps -aq --filter 'network=cds-network'/, () => ({
        stdout: ['stale-id', 'other-branch-id', 'current-id'].join('\n'),
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker inspect --format=.*stale-id/, () => ({
        stdout: 'stale-id|/cds-feature-a-api-stale|["api","cds-feature-a-api-stale"]',
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker inspect --format=.*other-branch-id/, () => ({
        stdout: 'other-branch-id|/cds-feature-b-api-stale|["api","cds-feature-b-api-stale"]',
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker inspect --format=.*current-id/, () => ({
        stdout: 'current-id|/cds-feature-a-api|["api","cds-feature-a-api"]',
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker network inspect --format=.*cds-network/, () => ({
        stdout: JSON.stringify({
          stale: {
            Name: 'cds-feature-a-api-stale',
            Aliases: ['api', 'cds-feature-a-api-stale'],
          },
          otherBranch: {
            Name: 'cds-feature-b-api-stale',
            Aliases: ['api', 'cds-feature-b-api-stale'],
          },
          current: {
            Name: 'cds-feature-a-api',
            Aliases: ['api', 'cds-feature-a-api'],
          },
        }),
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker ps -a --filter "label=cds\.managed=true" --filter "label=cds\.type=app"/, () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));

      await service.runService(makeEntry(), makeProfile(), makeService());

      const rmCommands = mock.commands.filter(c => c.includes('docker rm -f'));
      expect(rmCommands.some(c => c.includes("'stale-id'"))).toBe(true);
      expect(rmCommands.some(c => c.includes("'other-branch-id'"))).toBe(false);
      const staleRmIndex = mock.commands.findIndex(c => c.includes("docker rm -f 'stale-id'"));
      const currentRmIndex = mock.commands.findIndex(c => c.includes('docker rm -f cds-feature-a-api'));
      expect(staleRmIndex).toBeGreaterThanOrEqual(0);
      expect(currentRmIndex).toBeGreaterThan(staleRmIndex);
    });

    it('should run a single docker command (no 3-step)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        command: 'pnpm install && pnpm build && pnpm start',
        cacheMounts: [{ hostPath: '/cache/node_modules', containerPath: '/app/node_modules' }],
      });

      await service.runService(makeEntry(), profile, makeService());

      // Should have exactly 1 docker run call (persistent container)
      const dockerRuns = mock.commands.filter(c => c.includes('docker run'));
      expect(dockerRuns).toHaveLength(1);
      expect(dockerRuns[0]).toContain('docker run -d');
      expect(dockerRuns[0]).toContain('pnpm install && pnpm build && pnpm start');
    });

    it('should mount shared caches', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        cacheMounts: [
          { hostPath: '/cache/nuget', containerPath: '/root/.nuget' },
        ],
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'));
      expect(runCmd).toContain('-v "/cache/nuget":"/root/.nuget"');
    });

    // ── Phase 2 cgroup resource limits ──

    // 2026-05-06 用户授权"每个容器都不限制内存,尽情释放" — 不再下发
    // --memory / --memory-swap docker 运行时硬限。memoryMB 字段保留作
    // capacity 调度规划提示(capacityMessage 用),但不进 docker run。
    it('should NOT apply --memory / --memory-swap even when memoryMB is set (no-mem-limit policy)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        resources: { memoryMB: 512 },
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--memory');
      expect(runCmd).not.toContain('--memory-swap');
    });

    // 2026-05-28 用户授权"关闭所有容器资源限制" — 不再下发 --cpus 也不再下发
    // --memory。cpus / memoryMB 字段保留作 capacity 调度规划提示,不进 docker run。
    it('should NOT apply --cpus even when cpus is set (no-cpu-limit policy)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        resources: { cpus: 1.5 },
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--cpus');
    });

    it('should drop both --memory AND --cpus when both are set (no-resource-limit policy)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        resources: { memoryMB: 1024, cpus: 2 },
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--memory');
      expect(runCmd).not.toContain('--cpus');
    });

    it('should emit NO resource flags when resources is unset (backward compat)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      await service.runService(makeEntry(), makeProfile(), makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--memory');
      expect(runCmd).not.toContain('--cpus');
    });

    it('should ignore zero/negative resource values', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        resources: { memoryMB: 0, cpus: -1 },
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--memory');
      expect(runCmd).not.toContain('--cpus');
    });

    it('should throw if docker run fails', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: '', stderr: 'port in use', exitCode: 125 }));

      await expect(service.runService(makeEntry(), makeProfile(), makeService())).rejects.toThrow('启动服务');
    });

    it('should throw if command is missing', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const profile = makeProfile({ command: undefined });
      await expect(service.runService(makeEntry(), profile, makeService())).rejects.toThrow('缺少 command 字段');
    });
  });

  describe('stop (pause — container preserved)', () => {
    it('writes a [CDS-STOP] sentinel then docker stop, and does NOT docker rm', async () => {
      mock.addResponsePattern(/docker exec/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.stop('cds-feature-a-api', '调度器降温（保留容器，可秒级唤醒）');

      // 哨兵先写,进入 docker logs 末尾 → 与莫名崩溃区分
      const sentinelCommand = mock.commands.find((c) => c.includes('docker exec cds-feature-a-api') && c.includes('[CDS-STOP]')) ?? '';
      expect(sentinelCommand).not.toBe('');
      expect(sentinelCommand).toContain('[CDS-STOP]');
      // Bugbot #640：全角括号/逗号必须保留(U+FF00–FFEF 在白名单内),
      // 否则 docker logs 里 reason 丢失可读结构。
      expect(sentinelCommand).toContain('reason=调度器降温（保留容器，可秒级唤醒）');
      // Bugbot #640：单引号包裹 line(单引号已被白名单排除),不再依赖
      // "过滤双引号/$"来做 shell 转义。命令形如 sh -c "echo '...' > ..."。
      expect(sentinelCommand).toContain(`sh -c "echo '[CDS-STOP]`);
      expect(sentinelCommand).not.toContain(`sh -c 'echo "`);
      expect(mock.commands.some((c) => c === 'docker stop cds-feature-a-api')).toBe(true);
      // 关键不变量:stop 绝不 docker rm,否则 /restart 无法 docker restart
      // 唤醒(Cursor Bugbot 反馈的"正常停止后重启必失败"的根因)。
      expect(mock.commands.some((c) => /docker rm(\s|$)/.test(c))).toBe(false);
    });

    it('still stops when the sentinel exec fails (best-effort, no shell in image)', async () => {
      mock.addResponsePattern(/docker exec/, () => ({ stdout: '', stderr: 'no sh', exitCode: 1 }));
      mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await expect(service.stop('cds-feature-a-api')).resolves.toBeUndefined();
      expect(mock.commands.some((c) => c === 'docker stop cds-feature-a-api')).toBe(true);
      expect(mock.commands.some((c) => /docker rm(\s|$)/.test(c))).toBe(false);
    });

    it('records operationId and branch identity on stop events', async () => {
      const records: Array<{
        action: string;
        projectId?: string | null;
        branchId?: string | null;
        profileId?: string | null;
        operationId?: string | null;
        details?: Record<string, unknown>;
      }> = [];
      service = new ContainerService(mock, makeConfig(), undefined, {
        record(record) {
          records.push({
            action: record.action,
            projectId: record.projectId,
            branchId: record.branchId,
            profileId: record.profileId,
            operationId: record.operationId,
            details: record.details,
          });
        },
      });
      mock.addResponsePattern(/docker exec/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.stop('cds-feature-a-api', '用户手动停止', {
        projectId: 'default',
        branchId: 'feature-a',
        profileId: 'api',
        requestId: 'req-stop',
        operationId: 'op-stop',
        actor: 'user:1',
        trigger: 'manual',
        operation: 'branch-stop',
        source: 'api.stop-branch',
      });

      expect(records.find((record) => record.action === 'container.stop.requested')?.operationId).toBe('op-stop');
      expect(records.find((record) => record.action === 'container.stop.completed')?.operationId).toBe('op-stop');
      expect(records.find((record) => record.action === 'container.stop.requested')?.branchId).toBe('feature-a');
      expect(records.find((record) => record.action === 'container.stop.requested')?.profileId).toBe('api');
      expect(records.find((record) => record.action === 'container.stop.requested')?.details?.operation).toBe('branch-stop');
    });
  });

  describe('restartServiceInPlace', () => {
    it('records operationId on docker restart events', async () => {
      const records: Array<{ action: string; operationId?: string | null; branchId?: string | null; details?: Record<string, unknown> }> = [];
      service = new ContainerService(mock, makeConfig(), undefined, {
        record(record) {
          records.push({
            action: record.action,
            operationId: record.operationId,
            branchId: record.branchId,
            details: record.details,
          });
        },
      });
      vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
      mock.addResponse('docker inspect --format="{{.State.Status}}" cds-feature-a-api', {
        stdout: 'exited',
        stderr: '',
        exitCode: 0,
      });
      mock.addResponse('docker restart cds-feature-a-api', {
        stdout: 'cds-feature-a-api',
        stderr: '',
        exitCode: 0,
      });
      mock.addResponsePattern(/docker inspect cds-feature-a-api/, () => ({ stdout: '{}', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker logs/, () => ({ stdout: 'ready', stderr: '', exitCode: 0 }));

      await expect(service.restartServiceInPlace('cds-feature-a-api', undefined, {
        projectId: 'prd-agent',
        branchId: 'prd-agent-main',
        profileId: 'api',
        requestId: 'req-restart',
        operationId: 'op-restart',
        actor: 'user:1',
        trigger: 'manual',
        operation: 'branch-restart',
        source: 'api.restart-branch',
        reason: 'manual restart',
      })).resolves.toBe(true);

      const completed = records.find((record) => record.action === 'container.restart.completed');
      expect(completed?.operationId).toBe('op-restart');
      expect(completed?.branchId).toBe('prd-agent-main');
      expect(completed?.details).toMatchObject({
        operation: 'branch-restart',
        source: 'api.restart-branch',
        actor: 'user:1',
        trigger: 'manual',
      });
    });
  });

  describe('remove (destroy — container deleted)', () => {
    it('docker stop then docker rm', async () => {
      mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.remove('cds-feature-a-api');
      const stopIndex = mock.commands.findIndex((c) => c === 'docker stop cds-feature-a-api');
      const removeIndex = mock.commands.findIndex((c) => c === 'docker rm cds-feature-a-api');
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(removeIndex).toBeGreaterThan(stopIndex);
    });

    it('is idempotent for already-stopped containers: docker stop non-zero must NOT skip docker rm (Codex P1 @ ade2a21)', async () => {
      // 容器已是 exited:模拟 docker stop 返回非零(Codex 担心的场景)。
      // remove() 是两条相互独立的 await shell.exec —— shell.exec 在非零退出
      // 时 resolve(不 reject),所以第二条 docker rm 必达,不会被第一条短路。
      // (实际 docker 里 `docker stop <已停容器>` 也是 exit 0 幂等;此处用非零
      // 是更严苛的反例,证明即便非零 rm 仍执行。)
      mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: 'already stopped', exitCode: 1 }));
      mock.addResponsePattern(/docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await expect(service.remove('cds-feature-a-api')).resolves.toBeUndefined();
      expect(mock.commands.some((c) => c === 'docker stop cds-feature-a-api')).toBe(true);
      expect(mock.commands.some((c) => c === 'docker rm cds-feature-a-api')).toBe(true);
    });

    it('records already-absent containers as a warning instead of an error', async () => {
      const records: Array<{ action: string; severity?: string; details?: Record<string, unknown> }> = [];
      service = new ContainerService(mock, makeConfig(), undefined, {
        record(record) {
          records.push({ action: record.action, severity: record.severity, details: record.details });
        },
      });
      mock.addResponsePattern(/docker inspect/, () => ({
        stdout: '',
        stderr: 'Error response from daemon: No such container: cds-feature-a-api',
        exitCode: 1,
      }));
      mock.addResponsePattern(/docker logs/, () => ({
        stdout: '',
        stderr: 'Error response from daemon: No such container: cds-feature-a-api',
        exitCode: 1,
      }));
      mock.addResponsePattern(/docker stop/, () => ({
        stdout: '',
        stderr: 'Error response from daemon: No such container: cds-feature-a-api',
        exitCode: 1,
      }));
      mock.addResponsePattern(/docker rm/, () => ({
        stdout: '',
        stderr: 'Error response from daemon: No such container: cds-feature-a-api',
        exitCode: 1,
      }));

      await service.remove('cds-feature-a-api');

      const completed = records.find((record) => record.action === 'container.remove.completed');
      expect(completed?.severity).toBe('warn');
      expect(completed?.details?.removeStatus).toBe('already-absent');
    });
  });

  describe('isRunning', () => {
    it('should return true if container is running', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({ stdout: 'true', stderr: '', exitCode: 0 }));
      expect(await service.isRunning('c')).toBe(true);
    });

    it('should return false if container is not running', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({ stdout: 'false', stderr: '', exitCode: 0 }));
      expect(await service.isRunning('c')).toBe(false);
    });

    it('should return false if container does not exist', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({ stdout: '', stderr: 'No such object', exitCode: 1 }));
      expect(await service.isRunning('c')).toBe(false);
    });
  });

  describe('getLogs', () => {
    it('should return container logs', async () => {
      mock.addResponsePattern(/docker logs/, () => ({ stdout: 'log output', stderr: '', exitCode: 0 }));
      const logs = await service.getLogs('c');
      expect(logs).toContain('log output');
    });
  });
});

describe('Branch profile overrides — inheritance merge', () => {
  const baseline: BuildProfile = {
    id: 'api',
    name: 'API',
    dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
    workDir: 'prd-api',
    command: 'dotnet run',
    containerPort: 8080,
    env: { BASE_A: '1', BASE_B: '2' },
    resources: { memoryMB: 1024 },
    deployModes: {
      dev: { label: '开发', command: 'dotnet watch run' },
      static: { label: '静态', command: 'nginx' },
    },
  };

  const branchWithOverride = (override: BuildProfileOverride): BranchEntry => ({
    id: 'feature-x',
    branch: 'feature/x',
    worktreePath: '/wt/feature-x',
    services: {},
    status: 'idle',
    createdAt: '2026-02-12T00:00:00Z',
    profileOverrides: { api: override },
  });

  it('applyProfileOverride returns baseline unchanged when override is undefined', () => {
    const merged = applyProfileOverride(baseline, undefined);
    expect(merged).toEqual(baseline);
    // Fast path: no override → same reference (no allocation)
    expect(merged).toBe(baseline);
  });

  it('applyProfileOverride does NOT mutate the baseline', () => {
    const snapshot = JSON.parse(JSON.stringify(baseline));
    applyProfileOverride(baseline, {
      dockerImage: 'node:20',
      env: { BASE_A: '99', NEW_KEY: 'x' },
    });
    expect(baseline).toEqual(snapshot);
  });

  it('override replaces scalar fields when set', () => {
    const merged = applyProfileOverride(baseline, {
      dockerImage: 'node:20-alpine',
      command: 'pnpm dev',
      containerPort: 3000,
    });
    expect(merged.dockerImage).toBe('node:20-alpine');
    expect(merged.command).toBe('pnpm dev');
    expect(merged.containerPort).toBe(3000);
    // Unset fields inherit
    expect(merged.workDir).toBe('prd-api');
  });

  it('env merges key-wise with override winning per key', () => {
    const merged = applyProfileOverride(baseline, {
      env: { BASE_A: 'overridden', NEW_KEY: 'fresh' },
    });
    expect(merged.env).toEqual({
      BASE_A: 'overridden', // override wins
      BASE_B: '2',          // inherited
      NEW_KEY: 'fresh',     // added
    });
  });

  it('empty env in override leaves baseline env intact', () => {
    const merged = applyProfileOverride(baseline, { dockerImage: 'node:20' });
    expect(merged.env).toEqual(baseline.env);
  });

  it('resources replaces whole object when set', () => {
    const merged = applyProfileOverride(baseline, {
      resources: { memoryMB: 2048, cpus: 2 },
    });
    expect(merged.resources).toEqual({ memoryMB: 2048, cpus: 2 });
  });

  it('resolveEffectiveProfile: baseline → override → deployMode order', () => {
    // Branch overrides command AND activates a deploy mode that also changes command.
    // Deploy mode runs LAST so its command wins.
    const branch = branchWithOverride({
      command: 'branch-cmd',
      activeDeployMode: 'dev', // dev.command = 'dotnet watch run'
    });
    const effective = resolveEffectiveProfile(baseline, branch);
    expect(effective.command).toBe('dotnet watch run'); // deploy mode wins
    expect(effective.activeDeployMode).toBe('dev');
  });

  it('resolveEffectiveProfile: branch override takes effect when no deploy mode is active', () => {
    const branch = branchWithOverride({
      dockerImage: 'custom:latest',
      env: { BASE_A: 'customized' },
    });
    const effective = resolveEffectiveProfile(baseline, branch);
    expect(effective.dockerImage).toBe('custom:latest');
    expect(effective.env).toEqual({ BASE_A: 'customized', BASE_B: '2' });
  });

  it('resolveEffectiveProfile: undefined branch returns plain profile', () => {
    const effective = resolveEffectiveProfile(baseline, undefined);
    expect(effective).toEqual(baseline);
  });

  it('resolveEffectiveProfile: empty profileOverrides map = pure inheritance', () => {
    const branch: BranchEntry = {
      id: 'feature-y',
      branch: 'feature/y',
      worktreePath: '/wt/feature-y',
      services: {},
      status: 'idle',
      createdAt: '2026-02-12T00:00:00Z',
      profileOverrides: {},
    };
    const effective = resolveEffectiveProfile(baseline, branch);
    expect(effective).toEqual(baseline);
  });

  it('resolveEffectiveProfile: override can switch active deploy mode', () => {
    // Baseline has no active mode; branch activates 'static'.
    const branch = branchWithOverride({ activeDeployMode: 'static' });
    const effective = resolveEffectiveProfile(baseline, branch);
    expect(effective.command).toBe('nginx');
  });
});
