export type MeetingContextField = { label: string; value: string };

const MEETING_LABELS = ['评审方案', '会议地点', '会议时间', '方案地址', '参与人员', '评审结果'];

/**
 * 解析用户粘贴的会议邀请/已有纪要，仅用于前端即时预览。
 * 原始文本仍完整提交给后端，避免解析器遗漏内容时造成信息损失。
 */
export function parseMeetingContext(input: string): MeetingContextField[] {
  if (!input.trim()) return [];
  const found = new Map<string, string>();
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    for (const label of MEETING_LABELS) {
      const match = trimmed.match(new RegExp(`^${label}[：:]\\s*(.+)$`));
      if (match?.[1]?.trim()) found.set(label, match[1].trim());
    }
  }

  if (!found.has('参与人员')) {
    const mentions = Array.from(input.matchAll(/@\s*([^@\s，,；;]+)/g), match => match[1].trim())
      .filter(Boolean);
    const unique = [...new Set(mentions)];
    if (unique.length > 0) found.set('参与人员', unique.join('、'));
  }

  return MEETING_LABELS
    .filter(label => found.has(label))
    .map(label => ({ label, value: found.get(label)! }));
}
