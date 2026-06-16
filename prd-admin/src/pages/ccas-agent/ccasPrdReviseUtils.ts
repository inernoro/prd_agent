export type ReviseStreamOutcome = 'completed' | 'failed' | 'aborted';

export function finalizeCcasReviseDocument(
  baseMarkdown: string,
  streamedMarkdown: string,
  outcome: ReviseStreamOutcome
): string {
  if (outcome === 'completed' && streamedMarkdown.trim()) return streamedMarkdown;
  return baseMarkdown;
}
