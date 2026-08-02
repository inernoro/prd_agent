/**
 * 接线守卫：验收报告归档 → 事件总线 → 站内信深链，整条链必须真的连着。
 *
 * 为什么必须有这一套：判据（acceptance-severity）和文案表（cds-events-bus）各自都有
 * 单测，两边都能独立跑绿 —— 但**中间那一步接没接上，谁都测不到**。历史上这条链
 * 断了很久：CDS 的 defectCounts 字段自 E1 就在，报告归档后却一个事件都不发，
 * 于是「昨天报出 2 个 P0」只有主动翻报告中心的人知道。
 *
 * 判据（.claude/rules/predicate-and-wiring-discipline.md 形状 2）：把 reports.ts 里
 * 那行 publishBlockingAcceptance(...) 删掉，本套件必须变红。删掉后如果还是绿的，
 * 说明守卫本身是假的。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { StateService } from '../../src/services/state.js';
import { createReportsRouter } from '../../src/routes/reports.js';
import { cdsEventsBus, type CdsEventEnvelope } from '../../src/services/cds-events-bus.js';
import { renderNoticeFromEvent } from '../../src/services/notice-ledger.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

async function postReport(server: http.Server, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/api/reports',
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: any = raw;
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('验收阻断缺陷播报 —— 归档到站内信的整条接线', () => {
  let server: http.Server;
  let stateFile: string;
  let service: StateService;
  let events: CdsEventEnvelope[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-acc-notice-'));
    stateFile = path.join(tmpDir, 'state.json');
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    service = new StateService(stateFile);
    service.load();

    events = [];
    unsubscribe = cdsEventsBus.subscribe((envelope) => { events.push(envelope); });

    const app = express();
    app.use('/api', createReportsRouter({ stateService: service }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  afterEach(async () => {
    unsubscribe?.();
    await flushAllJsonStateStores();
    server?.close();
    delete process.env.CDS_CACHE_BASE;
    await (service.getBackingStore() as unknown as { flush(): Promise<void> }).flush().catch(() => {});
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const blocking = () => events.filter((e) => e.type === 'acceptance.report.blocking');

  it('P0 报告归档后发出阻断事件，正文带报告标题、原因与各档位计数', async () => {
    const res = await postReport(server, {
      title: '每日验收 2026-08-02',
      format: 'md',
      content: '# 每日验收',
      verdict: 'fail',
      defectCounts: { P0: 2, P1: 1, P2: 0, P3: 0 },
    });
    expect(res.status).toBe(201);

    expect(blocking()).toHaveLength(1);
    const data = blocking()[0].data as { message: string; reportId: string; conflict: boolean };
    expect(data.reportId).toBe(res.body.report.id);
    expect(data.message).toContain('每日验收 2026-08-02');
    expect(data.message).toContain('2 个 P0');
    expect(data.message).toContain('P0 2 / P1 1');
    expect(data.conflict).toBe(false);
  });

  it('干净的通过报告不发事件 —— 铃不该为常态响', async () => {
    const res = await postReport(server, {
      title: '通过的验收',
      format: 'md',
      content: '# ok',
      verdict: 'pass',
      defectCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    });
    expect(res.status).toBe(201);
    expect(blocking()).toHaveLength(0);
  });

  it('有条件通过 + 若干 P1 是每日常态，同样不发事件', async () => {
    await postReport(server, {
      title: '有条件通过',
      format: 'md',
      content: '# c',
      verdict: 'conditional',
      defectCounts: { P0: 0, P1: 3, P2: 5 },
    });
    expect(blocking()).toHaveLength(0);
  });

  it('自称通过却带 P1 —— 结论与缺陷矛盾，必须响并标记 conflict', async () => {
    await postReport(server, {
      title: '自称通过的验收',
      format: 'md',
      content: '# x',
      verdict: 'pass',
      defectCounts: { P1: 2 },
    });
    expect(blocking()).toHaveLength(1);
    expect((blocking()[0].data as { conflict: boolean }).conflict).toBe(true);
  });

  it('小写键同样触发 —— cdscli 的 --defects 写的就是小写', async () => {
    await postReport(server, {
      title: '小写键',
      format: 'md',
      content: '# x',
      verdict: 'conditional',
      defectCounts: { p0: 1 },
    });
    expect(blocking()).toHaveLength(1);
  });

  it('渲染成站内信：danger 级 + 落到那份报告的最终深链（带项目与文件夹）', async () => {
    service.addProject({ id: 'proj-main', slug: 'prd-agent', name: '主站' } as never);
    const folderId = service.findOrCreateFolderPath('proj-main', '每日验收');
    const res = await postReport(server, {
      title: '带项目的验收',
      format: 'md',
      content: '# x',
      verdict: 'fail',
      projectId: 'proj-main',
      folderId,
    });
    expect(res.status).toBe(201);
    // 项目与文件夹必须真的落到报告上，否则下面的深链断言会退化成空跑。
    expect(res.body.report.projectId).toBe('proj-main');
    expect(res.body.report.folderId).toBe(folderId);

    const notice = renderNoticeFromEvent(blocking()[0]);
    expect(notice).not.toBeNull();
    expect(notice!.level).toBe('danger');
    expect(notice!.title).toBe('验收发现阻断级缺陷');
    expect(notice!.source).toBe('acceptance');
    expect(notice!.actionLabel).toBe('查看验收报告');
    // 最终地址而非中间地址（CLAUDE.md §11）：三个参数齐了才能一步落到那份报告。
    // 少 project 列表按 projectId 过滤会命中空集（点开白屏），少 folder 左侧不高亮。
    expect(notice!.href).toContain('/reports?');
    expect(notice!.href).toContain('project=proj-main');
    expect(notice!.href).toContain(`folder=${folderId}`);
    expect(notice!.href).toContain(`report=${res.body.report.id}`);
    expect(notice!.projectName).toBe('主站');
  });

  it('两份报告十分钟内先后归档，合并键互不相同（否则第二份会被静默吞掉）', async () => {
    const a = await postReport(server, { title: 'A', format: 'md', content: '# a', verdict: 'fail' });
    const b = await postReport(server, { title: 'B', format: 'md', content: '# b', verdict: 'fail' });
    expect(blocking()).toHaveLength(2);

    const keyA = renderNoticeFromEvent(blocking()[0])!.dedupeKey;
    const keyB = renderNoticeFromEvent(blocking()[1])!.dedupeKey;
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain(a.body.report.id);
    expect(keyB).toContain(b.body.report.id);
  });

  it('非验收类报告（无 verdict 无计数）静默归档，不打扰任何人', async () => {
    const res = await postReport(server, { title: '随手记', format: 'md', content: '# note' });
    expect(res.status).toBe(201);
    expect(blocking()).toHaveLength(0);
  });
});
