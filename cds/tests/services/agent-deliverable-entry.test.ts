import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWorkspaceDeliverableEntry } from '../../src/services/agent-workspace-session-runtime';

/**
 * OpenDesign 在 run 状态里指名的交付文件会被搬成发布的 index.html。字符集正则允许点号，
 * `../app/page.html` 这类路径能过它，于是工作区之外的 HTML 可以被抄进成品（Codex P2，2026-09-24）。
 */
describe('交付文件只能是工作区内的相对 .html 路径', () => {
  it('拒绝 . 与 .. 路径段，正常的 slug 与子目录照常放行', () => {
    for (const ok of ['od-generate-artifact.html', 'pages/brief.html', 'a.b/c-d_e.html']) {
      expect(isWorkspaceDeliverableEntry(ok), ok).toBe(true);
    }
    for (const bad of ['../app/page.html', 'pages/../../etc/x.html', './index2.html', 'a/./b.html', '/abs.html', 'x.htm']) {
      expect(isWorkspaceDeliverableEntry(bad), bad).toBe(false);
    }
  });

  it('容器里的搬运脚本按真实路径核对、不跟随符号链接', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/services/agent-workspace-session-runtime.ts'), 'utf8');
    const script = source.slice(source.indexOf('const promoteDeliverableEntryScript'), source.indexOf("].join(' ');", source.indexOf('const promoteDeliverableEntryScript')));
    expect(script).toContain('isSymbolicLink()');
    expect(script).toContain('fs.realpathSync(from)');
    expect(script).toContain('real.startsWith(root + "/")');
    // 入口判据只走这一个函数，不许再退回裸正则。
    expect(source).toContain('if (!isWorkspaceDeliverableEntry(entryFile)) {');
  });
});
