// 进程入口：读配置、组装服务、先开 HTTP（能力接口在引擎拉起前就能如实回答「正在启动」），
// 再清空工作目录并拉起 OpenDesign。SIGTERM / SIGINT 时停止引擎进程组后退出。
import { createDesignRuntime } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await createDesignRuntime(config);
  await new Promise<void>((resolve) => runtime.server.listen(config.port, '0.0.0.0', resolve));
  console.log(`[design-runtime] map-design-executor-v1 listening on :${config.port}`
    + (config.apiKey ? '' : '（未配置 DESIGN_RUNTIME_API_KEY：任务接口全部拒绝，见 /v1/capabilities）'));
  void runtime.start();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[design-runtime] received ${signal}, stopping the engine and exiting`);
    runtime.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[design-runtime] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
