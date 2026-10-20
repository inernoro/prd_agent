import { describe, expect, it } from 'vitest';
import page from './ReviewAgentAllPage.tsx?raw';
import table from '../product-agent/overviewDataTable.tsx?raw';

describe('全部评审提交沿用产品管理布局', () => {
  it('uses the full-width product shell, shared buttons and table instead of standalone cards', () => {
    expect(page).toContain('<SectionShell');
    expect(page).toContain('title="全部评审提交"');
    expect(page).toContain('<Button size="sm"');
    expect(page).toContain('<OverviewDataTable tableKey="review-all-submissions"');
    expect(page).not.toMatch(/max-w-5xl|mx-auto|bg-indigo-|placeholder-white|text-white|text-emerald-400|text-red-400/);
    expect(page).toContain('var(--accent-fg-success)');
    expect(page).toContain('var(--accent-fg-danger)');
  });

  it('keeps controls wrapping and bounds long titles and filenames inside an independently scrollable table', () => {
    expect(page).toContain('flex min-w-0 flex-wrap items-center gap-3');
    expect(page).toContain('basis-full');
    expect(page).toContain('aria-label="提交人"');
    expect(page).toContain('submitters.map(');
    expect(page).toContain('title={item.title}');
    expect(page).toContain('<TruncateCell text={item.fileName}');
    expect(page).toContain('focus-visible:outline');
    expect(table).toContain('min-w-0 overflow-x-auto');
  });

  it('retains filters, leaderboard, pagination, appeal labels and keyboard-accessible detail buttons', () => {
    for (const behavior of [
      'getAllReviewSubmissions(page, pageSize, selectedSubmitterId || undefined, filterParam)',
      'getReviewSubmitters()', 'setStatusFilter(tab.key); setPage(1)',
      'setSelectedSubmitterId(e.target.value); setPage(1)',
      '<ReviewLeaderboardView groupBy="submitter" />',
      'reviewNav.submission(item.id)', 'item.appealStatus',
      'page <= 1', 'page >= totalPages', 'onClick={goBack}',
    ]) expect(page).toContain(behavior);
    expect(page).toContain('aria-pressed={statusFilter === tab.key}');
    expect(page).toContain('aria-pressed={view === tab.key}');
    expect(page).toContain('搜索当前页的方案标题或提交人');
  });
});
