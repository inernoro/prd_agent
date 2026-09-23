import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, 'SiteGenerateDialog.tsx'), 'utf8');

/**
 * 分步生成弹窗（设计稿 Source / Options / Progress / Done，2026-09-23）的结构契约。
 * 只守「类型与测试之外看不出来」的几件事：弹窗尺寸走 inline、四步都接上了、
 * 只交素材身份不交正文、等待期主视觉是产物骨架而不是转圈。
 */
describe('SiteGenerateDialog 分步布局契约', () => {
  it('弹窗关键尺寸走 inline style，窄屏不溢出', () => {
    expect(source).toContain("width: 'min(960px, calc(100vw - 16px))'");
    expect(source).toContain("maxWidth: 'calc(100vw - 16px)'");
    expect(source).toContain("height: 'min(780px, calc(100vh - 24px))'");
    expect(source).not.toContain('contentClassName="h-[');
    expect(source.match(/min-w-0/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it('四个步骤都接进了渲染（选素材 / 写要求 / 生成中 / 完成）', () => {
    for (const step of ['source', 'options', 'running', 'done']) {
      expect(source, `步骤 ${step} 没有渲染入口`).toContain(`{step === '${step}' && `);
    }
    expect(source).toContain("const STEP_LABELS = ['选素材', '写要求', '生成'] as const;");
  });

  it('选素材有两个页签：就地知识浏览器 + 直接上传（拖拽 / 选择 / 粘贴文字）', () => {
    expect(source).toContain('<KnowledgeInlineBrowser');
    expect(source).toContain("['knowledge', '引用知识库'");
    expect(source).toContain("['upload', '直接上传'");
    expect(source).toContain("useDesignAttachmentUploads('document', MAX_GENERATE_ATTACHMENTS)");
    expect(source).toContain('onDrop={(event) => {');
    expect(source).toContain('PASTED_TEXT_FILE_NAME');
  });

  it('只提交素材身份：知识是 entryId/storeId，上传是附件 id；不在浏览器里读正文', () => {
    expect(source).not.toContain('getDocumentContent');
    expect(source).not.toContain('.slice(0, 20_000)');
    expect(source).toContain('entryId: entry.entryId');
    expect(source).toContain('storeId: entry.storeId');
    expect(source).toContain('attachmentIds: uploads.readyIds');
    expect(source).toContain('styleId: selectedStyleId');
  });

  it('写要求一步：预设 chips、风格网格、执行器两张卡、标题与文件夹', () => {
    expect(source).toContain('PRESET_REQUESTS.map');
    expect(source).toContain('role="radiogroup" aria-label="风格"');
    expect(source).toContain('role="radiogroup" aria-label="设计执行器"');
    expect(source).toContain('id="design-site-title"');
    expect(source).toContain('id="design-site-folder"');
    // 默认执行器不可用时要写明原因，不许悄悄换掉。
    expect(source).toContain('runtimeFallbackNotice(capabilities, settingsDefaultRuntime, enabledRuntime?.id)');
  });

  it('生成中：每秒更新用时、阶段列表来自 phase 事件、有心跳、右侧实时预览', () => {
    expect(source).toContain('window.setInterval');
    expect(source).toContain('formatGenerationClock(elapsedSeconds)');
    expect(source).toContain('remainingEstimateText(activeRunRuntime, elapsedSeconds)');
    expect(source).toContain('appendGenerationStage(current, item.message, Date.now())');
    expect(source).toContain('最近一次回应');
    expect(source).toContain('实时预览（第一版写出后出现）');
    expect(source).toContain('className="sr-only">{phase}</span>');
  });

  it('等待期占位是产物形状的骨架，iframe 保留生成页面的白底画布', () => {
    expect(source).toContain('<PageSkeleton');
    expect(source).toContain('className="surface-reading flex h-full flex-col gap-2.5 p-5 text-crisp"');
    expect(source).toContain('className="h-full w-full bg-white"');
  });

  it('完成页：预览 + 打开网页 / 复制链接 / 帮我修改 / 再出一版，并写明风格与提示词版本', () => {
    const done = source.slice(source.indexOf('const doneStep = ('));
    expect(done).toContain('已保存到网页托管');
    expect(done).toContain('打开网页');
    expect(done).toContain('复制链接');
    expect(done).toContain('帮我修改');
    expect(done).toContain('再出一版对比');
    expect(source).toContain('const provenance = runProvenanceText(runInfo);');
  });
});
