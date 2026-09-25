import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MAX_LAUNCH_REQUEST_CHARS, parseDesignArtifactLaunch, readLaunchRequest } from '@/lib/designArtifactLaunch';
import { HtmlPptHandoffPanel } from './HtmlPptHandoffPanel';
import {
  HTML_PPT_TIMING_NOTE,
  OUTPUT_FORM_ORDER,
  OUTPUT_FORM_REGISTRY,
  buildHtmlPptHandoff,
  openHtmlPptHandoff,
  sendRoute,
  type HtmlPptHandoff,
} from './outputForm';

const entryA = { entryId: 'entry-a', storeId: 'store-a', title: '三季度复盘', storeName: '团队知识库' };
const entryB = { entryId: 'entry-b', storeId: 'store-a', title: '客户访谈纪要' };

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
}

/** 模拟点下「去 PPT 智能体生成」：存草稿、拿到跳转地址。 */
function depart(handoff: HtmlPptHandoff, storage = memoryStorage()) {
  if (!handoff.ok) throw new Error('handoff blocked');
  return { path: openHtmlPptHandoff(handoff, storage, () => 'handoff00001'), storage };
}

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
    const { path: target, storage } = depart(handoff);
    const { pathname, launch } = launchOf(target);
    expect(pathname).toBe('/md-to-ppt-agent');
    expect(launch).toEqual({
      target: 'html-ppt',
      sourceStoreId: 'store-a',
      sourceEntryId: 'entry-a',
      sourceTitle: '三季度复盘',
      sourceStoreName: '团队知识库',
      handoffId: 'handoff00001',
    });
    expect(target).not.toContain(encodeURIComponent('三季度的变化'));
    expect(readLaunchRequest('handoff00001', storage)).toEqual({ status: 'ready', text: '给客户讲清三季度的变化' });
    expect(handoff.carriedTitle).toBe('三季度复盘');
    expect(handoff.leftBehind).toEqual([]);
  });

  it('团队空间里发起时，交接把团队带过去；个人空间不带', () => {
    const inTeam = buildHtmlPptHandoff({
      instruction: '', knowledge: [entryA], uploadedFileNames: [], destinationTeamId: 'team-7f3a',
    });
    expect(launchOf(depart(inTeam).path).launch?.destinationTeamId).toBe('team-7f3a');
    const personal = buildHtmlPptHandoff({
      instruction: '', knowledge: [entryA], uploadedFileNames: [], destinationTeamId: null,
    });
    expect(launchOf(depart(personal).path).launch?.destinationTeamId).toBeUndefined();
    const html = renderToStaticMarkup(<HtmlPptHandoffPanel handoff={inTeam} onOpenBlank={() => {}} />);
    expect(html).toContain('团队空间');
  });

  it('没写要求时带一句默认要求过去：那边输入框有字、发送按钮可点', () => {
    const handoff = buildHtmlPptHandoff({ instruction: '   ', knowledge: [entryA], uploadedFileNames: [] });
    const { path: target, storage } = depart(handoff);
    expect(launchOf(target).launch?.handoffId).toBe('handoff00001');
    expect(readLaunchRequest('handoff00001', storage)).toEqual({ status: 'ready', text: '把《三季度复盘》做成一套网页 PPT' });
  });

  it('带不过去的稿子与文件逐个列出来，不静默丢弃', () => {
    const handoff = buildHtmlPptHandoff({
      instruction: '',
      knowledge: [entryA, entryB],
      uploadedFileNames: ['会议纪要-1.md', '报价单.pdf'],
    });
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(launchOf(depart(handoff).path).launch?.sourceEntryId).toBe('entry-a');
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
    const { path: target, storage } = depart(handoff);
    expect(target.length).toBeLessThan(400);
    const draft = readLaunchRequest(launchOf(target).launch!.handoffId!, storage);
    expect(draft.status === 'ready' ? draft.text : '').toHaveLength(MAX_LAUNCH_REQUEST_CHARS);
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

  it('PPT 的发布落点在打开工作台时冻结，交接与空白入口都用冻结值', () => {
    expect(stage).toContain('const [pptDestinationTeamId] = useState(destinationTeamId);');
    expect(stage).not.toMatch(/freshPptSessionPath\(destinationTeamId\)/);
    expect(stage).not.toMatch(/buildHtmlPptHandoff\(\{[^}]*destinationTeamId,\s*\}/);
  });

  it('发送按 sendRoute 分派，页面里只有这一处判定', () => {
    expect(stage.match(/sendRoute\(/g)?.length).toBe(1);
  });
});

describe('发送分派（sendRoute）', () => {
  const base = { blocked: false, generating: false, pptHandoffReady: true, hasRuntime: true };
  it('网页 PPT 只做交接，永远不走网页生成', () => {
    expect(sendRoute({ ...base, outputForm: 'html-ppt' })).toBe('ppt-handoff');
    expect(sendRoute({ ...base, outputForm: 'html-ppt', pptHandoffReady: false })).toBe('none');
    expect(sendRoute({ ...base, outputForm: 'html-ppt', hasRuntime: false })).toBe('ppt-handoff');
  });
  it('网页照常生成；被拦下或正在生成时什么都不做', () => {
    expect(sendRoute({ ...base, outputForm: 'web-page' })).toBe('generate');
    expect(sendRoute({ ...base, outputForm: 'web-page', hasRuntime: false })).toBe('none');
    expect(sendRoute({ ...base, outputForm: 'web-page', blocked: true })).toBe('none');
    expect(sendRoute({ ...base, outputForm: 'html-ppt', generating: true })).toBe('none');
  });
});
