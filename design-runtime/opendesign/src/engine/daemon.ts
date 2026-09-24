// OpenDesign daemon 的进程管理。
//
// 原来 CDS 为每个任务起一个容器，daemon 是容器的主进程；现在 daemon 与本服务同处一个容器，
// 由本服务作为父进程拉起、停止、重启。隔离方案 A（每实例一次一个任务、跑完清空）要求每个任务
// 结束后都把 daemon 停掉、清空它的数据目录再重新拉起——内存里的会话、sqlite 里的项目记录、
// Codex 的会话目录都随之归零，下一个任务看不到上一个任务的任何东西。
//
// 进程身份：生产镜像里本服务以 root 运行，daemon（以及它拉起的 Codex）以镜像自带的 open-design
// 用户运行。这不是多余的：Codex 在这个运行时里以 danger-full-access 执行模型给出的命令，
// 同一 uid 就能读到本服务进程的环境变量（含 DESIGN_RUNTIME_API_KEY）与转发口里的真实票据。
// 换成不同 uid 之后，/proc/<本服务>/environ 对它不可读，信号也发不过来。daemon 的环境变量
// 一律显式构造（buildDaemonEnv），不继承本进程的 process.env。
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';

export interface DaemonHandle {
  readonly baseUrl: string;
  /** 本次 daemon 生命周期的 OD_API_TOKEN。只在本进程与 daemon 之间使用。 */
  readonly apiToken: string;
  /**
   * 交给 Codex 的占位 token（MAP_CODEX_MODEL_TOKEN）。它只能用来访问本服务的本机转发口；
   * 真实的 MAP 模型票据只在转发口里注入，引擎永远拿不到。
   */
  readonly modelPlaceholderToken: string;
}

export interface DaemonExit {
  code: number | null;
  signal: string | null;
  at: string;
  /** true 表示是本服务主动停的（任务结束后的清理），false 表示进程自己退出了。 */
  intentional: boolean;
}

export interface EngineDaemon {
  /** 以一组新令牌拉起 daemon。已在运行时先停掉再起。 */
  start(): Promise<DaemonHandle>;
  /** 主动停止（任务结束后的清理步骤）。已停止时无操作。 */
  stop(): Promise<void>;
  current(): DaemonHandle | null;
  /** 导出产物时冻结引擎进程组，对应原 CDS 的 `docker pause`；导出结束必须 thaw。 */
  freeze(): void;
  thaw(): void;
  onUnexpectedExit(listener: (exit: DaemonExit) => void): void;
  describe(): { running: boolean; pid: number | null; lastExit: DaemonExit | null };
}

export interface OpenDesignDaemonOptions {
  /** 例如 [process.execPath, '/app/apps/daemon/dist/cli.js', '--no-open']。 */
  command: string[];
  cwd: string;
  port: number;
  dataDir: string;
  workspaceDir: string;
  /** 以哪个用户运行 daemon；只有本进程是 root 时才会生效。 */
  uid?: number;
  gid?: number;
  home: string;
  stopTimeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * daemon 的环境变量。逐项对应原 CDS `docker create --env-file` 那份清单，只有两处因拓扑改变而不同：
 * - OD_BIND_HOST 由 0.0.0.0 收紧为 127.0.0.1：原来 CDS 隔着 docker 网络访问它，现在同容器本机访问；
 * - OD_DATA_DIR / OD_SANDBOX_IMPORT_ALLOWED_ROOTS 取配置值（生产仍是 /app/.od 与 /workspace）。
 * 不继承本进程 process.env，DESIGN_RUNTIME_API_KEY 等本服务的密钥因此不会进入引擎进程。
 */
export function buildDaemonEnv(input: {
  port: number;
  dataDir: string;
  workspaceDir: string;
  apiToken: string;
  modelPlaceholderToken: string;
  home: string;
  path: string;
}): Record<string, string> {
  return {
    PATH: input.path,
    HOME: input.home,
    NODE_ENV: 'production',
    // 与上游镜像的 ENV 一致；本服务进程自己不用这个上限（见 Dockerfile）。
    NODE_OPTIONS: '--max-old-space-size=192',
    OD_BIND_HOST: '127.0.0.1',
    OD_PORT: String(input.port),
    OD_WEB_PORT: String(input.port),
    OD_DATA_DIR: input.dataDir,
    OD_API_TOKEN: input.apiToken,
    OD_SANDBOX_MODE: '1',
    OD_SANDBOX_IMPORT_ALLOWED_ROOTS: input.workspaceDir,
    // Codex 在 Linux 上默认以 workspace-write 沙箱运行，底层用 bubblewrap 在容器内再开一层
    // user namespace；非特权容器里开不出来，每条文件系统命令都会失败（2026-09-21 此前十八条 run
    // 零产出的真正原因）。容器本身就是隔离边界，用 OpenDesign 自己的运维开关关掉它。
    OD_CODEX_SANDBOX: 'danger-full-access',
    // 真实的 MAP 票据只属于本服务的转发口；Codex 的 env_key 拿到的是本次 daemon 生命周期的占位值。
    MAP_CODEX_MODEL_TOKEN: input.modelPlaceholderToken,
  };
}

export class OpenDesignDaemon implements EngineDaemon {
  private child: ChildProcess | null = null;
  private handle: DaemonHandle | null = null;
  private stopping: Promise<void> | null = null;
  private lastExit: DaemonExit | null = null;
  private readonly listeners: Array<(exit: DaemonExit) => void> = [];

  constructor(private readonly options: OpenDesignDaemonOptions) {}

  async start(): Promise<DaemonHandle> {
    await this.stop();
    const apiToken = crypto.randomBytes(32).toString('hex');
    const modelPlaceholderToken = `od-placeholder-${crypto.randomBytes(32).toString('base64url')}`;
    const env = buildDaemonEnv({
      port: this.options.port,
      dataDir: this.options.dataDir,
      workspaceDir: this.options.workspaceDir,
      apiToken,
      modelPlaceholderToken,
      home: this.options.home,
      path: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    });
    const [command, ...args] = this.options.command;
    const runAsOtherUser = typeof process.getuid === 'function' && process.getuid() === 0 && this.options.uid !== undefined;
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env,
      // 独立进程组：停止与冻结按组发信号，覆盖 daemon 拉起的 Codex 子进程。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(runAsOtherUser ? { uid: this.options.uid, gid: this.options.gid ?? this.options.uid } : {}),
    });
    const secrets = [apiToken, modelPlaceholderToken];
    const forward = (stream: NodeJS.ReadableStream | null, label: string) => {
      stream?.setEncoding('utf8');
      let buffer = '';
      stream?.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          let line = buffer.slice(0, newline);
          for (const secret of secrets) line = line.split(secret).join('***[masked]***');
          this.options.log?.(`[od ${label}] ${line.slice(0, 2_000)}`);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
        if (buffer.length > 8_192) buffer = buffer.slice(-8_192);
      });
    };
    forward(child.stdout, 'out');
    forward(child.stderr, 'err');
    const handle: DaemonHandle = {
      baseUrl: `http://127.0.0.1:${this.options.port}`,
      apiToken,
      modelPlaceholderToken,
    };
    this.child = child;
    this.handle = handle;
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { child.off('error', onError); resolve(); };
      const onError = (error: Error) => { child.off('spawn', onSpawn); reject(error); };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    child.once('exit', (code, signal) => {
      const intentional = this.stopping !== null && this.child === child;
      const exit: DaemonExit = { code, signal, at: new Date().toISOString(), intentional };
      this.lastExit = exit;
      // daemon 自己退出时，它拉起的 Codex 等子进程可能还活着、还在写 /workspace。这里是唯一还
      // 握着进程组号的地方：句柄一清，随后的 reset 里 stop() 就找不到它们了，残留进程会跨任务
      // 改写下一个任务的目录（Codex P1）。所以在清句柄之前先把整个组收掉（先 SIGCONT 防止被冻结）。
      this.signalGroup(child, 'SIGCONT');
      this.signalGroup(child, 'SIGKILL');
      if (this.child === child) {
        this.child = null;
        this.handle = null;
      }
      if (!intentional) for (const listener of this.listeners) listener(exit);
    });
    return handle;
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      this.handle = null;
      return;
    }
    this.stopping = (async () => {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      this.signalGroup(child, 'SIGCONT');
      this.signalGroup(child, 'SIGTERM');
      const timeoutMs = this.options.stopTimeoutMs ?? 10_000;
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs).unref()),
      ]);
      if (timedOut) {
        this.signalGroup(child, 'SIGKILL');
        await exited;
      } else {
        // 进程组里可能还留着 Codex 之类的孙进程，一并收掉。
        this.signalGroup(child, 'SIGKILL');
      }
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  current(): DaemonHandle | null {
    return this.handle;
  }

  freeze(): void {
    if (this.child) this.signalGroup(this.child, 'SIGSTOP');
  }

  thaw(): void {
    if (this.child) this.signalGroup(this.child, 'SIGCONT');
  }

  onUnexpectedExit(listener: (exit: DaemonExit) => void): void {
    this.listeners.push(listener);
  }

  describe(): { running: boolean; pid: number | null; lastExit: DaemonExit | null } {
    return { running: this.child !== null, pid: this.child?.pid ?? null, lastExit: this.lastExit };
  }

  private signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }
}
