import type { EmailRecipient, EmailTemplate } from '@/services';

/** 把正文 / 主题里的 {{key}} 用填写值替换；未填写的保留 {{key}} 以便使用者一眼看到还差什么。 */
export function renderText(text: string, values: Record<string, string>): string {
  if (!text) return '';
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (whole, key: string) => {
    const v = values[key];
    return v && v.trim() ? v : whole;
  });
}

/** 收件人列表 → 可读字符串："张三 <a@b.com>, 人事部" */
export function formatRecipients(list: EmailRecipient[]): string {
  if (!list || list.length === 0) return '';
  return list
    .map((r) => (r.email && r.email.trim() ? `${r.name} <${r.email.trim()}>` : r.name))
    .join('、');
}

/** 组装一封可直接粘贴到邮件客户端的完整文本（收件人 / 抄送 / 主题 / 正文）。 */
export function composeEmail(
  tpl: EmailTemplate,
  subject: string,
  body: string
): string {
  const lines: string[] = [];
  const to = formatRecipients(tpl.toRecipients);
  const cc = formatRecipients(tpl.ccRecipients);
  if (to) lines.push(`收件人：${to}`);
  if (cc) lines.push(`抄送：${cc}`);
  lines.push(`主题：${subject}`);
  lines.push('');
  lines.push(body);
  return lines.join('\n');
}

/** 复制到剪贴板，兼容无 navigator.clipboard 的场景。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
