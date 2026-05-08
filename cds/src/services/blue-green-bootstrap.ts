/**
 * Blue-Green Bootstrap — daemon 启动时实例化 supervisor + gracefulShutdown(B'.5)
 *
 * 把 5 个底层组件(active-color-store / standby-controller / nginx-upstream-writer /
 * graceful-shutdown / blue-green-supervisor)拼成可直接挂到 ServerDeps 的对象。
 *
 * 接入点(由 cds/src/index.ts 调用):
 *   const bg = createBlueGreenBootstrap({...});
 *   await bg.startupReconcile();        // 清理 stale 双 daemon 残留(C-5.3)
 *   deps.supervisor = bg.supervisor;    // self-update / self-force-sync 路由消费
 *   deps.gracefulShutdown = bg.gracefulShutdown;  // SIGTERM handler 调 runShutdown
 *
 * 开关语义(对应 spec.cds-blue-green-mece-acceptance.md C-2.1 / C-2.2):
 *   - CDS_ENABLE_BLUE_GREEN 默认未设 → supervisor 仍实例化(B'.5 起 lazy 模式),
 *     但 self-update 路由的判定函数会读 env 决定是否走蓝绿;不设 = 走老路径
 *   - CDS_DISABLE_BLUE_GREEN=1 → supervisor 强制 null,锁文件不创建;紧急熔断
 *   - 单进程旧路径下 supervisor 不被路由消费,完全 noop
 *
 * 设计要点:
 *   - 不重启 spawnDaemon / killProcess / waitForHealthz 这些底层 hook,而是
 *     在 deps 里注入"真实实现"(spawn 走 child_process / kill 走 process.kill /
 *     healthz 走 http.get);单测时由调用方 override
 *   - reconcileResidualDaemon 启动时跑一次,清掉因 crash 留下的"非 active 颜色"
 *     daemon。若 active-color 文件未初始化或 supervisor 缺失,直接 noop 返回
 *   - graceful-shutdown 永远实例化(独立开关,对所有路径都启用),让单进程
 *     旧路径也享受 SIGTERM 优雅关停
 *
 * 跟 .claude/rules/compute-then-send.md 的关系:本模块只做"拼装"(算),
 * 真正的 spawn / kill / nginx swap 全由 supervisor 调用方传入;DI 友好。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readActiveColor as readActiveColorFile,
  writeActiveColor as writeActiveColorFile,
  type ActiveColor,
} from './active-color-store.js';
import { NginxUpstreamWriter } from './nginx-upstream-writer.js';
import {
  GracefulShutdownController,
  createGracefulShutdownController,
} from './graceful-shutdown.js';
import { BlueGreenSupervisor } from './blue-green-supervisor.js';
import { createInternalTokenStore, type InternalTokenStore } from './internal-token-store.js';
import type {
  SupervisorDeps,
  SupervisorEvent,
  WaitHealthzOpts,
  WaitHealthzResult,
} from './blue-green-supervisor.types.js';
import type { IShellExecutor } from '../types.js';

export interface BlueGreenBootstrapOptions {
  /** CDS repo root,锁文件 / active-color 文件落在 ${cdsRoot}/.cds/ 下。 */
  cdsRoot: string;
  /** Shell executor(注入,便于单测)。 */
  shell: IShellExecutor;
  /** 蓝色 daemon 端口。默认 9900。 */
  bluePort?: number;
  /** 绿色 daemon 端口。默认 9901。 */
  greenPort?: number;
  /** Nginx upstream conf 绝对路径。缺省走 cdsRoot/cds/nginx/cds-active-upstream.conf。 */
  nginxConfPath?: string;
  /** Nginx 白名单目录(absPath 必须在该目录下)。缺省走 nginxConfPath 所在目录。 */
  nginxAllowDir?: string;
  /** 自动禁用阈值,默认 3。 */
  autoDisableThreshold?: number;
  /**
   * 测试 hook:override spawnDaemon。生产环境用默认实现(spawn `node dist/index.js
   * --standby --color blue|green`)。
   */
  spawnDaemon?: SupervisorDeps['spawnDaemon'];
  /** 测试 hook:override killProcess。 */
  killProcess?: SupervisorDeps['killProcess'];
  /** 测试 hook:override waitForHealthz。 */
  waitForHealthz?: SupervisorDeps['waitForHealthz'];
  /** 测试 hook:override callPromote。 */
  callPromote?: SupervisorDeps['callPromote'];
  /** 测试 hook:override readDaemonPid。 */
  readDaemonPid?: SupervisorDeps['readDaemonPid'];
  /** 进入兜底:env CDS_DISABLE_BLUE_GREEN=1 时返回 disable=true 的 bootstrap。 */
  envOverride?: Partial<NodeJS.ProcessEnv>;
}

export interface BlueGreenBootstrap {
  /** Supervisor 实例。CDS_DISABLE_BLUE_GREEN=1 时为 null。 */
  supervisor: BlueGreenSupervisor | null;
  /** Graceful shutdown controller。永远存在(独立于蓝绿开关)。 */
  gracefulShutdown: GracefulShutdownController;
  /**
   * Internal token store(B'.5.1 hotfix)— supervisor ↔ daemon 共享 secret。
   * CDS_DISABLE_BLUE_GREEN=1 时仍创建(便于未来手动切),但 supervisor 不会用。
   */
  internalTokenStore: InternalTokenStore;
  /** 启动时跑一次,reconcile 残留 daemon。返回 reconcile 结果 metric。 */
  startupReconcile: () => Promise<{ killed: number; remaining: number; skipped: boolean }>;
  /** Bootstrap 是否生效(CDS_DISABLE_BLUE_GREEN=1 时 false)。 */
  enabled: boolean;
}

const DEFAULT_BLUE_PORT = 9900;
const DEFAULT_GREEN_PORT = 9901;

/**
 * 默认 spawnDaemon:走 `node dist/index.js --standby --color <color>`。
 * 蓝绿模式由 supervisor 主动 spawn,本进程 fork 子进程跑同一份 dist。
 *
 * 注意:supervisor 只关心返回的 pid;child 句柄不必跟踪(已 detached + unref)。
 */
function defaultSpawnDaemon(cdsRoot: string): SupervisorDeps['spawnDaemon'] {
  return async (opts) => {
    // 蓝绿用同一份 dist/index.js;cdsRoot 通常是 prd_agent 仓库根,index.js 在 cds/dist/
    const distEntry = path.join(cdsRoot, 'cds', 'dist', 'index.js');
    const args = ['--standby', '--color', opts.color];
    const env = {
      ...process.env,
      CDS_PORT: String(opts.port),
    };
    const out = path.join(cdsRoot, 'cds', '.cds', `daemon-${opts.color}.log`);
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
    } catch {
      /* tolerate */
    }
    let outFd = -1;
    let errFd = -1;
    try {
      outFd = fs.openSync(out, 'a');
      errFd = fs.openSync(out, 'a');
    } catch {
      // openSync 失败 → stdio: ignore 兜底
    }
    const child: ChildProcess = spawn('node', [distEntry, ...args], {
      cwd: path.join(cdsRoot, 'cds'),
      detached: true,
      stdio:
        outFd >= 0 && errFd >= 0
          ? ['ignore', outFd, errFd]
          : ['ignore', 'ignore', 'ignore'],
      env,
    });
    child.unref();
    if (!child.pid) {
      throw new Error('spawn returned no pid');
    }
    return { pid: child.pid, child };
  };
}

/** 默认 killProcess:用 process.kill 发信号。 */
function defaultKillProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* ESRCH 等错误吞掉,supervisor 自有 alive 探测 */
  }
}

/**
 * 默认 waitForHealthz:周期 GET http://127.0.0.1:port/healthz?probe=routes,
 * 期望 200。timeoutMs / intervalMs 由 supervisor 传入。
 */
function defaultWaitForHealthz(): SupervisorDeps['waitForHealthz'] {
  return async (port: number, opts: WaitHealthzOpts): Promise<WaitHealthzResult> => {
    const interval = opts.intervalMs ?? 500;
    const start = Date.now();
    let lastError: string | undefined;
    while (Date.now() - start < opts.timeoutMs) {
      try {
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.get(
            { host: '127.0.0.1', port, path: '/healthz', timeout: 2000 },
            (res) => {
              const status = res.statusCode ?? 0;
              res.resume();
              resolve(status >= 200 && status < 300);
            },
          );
          req.on('error', (err) => {
            lastError = err.message;
            resolve(false);
          });
          req.on('timeout', () => {
            lastError = 'healthz timeout';
            try {
              req.destroy();
            } catch {
              /* ignore */
            }
            resolve(false);
          });
        });
        if (ok) return { ok: true };
      } catch (err) {
        lastError = (err as Error).message;
      }
      await sleep(interval);
    }
    return { ok: false, lastError };
  };
}

/**
 * 默认 callPromote:POST http://127.0.0.1:port/api/_internal/promote。
 * 200 视为成功;非 200 / 抛错都标失败。
 *
 * B'.5.1 hotfix:必须携带 X-CDS-Internal-Token header,token 从同主机的
 * .cds/internal-token 文件读取(daemon 启动时生成,0600 权限)。supervisor 与
 * daemon 在同一主机,所以可以读到同一个文件。
 */
function defaultCallPromote(getInternalToken: () => string): SupervisorDeps['callPromote'] {
  return (port) =>
    new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/_internal/promote',
          method: 'POST',
          timeout: 5000,
          headers: {
            'content-type': 'application/json',
            'x-cds-internal-token': getInternalToken(),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          if (status >= 200 && status < 300) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `promote http ${status}` });
          }
        },
      );
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: 'promote timeout' });
      });
      req.end();
    });
}

/**
 * 默认 readDaemonPid:从 ${cdsRoot}/.cds/daemon-{color}.pid 读 pid。
 * 不存在或解析失败返回 null。
 */
function defaultReadDaemonPid(cdsRoot: string): SupervisorDeps['readDaemonPid'] {
  return (color: ActiveColor): number | null => {
    const pidFile = path.join(cdsRoot, '.cds', `daemon-${color}.pid`);
    if (!fs.existsSync(pidFile)) return null;
    try {
      const raw = fs.readFileSync(pidFile, 'utf8').trim();
      const pid = Number(raw);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  };
}

/**
 * 默认 recordEvent:打到 console。生产可被覆盖以喷 SSE / 落 mongo。
 */
function defaultRecordEvent(event: SupervisorEvent): void {
  if ('kind' in event) {
    if (event.kind === 'rollback') {
      console.log(
        `[blue-green] rollback recovered=${event.recoveredColor} elapsed=${event.elapsedMs}ms ${event.reason}`,
      );
    } else {
      console.log(
        `[blue-green] auto-disable failures=${event.failures} elapsed=${event.elapsedMs}ms ${event.reason}`,
      );
    }
  } else {
    console.log(
      `[blue-green] stage=${event.stage} status=${event.status} elapsed=${event.elapsedMs}ms ${event.message}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 解析 envOverride / process.env 决定开关。CDS_DISABLE_BLUE_GREEN=1 短路。 */
function isBlueGreenDisabled(envOverride?: Partial<NodeJS.ProcessEnv>): boolean {
  const env = envOverride ?? process.env;
  return env.CDS_DISABLE_BLUE_GREEN === '1';
}

/**
 * 主 factory。返回 supervisor + gracefulShutdown + startupReconcile。
 *
 * - CDS_DISABLE_BLUE_GREEN=1 时 supervisor=null,gracefulShutdown 仍创建
 *   (graceful-shutdown 独立开关,对所有路径都启用)
 * - 否则 supervisor 永远实例化,但是否真走蓝绿由 self-update 路由层根据
 *   CDS_ENABLE_BLUE_GREEN env 决定(本 bootstrap 不直接读 ENABLE 标志)
 */
export function createBlueGreenBootstrap(
  opts: BlueGreenBootstrapOptions,
): BlueGreenBootstrap {
  const gracefulShutdown = createGracefulShutdownController();

  // B'.5.1 hotfix:internal token 在任何模式下都创建。CDS_DISABLE_BLUE_GREEN 时
  // supervisor 为 null,但 daemon 自身仍会校验 _internal/* token(防御未来手动
  // 启用蓝绿时漏挂校验)。token 文件是 0600 权限,与启用与否解耦。
  const internalTokenStore = createInternalTokenStore({
    tokenPath: path.join(opts.cdsRoot, 'cds', '.cds', 'internal-token'),
  });

  if (isBlueGreenDisabled(opts.envOverride)) {
    return {
      supervisor: null,
      gracefulShutdown,
      internalTokenStore,
      startupReconcile: async () => ({ killed: 0, remaining: 0, skipped: true }),
      enabled: false,
    };
  }

  const bluePort = opts.bluePort ?? DEFAULT_BLUE_PORT;
  const greenPort = opts.greenPort ?? DEFAULT_GREEN_PORT;
  const nginxConfPath =
    opts.nginxConfPath ??
    path.join(opts.cdsRoot, 'cds', 'nginx', 'cds-active-upstream.conf');
  const nginxAllowDir = opts.nginxAllowDir ?? path.dirname(nginxConfPath);

  // B'.5.1:daemon 启动时清 blue-green-disabled 标志。
  // 逻辑:进程重启 = 已走完老路径,意味着代码 / nginx / 容器都到了新一致的状态,
  // 给蓝绿一次重新尝试的机会。否则用户改不掉这个文件就永远禁用,违反"不输命令"。
  // 自动失败计数器仍然存在(3 次蓝绿失败后再次禁用),只是每次完整 daemon 重启
  // 重置一次。
  try {
    const disabledFile = path.join(opts.cdsRoot, 'cds', '.cds', 'blue-green-disabled');
    if (fs.existsSync(disabledFile)) {
      fs.rmSync(disabledFile, { force: true });
      console.log('  [blue-green] cleared .cds/blue-green-disabled (daemon restart = retry reset)');
    }
  } catch (err) {
    console.warn(`  [blue-green] failed to clear disabled flag: ${(err as Error).message}`);
  }

  // B'.5.1 改造:bootstrap 启动时 ensure cds-active-upstream.conf 存在。
  // 内容用当前 active color 对应的端口(蓝色=bluePort,绿色=greenPort)。
  // exec_cds.sh init / start 也会创建这个文件,但 daemon 自更新时切了 dist
  // 但 nginx/ 目录还没初始化的边界场景由这里兜底。
  try {
    if (!fs.existsSync(nginxConfPath)) {
      const currentColor = readActiveColorFile(opts.cdsRoot).color || 'blue';
      const currentPort = currentColor === 'green' ? greenPort : bluePort;
      const initial = `# Auto-managed by CDS blue-green supervisor — daemon writes this on switch\nupstream cds_master { server 127.0.0.1:${currentPort}; keepalive 8; }\n`;
      fs.mkdirSync(path.dirname(nginxConfPath), { recursive: true });
      fs.writeFileSync(nginxConfPath, initial, { encoding: 'utf8' });
      console.log(`  [blue-green] ensured cds-active-upstream.conf -> 127.0.0.1:${currentPort} (initial)`);
    }
  } catch (err) {
    console.warn(`  [blue-green] failed to ensure cds-active-upstream.conf: ${(err as Error).message}`);
  }

  // B'.5.1 紧急修复:把 host 上的 cds-active-upstream.conf 立即 docker cp 进
  // 运行中的 cds_nginx 容器。原因:nginx 主模板已切到 include 这个文件,但
  // docker compose volumes 新加的 mount 必须重启容器才生效 — 重启容器会让
  // 业务流量瞬断,违反"更新无感"原则。docker cp 是 idempotent 的,即使容器
  // 已经 mount 了文件,cp 也只是覆盖同一字节序列。
  // 失败容忍(可能 docker.sock 不可访问 / 容器没起来),supervisor 切换时
  // nginx-upstream-writer 还会再 cp 一次兜底。
  try {
    const r = spawnSync('docker', [
      'cp',
      nginxConfPath,
      'cds_nginx:/etc/nginx/cds-active-upstream.conf',
    ], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) {
      console.log(`  [blue-green] docker cp cds-active-upstream.conf -> cds_nginx:/etc/nginx/`);
      // reload nginx 让新 conf 生效(老 conf 还没 include 的话也无副作用)
      const reloadR = spawnSync('docker', ['exec', 'cds_nginx', 'nginx', '-s', 'reload'], {
        encoding: 'utf8', timeout: 5000,
      });
      if (reloadR.status === 0) {
        console.log(`  [blue-green] cds_nginx reloaded after initial cp`);
      } else {
        console.warn(`  [blue-green] cds_nginx reload after cp failed (non-fatal): ${reloadR.stderr || reloadR.stdout}`);
      }
    } else {
      console.warn(`  [blue-green] docker cp failed (non-fatal): ${r.stderr || r.stdout}`);
    }
  } catch (err) {
    console.warn(`  [blue-green] startup docker cp threw (non-fatal): ${(err as Error).message}`);
  }

  const deps: SupervisorDeps = {
    shell: opts.shell,
    nginxWriter: NginxUpstreamWriter,
    spawnDaemon: opts.spawnDaemon ?? defaultSpawnDaemon(opts.cdsRoot),
    killProcess: opts.killProcess ?? defaultKillProcess,
    waitForHealthz: opts.waitForHealthz ?? defaultWaitForHealthz(),
    callPromote: opts.callPromote ?? defaultCallPromote(() => internalTokenStore.getToken()),
    readActiveColor: () => readActiveColorFile(opts.cdsRoot).color,
    writeActiveColor: async (color: ActiveColor) => {
      writeActiveColorFile(opts.cdsRoot, color);
    },
    readDaemonPid: opts.readDaemonPid ?? defaultReadDaemonPid(opts.cdsRoot),
    recordEvent: defaultRecordEvent,
    cdsRoot: opts.cdsRoot,
    bluePort,
    greenPort,
    nginxConfPath,
    nginxAllowDir,
    verifyAdminTargetUrl: (port: number) => `http://127.0.0.1:${port}/healthz`,
    autoDisableThreshold: opts.autoDisableThreshold,
  };

  const supervisor = new BlueGreenSupervisor(deps);

  return {
    supervisor,
    gracefulShutdown,
    internalTokenStore,
    enabled: true,
    startupReconcile: async () => {
      try {
        const r = await supervisor.reconcileResidualDaemon();
        return { killed: r.killed, remaining: r.remaining, skipped: false };
      } catch (err) {
        console.warn(
          `[blue-green] startupReconcile failed (non-fatal): ${(err as Error).message}`,
        );
        return { killed: 0, remaining: 0, skipped: true };
      }
    },
  };
}

// 自测/调试 hook:暴露 default fns 让 unit test 直接断言"默认实现存在"
export const __testInternals = {
  defaultSpawnDaemon,
  defaultKillProcess,
  defaultWaitForHealthz,
  defaultCallPromote,
  defaultReadDaemonPid,
  isBlueGreenDisabled,
};

// fileURLToPath only used to satisfy ESM lint expectations in some builds; not used at runtime.
void fileURLToPath;
