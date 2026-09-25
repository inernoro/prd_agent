// 运行配置：全部来自环境变量，默认值对应生产镜像（design-runtime/opendesign/Dockerfile）里的布局。
// 密钥只有一个：DESIGN_RUNTIME_API_KEY。它只在本进程内存里使用，不写进任何文件、日志或引擎进程的环境。

export interface ServiceConfig {
  port: number;
  apiKey: string;
  workspaceDir: string;
  odDataDir: string;
  templatesDir: string;
  outputDir: string;
  webPrototypeSourceDir: string;
  designSystemsDir: string;
  odPort: number;
  odCommand: string[];
  odCwd: string;
  engineHome: string;
  engineUid?: number;
  engineGid?: number;
  egressPort: number;
  codexBin: string;
}

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function optionalInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  return integer(value, 0, name);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: integer(env.DESIGN_RUNTIME_PORT, 8093, 'DESIGN_RUNTIME_PORT'),
    apiKey: (env.DESIGN_RUNTIME_API_KEY || '').trim(),
    workspaceDir: env.DESIGN_RUNTIME_WORKSPACE_DIR || '/workspace',
    odDataDir: env.DESIGN_RUNTIME_OD_DATA_DIR || '/app/.od',
    templatesDir: env.DESIGN_RUNTIME_TEMPLATES_DIR || '/app/design-templates',
    outputDir: env.DESIGN_RUNTIME_OUTPUT_DIR || '/var/lib/map-design-runtime/output',
    webPrototypeSourceDir: env.DESIGN_RUNTIME_WEB_PROTOTYPE_SOURCE || '/app/plugins/_official/examples/web-prototype',
    designSystemsDir: env.DESIGN_RUNTIME_DESIGN_SYSTEMS_DIR || '/app/design-systems',
    odPort: integer(env.DESIGN_RUNTIME_OD_PORT, 7456, 'DESIGN_RUNTIME_OD_PORT'),
    odCommand: env.DESIGN_RUNTIME_OD_COMMAND
      ? env.DESIGN_RUNTIME_OD_COMMAND.split(' ').filter(Boolean)
      : [process.execPath, 'apps/daemon/dist/cli.js', '--no-open'],
    odCwd: env.DESIGN_RUNTIME_OD_CWD || '/app',
    engineHome: env.DESIGN_RUNTIME_ENGINE_HOME || '/home/open-design',
    engineUid: optionalInteger(env.DESIGN_RUNTIME_ENGINE_UID ?? '1001', 'DESIGN_RUNTIME_ENGINE_UID'),
    engineGid: optionalInteger(env.DESIGN_RUNTIME_ENGINE_GID ?? '1001', 'DESIGN_RUNTIME_ENGINE_GID'),
    egressPort: integer(env.DESIGN_RUNTIME_EGRESS_PORT, 8787, 'DESIGN_RUNTIME_EGRESS_PORT'),
    codexBin: env.DESIGN_RUNTIME_CODEX_BIN || 'codex',
  };
}
