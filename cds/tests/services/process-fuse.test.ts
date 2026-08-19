import { describe, it, expect, vi } from 'vitest';
import { installProcessFuse } from '../../src/services/process-fuse.js';
import { OffHostAuditLogSink } from '../../src/services/offhost-audit-log.js';

/**
 * 2026-08-18 事故的回归：一个后台小事失败，把整台 CDS 弄死了 18 分钟。
 *
 * 链条是「离机审计上传 401 → 失败被 rethrow 进没人接的 promise 链 → Node 默认
 * 把无人处理的拒绝当致命错误 → 进程退出 → systemd 反复重启超限 → 全站不可用」。
 *
 * 这里两头都钉：**引信**（sink 不许 rethrow）和**保险丝**（真出现无人处理的拒绝
 * 也不许死）。只钉一头都不够——引信这次拆了，下一个后台任务还会长出新的。
 */

const noopStore = () => {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    record: (r: Record<string, unknown>) => { records.push(r); },
    flush: async () => undefined,
  };
};

describe('总保险丝', () => {
  it('无人处理的拒绝：记一笔，但不退出进程', () => {
    const handlers: Record<string, (arg: unknown) => void> = {};
    const store = noopStore();
    const exit = vi.fn();
    const fuse = installProcessFuse({
      store: store as never,
      processName: 'cds-master',
      target: { on: ((ev: string, fn: (arg: unknown) => void) => { handlers[ev] = fn; }) as never },
      exit,
      logger: { error: () => undefined },
    });

    handlers.unhandledRejection(new Error('离机对象上传失败（HTTP 401）'));

    expect(exit, '兜住拒绝之后不该退出——退出正是这次事故本身').not.toHaveBeenCalled();
    expect(fuse.rejectionCount()).toBe(1);
    expect(fuse.lastRejection()?.message).toContain('401');
    const ev = store.records.at(-1) as Record<string, unknown>;
    expect(ev.action).toBe('process.unhandled-rejection');
    expect(ev.severity).toBe('error');   // 兜住了也要看得见，不许静默
  });

  it('未捕获异常：留下调用栈再退出，不改变生死', async () => {
    // 这一半不是为了续命——那时进程状态可能已经不一致。它只保证「死之前留下证据」：
    // 这次事故里进程死了，事件流一个字都没有，只能靠 systemd 那句话猜。
    const handlers: Record<string, (arg: unknown) => void> = {};
    const store = noopStore();
    const exit = vi.fn();
    installProcessFuse({
      store: store as never,
      processName: 'cds-master',
      target: { on: ((ev: string, fn: (arg: unknown) => void) => { handlers[ev] = fn; }) as never },
      exit,
      logger: { error: () => undefined },
    });

    handlers.uncaughtException(new Error('boom'));
    await new Promise((r) => setTimeout(r, 10));   // flush 是异步的

    const ev = store.records.at(-1) as Record<string, unknown>;
    expect(ev.action).toBe('process.uncaught-exception');
    expect(String((ev.details as Record<string, unknown>).stack)).toContain('boom');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('两个进程入口都装了保险丝', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const entry of ['src/index.ts', 'src/forwarder-main.ts']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), entry), 'utf8');
      expect(src, `${entry} 没装保险丝`).toContain('installProcessFuse(');
    }
  });
});

describe('离机审计失败不再产生无人处理的拒绝', () => {
  /** 造一个必然 401 的 fetch，复刻线上那台机器的行为。 */
  const failing401 = (): typeof fetch => (async () => new Response('Unauthorized', {
    status: 401, statusText: 'Unauthorized',
  })) as unknown as typeof fetch;

  const sink = (): { s: OffHostAuditLogSink; store: ReturnType<typeof noopStore> } => {
    const store = noopStore();
    const s = new OffHostAuditLogSink({
      primary: store as never,
      config: {
        endpoint: 'https://example.invalid', bucket: 'b',
        accessKeyId: 'k', secretAccessKey: 's', prefix: 'p',
      } as never,
      prefix: 'p/audit-log',
      fetchImpl: failing401(),
    });
    return { s, store };
  };

  it('上传 401 时不抛进链条——真正监听 unhandledRejection 验一次', async () => {
    const caught: unknown[] = [];
    const onRejection = (r: unknown): void => { caught.push(r); };
    process.on('unhandledRejection', onRejection);
    try {
      const { s, store } = sink();
      s.record({ category: 'system', severity: 'info', source: 't', action: 'a' } as never);
      // 这里**绝不能** await flush()：flush 内部有 `.catch()`，会把拒绝「接住」，
      // 于是雷被测试自己拆了，事故写法照样绿。第一版就是这么写的，红绿闭环时
      // 只有另一条用例变红才发现。只等真实的 tick，让 Node 自己判定有没有人接。
      await new Promise((r) => setTimeout(r, 50));

      expect(caught, '出现了无人处理的拒绝——这正是把 CDS 打死的那一步').toEqual([]);
      const ev = store.records.find((r) => r.action === 'offhost.audit.write.failed');
      expect(ev, '失败必须被记下来：不许为了不崩就把错误藏掉').toBeTruthy();
      expect(String((ev as Record<string, unknown>).message)).toContain('连续第 1 次');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('连续失败次数累计，成功一次归零——「一直哑着」要能被看出来', async () => {
    const { s } = sink();
    s.record({ category: 'system', severity: 'info', source: 't', action: 'a' } as never);
    s.record({ category: 'system', severity: 'info', source: 't', action: 'b' } as never);
    await s.flush();
    expect(s.consecutiveFailures()).toBe(2);
    expect(s.lastFailure()).toContain('401');
  });
});
