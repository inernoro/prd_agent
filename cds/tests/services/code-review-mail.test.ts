import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodeReviewMail } from '../../src/services/code-review-mail.js';
import type { CodeReviewAuditEvent } from '../../src/services/code-review-audit.js';

const { createTransport, sendMail, close } = vi.hoisted(() => ({
  createTransport: vi.fn(), sendMail: vi.fn(), close: vi.fn(),
}));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

describe('代码审查 SMTP 适配器（模拟传输，不投递真实邮件）', () => {
  const settings = (): NodeJS.ProcessEnv => ({
    CDS_REVIEW_SMTP_HOST: 'smtp.example.invalid', CDS_REVIEW_SMTP_FROM: 'reports@example.invalid',
    CDS_REVIEW_SMTP_USER: 'mailer', CDS_REVIEW_SMTP_PASSWORD: 'state-managed-private-password',
  });
  const input = () => ({ to: 'owner@example.invalid', title: '代码审查报告',
    url: 'https://cds.example.invalid/code-reviews?project=project-one&task=task-one',
    markdown: '# 审查结果\n\n修复建议与风险说明。', taskId: 'task-one' });
  beforeEach(() => {
    createTransport.mockReset(); sendMail.mockReset(); close.mockReset();
    createTransport.mockReturnValue({ sendMail, close });
    sendMail.mockResolvedValue({ accepted: ['owner@example.invalid'], rejected: [], response: '250 queued' });
  });

  it('兼容环境变量记录，发送需登录报告链接与 Markdown 附件，保留 TLS 与 SMTP 认证参数', async () => {
    const env = settings();
    const events: CodeReviewAuditEvent[] = [];
    const mail = createCodeReviewMail(env);
    expect(mail.configured()).toBe(true);
    await mail.send({ ...input(), audit: async (event) => { events.push(event); } });
    expect(createTransport).toHaveBeenCalledWith({ host: env.CDS_REVIEW_SMTP_HOST, port: 587,
      secure: false, requireTLS: true, auth: { user: 'mailer', pass: env.CDS_REVIEW_SMTP_PASSWORD },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: env.CDS_REVIEW_SMTP_FROM, to: input().to, subject: input().title,
      messageId: '<code-review-task-one@cds.example.invalid>',
      text: expect.stringContaining(`完整报告（需 CDS 登录）：${input().url}`),
      attachments: [{ filename: '代码审查报告.md', content: input().markdown, contentType: 'text/markdown; charset=utf-8' }],
    }));
    expect(events).toEqual([expect.objectContaining({ operation: 'smtp.deliver_report', outcome: 'success', evidence: '250 queued' })]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('每次探测和发送重新解析管理员全局配置，密码、主机与端口轮换无需重建适配器', async () => {
    const nativeEnv: NodeJS.ProcessEnv = {};
    let globalEnv: NodeJS.ProcessEnv = {};
    const resolve = vi.fn(() => ({ ...nativeEnv, ...globalEnv }));
    const mail = createCodeReviewMail(resolve);
    expect(mail.configured()).toBe(false);
    globalEnv = settings();
    expect(mail.configured()).toBe(true);
    await mail.send(input());
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'smtp.example.invalid', auth: { user: 'mailer', pass: globalEnv.CDS_REVIEW_SMTP_PASSWORD } }));
    nativeEnv.CDS_REVIEW_SMTP_PASSWORD = 'old-native-password';
    globalEnv = { ...globalEnv, CDS_REVIEW_SMTP_HOST: 'rotated.example.invalid', CDS_REVIEW_SMTP_PORT: '465', CDS_REVIEW_SMTP_PASSWORD: 'rotated-managed-password' };
    await mail.send(input());
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'rotated.example.invalid', port: 465, secure: true,
      requireTLS: false, auth: { user: 'mailer', pass: 'rotated-managed-password' } }));
    globalEnv.CDS_REVIEW_SMTP_HOST = '';
    expect(mail.configured()).toBe(false);
    await expect(mail.send(input())).rejects.toThrow('尚未配置');
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(6);
  });

  it('状态密钥中的实际密码与收件邮箱在抛出错误和失败审计中均被脱敏', async () => {
    const env = settings();
    const original = Object.assign(new Error(`535 invalid ${env.CDS_REVIEW_SMTP_PASSWORD} for owner@example.invalid`), { response: env.CDS_REVIEW_SMTP_PASSWORD });
    sendMail.mockRejectedValue(original);
    const events: CodeReviewAuditEvent[] = [];
    const mail = createCodeReviewMail(() => env);
    let caught: Error | undefined;
    try { await mail.send({ ...input(), audit: async (event) => { events.push(event); } }); }
    catch (error) { caught = error as Error; }
    expect(caught).not.toBe(original);
    expect(caught?.message).toBe('535 invalid [credential] for [email]');
    expect(JSON.stringify(caught)).not.toContain(env.CDS_REVIEW_SMTP_PASSWORD);
    expect(events).toEqual([expect.objectContaining({ outcome: 'network_error', evidence: caught?.message })]);
    expect(JSON.stringify(events)).not.toContain(env.CDS_REVIEW_SMTP_PASSWORD);
    expect(JSON.stringify(events)).not.toContain(input().to);
    expect(close).toHaveBeenCalledOnce();
  });

  it('发送过程中轮换密码仍以当前尝试的快照脱敏，成功响应也不能记录实际密码', async () => {
    const env = settings();
    const previousPassword = env.CDS_REVIEW_SMTP_PASSWORD!;
    const events: CodeReviewAuditEvent[] = [];
    sendMail.mockImplementation(async () => {
      env.CDS_REVIEW_SMTP_PASSWORD = 'new-password-after-send-start';
      return { accepted: [input().to], rejected: [], response: `250 accepted ${previousPassword}` };
    });
    await createCodeReviewMail(() => env).send({ ...input(), audit: async (event) => { events.push(event); } });
    expect(events[0]).toMatchObject({ outcome: 'success', evidence: '250 accepted [credential]' });
    expect(JSON.stringify(events)).not.toContain(previousPassword);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: { user: 'mailer', pass: previousPassword } }));
  });

  it('同步创建传输失败与审计写入错误同样不得把状态密码带给调用者', async () => {
    const env = settings();
    createTransport.mockImplementation(() => { throw new Error(`invalid transport ${env.CDS_REVIEW_SMTP_PASSWORD}`); });
    const events: CodeReviewAuditEvent[] = [];
    const mail = createCodeReviewMail(() => env);
    await expect(mail.send({ ...input(), audit: async (event) => { events.push(event); } })).rejects.toThrow('invalid transport [credential]');
    expect(events[0].evidence).toBe('invalid transport [credential]');
    expect(close).not.toHaveBeenCalled();
    await expect(mail.send({ ...input(), audit: async () => { throw new Error(`store failure ${env.CDS_REVIEW_SMTP_PASSWORD}`); } }))
      .rejects.toThrow('邮件投递审计记录失败：store failure [credential]');
  });

  it('SMTP 拒绝收件人时记录失败并保留报告中心默认通道', async () => {
    sendMail.mockResolvedValue({ accepted: [], rejected: [input().to], response: '550 rejected' });
    const events: CodeReviewAuditEvent[] = [];
    await expect(createCodeReviewMail(settings()).send({ ...input(), audit: async (event) => { events.push(event); } })).rejects.toThrow('SMTP 未接受收件地址');
    expect(events[0].outcome).toBe('network_error');
    expect(createCodeReviewMail({}).configured()).toBe(false);
  });
});
