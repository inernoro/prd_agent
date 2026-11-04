import { describe, expect, it } from 'vitest';
import list from './ReviewAssessmentListPage.tsx?raw';
import detail from './ReviewAssessmentDetailPage.tsx?raw';

describe('需求评估沿用产品管理布局', () => {
  it('列表和详情复用产品页头与按钮，不再窄幅居中或使用独立紫色主按钮', () => {
    for (const page of [list, detail]) {
      expect(page).toContain('<SectionShell');
      expect(page).toContain('<Button size="sm"');
      expect(page).not.toMatch(/max-w-(3xl|5xl)|bg-indigo-|text-white|text-emerald-300|text-red-300/);
    }
  });
  it('列表复用产品管理表格，同时保留上传、分页、自动刷新与原详情路径', () => {
    expect(list).toContain('<OverviewDataTable');
    expect(list).toContain('accept=".xls,.xlsx"');
    expect(list).toContain('onDrop=');
    expect(list).toContain('reviewNav.assessment(');
    expect(list).toContain('totalPages > 1');
    expect(list).toContain('setInterval(');
    expect(list).toContain('!loading && !loadError && items.length === 0');
  });
  it('结果仍展示流式进度、排序、分档、因子依据、重试和报告导出', () => {
    for (const existing of ['connectSse(', 'progress', 'orderedItems', 'TierChip', 'factorScores', 'handleRerun', 'downloadAssessmentReport', 'adjustmentLog']) {
      expect(detail).toContain(existing);
    }
    expect(detail).toContain('aria-expanded={expanded}');
    expect(detail).toContain('text-[color:var(--accent-fg-success)]');
  });
});
