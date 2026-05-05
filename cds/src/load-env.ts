import fs from 'node:fs';
import path from 'node:path';
import { warnLegacyCdsEnvKeys } from './config/known-env-keys.js';

/**
 * `.cds.env` self-loader —— 在 Node 启动最早期把磁盘上的 env 注入 process.env。
 *
 * ⚠️ 必须放在独立 module 里，让任何 import 它的 module（如 `config.ts`）在
 * top-level 评估自己的 module-scope 常量之前，先经过这里 side-effect。
 *
 * 历史教训（2026-05-05 确诊的两个 bug 同时显形）：
 *
 *   Bug 1（ES module 导入顺序）：原版本 `loadCdsEnvFile()` 写在 `index.ts:98`
 *   函数体里调用，但 `index.ts` 顶部的 `import { loadConfig } from './config.js'`
 *   会**先**触发 `config.ts` 的模块顶层求值——`DEFAULT_CONFIG.githubApp =
 *   resolveGitHubApp()` 在那一刻就读 `process.env`，但此时 self-loader 还
 *   没跑！结果 GitHub App config 永远 undefined，`/api/github/app` 一直
 *   报 `configured: false`，webhook 永远拒收 503，即便磁盘 .cds.env 配
 *   得好好的。把这一坨抽到独立 module + 在 `config.ts` 顶部 side-effect
 *   import 它，能确保 env 在 DEFAULT_CONFIG 求值之前就位。
 *
 *   Bug 2（self-update spawn 透传 stale env）：`branches.ts` 的 self-update /
 *   self-force-sync 端点 spawn 子进程时用 `env: { ...process.env }`。如果
 *   父进程 env 里某 key 是空字符串（曾经被 init 写过空值，或被 unset 后
 *   又被某个工具回填空），子进程继承到的也是空字符串。原 self-loader
 *   语义是「process.env[key] === undefined 才覆盖」——空字符串不算
 *   undefined，于是空值被保留下来。改成「只要假值（空串/undefined）就用
 *   磁盘最新值覆盖」可同时解决这条路径的 stale。
 *
 * 不变式：systemd `Environment=KEY=non-empty` / shell `export KEY=non-empty`
 * 显式注入的非空值仍然有最高优先级，self-loader 不动它们。
 */

function loadCdsEnvFile(): void {
  const candidates = [
    path.resolve(process.cwd(), '.cds.env'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.cds.env'),
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const content = fs.readFileSync(envPath, 'utf-8');
      const lineRe = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S*))\s*$/;
      let loaded = 0;
      let overwrote = 0;
      const loadedKeys: string[] = [];
      for (const line of content.split('\n')) {
        if (!line || /^\s*#/.test(line)) continue;
        const m = line.match(lineRe);
        if (!m) continue;
        const key = m[1];
        const raw = m[2] ?? m[3] ?? m[4] ?? '';
        const value = (m[2] !== undefined)
          ? raw.replace(/\\(.)/g, '$1')
          : raw;
        const existing = process.env[key];
        // 空字符串视同未配置——透过 spawn 透传过来的 stale 空值要被磁盘最新值覆盖。
        // 非空值 = 运维或上层显式注入，保留它们的最高优先级。
        if (existing === undefined || existing === '') {
          if (existing === '' && value !== '') overwrote++;
          process.env[key] = value;
          loaded++;
        }
        loadedKeys.push(key);
      }
      if (loaded > 0) {
        // logger 还没起来，先用 console.log 打到 cds.log
        const overwroteSuffix = overwrote > 0 ? ` (覆盖 ${overwrote} 个空字符串占位)` : '';
        console.log(`[cds-env-loader] 从 ${envPath} 加载 ${loaded} 个变量到 process.env${overwroteSuffix}`);
      }
      warnLegacyCdsEnvKeys(loadedKeys, envPath);
      return;
    } catch (err) {
      console.warn(`[cds-env-loader] 跳过 ${envPath}: ${(err as Error).message}`);
    }
  }
}

// 模块加载时自动执行——任何 `import './load-env.js'` 都触发一次。
// 重复 import 不会重复执行（ES module 缓存），所以幂等。
loadCdsEnvFile();
