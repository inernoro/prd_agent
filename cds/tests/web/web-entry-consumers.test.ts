import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const webRoot = path.resolve(process.cwd(), 'web', 'src');
const drawer = fs.readFileSync(path.join(webRoot, 'components', 'BranchDetailDrawer.tsx'), 'utf8');
const branchList = fs.readFileSync(path.join(webRoot, 'pages', 'BranchListPage.tsx'), 'utf8');
const detailPage = fs.readFileSync(path.join(webRoot, 'pages', 'BranchDetailPage.tsx'), 'utf8');

describe('Web 入口消费端接线', () => {
  it('抽屉收到 previewMode，并通过共享函数生成最终主入口', () => {
    expect(branchList).toContain("previewMode={state.status === 'ok' ? state.previewMode : 'multi'}");
    expect(drawer).toContain("from '@/lib/previewUrl'");
    expect(drawer).toContain('resolveWebEntryUrl(previewMode');
  });

  it('完整详情页消费 primaryEntry/webEntries，不再把用户页面叫网关入口', () => {
    expect(detailPage).toContain('primaryEntry?: WebEntryUrl;');
    expect(detailPage).toContain('webEntries?: WebEntryUrl[];');
    expect(detailPage).toContain('resolveWebEntryUrl(state.previewMode');
    expect(detailPage).toContain('其他 Web 页面');
    expect(detailPage).not.toContain('网关入口');
  });
});
