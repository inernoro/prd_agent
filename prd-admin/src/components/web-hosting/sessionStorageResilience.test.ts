import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 生成的任务逻辑随工作台搬进了 useSiteGenerationRun；判据跟着逻辑走。
const dialog = readFileSync(new URL('./workbench/useSiteGenerationRun.ts', import.meta.url), 'utf8');
const pptPage = readFileSync(new URL('../../pages/md-to-ppt-agent/MdToPptAgentPage.tsx', import.meta.url), 'utf8');

/**
 * sessionStorage 在隐私窗口、站点数据被禁、配额用尽时会**抛异常**，不是静默失败
 * （Codex P2 x2，2026-09-15）。两个后果都属于「白等一场」：
 *
 *  1. 生成弹窗里那次写入夹在「服务端任务已创建」与「进入流式 try」之间，一抛就地中断：
 *     服务端继续生成，弹窗永远停在「正在校验所选知识」。
 *  2. PPT 页把知识正文（可以好几兆、且同一份存两遍）整个塞进 session，超配额时
 *     saveSession 静默吞掉、快照停在上一版，刷新之后连 runId 都恢复不出来。
 */
describe('sessionStorage 失败不能拖垮正在跑的任务', () => {
  it('生成工作台的 storage 访问全部走带 try 的封装', () => {
    // companion：封装确实存在。
    expect(dialog).toContain('function rememberActiveRun(');
    expect(dialog).toContain('function forgetActiveRun(');
    expect(dialog).toContain('function readActiveRun(');

    // 真实 API 只许出现在三个封装里，各一次。
    const raw = dialog.match(/sessionStorage\.\w+\(/g) ?? [];
    expect(raw, '有 storage 调用绕过了封装，抛出来会把生成中断在半路').toHaveLength(3);

    // 封装自己不能递归（写过一次这个 bug）。
    expect(dialog).not.toMatch(/function forgetActiveRun\(\)[^}]*forgetActiveRun\(\)/);
  });

  it('PPT 页不把知识正文写进 session，只存身份', () => {
    expect(pptPage).toContain('function stripKbBodies');
    const start = pptPage.indexOf('function saveSession(');
    expect(start).toBeGreaterThan(-1);
    const body = pptPage.slice(start, start + 900);
    // companion：确实截到了 saveSession（它写 sessionStorage）。
    expect(body).toContain('sessionStorage.setItem');
    expect(body, '知识正文仍被整份写进 session，超配额会让快照停在上一版')
      .toContain('activeKnowledgeRefs: stripKbBodies(');
    expect(body).toContain('pendingKbRefs: stripKbBodies(');
    expect(body).toContain('kbRefs: stripKbBodies(m.kbRefs)');
  });
});
