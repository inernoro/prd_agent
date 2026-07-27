/**
 * llmgw/console-api 的 POST /gw/bug-reports 源码守卫（2026-07-27）。
 *
 * 该端点是 C#，本仓库的 CI 里没有它的单测工程；但它踩的三个坑都是**纯文本可判**的
 * 结构性问题，用源码守卫锁住比没有守卫好：
 *   1. server-authority：转发与落库不得绑 http.RequestAborted（用户切页就断，
 *      最坏时序是 MAP 里已建缺陷、网关这边没有任何记录）；
 *   2. 附件总量闸必须按 base64 字符长度算 —— 按解码字节算 12MB 时 base64 恰好
 *      16MiB，正好顶穿 MongoDB 单文档硬上限，写库直接抛异常；
 *   3. InsertOneAsync 必须有 try/catch，否则裸 500，缺陷与截图全丢。
 * 外加：create + submit 必须共用一份 10s 总预算（前端文案承诺 10s 转本地留存）。
 *
 * 判定只在 POST /gw/bug-reports 这一段里做，不影响文件其它端点。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRAM_CS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../llmgw/console-api/Program.cs',
);

const source = fs.readFileSync(PROGRAM_CS, 'utf-8');
const postStart = source.indexOf('app.MapPost("/gw/bug-reports"');
const getStart = source.indexOf('app.MapGet("/gw/bug-reports"');
const postSection = source.slice(postStart, getStart);
/** 去掉注释行后的代码，避免注释里提到的反面写法把守卫判红。 */
const postCode = postSection
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

describe('llmgw POST /gw/bug-reports 源码守卫', () => {
  it('能定位到提交端点区段', () => {
    expect(postStart).toBeGreaterThan(-1);
    expect(getStart).toBeGreaterThan(postStart);
  });

  it('转发与落库不得绑在 http.RequestAborted 上（server-authority）', () => {
    expect(postCode).not.toContain('http.RequestAborted');
  });

  it('转发走与请求生命周期解耦的独立超时预算，create 与 submit 共用同一个 token', () => {
    expect(postCode).toContain('new CancellationTokenSource(bugReportForwardBudget)');
    // create 请求、create 读响应体、submit 请求各用一次，加上声明共 4 处。
    expect((postCode.match(/forwardToken/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('附件总量闸按 base64 字符长度计（不是解码后字节）', () => {
    expect(source).toContain('BugReportMaxTotalBase64Chars');
    expect(postCode).toContain('totalBase64Chars += data.Length');
    expect(postCode).not.toContain('BugReportMaxTotalAttachmentBytes');
  });

  it('落库用 CancellationToken.None 且套 try/catch，失败给中文原因而不是裸 500', () => {
    expect(postCode).toContain('InsertOneAsync(bugReportDoc, cancellationToken: CancellationToken.None)');
    expect(postCode).toContain('catch (Exception storeError)');
    expect(postCode).toContain('BUG_REPORT_STORE_FAILED');
  });
});
