import type { DesignEntry, DesignFeedback, DesignFeedbackAction, DesignFeedbackMessage, DesignFeedbackProof, DesignRun, DesignSlot } from './design-workspace.js';

export const feedbackActionLabels = {
  take: '接手', deliver: '交付，请确认', confirm: '完结', return: '退回',
} as const satisfies Record<DesignFeedbackAction, string>;
export const feedbackMessageLabels: Record<DesignFeedbackMessage['kind'], string> = {
  answer: '答复', propose: '提议约定', evidence: '证据', confirm: '确认约定',
};

export function feedbackMessageText(body: string, message?: DesignFeedbackMessage): string {
  if (!message) return body;
  const detail = message.kind === 'answer' ? '涉及验收项：' + message.items.join('、')
    : message.kind === 'propose' ? '结论：' + message.conclusion + '\n范围：' + message.scope
    : message.kind === 'evidence' ? '运行：' + message.runId + '\n提交：' + message.commit : '';
  return [message.lead, detail, body === message.lead ? '' : body].filter(Boolean).join('\n\n');
}

export function feedbackProgramProof(entry: DesignEntry, thread: DesignFeedback, run: DesignRun, screenId: string, slot: DesignSlot): DesignFeedbackProof | undefined {
  if (run.version < thread.version || thread.screenId && thread.screenId !== screenId) return undefined;
  const key = `${screenId}/${slot}` as const;
  const observed = run.programEvidence?.[key];
  const image = run.visual?.[key];
  const version = entry.versions.find(row => row.version === run.version);
  const dataset = version?.demoData?.sha256 ?? observed?.fixtureDigest;
  if (!version || !image?.imageId || !dataset || !observed || observed.review?.matched === false
    || [observed, image].some(row => row.capturedBy !== 'cds' || row.commit !== run.commit || row.dataset !== dataset)) return undefined;
  return { runId: run.id, screenId, slot, imageId: image.imageId, commit: run.commit };
}

const technicalText = /`[^`]+`|https?:\/\/\S+|\b[\da-f]{7,40}\b|(?:[\w.-]+\/)+[\w.-]+|\b[A-Za-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+(?:\.[a-z]+){2,}\b/g;

export function checkFeedbackLanguage(lead: string, body: string, checkLead = true) {
  const text = [lead.trim(), body.trim()].filter(Boolean).join('\n');
  const hits = text.match(technicalText)?.length ?? 0;
  const problems: string[] = [];
  if (checkLead && (!lead.trim() || Array.from(lead.trim()).length > 40 || lead.match(technicalText))) {
    problems.push('先写一句 40 字以内的话，说明结论或下一步，代码和链接放在正文。');
  }
  if (hits > 4 || hits * 100 > Array.from(text).length) {
    problems.push('代码、路径、哈希、链接和英文标识符最多 4 处，每百字最多 1 处。');
  }
  if (checkLead && Array.from(body.trim()).length > 1500) problems.push('正文最多 1500 字。');
  return { hits, problems };
}

export function feedbackHandover(row: DesignFeedback, now = Date.now()) {
  const messages = [{ author: row.author, at: row.createdAt, needsReply: true },
    ...row.replies.map(reply => ({ ...reply, needsReply: !reply.supplement })),
    ...[...row.decisions, ...(row.transitions ?? [])].map(event => ({ ...event, needsReply: false }))]
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const stage = row.stage ?? (row.status === 'closed' ? 'done' : row.status === 'responded' ? 'review'
    : row.replies.length ? 'working' : 'raised');
  const handler = row.handler ?? row.replies.find(item => item.author.id !== row.author.id)?.author;
  const holder = stage === 'done' ? undefined : stage === 'review' ? row.confirmer ?? row.author : handler;
  const since = row.stageAt ?? messages.at(-1)!.at;
  const lastByHolder = holder && messages.reduce((last, item, index) => item.author.id === holder.id ? index : last, -1);
  const delegatedReview = stage === 'review' && row.confirmer !== undefined;
  const owed = lastByHolder === undefined ? 0 : messages.slice(lastByHolder + 1)
    .filter(message => message.needsReply && (!delegatedReview || message.at > since)).length;
  const days = Math.floor((now - Date.parse(since)) / 86_400_000);
  const stalledDays = stage === 'done' || !Number.isFinite(days) ? 0 : Math.max(0, days);
  const stall = stalledDays >= 7 ? 'bad' as const : stalledDays >= 3 ? 'warn' as const : undefined;
  return { raiser: row.author, handler, confirmer: row.confirmer, stage, holder, since, owed, stalledDays, stall, evidence: (row.attachments?.length ?? 0) };
}

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
