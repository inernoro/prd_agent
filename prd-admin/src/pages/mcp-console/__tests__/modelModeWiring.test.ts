import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('MCP 文学配图模型模式接线', () => {
  it('客户端设置同时提交模式与逻辑模型 PublicId', () => {
    const dialog = read('pages/mcp-console/QuotaEditorDialog.tsx');
    expect(dialog).toContain("'follow-user-panel'");
    expect(dialog).toContain("'fixed'");
    expect(dialog).toContain('mcpLiteraryImageModelMode');
    expect(dialog).toContain('mcpLiteraryImageModelPublicId');
  });

  it('固定模型选择器只展示文生图与图生图目录交集', () => {
    const dialog = read('pages/mcp-console/QuotaEditorDialog.tsx');
    expect(dialog).toContain('res.data.text2img.pools');
    expect(dialog).toContain('res.data.img2img.pools');
    expect(dialog).toContain('text.has(code)');
  });

  it('文学页面查询自己的模型能力，不再借用视觉创作白名单', () => {
    const page = read('pages/literary-agent/ArticleIllustrationEditorPage.tsx');
    expect(page).toContain('getLiteraryAgentAdapterInfo');
    expect(page).not.toContain('getVisualAgentAdapterInfo');
  });

  it('文学页面保留逻辑模型作为请求身份，并用实际线路做去重', () => {
    const page = read('pages/literary-agent/ArticleIllustrationEditorPage.tsx');
    const options = read('pages/literary-agent/literaryModelOptions.ts');
    expect(options).toContain('actualPlatformId: first.actualPlatformId || first.platformId');
    expect(options).toContain('`${model.actualPlatformId}:${model.actualModelId}`');
    expect(options).toContain('name: displayModelId');
    expect(options).toContain('modelName: pool.code || first.modelId');
    expect(page).toContain('modelId: effectiveModel.modelName');
    expect(page).toContain('modelId: effectiveChatModel?.modelName');
    expect(page).not.toContain('modelId: effectiveModel.actualModelId');
    expect(page).not.toContain('modelId: effectiveChatModel?.actualModelId');
  });
});
