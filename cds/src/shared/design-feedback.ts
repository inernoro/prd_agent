import type { DesignFeedback } from './design-workspace.js';

type FeedbackParts = { ask: string; done: string; problem: string; basis: string };
const headings: [keyof FeedbackParts, RegExp][] = [
  ['ask', /^(诉求|建议|希望|期望|要求)/], ['done', /^(怎么算解决|完成标准|验收|解决标准)/],
  ['basis', /^(证据|依据)/], ['problem', /^(问题|现象|约束|背景|原因)/],
];

export function feedbackParts(body: string): FeedbackParts {
  const parts: FeedbackParts = { ask: '', done: '', problem: '', basis: '' };
  let current: keyof FeedbackParts = 'problem';
  let fence = '';
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
    } else if (!fence) {
      const atx = line.match(/^ {0,3}#{1,6}[ \t]+(.+)/);
      const setext = !atx && /^\S/.test(line) && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? '');
      const title = atx?.[1] ?? (setext ? line : '');
      const next = headings.find(([, pattern]) => pattern.test(title.trim()))?.[0];
      if (next) {
        current = next;
        if (setext) index++;
        continue;
      }
    }
    parts[current] += line + '\n';
  }
  for (const key of Object.keys(parts) as (keyof FeedbackParts)[]) parts[key] = parts[key].trim();
  return parts;
}

export function completeFeedback(parts: FeedbackParts) {
  return Boolean(parts.ask && parts.done);
}

export function feedbackSummary(row: DesignFeedback) {
  const original = feedbackParts(row.body);
  if (completeFeedback(original)) return { parts: original, legacy: false, supplemented: true };
  const problem = [
    original.problem,
    original.ask && `### 原诉求\n\n${original.ask}`,
    original.done && `### 原完成标准\n\n${original.done}`,
  ].filter(Boolean).join('\n\n');
  for (let index = row.replies.length - 1; index >= 0; index--) {
    const reply = row.replies[index];
    if (!reply.supplement && reply.author.id !== row.author.id) continue;
    const { ask, done } = feedbackParts(reply.body);
    if (ask && done) return { parts: { ...original, problem, ask, done }, legacy: true, supplemented: true };
  }
  return { parts: { ...original, problem }, legacy: true, supplemented: false };
}
