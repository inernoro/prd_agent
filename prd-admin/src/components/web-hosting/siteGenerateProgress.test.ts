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

  it('offers explicit server cancellation without treating dialog close as cancellation', () => {
    expect(parseSiteGenerationProgressEvent({
      event: 'cancelled',
      data: '{"message":"网页生成已取消"}',
    })).toEqual({ kind: 'cancelled', message: '网页生成已取消' });
    const source = readFileSync(path.resolve(__dirname, 'SiteGenerateDialog.tsx'), 'utf8');
    expect(source).toContain('cancelDesignArtifactRun(activeRunId)');
    expect(source).toContain("onClick={() => void stopGeneration()}");
    expect(source).toContain("'停止生成'");
    expect(source).toContain('abortRef.current?.abort();');
    expect(source).not.toContain('return () => {\n      void stopGeneration()');
  });
});


describe('实际模型必须透出到面板', () => {
  // .claude/rules/ai-model-visibility.md：用户会因为「换了个模型」直接感到结果不同，
  // 所以模型池换人或故障转移之后真正跑这一次的模型必须显示出来，且只能来自后端。
  it('把后端的 model 事件解析成模型与平台', () => {
    expect(parseSiteGenerationProgressEvent({
      event: 'model',
      data: JSON.stringify({ model: 'anthropic/claude-sonnet-4-6', platform: 'OpenRouter' }),
    })).toEqual({ kind: 'model', model: 'anthropic/claude-sonnet-4-6', platform: 'OpenRouter' });
  });

  it('平台缺失时兜底到网关名，但模型名绝不自己编', () => {
    expect(parseSiteGenerationProgressEvent({
      event: 'model',
      data: JSON.stringify({ model: 'gpt-5' }),
    })).toEqual({ kind: 'model', model: 'gpt-5', platform: 'LLM Gateway' });
    for (const data of ['{}', '{"model":""}', '{"model":"   "}']) {
      expect(parseSiteGenerationProgressEvent({ event: 'model', data }).kind, data).toBe('unknown');
    }
  });
});

describe('两个面板都要把模型摆出来，不只是解析出来', () => {
  // 形状 2（链路只建到一半）：解析器认得 model 事件，但没人渲染，删掉也不会红。
  const panels = [
    ['SiteGenerateDialog.tsx', '生成弹窗'],
    ['SiteEditPanel.tsx', '改写面板'],
  ] as const;
  for (const [file, label] of panels) {
    it(`${label}订阅 model 事件并渲染「模型 · 平台」`, () => {
      const source = readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(source, `${label}没有消费 model 事件`).toMatch(/kind === 'model'|event\.event === 'model'/);
      expect(source, `${label}没有把模型渲染出来`).toContain('{resolvedModel.model} · {resolvedModel.platform}');
      // 值必须来自后端：面板里不许出现写死的模型名当占位。
      expect(source).not.toMatch(/resolvedModel\s*=\s*\{\s*model:\s*'/);
    });
  }
});
