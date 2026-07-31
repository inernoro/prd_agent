/**
 * 自更新失败归因的接线守卫。
 *
 * 归因模块本身有单测（self-update-failure-diagnosis.test.ts），但那只证明
 * 「函数算得对」，不证明「有人在用它」。predicate-and-wiring-discipline 形状 2：
 * 链路只建到一半时，删掉接线测试仍全绿——本文件就是补那条守卫。
 *
 * 守两件事：
 *   1. 两条自更新路由的失败出口都走归因，没有人偷偷 sendSSE 一个裸 message；
 *   2. 外部工具的原始输出（errMsg / validation.error / Error.message）不许再被
 *      拼进 message 模板——那正是用户投诉的「壳是中文芯是英文」。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRANCHES = fs.readFileSync(path.join(ROOT, 'src/routes/branches.ts'), 'utf-8');

/** 截出一条路由的源码块（从 router.post('<route>' 到下一个 router. 声明）。 */
function routeSource(route: string): string {
  const start = BRANCHES.indexOf(`router.post('${route}'`);
  expect(start, `找不到路由 ${route}——它被改名或删了，本守卫需要同步更新`).toBeGreaterThan(-1);
  const rest = BRANCHES.slice(start + 10);
  const nextIdx = rest.search(/\n {2}router\.(post|get|put|delete|patch)\(/);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

const SELF_UPDATE = routeSource('/self-update');
const FORCE_SYNC = routeSource('/self-force-sync');

describe('自更新失败归因接线', () => {
  it('归因模块确实被 branches.ts 引用（不是建了没人用）', () => {
    expect(BRANCHES).toContain("from '../services/self-update-failure-diagnosis.js'");
    expect(BRANCHES).toContain('diagnoseSelfUpdateFailure(');
  });

  it('两条自更新路由都建了统一失败出口 failWith', () => {
    expect(SELF_UPDATE).toContain('const failWith =');
    expect(FORCE_SYNC).toContain('const failWith =');
  });

  for (const [name, source] of [['/self-update', SELF_UPDATE], ['/self-force-sync', FORCE_SYNC]] as const) {
    it(`${name} 的每个 SSE 失败出口都带 cause 字段`, () => {
      // 逐个 sendSSE(res, 'error', {...}) 检查其对象字面量里有 cause。
      const offenders: string[] = [];
      const marker = "sendSSE(res, 'error', {";
      let idx = source.indexOf(marker);
      while (idx !== -1) {
        const block = source.slice(idx, idx + 700);
        const objectEnd = block.indexOf('});');
        const payload = objectEnd === -1 ? block : block.slice(0, objectEnd);
        if (!payload.includes('cause:')) {
          offenders.push(payload.split('\n').slice(0, 3).join(' ').trim());
        }
        idx = source.indexOf(marker, idx + marker.length);
      }
      expect(offenders, `${name} 有失败出口没走归因：${offenders.join(' | ')}`).toEqual([]);
    });

    it(`${name} 不再把工具原始输出拼进 message`, () => {
      // 这些变量装的都是 git / pnpm / tsc / esbuild 的原文（多为英文）。
      // 它们只能出现在 raw: 字段里，不许进 message 模板。
      const rawVars = ['${errMsg', '${validation.error', '${(err as Error).message', '${(swapErr as Error).message'];
      const offenders: string[] = [];
      for (const line of source.split('\n')) {
        if (!line.includes('message:')) continue;
        for (const rawVar of rawVars) {
          if (line.includes(rawVar)) offenders.push(line.trim());
        }
      }
      expect(offenders, `${name} 仍在把英文原文塞进 message：${offenders.join(' | ')}`).toEqual([]);
    });
  }

  it('失败记录同时落中文归因和英文原文，便于事后复盘', () => {
    // recordFailure 收第二个参数（failure 结构体）；只落 error 字符串会丢掉 raw。
    expect(SELF_UPDATE).toContain('failure: {');
    expect(FORCE_SYNC).toContain('failure: {');
  });
});

describe('前端把中文归因当主文案', () => {
  const maintenance = fs.readFileSync(
    path.join(ROOT, 'web/src/pages/cds-settings/tabs/MaintenanceTab.tsx'),
    'utf-8',
  );
  const badge = fs.readFileSync(path.join(ROOT, 'web/src/components/GlobalUpdateBadge.tsx'), 'utf-8');

  it('更新历史用失败卡渲染，而不是直接铺一段原文', () => {
    expect(maintenance).toContain('SelfUpdateFailureCard');
    // 原始输出必须是折叠的：details/summary 是这里的可见性契约。
    expect(maintenance).toContain('原始输出');
    expect(maintenance).toMatch(/<details/);
  });

  it('更新徽章弹窗读 cause/nextAction，不再只有一串 message', () => {
    expect(badge).toContain('data.cause');
    expect(badge).toContain('data.nextAction');
    expect(badge).toContain('下一步');
  });
});
