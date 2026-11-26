import { apiDownload, apiRequest } from '@/services/real/apiClient';
import type { DesignArtifactRunSummary } from '@/services/real/webPages';

type CodeFilmRun = Pick<DesignArtifactRunSummary,
  'runId' | 'status' | 'title' | 'phase' | 'progress' | 'resolvedModel' | 'lastProgressAt' | 'error'>;

export type { CodeFilmRun };

const base = '/api/design-artifacts';
const runPath = (id: string) => `${base}/runs/${encodeURIComponent(id)}`;

export function getCodeFilmAvailability() {
  return apiRequest<{ codeFilmEnabled?: boolean }>(`${base}/runtime-capabilities`, { timeoutMs: 15_000 });
}

export function listCodeFilms() {
  return apiRequest<{ items: CodeFilmRun[] }>(`${base}/code-films`);
}

export function createCodeFilm(input: { attachmentId: string; instruction: string; modelOptionId?: string }) {
  return apiRequest<CodeFilmRun>(`${base}/runs`, {
    method: 'POST',
    body: {
      artifactType: 'code-film',
      attachmentIds: [input.attachmentId],
      sourceSurface: 'web-hosting',
      instruction: input.instruction,
      modelOptionId: input.modelOptionId,
    },
  });
}

export function downloadCodeFilm(runId: string) {
  return apiDownload(`${runPath(runId)}/film.mp4`, '视觉笔记.mp4');
}

export function saveCodeFilm(runId: string) {
  return apiRequest<{ siteId: string }>(`${runPath(runId)}/save-film`, { method: 'POST', timeoutMs: 150_000 });
}
