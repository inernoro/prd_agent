import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DesignArtifactRunSummary } from '@/services/real/webPages';
import {
  GATEWAY_PLATFORM_FALLBACK,
  parseSiteGenerationProgressEvent,
  resolveGeneratedSiteId,
  resolveRunModelBadge,
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


/**
 * 面板的「源码」按它真正的几个文件一起读：
 * - 修改面板 = SiteEditPanel（界面）+ useSiteEditSession（任务逻辑，与工作台共用）
 * - 生成工作台 = NewSiteStage（界面）+ useSiteGenerationRun（任务逻辑）+ WorkbenchParts（进度卡）
 */
const PANEL_FILES: Record<string, string[]> = {
  'SiteEditPanel.tsx': ['SiteEditPanel.tsx', 'workbench/useSiteEditSession.ts'],
  'workbench:generate': ['workbench/NewSiteStage.tsx', 'workbench/useSiteGenerationRun.ts', 'workbench/WorkbenchParts.tsx'],
};

function readPanelSource(file: string): string {
  return (PANEL_FILES[file] ?? [file])
    .map((name) => readFileSync(path.resolve(__dirname, name), 'utf8'))
    .join('\n');
}

const generationRunSource = () => readFileSync(path.resolve(__dirname, 'workbench/useSiteGenerationRun.ts'), 'utf8');

describe('生成工作台的进度契约', () => {
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

  it('keeps recovery inside the workbench when the public stream ends or fails', () => {
    const source = generationRunSource();
    expect(source.match(/await recoverActiveRun\(created\.data\.runId, abort\.signal\)/g)).toHaveLength(2);
    expect(source).toContain('resolveGeneratedSiteId(result.data)');
    expect(source).not.toContain("if (!result.success) {\n        sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY)");
  });

  it('offers explicit server cancellation without treating workbench close as cancellation', () => {
    expect(parseSiteGenerationProgressEvent({
      event: 'cancelled',
      data: '{"message":"网页生成已取消"}',
    })).toEqual({ kind: 'cancelled', message: '网页生成已取消' });
    const source = generationRunSource();
    expect(source).toContain('cancelDesignArtifactRun(activeRunId)');
    expect(source).toContain('abortRef.current?.abort();');
    // 关窗（卸载）只断开进度连接，不许顺手把服务器上的任务取消掉。
    expect(source).toContain('useEffect(() => () => abortRef.current?.abort(), []);');
    expect(source).not.toMatch(/return \(\) => \{\s*void stop\(\)/);
    // 停止是进度卡上的显式按钮，交给钩子里真正打服务端的 stop。
    const stage = readFileSync(path.resolve(__dirname, 'workbench/NewSiteStage.tsx'), 'utf8');
    expect(stage).toContain('onStop={() => void run.stop()}');
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
    ['workbench:generate', '生成工作台'],
    ['SiteEditPanel.tsx', '改写面板'],
  ] as const;
  for (const [file, label] of panels) {
    it(`${label}订阅 model 事件并渲染「模型 · 平台」`, () => {
      const source = readPanelSource(file);
      expect(source, `${label}没有消费 model 事件`).toMatch(/kind === 'model'|event\.event === 'model'/);
      expect(source, `${label}没有把模型渲染出来`).toContain('{resolvedModel.model} · {resolvedModel.platform}');
      // 值必须来自后端：面板里不许出现写死的模型名当占位。
      expect(source).not.toMatch(/resolvedModel\s*=\s*\{\s*model:\s*'/);
    });
  }
});

describe('刷新之后徽章要还原', () => {
  it('从 run 读回模型；平台缺失时退回统一兜底', () => {
    expect(resolveRunModelBadge(run({ resolvedModel: 'gpt-4.1', resolvedPlatform: 'OpenAI' })))
      .toEqual({ model: 'gpt-4.1', platform: 'OpenAI' });
    expect(resolveRunModelBadge(run({ resolvedModel: 'gpt-4.1', resolvedPlatform: '  ' })))
      .toEqual({ model: 'gpt-4.1', platform: GATEWAY_PLATFORM_FALLBACK });
  });

  it('没有模型就不出徽章，不拿空串顶上', () => {
    expect(resolveRunModelBadge(run({}))).toBeNull();
    expect(resolveRunModelBadge(run({ resolvedModel: '   ' }))).toBeNull();
  });

  // 形状 2：恢复读回这条线删掉不会红——流事件已经过去了，只有刷新时才看得出来。
  const panels = [
    ['workbench:generate', '生成工作台'],
    ['SiteEditPanel.tsx', '改写面板'],
  ] as const;
  for (const [file, label] of panels) {
    it(`${label}的恢复路径把徽章读回来`, () => {
      const source = readPanelSource(file);
      expect(source, `${label}恢复时没有还原模型`).toContain('setResolvedModel(resolveRunModelBadge(');
    });
  }

  it('生成工作台常驻挂载，重开时必须清掉上一轮的模型', () => {
    const source = generationRunSource();
    // 打开工作台时调用的 reset：从它开始到「接回上次的任务」之前，必须清掉 resolvedModel。
    const start = source.indexOf('const reset = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('const runId = readActiveRun();', start));
    expect(block).toContain('setResolvedModel(null)');
  });
});

describe('恢复轮询要分得清「断线」和「没了」', () => {
  // 形状 3：两个面板各有一份恢复循环，改写面板早就终态处理 NOT_FOUND，生成弹窗没有，
  // 于是它会每 1.5 秒无限轮询、generating 永远为真、旧 key 永远不清——用户发不起下一次生成。
  const panels = [
    ['workbench:generate', '生成工作台'],
    ['SiteEditPanel.tsx', '改写面板'],
  ] as const;
  for (const [file, label] of panels) {
    it(`${label}把 NOT_FOUND 当终态收尾，而不是继续轮询`, () => {
      const source = readPanelSource(file);
      const branch = source.indexOf("result.error?.code === 'NOT_FOUND'");
      expect(branch, `${label}没有单独处理 NOT_FOUND，会把永久失败当成断线一直重试`)
        .toBeGreaterThan(-1);
      // 终态分支必须真的收尾：停掉 generating 并就地 return，不落回重试路径。
      const body = source.slice(branch, branch + 900);
      expect(body, `${label}的 NOT_FOUND 分支没有停掉 generating`).toContain('setGenerating(false)');
      expect(body, `${label}的 NOT_FOUND 分支没有 return，会继续走到重试`).toContain('return;');
    });
  }

  it('生成工作台的终态分支要清掉持久化的旧 run，否则重开还会卡在同一个循环', () => {
    const source = generationRunSource();
    const branch = source.indexOf("result.error?.code === 'NOT_FOUND'");
    // 断言的是行为（把持久化的 run 清掉），不是某一种写法：这条原先钉死
    // `sessionStorage.removeItem(...)` 的字面量，随后把 storage 访问收敛进
    // forgetActiveRun 封装（让配额/隐私窗口抛异常时不至于中断生成）就红了，
    // 而代码其实更对——反向锁死住实现的断言（判据与接线纪律 形状 4a）。
    expect(source.slice(branch, branch + 900)).toContain('forgetActiveRun()');
  });
});
