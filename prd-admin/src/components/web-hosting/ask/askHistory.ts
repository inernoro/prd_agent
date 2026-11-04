import type { AskMessage } from './askTypes';

/** 与服务端 AskHistoryBudget 一致；显示文本保留，发请求前限制历史体积。 */
export function buildAskHistory(messages: AskMessage[]) {
  const recent = messages.filter(message => !message.error && !message.streaming)
    .map(({ role, content }) => ({ role, content: (role === 'assistant' ? assistantHistoryText(content) : content).trim().slice(0, 2000) }))
    .filter(message => message.content.length > 0).slice(-8);
  let used = 0;
  const kept: { role: AskMessage['role']; content: string }[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    if (used + recent[i].content.length > 6000) break;
    used += recent[i].content.length;
    kept.unshift(recent[i]);
  }
  return kept;
}

/** 仅移除服务端生成的数字脚注附录与编号；不能把上一轮编号解释成当前原文来源。 */
function assistantHistoryText(content: string) {
  return content.split(/\r?\n\r?\n\[\^1\]: /, 1)[0]
    .replace(/(?<!\\)\[\^[1-9]\d*\]/g, '')
    .replace(/\[引用:\d+\]/g, '');
}
