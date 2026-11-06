import nodemailer from 'nodemailer';
import { redactReviewEvidence, type CodeReviewAudit } from './code-review-audit.js';

export interface CodeReviewMail {
  configured(): boolean;
  send(input: { to: string; title: string; url: string; markdown: string; taskId: string; audit?: CodeReviewAudit }): Promise<void>;
}

/** SMTP settings come from CDS-managed configuration, never from uploaded project code. */
export function createCodeReviewMail(environment: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = () => process.env): CodeReviewMail {
  const readEnv = () => ({ ...(typeof environment === 'function' ? environment() : environment) });
  const hasConfig = (env: NodeJS.ProcessEnv) => Boolean(env.CDS_REVIEW_SMTP_HOST?.trim() && env.CDS_REVIEW_SMTP_FROM?.trim());
  const configured = () => hasConfig(readEnv());
  return {
    configured,
    async send({ to, title, url, markdown, taskId, audit }) {
      // Resolve once per attempt: a password rotation while sending must not
      // change the secret used to redact this attempt's response and errors.
      const env = readEnv();
      if (!hasConfig(env)) throw new Error('CDS 尚未配置审查报告邮件通道');
      const redact = (value: unknown) => {
        let content = String(value);
        if (env.CDS_REVIEW_SMTP_PASSWORD) content = content.split(env.CDS_REVIEW_SMTP_PASSWORD).join('[credential]');
        return redactReviewEvidence(content);
      };
      const port = Number(env.CDS_REVIEW_SMTP_PORT || 587);
      const started = Date.now();
      const evidence = { operation: 'smtp.deliver_report', url: redact(`smtp://${env.CDS_REVIEW_SMTP_HOST}:${port}`), method: 'SMTP', startedAt: new Date(started).toISOString() };
      let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
      try {
        transport = nodemailer.createTransport({
          host: env.CDS_REVIEW_SMTP_HOST, port,
          secure: env.CDS_REVIEW_SMTP_SECURE === 'true' || port === 465,
          requireTLS: port !== 465,
          auth: env.CDS_REVIEW_SMTP_USER ? { user: env.CDS_REVIEW_SMTP_USER, pass: env.CDS_REVIEW_SMTP_PASSWORD } : undefined,
          connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
        });
        const result = await transport.sendMail({
          from: env.CDS_REVIEW_SMTP_FROM, to, subject: title,
          messageId: `<code-review-${taskId}@${new URL(url).hostname}>`,
          text: `代码审查已完成。\n\n${markdown.slice(0, 1200)}\n\n完整报告（需 CDS 登录）：${url}`,
          attachments: [{ filename: '代码审查报告.md', content: markdown, contentType: 'text/markdown; charset=utf-8' }],
        });
        if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP 未接受收件地址');
        await audit?.({ ...evidence, durationMs: Date.now() - started, outcome: 'success',
          evidence: redact(result.response || 'SMTP 已接受邮件').slice(0, 1000), truncated: false });
      } catch (error) {
        const reason = redact(error instanceof Error ? error.message : error).slice(0, 1000);
        try {
          await audit?.({ ...evidence, durationMs: Date.now() - started, outcome: 'network_error',
            evidence: reason, truncated: false });
        } catch (auditError) {
          throw new Error(`邮件投递审计记录失败：${redact(auditError instanceof Error ? auditError.message : auditError).slice(0, 1000)}`);
        }
        // Throwing the original transport error would leak state-managed
        // passwords into delivery.error, whose outer masker only knows env.
        throw new Error(reason);
      } finally {
        // Closing an already completed SMTP transport must not replace the
        // recorded delivery outcome or expose an unsanitized cleanup error.
        try { transport?.close(); } catch { /* best-effort connection cleanup */ }
      }
    },
  };
}
