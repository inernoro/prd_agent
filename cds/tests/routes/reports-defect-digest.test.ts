/**
 * 结构化缺陷证据端到端契约测试：POST /api/reports 收下 → 持久化 → GET
 * /api/reports/defect-digest 算得出来。
 *
 * 为什么要走真实路由而不是只测纯函数：这条链路上每一段「删掉不会红」的接线都出过事
 * （predicate-and-wiring-discipline 形状 2）——
 *   - 路由不解析 defectRows：字段被 System.Text.Json 式地静默丢弃，纯函数测试照样全绿；
 *   - state 层不落盘：POST 返回 201 看着正常，重启后证据没了；
 *   - digest 路由注册在 `/reports/:id` 之后：`defect-digest` 被参数路由吞掉，404。
 * 这三处都不会让纯函数测试变红，只能靠这条端到端用例守。
 *
 * 红绿闭环记录（2026-08-02，逐条实测）：
 *   - 删掉 reports.ts POST 里的 `defectRows: normDefectRows(rawDefectRows)` → 「落盘」与
 *     「简报按模块聚类」用例变红；
 *   - 把 digest 路由挪到 `router.get('/reports/:id')` 之后 → 「路由不被 :id 吞掉」变红；
 *   - 删掉 state.ts buildAcceptanceReportMeta 里的 defectRows 赋值 → 「落盘」变红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StateService } from '../../src/services/state.js';
import { createReportsRouter } from '../../src/routes/reports.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

async function request(
  app: express.Express,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${url}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    server.close();
  }
}

const DEFECT_ROWS = [
  { severity: 'P0', id: 'D-01', symptom: '生成后预览空白', module: '视觉创作/编辑器' },
  // 小写 + 分隔符空格：同一个模块的等价写法，必须并进同一簇而不是分裂
  { severity: 'p1', id: 'D-02', symptom: '缩略图错位', module: '视觉创作 / 编辑器' },
  { severity: 'P2', id: 'D-03', symptom: '文案错别字', module: '报告中心' },
];

const ROOT_CAUSE_ROWS = [
  { cause: '解析器未接线', conclusion: '产品失败', action: '补接线' },
  { cause: '用例未覆盖', conclusion: '覆盖缺口', action: '补用例' },
];

describe('验收报告结构化缺陷证据 + 缺陷归因简报', () => {
  let stateFile: string;
  let stateService: StateService;
  let app: express.Express;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-digest-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    stateService = new StateService(stateFile);
    stateService.load();
    app = express();
    app.use('/api', createReportsRouter({ stateService }));
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    delete process.env.CDS_CACHE_BASE;
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createReport(extra: Record<string, unknown> = {}): Promise<string> {
    const res = await request(app, 'POST', '/api/reports', {
      title: '功能验收 · 视觉创作 · 2026-08-02',
      format: 'md',
      content: '# 验收\n\n正文',
      verdict: 'fail',
      defectRows: DEFECT_ROWS,
      rootCauseRows: ROOT_CAUSE_ROWS,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.report.id as string;
  }

  it('POST 收下结构化证据并落盘，GET /reports/:id 读得回来', async () => {
    const id = await createReport();

    // 落盘：直接查存储层，避开响应体可能的「算出来但没存」假象
    const stored = stateService.getAcceptanceReport(id);
    expect(stored?.defectRows).toHaveLength(3);
    expect(stored?.defectRows?.[0]).toMatchObject({ severity: 'P0', id: 'D-01', module: '视觉创作/编辑器' });
    expect(stored?.rootCauseRows).toHaveLength(2);
    expect(stored?.rootCauseRows?.[1]).toMatchObject({ conclusion: '覆盖缺口' });

    const got = await request(app, 'GET', `/api/reports/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.report.defectRows).toHaveLength(3);
  });

  it('严重度原文保留，归一化留给简报层（存储层不做第二份判据）', async () => {
    const id = await createReport();
    expect(stateService.getAcceptanceReport(id)?.defectRows?.[1].severity).toBe('p1');
  });

  it('空行 / 非对象元素被丢弃，不占统计位', async () => {
    const res = await request(app, 'POST', '/api/reports', {
      title: 'T', format: 'md', content: 'x',
      defectRows: [{}, 'not-an-object', null, { severity: 'P3', module: 'A' }],
    });
    expect(res.status).toBe(201);
    expect(stateService.getAcceptanceReport(res.body.report.id)?.defectRows).toEqual([
      { severity: 'P3', id: null, symptom: null, module: 'A' },
    ]);
  });

  it('defectRows 也接受 JSON 字符串（multipart 表单字段只能传字符串）', async () => {
    const res = await request(app, 'POST', '/api/reports', {
      title: 'T', format: 'md', content: 'x',
      defectRows: JSON.stringify([{ severity: 'P1', module: 'A' }]),
    });
    expect(res.status).toBe(201);
    expect(stateService.getAcceptanceReport(res.body.report.id)?.defectRows).toHaveLength(1);
  });

  it('GET /reports/defect-digest 不被 /reports/:id 参数路由吞掉', async () => {
    const res = await request(app, 'GET', '/api/reports/defect-digest');
    expect(res.status).toBe(200);
    expect(res.body.digest).toBeTruthy();
    // 被 :id 吞掉时返回的是 { error: 'not_found' }，这一条能把路由顺序钉住
    expect(res.body.digest.severityTotals).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
  });

  it('简报按模块聚类，等价写法合并，且数字点得回报告', async () => {
    const id = await createReport();
    const res = await request(app, 'GET', '/api/reports/defect-digest?days=30');
    expect(res.status).toBe(200);
    const digest = res.body.digest;

    expect(digest.windowDays).toBe(30);
    expect(digest.reportCount).toBe(1);
    expect(digest.reportsWithDefectRows).toBe(1);
    expect(digest.severityTotals).toEqual({ P0: 1, P1: 1, P2: 1, P3: 0 });
    expect(digest.verdictTotals.fail).toBe(1);

    expect(digest.clusters).toHaveLength(2);
    expect(digest.clusters[0].defectCount).toBe(2);      // 两种写法的「视觉创作/编辑器」合并
    expect(digest.clusters[0].reportIds).toEqual([id]);  // 追溯锚点
    expect(digest.clusters[0].worstSeverity).toBe('P0');

    expect(digest.rootCauses.map((r: any) => r.conclusion).sort()).toEqual(['产品失败', '覆盖缺口']);
  });

  it('days 参数被夹在 1..365，非法值退回默认 30', async () => {
    const huge = await request(app, 'GET', '/api/reports/defect-digest?days=99999');
    expect(huge.body.digest.windowDays).toBe(365);
    const zero = await request(app, 'GET', '/api/reports/defect-digest?days=0');
    expect(zero.body.digest.windowDays).toBe(1);
    const junk = await request(app, 'GET', '/api/reports/defect-digest?days=abc');
    expect(junk.body.digest.windowDays).toBe(30);
  });

  it('没有结构化证据的存量报告只计入 verdict 分布，不报错', async () => {
    const res = await request(app, 'POST', '/api/reports', {
      title: '旧报告', format: 'md', content: 'x', verdict: 'pass',
    });
    expect(res.status).toBe(201);
    const digest = (await request(app, 'GET', '/api/reports/defect-digest')).body.digest;
    expect(digest.reportCount).toBe(1);
    expect(digest.reportsWithDefectRows).toBe(0);
    expect(digest.verdictTotals.pass).toBe(1);
    expect(digest.clusters).toEqual([]);
  });
});
