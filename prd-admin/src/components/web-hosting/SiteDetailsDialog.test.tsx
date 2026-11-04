// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SiteCard } from './SiteCard';
import type { SiteCardProps } from './SiteCard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const site: SiteCardProps['site'] = {
  id: 'details', title: '完整标题'.repeat(15), description: '完整描述'.repeat(50), sourceType: 'api',
  cosPrefix: '', entryFile: 'index.html', siteUrl: '', pdfAssetUrl: undefined, coverImageUrl: '/cover.png',
  files: Array.from({ length: 103 }, (_, i) => ({ path: `第${i}个文件.html`, cosKey: '', size: 1234, mimeType: 'text/html' })),
  totalSize: 127102, tags: ['标签一', '标签二', '标签三', '不能丢的第四个标签'], folderCanonicalName: '',
  folder: '测试分组', ownerUserId: 'owner', viewCount: 987654321, visibility: 'private',
  createdAt: '2026-11-01T01:02:03Z', updatedAt: '2026-11-04T04:05:06Z',
};

describe('网页详情的信息保留', () => {
  for (const size of ['small', 'medium', 'large'] as const) {
    it(`${size} 直接打开完整信息，零次显示且不触发访问、选择或修改`, async () => {
      const container = document.createElement('div'); document.body.append(container);
      const root = createRoot(container);
      const action = vi.fn();
      try {
        await act(async () => root.render(<SiteCard site={site} size={size} selected={false}
          activity={{ editCount: 0, isNew: true }} visitorCount={987654321} shared shareStats={{ activeLinks: 3 }}
          onSelect={action} onVisit={action} onTogglePublic={action} onEdit={action} onDelete={action}
          onShare={action} onQrCode={action} onTransferToLibrary={action} onReplaceFile={action} />));
        expect(container.querySelector('[data-site-edit-badge]')?.getAttribute('aria-label')).toBe('已编辑 0 次');
        const trigger = container.querySelector<HTMLButtonElement>('[data-site-details-button]')!;
        expect(trigger).not.toBeNull();
        await act(async () => trigger.click());
        const dialog = document.querySelector('[role="dialog"]')!;
        expect(dialog).not.toBeNull();
        expect(container.contains(dialog)).toBe(false);
        for (const value of [site.title, site.description!, site.tags[3], '987654321 次', '987654321 人', '0 次', '3 条', 'MCP 生成', '创建时间', '更新时间', '测试分组']) {
          expect(dialog.textContent).toContain(value);
        }
        expect(dialog.querySelectorAll('li')).toHaveLength(103);
        expect(dialog.textContent).toContain('第102个文件.html');
        expect(dialog.querySelector('details, [aria-expanded="false"]')).toBeNull();
        expect(action).not.toHaveBeenCalled();
        await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(container.querySelector('[aria-label="新创建，尚未打开"]')).not.toBeNull();
      } finally { await act(async () => root.unmount()); container.remove(); }
    });
  }
});
