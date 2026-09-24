import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(path.resolve(__dirname, name), 'utf8');
const workbench = read('SiteWorkbench.tsx');
const parts = read('WorkbenchParts.tsx');
const newStage = read('NewSiteStage.tsx');
const editStage = read('SiteEditStage.tsx');
const run = read('useSiteGenerationRun.ts');
const page = readFileSync(path.resolve(__dirname, '../../../pages/WebPagesPage.tsx'), 'utf8');

/**
 * 生成工作台（一个对话 + 一个预览，2026-09-24）的结构契约。
 * 只守「类型与测试之外看不出来」的几件事：尺寸走 inline、左右两栏手机变页签、
 * 资料是叠加不是二选一、只交资料身份、等待期主视觉是页面骨架、生成完在同一窗口接着改。
 */
describe('生成工作台布局契约', () => {
  it('弹窗关键尺寸走 inline style，窄屏不溢出', () => {
    expect(workbench).toContain("width: 'min(1440px, calc(100vw - 16px))'");
    expect(workbench).toContain("maxWidth: 'calc(100vw - 16px)'");
    expect(workbench).toContain("height: 'min(900px, calc(100dvh - 16px))'");
    expect(workbench).not.toContain('contentClassName="h-[');
  });

  it('桌面左对话右预览且预览占弹性列；窄屏收成「对话 / 预览」两个页签', () => {
    expect(parts).toContain('lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]');
    expect(parts).toContain("aria-label=\"对话与预览\"");
    expect(workbench).toContain('<PaneTabs pane={pane} onChange={setPane}');
    // 窄屏一次只显示一栏，桌面两栏都在。
    expect(parts).toContain("${pane === 'chat' ? 'flex' : 'hidden'}");
    expect(parts).toContain("${pane === 'preview' ? 'flex' : 'hidden'}");
  });

  it('资料从输入框左边的 + 叠加放入：知识库、上传、粘贴纪要，不是二选一的页签', () => {
    for (const id of ["id: 'knowledge'", "id: 'upload'", "id: 'notes'"]) {
      expect(newStage, `+ 菜单缺了 ${id}`).toContain(id);
    }
    expect(newStage).toContain('<KnowledgeInlineBrowser');
    expect(newStage).toContain("useDesignAttachmentUploads('document', MAX_GENERATE_ATTACHMENTS)");
    // 粘贴的纪要走同一条附件路径，服务端同样当作事实来源。
    expect(newStage).toContain("new File([text], `会议纪要-${index}.md`, { type: 'text/markdown' })");
    // 知识与文件同时提交，不是互斥。
    expect(newStage).toContain('knowledge: selectedKnowledge,');
    expect(newStage).toContain('attachmentIds: uploads.readyIds,');
  });

  it('只提交资料身份：知识是 entryId/storeId，上传是附件 id；不在浏览器里读正文', () => {
    const both = newStage + run;
    expect(both).not.toContain('getDocumentContent');
    expect(both).not.toContain('.slice(0, 20_000)');
    expect(run).toContain('entryId: entry.entryId');
    expect(run).toContain('storeId: entry.storeId');
    expect(run).toContain('attachmentIds: request.attachmentIds');
    expect(run).toContain('styleId: request.styleId');
  });

  it('风格：画廊里预设按 styleId、目录风格按 designSystemId 交给服务端；生成前右边是真实样张', () => {
    expect(newStage).toContain("styleId: styleSelection?.kind === 'preset' ? styleSelection.styleId : null,");
    expect(newStage).toContain("designSystemId: styleSelection?.kind === 'design-system' ? styleSelection.designSystemId : null,");
    expect(run).toContain('designSystemId: request.designSystemId ?? null,');
    expect(newStage).toContain('<StyleGallery');
    expect(newStage).toContain('<StyleThumbnail');
    // 样张标题先换成资料的标题，让人预判成品长什么样。
    expect(newStage).toContain('title={sampleTitle}');
  });

  it('只有一个执行器时不摆选择器；默认执行器不可用要写明原因', () => {
    expect(newStage).toContain('enabledRuntimes.length > 1 ? (');
    expect(newStage).toContain('runtimeFallbackNotice(capabilities, settingsDefaultRuntime, requestRuntime?.id)');
  });

  it('生成中：每秒更新用时、阶段来自 phase 事件、有心跳、右边是实时页面', () => {
    expect(run).toContain('window.setInterval');
    expect(newStage).toContain('formatGenerationClock(run.elapsedSeconds)');
    expect(newStage).toContain('remainingEstimateText(run.activeRunRuntime, run.elapsedSeconds)');
    expect(run).toContain('appendGenerationStage(current, item.message, Date.now())');
    expect(newStage).toContain('最近一次回应');
    expect(newStage).toContain('srcDoc={run.previewHtml}');
    expect(parts).toContain('aria-live="polite"');
  });

  it('等待期占位是页面形状的骨架，iframe 保留生成页面的白底画布', () => {
    expect(newStage).toContain('<PageSkeleton');
    expect(editStage).toContain('<PageSkeleton');
    expect(parts).toContain('className="surface-reading flex h-full flex-col gap-3 p-6"');
    expect(newStage).toContain('className="h-full w-full bg-white"');
    expect(editStage).toContain('className="h-full w-full bg-white"');
  });

  it('生成完不关窗：同一段对话交给修改阶段，接着说想改哪里', () => {
    expect(newStage).toContain('onGenerated(done.id, {');
    expect(workbench).toContain('getSite(siteId)');
    expect(workbench).toContain('<SiteEditStage');
    expect(editStage).toContain('网页已生成，用时 ${intro.durationText}');
  });

  it('修改阶段：先出草稿，线上版与草稿可切换对比，确认才发布；发给客户复用一键分享', () => {
    expect(editStage).toContain("options={[{ value: 'live', label: '线上版' }, { value: 'draft', label: '草稿' }]}");
    expect(editStage).toContain('void publish(draftId)');
    expect(editStage).toContain('void reject(draftId');
    expect(editStage).toContain('<QuickSharePopover');
    expect(editStage).toContain("'生成修改草稿 · 线上不变'");
    // 工作台自己有对话气泡，不许再把草稿的旧要求回填进输入框。
    expect(editStage).toContain('prefillInstructionFromDraft: false');
  });

  it('列表页只有一套生成入口：旧的分步弹窗已下线', () => {
    expect(page).toContain('<SiteWorkbench');
    expect(page).not.toContain('SiteGenerateDialog');
  });
});
