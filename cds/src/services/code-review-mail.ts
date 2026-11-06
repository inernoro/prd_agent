import nodemailer from 'nodemailer';
import { redactReviewEvidence, type CodeReviewAudit } from './code-review-audit.js';

export interface CodeReviewMail {
  configured(): boolean;
  send(input: { to: string; title: string; url: string; markdown: string; taskId: string; audit?: CodeReviewAudit }): Promise<void>;
}

/** SMTP settings belong to the CDS control process, never to uploaded project code. */
export function createCodeReviewMail(env: NodeJS.ProcessEnv = process.env): CodeReviewMail {
  const configured = () => Boolean(env.CDS_REVIEW_SMTP_HOST && env.CDS_REVIEW_SMTP_FROM);
  return {
    configured,
    async send({ to, title, url, markdown, taskId, audit }) {
      if (!configured()) throw new Error('CDS 尚未配置审查报告邮件通道');
      const port = Number(env.CDS_REVIEW_SMTP_PORT || 587);
      const transport = nodemailer.createTransport({
        host: env.CDS_REVIEW_SMTP_HOST, port,
        secure: env.CDS_REVIEW_SMTP_SECURE === 'true' || port === 465,
        requireTLS: port !== 465,
        auth: env.CDS_REVIEW_SMTP_USER ? { user: env.CDS_REVIEW_SMTP_USER, pass: env.CDS_REVIEW_SMTP_PASSWORD } : undefined,
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      });
      const started = Date.now();
      const evidence = { operation: 'smtp.deliver_report', url: `smtp://${env.CDS_REVIEW_SMTP_HOST}:${port}`, method: 'SMTP', startedAt: new Date(started).toISOString() };
      try {
        const result = await transport.sendMail({
          from: env.CDS_REVIEW_SMTP_FROM, to, subject: title,
          messageId: `<code-review-${taskId}@${new URL(url).hostname}>`,
          text: `代码审查已完成。\n\n${markdown.slice(0, 1200)}\n\n完整报告（需 CDS 登录）：${url}`,
          attachments: [{ filename: '代码审查报告.md', content: markdown, contentType: 'text/markdown; charset=utf-8' }],
        });
        if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP 未接受收件地址');
        await audit?.({ ...evidence, durationMs: Date.now() - started, outcome: 'success',
          evidence: redactReviewEvidence(String(result.response || 'SMTP 已接受邮件')).slice(0, 1000), truncated: false });
      } catch (error) {
        let reason = String((error as Error).message);
        if (env.CDS_REVIEW_SMTP_PASSWORD) reason = reason.split(env.CDS_REVIEW_SMTP_PASSWORD).join('[credential]');
        await audit?.({ ...evidence, durationMs: Date.now() - started, outcome: 'network_error',
          evidence: redactReviewEvidence(reason).slice(0, 1000), truncated: false });
        throw error;
      } finally { transport.close(); }
    },
  };
}
