import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SseEvent } from '@/lib/sse';
import type { DesignGenerationSettings } from '@/services/real/webPages';
import {
  attachmentBadge,
  readyAttachmentIds,
  screenshotRuntimeSupported,
  summarizeAttachments,
  validateDesignAttachment,
} from './designAttachments';
import {
  buildGenerationSettingsPatch,
  composePromptBundle,
  type GenerationSettingsDraft,
} from './generationSettingsModel';
import {
  DESIGN_PREVIEW_EVENT_CSP,
  designPreviewEventDocument,
  isNewerPreviewRevision,
  runtimeFallbackNotice,
} from './siteEditPreview';
import {
  appendGenerationStage,
  closeGenerationStages,
  formatGenerationClock,
  generationStageLabel,
  parseSiteGenerationProgressEvent,
  remainingEstimateText,
  runProvenanceText,
} from './siteGenerateProgress';
import { orderRuntimeCards, titleFromFileName } from './siteGenerateOptions';

const event = (name: string, data: unknown): SseEvent => ({ event: name, data: JSON.stringify(data) } as SseEvent);

describe('preview 事件', () => {
  it('解析整页正文与 revision，空正文不算预览', () => {
    expect(parseSiteGenerationProgressEvent(event('preview', { html: '<html><body>A</body></html>', revision: 3 })))
      .toEqual({ kind: 'preview', html: '<html><body>A</body></html>', revision: 3 });
    expect(parseSiteGenerationProgressEvent(event('preview', { html: '   ', revision: 1 })).kind).toBe('unknown');
    expect(parseSiteGenerationProgressEvent(event('preview', { html: '<p>x</p>' }))).toMatchObject({ revision: 0 });
  });

  it('CSP meta 插在页面自己的任何节点之前', () => {
    const doc = designPreviewEventDocument('<!doctype html><html lang="zh"><head><script src="a.js"></script></head><body>x</body></html>');
    const metaAt = doc.indexOf('Content-Security-Policy');
    expect(metaAt).toBeGreaterThan(-1);
    expect(metaAt).toBeLessThan(doc.indexOf('<script'));
    expect(doc).toContain(DESIGN_PREVIEW_EVENT_CSP);
    expect(DESIGN_PREVIEW_EVENT_CSP).toContain("connect-src 'none'");
    expect(DESIGN_PREVIEW_EVENT_CSP).toContain("form-action 'none'");
  });

  it('CSP 对每一类资源都不放行网络来源（未列出的类型必须落到 default-src \'none\'）', () => {
    const directives = new Map(
      DESIGN_PREVIEW_EVENT_CSP.split(';')
        .map((part) => part.trim().split(/\s+/u))
        .filter((tokens) => tokens[0])
        .map((tokens) => [tokens[0].toLowerCase(), tokens.slice(1)] as const),
    );
    // 浏览器的回退规则：某类资源没有自己的指令时用 default-src；default-src 也没有就是不限制。
    const effective = (name: string) => directives.get(name) ?? directives.get('default-src') ?? null;
    const noNetwork = new Set(["'none'", "'unsafe-inline'", 'data:', 'blob:']);
    for (const kind of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src',
      'object-src', 'frame-src', 'child-src', 'worker-src', 'manifest-src']) {
      const sources = effective(kind);
      expect(sources, `${kind} 没有任何限制，按浏览器默认放行`).not.toBeNull();
      for (const source of sources ?? []) expect(noNetwork.has(source), `${kind} 放行了 ${source}`).toBe(true);
    }
    expect(directives.get('default-src')).toEqual(["'none'"]);
  });

  it('没有 head / html 的片段也会被包成带 CSP 的文档', () => {
    expect(designPreviewEventDocument('<html><body>x</body></html>')).toMatch(/^<html><head><meta http-equiv="Content-Security-Policy"/);
    expect(designPreviewEventDocument('<section>片段</section>')).toMatch(/^<!doctype html><html><head><meta/);
    expect(designPreviewEventDocument('  ')).toBe('');
    // <header> 不是 <head>：不能把 meta 塞进页眉里。
    const withHeader = designPreviewEventDocument('<html><body><header>页眉</header></body></html>');
    expect(withHeader.indexOf('Content-Security-Policy')).toBeLessThan(withHeader.indexOf('<header>'));
  });

  it('断线重放的旧 revision 不能把新页面盖回去', () => {
    expect(isNewerPreviewRevision(2, 1)).toBe(true);
    expect(isNewerPreviewRevision(2, 2)).toBe(true);
    expect(isNewerPreviewRevision(1, 2)).toBe(false);
    expect(isNewerPreviewRevision(0, -1)).toBe(true);
  });
});

describe('阶段列表', () => {
  it('随时间变化的尾巴不算换阶段', () => {
    expect(generationStageLabel('OpenDesign 正在设计并写出页面 · 已运行 3 分 05 秒')).toBe('OpenDesign 正在设计并写出页面');
    let stages = appendGenerationStage([], '正在准备隔离工作区', 1_000);
    stages = appendGenerationStage(stages, 'OpenDesign 正在设计并写出页面 · 已运行 10 秒', 5_000);
    stages = appendGenerationStage(stages, 'OpenDesign 正在设计并写出页面 · 已运行 20 秒', 15_000);
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ label: '正在准备隔离工作区', endedAtMs: 5_000 });
    expect(stages[1]).toMatchObject({ detail: 'OpenDesign 正在设计并写出页面 · 已运行 20 秒', endedAtMs: null });
  });

  it('空消息不产生阶段，终态把进行中的那一步收口', () => {
    expect(appendGenerationStage([], '  ', 0)).toEqual([]);
    const closed = closeGenerationStages(appendGenerationStage([], 'A', 0), 9_000);
    expect(closed[0].endedAtMs).toBe(9_000);
  });

  it('用时时钟与剩余时间估算', () => {
    expect(formatGenerationClock(348)).toBe('05:48');
    expect(formatGenerationClock(3_725)).toBe('1:02:05');
    expect(remainingEstimateText('open-design', 5 * 60)).toBe('按通常耗时估算，预计还需 4–7 分钟');
    expect(remainingEstimateText('open-design', 11 * 60)).toBe('按通常耗时估算，预计还需不到 1 分钟');
    expect(remainingEstimateText('open-design', 13 * 60)).toContain('已超过通常耗时');
    // 不认识的执行器不许编一个预估出来。
    expect(remainingEstimateText('unknown-runtime', 60)).toBe('正在积累耗时数据，暂不预估剩余时间');
  });

  it('风格与提示词版本那句话，缺哪项就不写哪项', () => {
    expect(runProvenanceText({ styleName: '编辑风格', promptFingerprint: '1a2b3c4d5e6f' })).toBe('风格：编辑风格 · 提示词版本 1a2b3c4d');
    expect(runProvenanceText({ styleName: null, promptFingerprint: 'abcdef0123' })).toBe('提示词版本 abcdef01');
    expect(runProvenanceText(null)).toBe('');
  });
});

describe('执行器回落要说原因', () => {
  const runtimes = [
    { id: 'open-design', label: 'OpenDesign', enabled: false, reason: '会话容器未就绪' },
    { id: 'map-gateway', label: 'MAP 直连', enabled: true },
  ];
  it('默认不可用、改用了别的：写明默认是谁、为什么、改用了谁', () => {
    expect(runtimeFallbackNotice(runtimes, 'open-design', 'map-gateway'))
      .toBe('默认的「OpenDesign」暂不可用（会话容器未就绪），本次改用「MAP 直连」。');
  });
  it('默认可用或已选中默认时不出这句', () => {
    expect(runtimeFallbackNotice(runtimes, 'map-gateway', 'map-gateway')).toBe('');
    expect(runtimeFallbackNotice([{ ...runtimes[0], enabled: true }, runtimes[1]], 'open-design', 'map-gateway')).toBe('');
  });
  it('卡片顺序：快速在前、精细在后，未知执行器排最后', () => {
    expect(orderRuntimeCards([{ id: 'x' }, { id: 'open-design' }, { id: 'map-gateway' }]).map((item) => item.id))
      .toEqual(['map-gateway', 'open-design', 'x']);
  });
});

describe('附件上传队列', () => {
  it('按用途拒收格式、超限与空文件', () => {
    expect(validateDesignAttachment({ name: '方案.docx', size: 1024 }, 'document')).toBeNull();
    expect(validateDesignAttachment({ name: '截图.PNG', size: 1024 }, 'image')).toBeNull();
    expect(validateDesignAttachment({ name: '截图.png', size: 1024 }, 'document')).toContain('格式不支持');
    expect(validateDesignAttachment({ name: '方案.pdf', size: 1024 }, 'image')).toContain('不是支持的截图格式');
    expect(validateDesignAttachment({ name: '大.pdf', size: 21 * 1024 * 1024 }, 'document')).toContain('上传上限');
    expect(validateDesignAttachment({ name: '空.md', size: 0 }, 'document')).toContain('空文件');
    // 服务端 20 MiB 限的是整个 multipart 请求：恰好 20 MiB 的文件前端就要拦下（Codex P2）。
    expect(validateDesignAttachment({ name: '刚好.pdf', size: 20 * 1024 * 1024 }, 'document')).toContain('上传上限');
    // 服务端不认 .markdown（Codex P2）。
    expect(validateDesignAttachment({ name: '稿子.markdown', size: 1024 }, 'document')).toContain('格式不支持');
    // 截图与服务端参考图契约同口径（Codex P2）：GIF 与超过 5 MB 在选文件时就拦下。
    expect(validateDesignAttachment({ name: '动图.gif', size: 1024 }, 'image')).toContain('只支持 PNG、JPG、WebP');
    expect(validateDesignAttachment({ name: '大图.png', size: 6 * 1024 * 1024 }, 'image')).toContain('超过 5 MB');
    expect(validateDesignAttachment({ name: '刚好.webp', size: 5 * 1024 * 1024 }, 'image')).toBeNull();
  });

  it('徽标与状态汇总', () => {
    expect(attachmentBadge('a.markdown')).toBe('MD');
    expect(attachmentBadge('b.docx')).toBe('DOCX');
    expect(summarizeAttachments([{ status: 'ready' }, { status: 'reading' }])).toBe('1 个文件已就绪，1 个还在上传或读取');
    expect(summarizeAttachments([{ status: 'failed' }])).toBe('1 个失败，可移除后重传');
  });

  it('截图只对精细设计生效（快速修改带截图后端会 400）', () => {
    expect(screenshotRuntimeSupported('open-design')).toBe(true);
    expect(screenshotRuntimeSupported('map-gateway')).toBe(false);
    expect(screenshotRuntimeSupported(undefined)).toBe(false);
    // 接线：面板按它置灰，提交时也按它决定带不带截图。
    const panel = readFileSync(new URL('./SiteEditPanel.tsx', import.meta.url), 'utf8')
      + readFileSync(new URL('./workbench/useSiteEditSession.ts', import.meta.url), 'utf8');
    expect(panel).toContain('screenshotAttachmentIds: screenshotRuntimeSupported(requestRuntime.id) ? screenshots.readyIds : []');
    expect(panel).toContain('disabled={generating || !screenshotsSupported}');
  });

  it('只有上传完成的附件才进请求', () => {
    expect(readyAttachmentIds([
      { key: 'a', fileName: 'a.md', size: 1, status: 'ready', progress: 100, attachmentId: 'att-1' },
      { key: 'b', fileName: 'b.md', size: 1, status: 'reading', progress: 100 },
      { key: 'c', fileName: 'c.md', size: 1, status: 'failed', progress: 30, error: 'x' },
    ])).toEqual(['att-1']);
    expect(titleFromFileName('发布说明.v2.docx')).toBe('发布说明.v2');
  });
});

describe('网页生成设置只提交改过的字段', () => {
  const settings: DesignGenerationSettings = {
    defaultRuntime: 'open-design',
    reviewMode: 'light',
    styles: [
      { id: 'editorial', name: '编辑风格', description: '杂志感', designSystemId: 'ds-editorial', swatches: ['#112233', '#445566', '#778899'], enabled: true, isDefault: true, builtIn: true },
    ],
    prompts: {
      generate: { value: '默认创作', isDefault: true, defaultValue: '默认创作' },
      edit: { value: '自定义修改', isDefault: false, defaultValue: '默认修改' },
      review: { value: '默认自查', isDefault: true, defaultValue: '默认自查' },
    },
    platformContract: '契约全文',
    promptFingerprint: 'abc',
    updatedAt: null,
    updatedBy: null,
    canEdit: true,
  };
  const draftOf = (change: Partial<GenerationSettingsDraft> = {}): GenerationSettingsDraft => ({
    defaultRuntime: settings.defaultRuntime,
    reviewMode: settings.reviewMode,
    styles: settings.styles.map((style) => ({ ...style, swatches: [...style.swatches] })),
    prompts: { generate: '默认创作', edit: '自定义修改', review: '默认自查' },
    ...change,
  });

  it('什么都没改就是空补丁', () => {
    expect(buildGenerationSettingsPatch(settings, draftOf())).toEqual({});
  });

  it('只改执行器与自查强度时，不带上风格与提示词', () => {
    expect(buildGenerationSettingsPatch(settings, draftOf({ defaultRuntime: 'map-gateway', reviewMode: 'strict' })))
      .toEqual({ defaultRuntime: 'map-gateway', reviewMode: 'strict' });
  });

  it('提示词改回默认稿时提交空串（契约里的「恢复默认」）', () => {
    const patch = buildGenerationSettingsPatch(settings, draftOf({ prompts: { generate: '新的创作要求', edit: '默认修改', review: '默认自查' } }));
    expect(patch).toEqual({ prompts: { generate: '新的创作要求', edit: '' } });
  });

  it('风格有改动时提交完整列表，且不带只读的 builtIn 与色块（色块由后端从设计系统 tokens 派生）', () => {
    const draft = draftOf();
    draft.styles[0] = { ...draft.styles[0], name: '编辑风格 2' };
    const patch = buildGenerationSettingsPatch(settings, draft);
    expect(patch.styles).toEqual([
      { id: 'editorial', name: '编辑风格 2', description: '杂志感', designSystemId: 'ds-editorial', enabled: true, isDefault: true },
    ]);
  });

  it('只读色块变了不算改动，不会触发保存', () => {
    const draft = draftOf();
    draft.styles[0] = { ...draft.styles[0], swatches: ['#000000', '#ffffff', '#ff0000'] };
    expect(buildGenerationSettingsPatch(settings, draft)).toEqual({});
  });

  it('复制全部按平台契约在前的顺序拼接', () => {
    const bundle = composePromptBundle('契约', { generate: '创作', edit: '修改', review: '自查' });
    expect(bundle.indexOf('契约')).toBeLessThan(bundle.indexOf('创作'));
    expect(bundle).toContain('## 自查提示词\n\n自查');
  });
});
