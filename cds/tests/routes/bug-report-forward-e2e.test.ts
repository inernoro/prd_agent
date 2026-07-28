/**
 * 快捷提缺陷：转发链路端到端验收（2026-07-28）。
 *
 * PR #1273 修了两件此前只有源码守卫的事：
 *   1. 附件必须在 submit **之前**上传到缺陷系统——否则单子里只有文件名没有图，
 *      而 UI 照报「已提交」（谎报成功）；
 *   2. 前端总量闸必须按 **base64 字符数** 判定，与后端同口径——按解码字节算的话
 *      两张 5MB 图在前端放行、提交后才被后端拒。
 *
 * 这里用**真 HTTP**（本地起一个假 MAP 服务）+ **真 global fetch / FormData / Blob**
 * （不注入 fetchImpl）跑完整转发链路，断言请求顺序与真实收到的字节；
 * 前端闸门用**真实 5MB 量级**的 base64 走真函数。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBugReportsRouter } from '../../src/routes/bug-reports.js';
import {
  validateBugReportDraft,
  totalAttachmentBase64Chars,
  MAX_TOTAL_ATTACHMENT_BASE64_CHARS,
} from '../../../llmgw/web/src/components/BugReportCore.js';

interface MapHit {
  method: string;
  url: string;
  contentType: string;
  /** multipart 请求里真实收到的字节数（只对附件上传有意义）。 */
  bodyBytes: number;
  /** multipart 里解析出的文件名。 */
  filename: string | null;
}

let mapServer: http.Server;
let mapUrl: string;
let hits: MapHit[];
let app: express.Express;
let appServer: http.Server;
let appUrl: string;
let dataDir: string;

beforeEach(async () => {
  hits = [];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bugfwd-e2e-'));

  // 假 MAP：只关心「谁先被调、收到了什么」。
  mapServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('latin1');
      const nameMatch = /filename="([^"]*)"/.exec(text);
      hits.push({
        method: req.method || '',
        url: req.url || '',
        contentType: String(req.headers['content-type'] || ''),
        bodyBytes: body.length,
        // body 按 latin1 读的（为了不破坏二进制），文件名要按 UTF-8 还原回来
        filename: nameMatch ? Buffer.from(nameMatch[1]!, 'latin1').toString('utf8') : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { defect: { id: 'd-1', defectNo: 'DEF-E2E-1' } } }));
    });
  });
  await new Promise<void>((r) => mapServer.listen(0, '127.0.0.1', r));
  mapUrl = `http://127.0.0.1:${(mapServer.address() as AddressInfo).port}`;

  app = express();
  app.use('/api', createBugReportsRouter({
    getDataDir: () => dataDir,
    // 走真实的 global fetch（不注入 fetchImpl）——FormData / Blob / multipart 都是真的
    readForwardConfig: () => ({ baseUrl: mapUrl, token: 'test-token' }),
    resolveReporter: () => 'tester',
  }));
  appServer = http.createServer(app);
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
  appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => mapServer.close(() => r()));
  if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
});

function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${appUrl}/api/bug-reports`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(text || '{}') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('提缺陷转发 · 真 HTTP 端到端', () => {
  it('附件在 submit 之前真的传上去了，且传的是真实字节', async () => {
    const png = Buffer.alloc(3 * 1024, 9); // 3KB 真实内容
    const res = await post({
      description: '端到端：附件必须跟着走',
      severity: 'major',
      attachments: [{ name: '证据.png', mimeType: 'image/png', dataBase64: png.toString('base64') }],
    });

    expect(res.status).toBe(201);
    expect(res.json.delivery).toBe('forwarded');
    expect(res.json.reference).toBe('DEF-E2E-1');
    // 转发成功且附件没掉队 → 不该有降级说明
    expect(res.json.degradeReason ?? null).toBeNull();

    const urls = hits.map((h) => `${h.method} ${h.url}`);
    // 事故值：只有 create + submit 两条，附件从来没上传过
    expect(urls).toEqual([
      'POST /api/defect-agent/defects',
      'POST /api/defect-agent/defects/d-1/attachments',
      'POST /api/defect-agent/defects/d-1/submit',
    ]);

    const upload = hits[1]!;
    expect(upload.contentType).toMatch(/multipart\/form-data/);
    expect(upload.filename).toBe('证据.png');
    // 真的把 3KB 图片字节发出去了（multipart 边界会多几百字节）
    expect(upload.bodyBytes).toBeGreaterThan(3 * 1024);
  }, 30_000);

  it('附件上传失败时如实降级，但不推翻「已进单」', async () => {
    // 让附件上传返 500，create / submit 正常
    await new Promise<void>((r) => mapServer.close(() => r()));
    mapServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push({ method: req.method || '', url: req.url || '', contentType: '', bodyBytes: 0, filename: null });
        if ((req.url || '').endsWith('/attachments')) {
          res.writeHead(500); res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { defect: { id: 'd-1', defectNo: 'DEF-E2E-2' } } }));
      });
    });
    await new Promise<void>((r) => mapServer.listen(new URL(mapUrl).port, '127.0.0.1', r));

    const res = await post({
      description: '附件传不上去也要说',
      severity: 'minor',
      attachments: [{ name: '图.png', mimeType: 'image/png', dataBase64: Buffer.alloc(512, 1).toString('base64') }],
    });
    expect(res.status).toBe(201);
    expect(res.json.delivery).toBe('forwarded');
    // 事故值：静默返回「已提交」，用户以为图在里面
    expect(String(res.json.degradeReason || '')).toMatch(/截图|附件/);
  }, 30_000);
});

describe('网关前端总量闸 · 真实 5MB 量级', () => {
  function attachment(mb: number) {
    // 真造 mb 兆的字节再转 base64（不是估算）
    return { dataBase64: Buffer.alloc(mb * 1024 * 1024, 7).toString('base64') };
  }

  it('两张 5MB 图必须在前端就被拦下（base64 口径）', () => {
    const draft = {
      description: 'x',
      severity: 'major' as const,
      attachments: [attachment(5), attachment(5)],
    };
    // 解码后 10MB「看起来」没超 12MB，但转成 base64 约 13.3MB，后端按 base64 量的
    // 12MiB 闸门必拒——这正是事故形态：用户挑完图、等完上传，提交后才被整单拒绝。
    const chars = totalAttachmentBase64Chars(draft.attachments);
    expect(chars).toBeGreaterThan(MAX_TOTAL_ATTACHMENT_BASE64_CHARS);
    expect(chars / (10 * 1024 * 1024)).toBeGreaterThan(1.3); // 确认确实膨胀了 4/3

    const err = validateBugReportDraft(draft as never);
    expect(err).toBeTruthy();
    expect(String(err)).toMatch(/超过上限/);
  });

  it('单张 5MB 图仍然放行（不许误伤正常提交）', () => {
    const err = validateBugReportDraft({
      description: 'x',
      severity: 'major',
      attachments: [attachment(5)],
    } as never);
    expect(err).toBeNull();
  });
});
