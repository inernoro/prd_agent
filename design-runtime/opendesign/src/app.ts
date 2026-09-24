// 组装：配置 → 引擎进程 → 生命周期（隔离方案 A）→ 执行器 → 任务槽 → HTTP。
// 入口 index.ts 与协议层测试走同一个组装函数，测试只替换引擎进程与 fetch，不另拼一套接线。
import type http from 'node:http';
import { fileURLToPath } from 'node:url';

import type { ServiceConfig } from './config.js';
import { OpenDesignDaemon, type EngineDaemon } from './engine/daemon.js';
import type { EgressRelay, EgressRelayOptions } from './engine/egress-relay.js';
import { EngineLifecycle } from './engine/lifecycle.js';
import { runEngineSelfCheck, type EngineSelfCheck } from './engine/self-check.js';
import { DesignTaskExecutor } from './executor.js';
import { createServer } from './http/server.js';
import { TaskManager } from './tasks.js';

export interface DesignRuntimeOverrides {
  daemon?: EngineDaemon;
  fetchImpl?: typeof fetch;
  selfCheck?: EngineSelfCheck;
  pollIntervalMs?: number;
  startRelay?: (options: EgressRelayOptions) => Promise<EgressRelay>;
  resetRetryBaseMs?: number;
  log?: (line: string) => void;
}

export interface DesignRuntime {
  server: http.Server;
  tasks: TaskManager;
  lifecycle: EngineLifecycle;
  /** 首次清空目录并拉起引擎；失败时槽位进入 blocked 并自动重试，不抛出。 */
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createDesignRuntime(config: ServiceConfig, overrides: DesignRuntimeOverrides = {}): Promise<DesignRuntime> {
  const log = overrides.log ?? ((line: string) => console.log(line));
  const daemon = overrides.daemon ?? new OpenDesignDaemon({
    command: config.odCommand,
    cwd: config.odCwd,
    port: config.odPort,
    dataDir: config.odDataDir,
    workspaceDir: config.workspaceDir,
    uid: config.engineUid,
    gid: config.engineGid,
    home: config.engineHome,
    log,
  });
  const lifecycle = new EngineLifecycle({
    daemon,
    directories: {
      workspaceDir: config.workspaceDir,
      dataDir: config.odDataDir,
      templatesDir: config.templatesDir,
      outputDir: config.outputDir,
    },
    fetchImpl: overrides.fetchImpl,
    pollIntervalMs: overrides.pollIntervalMs,
    engineUid: config.engineUid,
    engineGid: config.engineGid,
    // 服务自己的代码目录（镜像里是 /opt/map-design-runtime/dist）、工作目录与只读资源都不许落进任务目录。
    protectedPaths: [fileURLToPath(new URL('.', import.meta.url)), process.cwd(), config.webPrototypeSourceDir, config.designSystemsDir],
  });
  const executor = new DesignTaskExecutor({
    paths: {
      workspaceDir: config.workspaceDir,
      dataDir: config.odDataDir,
      templatesDir: config.templatesDir,
      outputDir: config.outputDir,
      webPrototypeSourceDir: config.webPrototypeSourceDir,
    },
    daemon,
    fetchImpl: overrides.fetchImpl,
    pollIntervalMs: overrides.pollIntervalMs,
    relayPort: config.egressPort,
    engineUid: config.engineUid,
    engineGid: config.engineGid,
    startRelay: overrides.startRelay,
  });
  const tasks = new TaskManager({
    run: (task, signal, onCreatingStage, onStage) => executor.run(task, signal, onCreatingStage, onStage),
    lifecycle,
    resetRetryBaseMs: overrides.resetRetryBaseMs,
    log,
  });
  const selfCheck = overrides.selfCheck ?? await runEngineSelfCheck({
    codexBin: config.codexBin,
    webPrototypeSourceDir: config.webPrototypeSourceDir,
    designSystemsDir: config.designSystemsDir,
  });
  const server = createServer({
    apiKey: config.apiKey,
    apiKeyConfigured: config.apiKey.length > 0,
    selfCheck,
    lifecycle,
    tasks,
  });
  return {
    server,
    tasks,
    lifecycle,
    start: () => tasks.start(),
    shutdown: async () => {
      await tasks.shutdown();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
