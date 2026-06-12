import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { ContainerService } from '../../src/services/container.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';

/**
 * 真实 docker 集成测试 —— 锁死 stop/remove 重构在**真实容器**上的核心不变量,
 * 把"靠 MockShell 断言命令字符串"升级为"真容器跑一遍"。
 *
 * 本测试需要可用的 docker daemon。无 daemon 的环境(CI 沙箱 / 本会话沙箱)
 * 自动 skip —— 不让它 fail 整个套件;有 docker 的机器(CDS 宿主 / 带 docker 的
 * CI)会真实执行,提供 MockShell 给不了的真实证据。
 *
 * 验证矩阵:
 *  - stop()   → 容器仍存在(exited)、docker logs 末尾有 [CDS-STOP] 哨兵、未 rm
 *  - docker restart 能把已 stop 的容器秒级唤醒(Bugbot「正常停止后重启必失败」根因)
 *  - remove() → 容器与 logs 一并消失
 */

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function dockerImageAvailable(image: string): boolean {
  try {
    execSync(`docker image inspect ${image}`, { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    try {
      execSync(`docker pull ${image}`, { stdio: 'ignore', timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }
}

const DOCKER_OK = dockerAvailable();
const TEST_IMAGE = 'alpine:3';
const TEST_IMAGE_OK = DOCKER_OK && dockerImageAvailable(TEST_IMAGE);

const makeConfig = (): CdsConfig => ({
  repoRoot: '/repo',
  worktreeBase: '/wt',
  masterPort: 9900,
  workerPort: 5500,
  dockerNetwork: 'bridge',
  portStart: 10001,
  sharedEnv: {},
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
});

describe.skipIf(!TEST_IMAGE_OK)('ContainerService stop/remove against real docker', () => {
  const shell = new ShellExecutor();
  const svc = new ContainerService(shell, makeConfig());
  const name = `cds-verify-${Date.now()}`;
  const REASON = '集成测试停止（保留容器）';

  afterAll(() => {
    // 无论断言结果如何都清掉测试容器,绝不污染宿主。
    try {
      execSync(`docker rm -f ${name}`, { stdio: 'ignore', timeout: 15_000 });
    } catch {
      /* 已删除 / 从未创建 */
    }
  });

  it(
    'stop keeps the container (exited) + writes [CDS-STOP] sentinel; docker restart revives it; remove deletes it',
    async () => {
      // 起一个长睡眠容器(有 sh,哨兵可写;sleep 让它不会自己退出)
      const run = await shell.exec(`docker run -d --name ${name} ${TEST_IMAGE} sleep 600`);
      expect(run.exitCode, `docker run failed: ${run.stderr}`).toBe(0);

      // 1) stop() —— 仅 docker stop + 哨兵,不得 rm
      await svc.stop(name, REASON);

      const status = await shell.exec(`docker inspect -f "{{.State.Status}}" ${name}`);
      expect(status.exitCode, '容器在 stop 后必须仍然存在(未被 rm)').toBe(0);
      expect(status.stdout.trim()).toBe('exited');

      const logs = await shell.exec(`docker logs ${name}`);
      expect(logs.stdout + logs.stderr).toContain('[CDS-STOP]');
      // 全角括号/逗号必须保留(Bugbot #640 白名单加固)
      expect(logs.stdout + logs.stderr).toContain(`reason=${REASON}`);

      // 2) docker restart 把已 stop 的容器秒级唤醒(/restart 端点真实路径)
      const restart = await shell.exec(`docker restart ${name}`);
      expect(restart.exitCode, `docker restart failed: ${restart.stderr}`).toBe(0);
      const running = await shell.exec(`docker inspect -f "{{.State.Running}}" ${name}`);
      expect(running.stdout.trim()).toBe('true');

      // 3) remove() —— stop + rm,容器与 logs 一并消失
      await svc.remove(name);
      const gone = await shell.exec(`docker inspect ${name}`);
      expect(gone.exitCode, 'remove 后容器必须彻底消失').not.toBe(0);
    },
    180_000,
  );
});
