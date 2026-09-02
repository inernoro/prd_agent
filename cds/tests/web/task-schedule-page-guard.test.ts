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
