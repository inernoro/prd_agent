/**
 * Blue-Green Supervisor 编排 — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 1.6 / 1.7 / 5.2 / 8.2 / 8.5
 * 实现位置:cds/src/services/blue-green-supervisor.ts
 *
 * Supervisor 职责:在 self-update 完成 esbuild 后,接管"切换"流程:
 * spawn 新 daemon → 健康检查 → 改 nginx → promote → 退役旧 daemon。
 * 任一步骤失败,自动回滚到旧 daemon 仍服务的状态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IShellExecutor, ExecResult, ExecOptions } from '../../src/types.js';
import type { ActiveColor } from '../../src/services/active-color-store.js';
import type {
  SupervisorDeps,
  SupervisorEvent,
  SwitchActiveOpts,
} from '../../src/services/blue-green-supervisor.types.js';
import { BlueGreenSupervisor } from '../../src/services/blue-green-supervisor.js';

/**
 * Mock shell executor:返回 nginx -t / nginx -s reload 都成功(exitCode=0)。
 */
function createOkExecutor(): IShellExecutor & { calls: Array<{ command: string }> } {
  const calls: Array<{ command: string }> = [];
  return {
    calls,
    async exec(command: string, _options?: ExecOptions): Promise<ExecResult> {
      calls.push({ command });
      // 默认所有命令成功
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

/**
 * Mock NginxUpstreamWriter:swap 直接返回成功(不做实际文件 / nginx 操作)。
 * 单测里关注的是 supervisor 编排,nginx 内部行为已在 nginx-upstream-writer.test.ts 覆盖。
 */
function createOkNginxWriter(swapCalls: Array<{ port: number }> = []) {
  return {
    swap: async (opts: { port: number }) => {
      swapCalls.push({ port: opts.port });
      return { ok: true, stage: 'done' as const, rolledBack: false };
    },
    // 其它字段不会被 supervisor 调
    validatePort: () => ({ ok: true } as const),
    validateConfPath: () => ({ ok: true } as const),
    renderUpstream: () => '',
    writeAtomic: async () => {},
    validateNginxConf: async () => ({ ok: true, stderr: '' }),
    reloadNginx: async () => ({ ok: true, stderr: '' }),
  };
}

/**
 * 构造一份完整的 deps,部分字段允许覆盖。tmpRoot 作为 cdsRoot。
 * spawn / kill / promote / waitForHealthz 默认全部成功。
 */
interface BuildDepsOverrides {
  shell?: IShellExecutor;
  nginxWriter?: SupervisorDeps['nginxWriter'];
  spawnDaemon?: SupervisorDeps['spawnDaemon'];
  killProcess?: SupervisorDeps['killProcess'];
  isProcessAlive?: SupervisorDeps['isProcessAlive'];
  waitForHealthz?: SupervisorDeps['waitForHealthz'];
  callPromote?: SupervisorDeps['callPromote'];
  readActiveColor?: SupervisorDeps['readActiveColor'];
  writeActiveColor?: SupervisorDeps['writeActiveColor'];
  recordEvent?: SupervisorDeps['recordEvent'];
  readDaemonPid?: SupervisorDeps['readDaemonPid'];
  verifyAdminTargetUrl?: SupervisorDeps['verifyAdminTargetUrl'];
  autoDisableThreshold?: number;
  bluePort?: number;
  greenPort?: number;
}

function buildDeps(
  cdsRoot: string,
  recorded: SupervisorEvent[],
  overrides: BuildDepsOverrides = {},
): SupervisorDeps {
  const swapCalls: Array<{ port: number }> = [];
  const defaults: SupervisorDeps = {
    shell: overrides.shell ?? createOkExecutor(),
    nginxWriter:
      overrides.nginxWriter ??
      (createOkNginxWriter(swapCalls) as unknown as SupervisorDeps['nginxWriter']),
    spawnDaemon:
      overrides.spawnDaemon ??
      (async () => ({ pid: 999_999_001 })),
    killProcess:
      overrides.killProcess ??
      (() => {
        /* noop */
      }),
    isProcessAlive:
      overrides.isProcessAlive ??
      (() => false), // 默认进程"已死",supervisor 不会等
    waitForHealthz:
      overrides.waitForHealthz ?? (async () => ({ ok: true })),
    callPromote: overrides.callPromote ?? (async () => ({ ok: true })),
    readActiveColor:
      overrides.readActiveColor ??
      (() => 'blue' as ActiveColor),
    writeActiveColor:
      overrides.writeActiveColor ??
      (async () => {
        /* noop */
      }),
    recordEvent: overrides.recordEvent ?? ((ev) => recorded.push(ev)),
    cdsRoot,
    bluePort: overrides.bluePort ?? 9900,
    greenPort: overrides.greenPort ?? 9901,
    readDaemonPid:
      overrides.readDaemonPid ??
      ((color) => (color === 'blue' ? 11111 : 22222)),
    nginxConfPath: path.join(cdsRoot, 'nginx', 'cds-active-upstream.conf'),
    nginxAllowDir: path.join(cdsRoot, 'nginx'),
    verifyAdminTargetUrl: overrides.verifyAdminTargetUrl,
    autoDisableThreshold: overrides.autoDisableThreshold,
  };
  return defaults;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-supervisor-'));
  // 保证 .cds 目录可以被 supervisor 创建
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function readActiveColorFile(): ActiveColor | null {
  const p = path.join(tmpRoot, '.cds', 'active-color');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (raw === 'blue' || raw === 'green') return raw;
  return null;
}

function readActivePortFile(): number | null {
  const p = path.join(tmpRoot, '.cds', 'active-port');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// 1. 正常蓝绿切换
// ============================================================
describe('Supervisor — 正常蓝绿切换', () => {
  it('[C-1.6] 全流程:spawn green → wait healthz → write nginx → reload → promote → SIGTERM blue → 状态干净', async () => {
    const recorded: SupervisorEvent[] = [];
    const stages: string[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];
    const swapCalls: Array<{ port: number }> = [];

    let writtenColor: ActiveColor | null = null;
    const deps = buildDeps(tmpRoot, recorded, {
      writeActiveColor: async (color) => {
        writtenColor = color;
        // 真正写出文件,以便测试 active-color 的检查
        fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      nginxWriter: createOkNginxWriter(swapCalls) as unknown as SupervisorDeps['nginxWriter'],
    });

    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive({
      onStage: (stage) => stages.push(stage),
    });

    expect(result.ok).toBe(true);
    expect(result.fromColor).toBe('blue');
    expect(result.toColor).toBe('green');
    expect(result.fromPort).toBe(9900);
    expect(result.toPort).toBe(9901);
    expect(result.rolledBack).toBe(false);

    // stage 顺序覆盖完整流程
    expect(stages).toContain('spawn-green');
    expect(stages).toContain('wait-healthz');
    expect(stages).toContain('nginx-write');
    expect(stages).toContain('promote-green');
    expect(stages).toContain('shutdown-blue');
    expect(stages).toContain('commit-color');
    expect(stages).toContain('done');

    // nginx swap 写到 9901
    expect(swapCalls).toHaveLength(1);
    expect(swapCalls[0].port).toBe(9901);

    // 蓝 daemon 被 SIGTERM
    expect(killed.some((k) => k.pid === 11111 && k.signal === 'SIGTERM')).toBe(true);

    // active-color 文件已落
    expect(writtenColor).toBe('green');
  });

  it('[C-1.6] 切换后 .cds/active-color 文件从 blue 变 green', async () => {
    const recorded: SupervisorEvent[] = [];
    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    const deps = buildDeps(tmpRoot, recorded, {
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();
    expect(result.ok).toBe(true);
    expect(readActiveColorFile()).toBe('green');
  });

  it('[C-1.6] 切换后 .cds/active-port 文件从 9900 变 9901', async () => {
    const recorded: SupervisorEvent[] = [];
    const deps = buildDeps(tmpRoot, recorded);
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();
    expect(result.ok).toBe(true);
    expect(readActivePortFile()).toBe(9901);
  });

  it('[C-1.6] 切换后 systemd ps 里只剩 1 个 daemon 进程', async () => {
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];
    let blueAlive = true;

    const deps = buildDeps(tmpRoot, recorded, {
      killProcess: (pid, signal) => {
        killed.push({ pid, signal });
        if (pid === 11111) blueAlive = false;
      },
      isProcessAlive: (pid) => (pid === 11111 ? blueAlive : false),
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();
    expect(result.ok).toBe(true);
    // SIGTERM 蓝 daemon
    expect(killed.some((k) => k.pid === 11111 && k.signal === 'SIGTERM')).toBe(true);
    // 蓝最终已退出
    expect(blueAlive).toBe(false);
  });

  it('[C-1.6] 切换后 self-update 流水里有 mode=blue-green 一条记录,带完整 stage 时间戳', async () => {
    const recorded: SupervisorEvent[] = [];
    const deps = buildDeps(tmpRoot, recorded);
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();
    expect(result.ok).toBe(true);

    // 核心 stage 都至少推送过一条 done
    const stageEvents = result.events.filter(
      (e): e is Extract<SupervisorEvent, { stage: string; status: string }> =>
        'stage' in e && 'status' in e,
    );
    const doneStages = stageEvents.filter((e) => e.status === 'done').map((e) => e.stage);
    for (const need of [
      'lock-acquire',
      'spawn-green',
      'wait-healthz',
      'nginx-write',
      'promote-green',
      'shutdown-blue',
      'commit-color',
      'done',
    ]) {
      expect(doneStages).toContain(need);
    }

    // 每条事件都带 elapsedMs (单调递增基本性质)
    for (const ev of stageEvents) {
      expect(typeof ev.elapsedMs).toBe('number');
      expect(ev.elapsedMs).toBeGreaterThanOrEqual(0);
    }

    // recorded 与 result.events 同源(supervisor 既往 events 推也调 recordEvent)
    expect(recorded.length).toBeGreaterThanOrEqual(stageEvents.length);
  });
});

// ============================================================
// 2. 阶段失败与回滚
// ============================================================
describe('Supervisor — 阶段失败与回滚', () => {
  it('[C-1.7] spawn 阶段失败(exec 错):流水标 stage=spawn fail,旧 daemon 不动,active-color 不变', async () => {
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];

    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    const deps = buildDeps(tmpRoot, recorded, {
      spawnDaemon: async () => {
        throw new Error('exec failed: no such file');
      },
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('spawn-green');
    expect(result.rolledBack).toBe(true);

    // active-color 仍为 blue
    expect(readActiveColorFile()).toBe('blue');

    // 旧 daemon 没被 kill
    expect(killed.find((k) => k.pid === 11111)).toBeUndefined();
  });

  it('[C-1.7] healthz 60s 超时:流水标 stage=health-check fail,kill 新 daemon,active-color 不变', async () => {
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];

    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    const deps = buildDeps(tmpRoot, recorded, {
      spawnDaemon: async () => ({ pid: 33333 }),
      waitForHealthz: async () => ({ ok: false, lastError: 'timeout after 60000ms' }),
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive({ healthCheckTimeoutMs: 60_000 });

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('wait-healthz');
    expect(readActiveColorFile()).toBe('blue');

    // 新 daemon 被 SIGTERM
    expect(killed.some((k) => k.pid === 33333 && k.signal === 'SIGTERM')).toBe(true);
    // 旧 daemon 未被 kill
    expect(killed.find((k) => k.pid === 11111)).toBeUndefined();
  });

  it('[C-5.4] nginx -t 校验失败:流水标 stage=nginx-validate fail,**不**执行 reload,upstream 文件回滚', async () => {
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];

    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    // mock nginxWriter,模拟 validate 阶段失败 + 回滚成功
    const swapCalls: Array<{ port: number }> = [];
    const writer = {
      swap: async (opts: { port: number }) => {
        swapCalls.push({ port: opts.port });
        return {
          ok: false,
          stage: 'validate' as const,
          rolledBack: true,
          error: 'nginx -t failed: invalid syntax',
        };
      },
      validatePort: () => ({ ok: true } as const),
      validateConfPath: () => ({ ok: true } as const),
      renderUpstream: () => '',
      writeAtomic: async () => {},
      validateNginxConf: async () => ({ ok: false, stderr: 'syntax error' }),
      reloadNginx: async () => ({ ok: true, stderr: '' }),
    };

    const deps = buildDeps(tmpRoot, recorded, {
      spawnDaemon: async () => ({ pid: 33333 }),
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      nginxWriter: writer as unknown as SupervisorDeps['nginxWriter'],
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('nginx-validate');
    expect(readActiveColorFile()).toBe('blue');
    // 新 daemon 被 kill
    expect(killed.some((k) => k.pid === 33333 && k.signal === 'SIGTERM')).toBe(true);
    // swap 调用了 1 次,且 port 是新端口(回滚由 nginxWriter 自己处理)
    expect(swapCalls).toEqual([{ port: 9901 }]);
  });

  it('[C-1.7] nginx reload 失败:upstream 文件回滚到旧版,kill 新 daemon', async () => {
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];
    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    const writer = {
      swap: async () => ({
        ok: false,
        stage: 'reload' as const,
        rolledBack: true,
        error: 'nginx -s reload failed',
      }),
      validatePort: () => ({ ok: true } as const),
      validateConfPath: () => ({ ok: true } as const),
      renderUpstream: () => '',
      writeAtomic: async () => {},
      validateNginxConf: async () => ({ ok: true, stderr: '' }),
      reloadNginx: async () => ({ ok: false, stderr: 'reload failed' }),
    };

    const deps = buildDeps(tmpRoot, recorded, {
      spawnDaemon: async () => ({ pid: 44444 }),
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      nginxWriter: writer as unknown as SupervisorDeps['nginxWriter'],
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('nginx-reload');
    expect(readActiveColorFile()).toBe('blue');
    expect(killed.some((k) => k.pid === 44444 && k.signal === 'SIGTERM')).toBe(true);
  });

  it('[C-1.7] promote 失败(新 daemon /api/_internal/promote 返 5xx):reload 回退 + kill 新 daemon', async () => {
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];
    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    // 第一次 swap 写到 9901 OK,promote 失败后 supervisor 应当再调一次 swap 把端口切回 9900
    const swapCalls: Array<{ port: number }> = [];
    const writer = {
      swap: async (opts: { port: number }) => {
        swapCalls.push({ port: opts.port });
        return { ok: true, stage: 'done' as const, rolledBack: false };
      },
      validatePort: () => ({ ok: true } as const),
      validateConfPath: () => ({ ok: true } as const),
      renderUpstream: () => '',
      writeAtomic: async () => {},
      validateNginxConf: async () => ({ ok: true, stderr: '' }),
      reloadNginx: async () => ({ ok: true, stderr: '' }),
    };

    const deps = buildDeps(tmpRoot, recorded, {
      spawnDaemon: async () => ({ pid: 55555 }),
      callPromote: async () => ({ ok: false, error: 'standby returned 500' }),
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      nginxWriter: writer as unknown as SupervisorDeps['nginxWriter'],
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('promote-green');
    expect(readActiveColorFile()).toBe('blue');
    // swap 至少被调 2 次(切到 9901 + 切回 9900)
    expect(swapCalls.length).toBeGreaterThanOrEqual(2);
    expect(swapCalls[0].port).toBe(9901);
    expect(swapCalls[swapCalls.length - 1].port).toBe(9900);
    // 新 daemon 被 kill
    expect(killed.some((k) => k.pid === 55555 && k.signal === 'SIGTERM')).toBe(true);
  });

  it('[C-8.2] 整个流程任一失败,旧 daemon 在切换全程**继续处理流量**,无 5xx 给最终用户', async () => {
    // 通过断言 active-color 不变 + 旧 daemon 没被 kill 来证明
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];
    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    // 所有阶段都失败的尝试,本测试用 healthz 失败代表
    const deps = buildDeps(tmpRoot, recorded, {
      spawnDaemon: async () => ({ pid: 66666 }),
      waitForHealthz: async () => ({ ok: false, lastError: 'timeout' }),
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    // 蓝 daemon 全程不动
    expect(killed.find((k) => k.pid === 11111)).toBeUndefined();
    // active-color 仍是 blue
    expect(readActiveColorFile()).toBe('blue');
    // recordEvent 收到 rollback 汇总
    const rollbackEvents = recorded.filter((e) => 'kind' in e && (e as any).kind === 'rollback');
    expect(rollbackEvents.length).toBeGreaterThanOrEqual(1);
    expect((rollbackEvents[0] as any).recoveredColor).toBe('blue');
  });
});

// ============================================================
// 3. 异常容错
// ============================================================
describe('Supervisor — 异常容错', () => {
  it('[C-5.3] supervisor 进程崩溃后,启动 reconcile 检测到双 daemon 残留 → 杀掉 standby 的那个', async () => {
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];
    // active-color = blue 表示 11111 是 active,22222 (green) 是残留
    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    const deps = buildDeps(tmpRoot, recorded, {
      readActiveColor: () => 'blue',
      readDaemonPid: (color) => (color === 'blue' ? 11111 : 22222),
      // 两个进程都活着
      isProcessAlive: () => true,
      killProcess: (pid, signal) => killed.push({ pid, signal }),
    });
    const sup = new BlueGreenSupervisor(deps);
    const r = await sup.reconcileResidualDaemon();

    expect(r.killed).toBe(1);
    expect(r.remaining).toBe(1);
    expect(killed).toEqual([{ pid: 22222, signal: 'SIGTERM' }]);
  });

  it('[C-8.5] 连续 3 次蓝绿切换失败,自动写 .cds/blue-green-disabled 标志,下次 self-update 走老路径并告警', async () => {
    const recorded: SupervisorEvent[] = [];
    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    const deps = buildDeps(tmpRoot, recorded, {
      spawnDaemon: async () => {
        throw new Error('spawn fail');
      },
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
      autoDisableThreshold: 3,
    });
    const sup = new BlueGreenSupervisor(deps);
    const r1 = await sup.switchActive();
    expect(r1.ok).toBe(false);
    const r2 = await sup.switchActive();
    expect(r2.ok).toBe(false);
    const r3 = await sup.switchActive();
    expect(r3.ok).toBe(false);

    // 第 3 次失败时 disabled 标志位生效
    const disabledPath = path.join(tmpRoot, '.cds', 'blue-green-disabled');
    expect(fs.existsSync(disabledPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(disabledPath, 'utf8'));
    expect(content.disabled).toBe(true);
    expect(content.failures).toBeGreaterThanOrEqual(3);

    // 第 4 次直接拒
    const r4 = await sup.switchActive();
    expect(r4.ok).toBe(false);
    expect(r4.failedStage).toBe('lock-acquire');
    expect(r4.error).toMatch(/auto-disabled|禁用/);

    // 应推过 auto-disable 事件
    const adEvents = recorded.filter((e) => 'kind' in e && (e as any).kind === 'auto-disable');
    expect(adEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('[C-1.7] 旧 daemon SIGTERM 后 30s 仍未退出 → SIGKILL,流水记 forced-kill 警告', async () => {
    const recorded: SupervisorEvent[] = [];
    const killed: Array<{ pid: number; signal: string }> = [];
    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), 'blue');

    // 旧 daemon SIGTERM 后永远不退出
    const deps = buildDeps(tmpRoot, recorded, {
      writeActiveColor: async (color) => {
        fs.writeFileSync(path.join(tmpRoot, '.cds', 'active-color'), color);
      },
      isProcessAlive: (pid) => pid === 11111, // 蓝永远活着
      killProcess: (pid, signal) => killed.push({ pid, signal }),
    });
    const sup = new BlueGreenSupervisor(deps);
    // 用极短超时让测试不阻塞
    const result = await sup.switchActive({ shutdownForceKillAfterMs: 50 });
    expect(result.ok).toBe(true); // shutdown 失败不致命

    // SIGTERM + SIGKILL 都被发出
    expect(killed.some((k) => k.pid === 11111 && k.signal === 'SIGTERM')).toBe(true);
    expect(killed.some((k) => k.pid === 11111 && k.signal === 'SIGKILL')).toBe(true);

    // 流水里有 forced-kill 警告
    const errEvents = recorded.filter(
      (e) => 'stage' in e && (e as any).stage === 'shutdown-blue' && (e as any).status === 'error',
    );
    expect(errEvents.length).toBeGreaterThanOrEqual(1);
    expect((errEvents[0] as any).message).toMatch(/forced-kill|强杀/);
  });
});

// ============================================================
// 4. SSE 进度推送
// ============================================================
describe('Supervisor — SSE 进度推送', () => {
  it('[C-7.3] 每个 stage 开始/结束推送 SSE event,格式与现有 self-update 一致', async () => {
    const recorded: SupervisorEvent[] = [];
    const deps = buildDeps(tmpRoot, recorded);
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();
    expect(result.ok).toBe(true);

    // 关键 stage 应同时有 running 和 done
    const stageEvents = recorded.filter(
      (e): e is Extract<SupervisorEvent, { stage: string }> =>
        'stage' in e,
    );
    const groupByStage: Record<string, string[]> = {};
    for (const ev of stageEvents) {
      if (!groupByStage[ev.stage]) groupByStage[ev.stage] = [];
      groupByStage[ev.stage].push(ev.status);
    }
    for (const stage of ['spawn-green', 'wait-healthz', 'promote-green']) {
      expect(groupByStage[stage]).toContain('running');
      expect(groupByStage[stage]).toContain('done');
    }

    // 每条事件结构合规:stage / status / elapsedMs / message
    for (const ev of stageEvents) {
      expect(typeof ev.stage).toBe('string');
      expect(typeof ev.status).toBe('string');
      expect(typeof ev.elapsedMs).toBe('number');
      expect(typeof ev.message).toBe('string');
    }
  });

  it('[C-6.6] 进度文案对运维友好:"等绿就绪 (2s)"、"切流"、"退役蓝"等中文', async () => {
    const recorded: SupervisorEvent[] = [];
    const deps = buildDeps(tmpRoot, recorded);
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();
    expect(result.ok).toBe(true);

    const allMessages = recorded
      .filter((e) => 'message' in e)
      .map((e) => (e as any).message as string)
      .join('\n');

    // 关键中文文案至少出现一处
    expect(allMessages).toMatch(/等绿就绪|健康/);
    expect(allMessages).toMatch(/切流|nginx/);
    expect(allMessages).toMatch(/退役|旧 daemon/);
  });
});

// ============================================================
// 5. 单 supervisor 实例锁
// ============================================================
describe('Supervisor — 单 supervisor 实例锁', () => {
  it('[C-1.6] 同时触发两次 self-update,第二次立即返回"正在切换中"', async () => {
    const recorded: SupervisorEvent[] = [];

    // 让第一次切换中途阻塞,以便第二次可以并发尝试
    let resolveHealth: (() => void) | null = null;
    const healthPromise = new Promise<void>((resolve) => {
      resolveHealth = resolve;
    });

    const deps = buildDeps(tmpRoot, recorded, {
      waitForHealthz: async () => {
        await healthPromise;
        return { ok: true };
      },
    });
    const sup = new BlueGreenSupervisor(deps);

    const p1 = sup.switchActive();
    // 给 P1 一点时间进入 wait-healthz
    await new Promise((r) => setTimeout(r, 30));
    expect(sup.isInProgress()).toBe(true);
    const p2 = await sup.switchActive();
    expect(p2.ok).toBe(false);
    expect(p2.failedStage).toBe('lock-acquire');
    expect(p2.error).toMatch(/正在切换中|in progress/i);

    // 解封 P1
    resolveHealth?.();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
  });

  it('[C-1.6] supervisor 锁文件 .cds/blue-green.lock 包含 pid,进程死了下次自动清理', async () => {
    const recorded: SupervisorEvent[] = [];
    const lockPath = path.join(tmpRoot, '.cds', 'blue-green.lock');

    // 预先写一个 stale 锁(指向一个不存在的 pid)
    fs.mkdirSync(path.join(tmpRoot, '.cds'), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99_999_999, startedAt: '2020-01-01T00:00:00Z' }),
    );

    const deps = buildDeps(tmpRoot, recorded, {
      // 99999999 死的
      isProcessAlive: (pid) => {
        if (pid === 99_999_999) return false;
        return false;
      },
    });
    const sup = new BlueGreenSupervisor(deps);
    const result = await sup.switchActive();
    expect(result.ok).toBe(true);

    // 锁文件已被释放
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
