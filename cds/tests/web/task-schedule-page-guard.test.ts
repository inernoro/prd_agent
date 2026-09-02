import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 任务调度页里几处「删掉之后页面照样渲染、所有用例照样绿」的接线。
 * 这类退化只有真人操作才会发现（predicate-and-wiring 形状 2），所以用源码扫描钉住。
 */
const SRC = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/TaskSchedulePage.tsx'),
  'utf8',
);
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('任务调度页的接线', () => {
  const src = strip(SRC);

  /*
   * Codex #1471 P2。保存 / 删除 / 立即执行失败时只 setError，而页面级 ErrorBlock
   * 渲染在弹窗之后、被遮罩盖住；失败时弹窗又不会关（只有成功才 setEditorOpen(false)），
   * 于是用户看到的只是忙碌态停下，没有原因也没有下一步。
   * 红绿闭环：删掉弹窗里那个 data-editor-error 块，本用例立刻红。
   */
  it('编辑弹窗内部要能显示错误，不能只依赖被遮罩盖住的页面级 ErrorBlock', () => {
    const dialogStart = src.indexOf('<Dialog open={editorOpen}');
    expect(dialogStart, '找不到编辑弹窗（结构变了？）').toBeGreaterThan(-1);
    const dialogEnd = src.indexOf('</Dialog>', dialogStart);
    const dialog = src.slice(dialogStart, dialogEnd);

    expect(dialog, '编辑弹窗里没有错误出口').toContain('data-editor-error');
    // 必须真的绑在 error 上，不是一个写死的占位
    expect(dialog).toMatch(/\{error \?[\s\S]{0,400}data-editor-error/);
    // 无障碍：错误要能被读屏播报
    expect(dialog).toContain('role="alert"');
  });

  /*
   * 打开编辑器时不清 error，上一次操作的报错会顶在新弹窗里。
   * 红绿闭环：把 openEditor 里的 setError('') 删掉，本用例红。
   */
  it('打开编辑器会清掉上一次的错误', () => {
    const at = src.indexOf('const openEditor');
    expect(at, '找不到 openEditor').toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('};', at));
    expect(body).toContain("setError('')");
    expect(body).toContain('setEditorOpen(true)');
    // 所有打开编辑器的入口都要走它，不许再有裸的 setEditorOpen(true)
    const bare = src.match(/setEditorOpen\(true\)/g) || [];
    expect(bare.length, '有入口绕过 openEditor 直接 setEditorOpen(true)').toBe(1);
  });

  /*
   * Codex #1471 P2。服务端为每个任务保留 120 条，但页面读的是**全局最近 400 条**：
   * 高频任务把名额占满后，低频任务的健康条、P50、细带、运行流全被抽空——
   * 服务端那个修复到不了用户面前。选中任务时必须按 jobId 单独取它的完整史。
   * 红绿闭环：删掉那个 jobId 拉取的 effect，本用例报找不到 selectedRuns 的来源。
   */
  it('选中任务时按 jobId 取它的完整运行史，不只吃全局切片', () => {
    expect(src, '没有按 jobId 取运行史').toMatch(/scheduled-jobs\/runs\?jobId=/);
    expect(src, '拉回来的结果没有落到状态里').toContain('setSelectedRuns');
    // 合并后的池子要真的被「这个任务自己」的视图消费
    const merged = src.slice(src.indexOf('const mergedRuns'), src.indexOf('const healthOf'));
    expect(merged).toContain('selectedRuns');
    expect(src).toMatch(/\}, \[mergedRuns\]\);/);

    // 今日统计仍然只看全局那份：否则同一屏的数字会随着选中谁而变。
    const overview = src.slice(src.indexOf('const overview'), src.indexOf('const overview') + 160);
    expect(overview, '今日统计不能吃 mergedRuns，否则数字随选中项漂移').toContain('buildOverview(jobs, runs, now)');
    expect(overview).not.toContain('mergedRuns');
  });

  /*
   * Codex #1471 P2。值班条右侧那段统计是固定宽的（5×86 + 188 = 618px）。
   * 它此前从 md（768px）就露，那一档扣掉左栏与内边距后几乎没有余量，
   * 结论条被压到接近零并被父级 overflow-hidden 裁掉——而结论条是这一页存在的理由。
   * 红绿闭环：把 lg:flex 换回 md:flex，本用例立刻红。
   */
  it('固定宽的统计段要等到宽度够了才露，不能挤掉结论条', () => {
    expect(src, '统计段仍从 md 就露，768px 那一档会挤掉结论条').not.toMatch(/hidden shrink-0 items-stretch md:flex/);
    expect(src).toContain('hidden shrink-0 items-stretch lg:flex');
  });

  /*
   * 三个写操作在进入时都要先清 error，否则上一次的报错会伪装成这一次的结果。
   * 红绿闭环：删掉 deleteJob 里的 setError('')，本用例红。
   */
  it('保存 / 删除 / 立即执行进入时都先清错误', () => {
    for (const fn of ['const saveJob', 'const deleteJob', 'const runNow']) {
      const at = src.indexOf(fn);
      expect(at, `找不到 ${fn}`).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf('  };', at));
      expect(body, `${fn} 没有在开头清掉上一次的错误`).toContain("setError('')");
    }
  });
});
