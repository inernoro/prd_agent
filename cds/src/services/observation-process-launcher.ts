import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export function launchObservationProcess(kind: 'observation-process' | 'observation-executor-process', owner: string): ChildProcess {
  if (!/^cds-observation-[a-f0-9]{32}$/.test(owner)) throw new Error('Invalid observation process owner');
  const compiled = new URL(`./${kind}.js`, import.meta.url);
  const script = existsSync(compiled)
    ? `import(${JSON.stringify(compiled.href)});`
    : `require(${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))}).tsImport(${JSON.stringify(new URL(`./${kind}.ts`, import.meta.url).href)}, { parentURL: ${JSON.stringify(import.meta.url)} });`;
  const env: NodeJS.ProcessEnv = {};
  // 启动环境不复制 Master 凭据或 NODE_OPTIONS。每条查询单独下传完整环境快照。
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return spawn(process.execPath, ['--input-type=commonjs', '--max-old-space-size=128', '--eval', script, '--', owner], {
    detached: true, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
  });
}
