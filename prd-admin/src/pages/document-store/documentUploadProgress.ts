import type { DocumentFileUploadPhase } from '@/services/real/documentStore';

export type DocumentUploadProgressState = {
  name: string;
  percent: number;
  index: number;
  total: number;
  phase: DocumentFileUploadPhase;
  parsingStartedAt?: number;
};

export function beginDocumentUploadProgress(name: string, index: number, total: number): DocumentUploadProgressState {
  return { name, percent: 0, index, total, phase: 'uploading' };
}

export function advanceDocumentUploadProgress(
  current: DocumentUploadProgressState | null,
  input: Omit<DocumentUploadProgressState, 'parsingStartedAt'>,
  now = Date.now(),
): DocumentUploadProgressState {
  const sameFile = current?.name === input.name && current.index === input.index && current.total === input.total;
  return {
    ...input,
    percent: Math.max(0, Math.min(100, Math.round(input.percent))),
    ...(input.phase === 'parsing' ? {
      parsingStartedAt: sameFile && current?.phase === 'parsing'
        ? current.parsingStartedAt ?? now
        : now,
    } : {}),
  };
}

export function describeDocumentUploadProgress(progress: DocumentUploadProgressState, now = Date.now()) {
  const parsingSeconds = progress.phase === 'parsing' && progress.parsingStartedAt !== undefined
    ? Math.max(0, Math.floor((now - progress.parsingStartedAt) / 1000))
    : 0;
  return progress.phase === 'parsing'
    ? { title: `正在解析 ${progress.name}`, status: `解析中 · 已等待 ${parsingSeconds} 秒`, barPercent: 100, parsingSeconds }
    : { title: `正在上传 ${progress.name}`, status: `${progress.percent}%`, barPercent: progress.percent, parsingSeconds };
}
