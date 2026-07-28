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

describe('llmgw 提缺陷：附件与前端闸门（Codex PR #1273 第四十一轮 P2）', () => {
  it('附件必须在 submit 之前上传到缺陷系统，不能只留文件名', () => {
    // 事故值：只 create + submit，MAP 收到的是「说有截图但没有截图」的单子，
    // 而 UI 照样报「已提交」。CDS 侧早就修了，网关这边一直漏着。
    expect(postCode).toContain('/attachments');
    expect(postCode).toContain('MultipartFormDataContent');
    const uploadAt = postCode.indexOf('/attachments');
    const submitAt = postCode.indexOf('/submit');
    expect(uploadAt).toBeGreaterThan(-1);
    expect(submitAt).toBeGreaterThan(-1);
    // 顺序要紧：先传图再流转，否则单子已经流到下游才补图。
    expect(uploadAt).toBeLessThan(submitAt);
  });

  it('附件上传失败要如实降级，且不覆盖 submit 的失败说明', () => {
    expect(postCode).toContain('attachmentFailures');
    expect(postCode).toMatch(/未能上传到缺陷系统/);
    // 两条降级原因必须并存：后写的不能把前一条盖掉。
    expect(postCode).toMatch(/string\.IsNullOrEmpty\(degradeReason\)\s*\?\s*submitIssue/);
  });
});

describe('llmgw 前端总量闸必须与后端同口径（base64 字符数）', () => {
  const CORE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../llmgw/web/src/components/BugReportCore.ts',
  );
  const core = fs.readFileSync(CORE, 'utf-8');

  it('校验按 base64 字符数，不是解码后字节数', () => {
    // 事故值：按解码字节算 12MiB「通过」，转 base64 约 16MiB，后端按 base64
    // 字符量的 12MiB 闸门必拒 —— 用户挑完图等完上传才被整单拒绝。
    expect(core).toContain('MAX_TOTAL_ATTACHMENT_BASE64_CHARS');
    expect(core).toContain('totalAttachmentBase64Chars');
    expect(core).toMatch(/const totalChars = totalAttachmentBase64Chars\(attachments\);/);
    expect(core).toMatch(/if \(totalChars > MAX_TOTAL_ATTACHMENT_BASE64_CHARS\)/);
    // 闸门判定不得再拿解码字节口径去比
    expect(core).not.toMatch(/if \(total > MAX_TOTAL_ATTACHMENT_BYTES\)/);
  });

  it('前端闸门常量与后端 BugReportMaxTotalBase64Chars 数值一致', () => {
    const front = /MAX_TOTAL_ATTACHMENT_BASE64_CHARS = (\d+) \* 1024 \* 1024/.exec(core);
    const back = /BugReportMaxTotalBase64Chars = (\d+)L \* 1024 \* 1024/.exec(source);
    expect(front?.[1]).toBeTruthy();
    expect(back?.[1]).toBeTruthy();
    expect(front![1]).toBe(back![1]);
  });
});
