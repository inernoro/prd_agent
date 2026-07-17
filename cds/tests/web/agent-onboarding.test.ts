import { describe, expect, it } from 'vitest';
import { buildCdsAgentPrompt, PROJECT_SKILL_PATHS } from '../../web/src/lib/agent-onboarding.js';

describe('CDS Agent 接入口令', () => {
  it('已有项目口令不含密钥，不修改全局环境，并使用页面批准', () => {
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'existing', projectId: 'proj-a' },
    });

    expect(prompt).toContain('connect --host https://cds.example --project proj-a');
    expect(prompt).toContain('不要向我索要或展示任何密钥');
    expect(prompt).toContain('不要修改系统环境变量、shell profile 或全局 PATH');
    expect(prompt).not.toContain('AI_ACCESS_KEY=');
    expect(prompt).not.toContain('CDS_PROJECT_KEY=');
    expect(prompt).not.toContain('~/.claude');
  });

  it('首次接入口令申请一次性新项目权限', () => {
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'new' },
    });
    expect(prompt).toContain('--new-project');
    expect(prompt).toContain('创建权限使用一次后会自动切换为项目级权限');
  });

  it('列出三个 Agent 的项目级技能目录', () => {
    expect(PROJECT_SKILL_PATHS).toEqual([
      { agent: 'Codex / 通用 Agent Skills', path: '.agents/skills' },
      { agent: 'Cursor', path: '.cursor/skills' },
      { agent: 'Claude Code', path: '.claude/skills' },
    ]);
  });
});
