import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「全部能力」页的基础设施分组另有一份清单。
 *
 * navCoverage 守的是 NAV_REGISTRY 与 App 路由的对账，绿了只说明路由能走通、命令面板搜得到；
 * 但 AgentLauncherPage（桌面首页 / 全部能力）的 infra 那一组读的**不是** launcherCatalog，
 * 而是 homeLauncherItems.ts 里手写的 buildStaticInfra。于是会出现这种情况：
 * 在 NAV_REGISTRY 登记了 section:'infra'、navCoverage 全绿、`pnpm test` 1461 全过，
 * 真人打开「全部能力」却一个入口都看不见——本次数据同步就是这么栽的
 * （predicate-and-wiring-discipline 形状 2：建了一半的接线，删掉也不会红）。
 *
 * 彻底的修法是让 infra 组直接派生自 NAV_REGISTRY，但那要动首页的分组与排序，
 * 不在本次范围内（rule 5.5 B 类）。这里先立一道棘轮：**已知没接上的只许减不许增**，
 * 让下一个往 infra 加入口的人当场看见这份清单的存在，而不是等到验收时才发现点不到。
 */

const SRC = path.resolve(__dirname, '../..');

/** 已知未接进 buildStaticInfra 的 infra 路由。只许删，不许加。 */
const KNOWN_MISSING = new Set([
  // 子路由：本来就不该作为独立入口出现在首页，靠父级 /document-store 进入。
  '/document-store/universe',
  '/document-store/:storeId/universe',
  // 存量欠债，与本次改动无关，记在 debt.frontend.md，走到时再补。
  '/learning-center',
  '/infra-services',
  '/admin-web-pages',
]);

function readInfraRoutesFromRegistry(): string[] {
  const source = fs.readFileSync(path.join(SRC, 'app/navRegistry.tsx'), 'utf8');
  // 一个条目从 path 到它自己的 section，中间不允许跨过下一个 path——
  // 否则会把后一条的 section 认到前一条头上（形状 6：取值取错了那一份）。
  const entries = [...source.matchAll(/path:\s*'([^']+)'([\s\S]*?)(?=\n\s*\{\s*\n\s*(?:\/\/[^\n]*\n\s*)*path:\s*'|$)/g)]
    .filter(([, , body]) => /section:\s*'infra'/.test(body))
    .map(([, p]) => p);
  expect(entries.length, 'navRegistry 里一条 section=infra 都没解析出来，正则多半失效了').toBeGreaterThan(5);
  return entries;
}

function readLauncherRoutes(): Set<string> {
  const source = fs.readFileSync(path.join(SRC, 'lib/homeLauncherItems.ts'), 'utf8');
  const routes = [...source.matchAll(/routePath:\s*'([^']+)'/g)].map(([, p]) => p);
  expect(routes.length, 'homeLauncherItems 里一条 routePath 都没解析出来，正则多半失效了').toBeGreaterThan(10);
  return new Set(routes);
}

describe('全部能力页的基础设施入口覆盖', () => {
  it('新增的 infra 入口必须同时接进 buildStaticInfra，否则首页点不到', () => {
    const inLauncher = readLauncherRoutes();
    const missing = readInfraRoutesFromRegistry().filter((p) => !inLauncher.has(p) && !KNOWN_MISSING.has(p));
    expect(
      missing,
      '下列路由在 NAV_REGISTRY 登记为 section:\'infra\'，但 homeLauncherItems.ts 的 buildStaticInfra 里没有，'
        + '「全部能力」页的基础设施分组不会出现它们。请在 buildStaticInfra 补一条：\n  '
        + missing.join('\n  '),
    ).toEqual([]);
  });

  it('棘轮只许收紧：豁免名单里不能留已经接好的路由', () => {
    const inLauncher = readLauncherRoutes();
    const stale = [...KNOWN_MISSING].filter((p) => inLauncher.has(p));
    expect(stale, `这些路由已经接进 buildStaticInfra，请把它们从 KNOWN_MISSING 里删掉：${stale.join(', ')}`).toEqual([]);
  });

  it('数据同步入口真的在清单里', () => {
    // 这一条是本次的具体标的：它曾经只登记在 NAV_REGISTRY，
    // 全量测试绿、真人在「全部能力」页搜不到。
    expect(readLauncherRoutes().has('/data-sync')).toBe(true);
  });
});
