import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 「是否正在忙」只有一个判据：同步的 busyRef（Codex P2，2026-09-24）。
 * React 的 generating 状态要等下一次渲染才更新，用户在重渲染之前连点两次、或在恢复在途任务
 * 的同步窗口里点发送，两次调用读到的都是旧的 generating === false：第二次只中断了第一次的
 * 流，却中断不了它已发出的创建请求，于是服务端建出两个任务，其中一个在后台计费却没人看得见。
 * 新建与修改两个入口必须用同一个判据。
 */
const hooks = [
  { name: '新建网页', file: './workbench/useSiteGenerationRun.ts', entry: 'const start = async (' },
  { name: '修改网页', file: './workbench/useSiteEditSession.ts', entry: 'const generate = async (' },
];

describe('提交入口的忙碌判据', () => {
  for (const hook of hooks) {
    it(`${hook.name}：入口守卫检查同步的 busyRef`, () => {
      const source = readFileSync(new URL(hook.file, import.meta.url), 'utf8');
      const entryAt = source.indexOf(hook.entry);
      expect(entryAt, `${hook.entry} 不见了，契约可能被挪走了`).toBeGreaterThan(-1);
      const guardEnd = source.indexOf('return;', entryAt);
      const guard = source.slice(entryAt, guardEnd);
      expect(guard, '入口的第一道守卫没有读 busyRef.current：重渲染之前连点会建出两个任务')
        .toContain('busyRef.current');
      const markAt = source.indexOf('busyRef.current = true;', entryAt);
      const firstAwait = source.indexOf('await ', entryAt);
      expect(markAt, '入口没有同步标记忙碌').toBeGreaterThan(-1);
      expect(markAt, '忙碌标记排在了第一个 await 之后：等待期间的第二次点击看不见它').toBeLessThan(firstAwait);
    });
  }
});
