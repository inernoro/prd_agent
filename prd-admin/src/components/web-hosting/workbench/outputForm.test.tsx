import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MAX_LAUNCH_REQUEST_CHARS, parseDesignArtifactLaunch } from '@/lib/designArtifactLaunch';
import { HtmlPptHandoffPanel } from './HtmlPptHandoffPanel';
import { HTML_PPT_TIMING_NOTE, OUTPUT_FORM_ORDER, OUTPUT_FORM_REGISTRY, buildHtmlPptHandoff } from './outputForm';

const entryA = { entryId: 'entry-a', storeId: 'store-a', title: '三季度复盘', storeName: '团队知识库' };
const entryB = { entryId: 'entry-b', storeId: 'store-a', title: '客户访谈纪要' };

function launchOf(handoffPath: string) {
  return {
    pathname: handoffPath.slice(0, handoffPath.indexOf('?')),
    launch: parseDesignArtifactLaunch(handoffPath.slice(handoffPath.indexOf('?'))),
  };
}

describe('生成工作台的产出形式：网页 / 网页 PPT', () => {
  it('两个选项都登记在注册表里，网页在前、网页 PPT 在后', () => {
    expect(OUTPUT_FORM_ORDER).toEqual(['web-page', 'html-ppt']);
    expect(OUTPUT_FORM_REGISTRY['web-page'].label).toBe('网页');
    expect(OUTPUT_FORM_REGISTRY['html-ppt'].label).toBe('网页 PPT');
  });

  it('网页 PPT 带着第一篇稿子和要求去 HTML PPT 智能体，要求原样进跳转参数', () => {
    const handoff = buildHtmlPptHandoff({
      instruction: '  给客户讲清三季度的变化  ',
      knowledge: [entryA],
      uploadedFileNames: [],
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    const { pathname, launch } = launchOf(handoff.path);
    expect(pathname).toBe('/md-to-ppt-agent');
    expect(launch).toEqual({
      target: 'html-ppt',
      sourceStoreId: 'store-a',
      sourceEntryId: 'entry-a',
      sourceTitle: '三季度复盘',
      sourceStoreName: '团队知识库',
      request: '给客户讲清三季度的变化',
    });
    expect(handoff.carriedTitle).toBe('三季度复盘');
    expect(handoff.leftBehind).toEqual([]);
  });

  it('没写要求时不带 request 参数，PPT 智能体的输入框保持空白', () => {
    const handoff = buildHtmlPptHandoff({ instruction: '   ', knowledge: [entryA], uploadedFileNames: [] });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.path).not.toContain('request=');
    expect(launchOf(handoff.path).launch?.request).toBeUndefined();
  });

  it('带不过去的稿子与文件逐个列出来，不静默丢弃', () => {
    const handoff = buildHtmlPptHandoff({
      instruction: '',
      knowledge: [entryA, entryB],
      uploadedFileNames: ['会议纪要-1.md', '报价单.pdf'],
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(launchOf(handoff.path).launch?.sourceEntryId).toBe('entry-a');
    expect(handoff.leftBehind).toEqual(['客户访谈纪要', '会议纪要-1.md', '报价单.pdf']);
  });

  it('没有知识库稿子就不能交接，并说清缺什么；只有文件时指明去那边上传', () => {
    const empty = buildHtmlPptHandoff({ instruction: '做个 PPT', knowledge: [], uploadedFileNames: [] });
    expect(empty).toEqual({ ok: false, blocker: expect.stringContaining('从知识库放一篇稿子') });
    const filesOnly = buildHtmlPptHandoff({ instruction: '', knowledge: [], uploadedFileNames: ['a.pdf'] });
    expect(filesOnly).toEqual({ ok: false, blocker: expect.stringContaining('PPT 智能体里直接上传') });
  });

  it('要求超过服务端上限时截断而不是整条丢弃', () => {
    const handoff = buildHtmlPptHandoff({
      instruction: '讲'.repeat(MAX_LAUNCH_REQUEST_CHARS + 50),
      knowledge: [entryA],
      uploadedFileNames: [],
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(launchOf(handoff.path).launch?.request).toHaveLength(MAX_LAUNCH_REQUEST_CHARS);
  });

  it('网页 PPT 的耗时写成经验值，不照搬网页生成的数字', () => {
    expect(HTML_PPT_TIMING_NOTE).toContain('经验值');
    expect(HTML_PPT_TIMING_NOTE).not.toMatch(/9–12|约 1 分钟/);
  });

  it('右侧说明屏列出会带过去的稿子、要重新放的资料和落点', () => {
    const handoff = buildHtmlPptHandoff({ instruction: '', knowledge: [entryA, entryB], uploadedFileNames: [] });
    const html = renderToStaticMarkup(<HtmlPptHandoffPanel handoff={handoff} onOpenBlank={() => {}} />);
    expect(html).toContain('知识库《三季度复盘》');
    expect(html).toContain('客户访谈纪要');
    expect(html).toContain('发布给客户');
    const blocked = renderToStaticMarkup(
      <HtmlPptHandoffPanel
        handoff={buildHtmlPptHandoff({ instruction: '', knowledge: [], uploadedFileNames: [] })}
        onOpenBlank={() => {}}
      />,
    );
    expect(blocked).toContain('从知识库放一篇稿子');
    expect(blocked).not.toContain('会带过去');
  });
});

/**
 * 接线守卫：工作台真的用上了产出形式，且「网页 PPT」走交接而不是建网页设计任务。
 * 统一设计任务入口会以「只支持生成网页」回绝 html-ppt，所以这条分支绝不能落到 run.start。
 */
describe('新建阶段接线', () => {
  const stage = readFileSync(path.resolve(__dirname, 'NewSiteStage.tsx'), 'utf8');

  it('输入区有「产出形式」分段控件，选项来自注册表', () => {
    expect(stage).toContain('label="产出形式"');
    expect(stage).toContain('OUTPUT_FORM_ORDER.map(');
  });

  it('网页 PPT 在建设计任务之前就跳转并返回', () => {
    const send = stage.slice(stage.indexOf('const send = () => {'));
    const pptBranch = send.indexOf('if (isPpt) {');
    const navigateCall = send.indexOf('navigate(pptHandoff.path)');
    const runStart = send.indexOf('run.start(');
    expect(pptBranch).toBeGreaterThanOrEqual(0);
    expect(navigateCall).toBeGreaterThan(pptBranch);
    expect(runStart).toBeGreaterThan(navigateCall);
    // 跳转之后、这条 if 分支闭合之前必须 return，不能掉进下面的网页生成。
    const branchTail = send.slice(navigateCall, send.indexOf('}', navigateCall));
    expect(branchTail).toContain('return;');
  });
});
