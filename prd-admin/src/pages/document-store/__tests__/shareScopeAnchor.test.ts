import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Codex P1 守卫（接线类，删掉不会有别的用例变红，故必须单独守）：
 *
 * 1. 分享/下载的「当前这篇」锚点不能只 find(entries)——entries 只有首页 200 条，
 *    大库里后端搜索命中的条目不在其中，范围会静默回落到整库（正是本 PR 要防的暴露）。
 *    DocBrowser 必须把带 searchResults 兜底的解析结果回传，页面必须消费它。
 * 2. 全屏弹窗必须 createPortal 到 body，且高度约束走 inline style（frontend-modal.md）。
 */
describe('分享/下载范围锚点与浮层接线', () => {
  const docBrowser = fs.readFileSync(path.join(SRC, 'components/doc-browser/DocBrowser.tsx'), 'utf8');
  const page = fs.readFileSync(path.join(SRC, 'pages/document-store/DocumentStorePage.tsx'), 'utf8');

  it('DocBrowser 把选中条目的解析结果回传调用方', () => {
    expect(docBrowser).toContain('onSelectedEntryChange');
    // 回传的必须是带 searchResults 兜底的 selectedEntryData，不是裸 entries.find
    expect(docBrowser).toContain('onSelectedEntryChange?.(selectedEntryData)');
  });

  it('页面把回传结果接上，并用作 selectedDocEntry 的兜底', () => {
    expect(page).toContain('onSelectedEntryChange={setBrowserSelectedEntry}');
    expect(page).toContain('browserSelectedEntry');
  });

  it('分享与下载弹窗都 createPortal 到 body，且高度走 inline style', () => {
    // 分享弹窗与下载弹窗各有一次 createPortal(..., document.body)（另有右键菜单等既有浮层）
    const portals = page.match(/document\.body/g) ?? [];
    expect(portals.length).toBeGreaterThanOrEqual(4);
    expect(page).toContain("maxHeight: '85vh'");
    // 不再用 Tailwind arbitrary 值承担弹窗高度约束
    expect(page).not.toContain('max-h-[85vh]');
  });
});
