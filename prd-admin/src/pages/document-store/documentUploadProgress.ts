export type DocumentUploadProgressState = {
  name: string;
  percent: number;
  index: number;
  total: number;
  phase: 'uploading' | 'parsing';
  parsingStartedAt?: number;
};

export function beginDocumentUploadProgress(
  name: string,
  index: number,
  total: number,
): DocumentUploadProgressState {
  return { name, percent: 0, index, total, phase: 'uploading' };
}

export function advanceDocumentUploadProgress(
  current: DocumentUploadProgressState | null,
  input: {
    name: string;
    percent: number;
    index: number;
    total: number;
    phase?: DocumentUploadProgressState['phase'];
  },
  now = Date.now(),
): DocumentUploadProgressState {
  const percent = Math.max(0, Math.min(100, Math.round(input.percent)));
  const parsing = input.phase === 'parsing';
  return {
    ...input,
    percent,
    phase: parsing ? 'parsing' : 'uploading',
    ...(parsing ? {
      parsingStartedAt: current?.name === input.name && current.phase === 'parsing'
        ? current.parsingStartedAt ?? now
        : now,
    } : {}),
  };
}

export function describeDocumentUploadProgress(
  progress: DocumentUploadProgressState,
  now = Date.now(),
) {
  const parsingSeconds = progress.phase === 'parsing' && progress.parsingStartedAt
    ? Math.max(0, Math.floor((now - progress.parsingStartedAt) / 1_000))
    : 0;
  return progress.phase === 'parsing'
    ? {
      title: `正在解析 ${progress.name}`,
      status: `解析中 · 已等待 ${parsingSeconds} 秒`,
      barPercent: 100,
      parsingSeconds,
    }
    : {
      title: `正在上传 ${progress.name}`,
      status: `${progress.percent}%`,
      barPercent: progress.percent,
      parsingSeconds,
    };
}
