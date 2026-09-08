import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DesignArtifactRunSummary } from '@/services/real/webPages';
import {
  parseSiteGenerationProgressEvent,
  resolveGeneratedSiteId,
} from './siteGenerateProgress';

const run = (overrides: Partial<DesignArtifactRunSummary>): DesignArtifactRunSummary => ({
  runId: 'run-a',
  status: 'Done',
  artifactType: 'web-page',
  operation: 'generate',
  sourceSurface: 'web-hosting',
  runtime: 'map-gateway',
  progress: 100,
  phase: '完成',
  createdAt: '2026-09-08T00:00:00Z',
  knowledgeReferences: [],
  ...overrides,
});

describe('SiteGenerateDialog generation progress contract', () => {
  it('consumes the MAP phase, incremental content, and terminal site event', () => {
    expect(parseSiteGenerationProgressEvent({
      event: 'phase',
      data: '{"progress":35,"message":"正在组织页面"}',
    })).toEqual({ kind: 'phase', progress: 35, message: '正在组织页面' });
    expect(parseSiteGenerationProgressEvent({
      event: 'delta',
      data: '{"text":"<main>"}',
    })).toEqual({ kind: 'delta', text: '<main>' });
    expect(parseSiteGenerationProgressEvent({
      event: 'done',
      data: '{"siteId":"site-map"}',
    })).toEqual({ kind: 'done', siteId: 'site-map', siteUrl: undefined });
    expect(resolveGeneratedSiteId(run({ artifactSiteId: 'site-map' }))).toBe('site-map');
  });

  it('recovers an OpenDesign terminal result from its produced artifact identity', () => {
    expect(resolveGeneratedSiteId(run({
      runtime: 'open-design',
      artifactSiteId: null,
      producedArtifactSiteId: 'site-open-design',
    }))).toBe('site-open-design');
    expect(parseSiteGenerationProgressEvent({
      event: 'thinking',
      data: '{"text":"正在读取远程工作区"}',
    })).toEqual({ kind: 'thinking', text: '正在读取远程工作区' });
  });

  it('keeps recovery inside the current dialog when the public stream ends or fails', () => {
    const source = readFileSync(path.resolve(__dirname, 'SiteGenerateDialog.tsx'), 'utf8');
    expect(source.match(/await recoverActiveRun\(created\.data\.runId, abort\.signal\)/g)).toHaveLength(2);
    expect(source).toContain('resolveGeneratedSiteId(result.data)');
    expect(source).not.toContain("if (!result.success) {\n        sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY)");
  });
});
