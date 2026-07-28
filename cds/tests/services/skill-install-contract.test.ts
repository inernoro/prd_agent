/**
 * 技能安装约定跨仓守卫。
 *
 * 背景：安装目录这件事此前散在四处各写各的，findmapskills 教用户装
 * `~/.claude/skills/`（用户级 + 写死 .claude），CDS 引导脚本装项目级三宿主。
 * 结果是同一个客户项目里分裂出两处技能库：一处跟着 git 走、一处跟着这台机器走，
 * 队友 clone 下来少一半。
 *
 * 约定统一为：**项目级优先，探测顺序 .claude → .cursor → 兜底 .agents**。
 * 三处实现跨语言无法共享代码（TS 脚本 / C# 后端 / Markdown 技能），
 * 只能靠本测试把它们钉在一起 —— 任何一处改了，这里就红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { buildBootstrapScript, findPreset } from '../../src/routes/bootstrap.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** 三处实现共同的探测顺序。改这里 = 改约定，必须三处同步。 */
const EXPECTED_ORDER = ['.claude/skills', '.cursor/skills', '.agents/skills'];

describe('技能安装约定（跨 CDS / MAP / 技能文件）', () => {
  const sources: Array<[string, string]> = [
    ['CDS 引导脚本', buildBootstrapScript(findPreset('pm-project')!, 'https://cds.test', 'https://up.test')],
    ['findmapskills SKILL.md', read('.claude/skills/findmapskills/SKILL.md')],
    ['findmapskills README.md', read('.claude/skills/findmapskills/README.md')],
    ['MAP SkillInstallContract', read('prd-api/src/PrdAgent.Api/Controllers/Api/OfficialSkills/SkillInstallContract.cs')],
  ];

  it.each(sources)('%s 使用同一套宿主探测顺序', (_label, text) => {
    const found = EXPECTED_ORDER.filter((d) => text.includes(d));
    expect(found).toEqual(EXPECTED_ORDER);
    // 顺序也要一致：.claude 必须排在 .cursor 前，.agents 兜底在最后
    expect(text.indexOf('.claude/skills')).toBeLessThan(text.indexOf('.cursor/skills'));
    expect(text.indexOf('.cursor/skills')).toBeLessThan(text.indexOf('.agents/skills'));
  });

  it.each(sources)('%s 不把技能装进用户主目录', (_label, text) => {
    // 装到 ~ 的话技能不跟项目走，团队 clone 下来少一半。
    // 允许在解释性文字里出现 `~`，但不允许出现真正的安装路径。
    expect(text).not.toMatch(/-d\s+~\/\.claude\/skills/);
    expect(text).not.toMatch(/-d\s+"?\$HOME\/\.claude\/skills/);
    expect(text).not.toMatch(/unzip[^\n]*~\/\.claude\/skills/);
  });

  it('MAP 侧的单行式是合法 shell（不能把 if/elif 用 && 拼起来）', () => {
    const cs = read('prd-api/src/PrdAgent.Api/Controllers/Api/OfficialSkills/SkillInstallContract.cs');
    const oneLiner = /DetectOneLiner\s*=\s*([\s\S]*?);/.exec(cs)?.[1] ?? '';
    expect(oneLiner).toContain('SKILLS_DIR=$(');
    // `if ... && elif ...` 不是合法 shell，粘贴过去直接语法错
    expect(oneLiner).not.toMatch(/\bif\b[\s\S]*&&[\s\S]*\belif\b/);
  });

  it('findmapskills 只有一份正文（后端不再内嵌第二份）', () => {
    const templates = read('prd-api/src/PrdAgent.Api/Controllers/Api/OfficialSkills/OfficialSkillTemplates.cs');
    // 历史上这里内嵌过一份完整 SKILL.md，注释写着「两边都要改」，实测已开始漂移
    expect(templates).not.toContain('FindMapSkillsSkillMd');
    expect(templates).not.toContain('FindMapSkillsReadme');
    expect(templates).not.toContain('两边都要改');
  });
});
