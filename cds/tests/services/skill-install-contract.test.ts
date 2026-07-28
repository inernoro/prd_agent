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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildBootstrapScript, findPreset } from '../../src/routes/bootstrap.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * 三处实现共同的宿主顺序。改这里 = 改约定，必须处处同步。
 *
 * 写法有两种形态（都合法）：安装侧循环宿主根目录 `for h in .claude .cursor .agents`，
 * 探测侧直接列技能目录 `for d in .claude/skills .cursor/skills .agents/skills`。
 * 断言只看三个宿主名的先后，不绑死写法。
 */
const EXPECTED_ORDER = ['.claude', '.cursor', '.agents'];

describe('技能安装约定（跨 CDS / MAP / 技能文件）', () => {
  const sources: Array<[string, string]> = [
    ['CDS 引导脚本', buildBootstrapScript(findPreset('pm-project')!, 'https://cds.test', 'https://up.test')],
    ['findmapskills SKILL.md', read('.claude/skills/findmapskills/SKILL.md')],
    ['findmapskills README.md', read('.claude/skills/findmapskills/README.md')],
    ['MAP SkillInstallContract', read('prd-api/src/PrdAgent.Api/Controllers/Api/OfficialSkills/SkillInstallContract.cs')],
    // sdd-init 是引导脚本的下一棒：它探测技能目录来决定角色、技能索引和规则文件名
    // （CLAUDE.md vs AGENTS.md）。只看 .claude 会把 Codex/Cursor 项目判成「没装技能」。
    ['sdd-init SKILL.md', read('.claude/skills/sdd-init/SKILL.md')],
    ['sdd-init role-playbooks.md', read('.claude/skills/sdd-init/reference/role-playbooks.md')],
  ];

  /** 真正往磁盘写技能的实现。sdd-init SKILL.md 只做探测、不安装，故不在此列。 */
  const installers = sources.filter(([label]) => label !== 'sdd-init SKILL.md');

  it.each(sources)('%s 覆盖三个宿主且顺序一致', (_label, text) => {
    // 直接取遍历宿主的那一行，别用「全文第一次出现」——正文里的说明文字会打乱顺序。
    const loop = /for\s+\w+\s+in\s+((?:\.\w[\w/]*\s+){2}\.\w[\w/]*)\s*;?\s*do/.exec(text);
    expect(loop, '找不到遍历宿主目录的 for 循环').not.toBeNull();
    const hosts = loop![1].trim().split(/\s+/).map((h) => h.replace(/\/skills$/, ''));
    expect(hosts).toEqual(EXPECTED_ORDER);
    // 兜底目录必须是 .agents/skills（一个宿主都没有时建它）
    expect(text).toContain('.agents/skills');
  });

  it.each(installers)('%s 装到所有存在的宿主，不是只装第一个命中的', (_label, text) => {
    // 一个仓库可能同时装了多个 Agent（本仓库就同时有 .claude 和 .agents）。
    // 按优先级取第一个的话，从 Codex 跑会装进 .claude/skills，而 Codex 只读
    // .agents/skills —— 装完了一个技能都看不见。所以必须遍历安装，不能 elif 取一个。
    expect(text).toContain('SKILLS_DIRS');
    // 早期的「取第一个」写法（if/elif 链或 && || 三元）一律不许再出现
    expect(text).not.toMatch(/elif\s+\[\s+-d\s+"?\.cursor/);
    expect(text).not.toMatch(/SKILLS_DIR=\$\(\[\s+-d\s+\.claude\s+\]\s+&&/);
    // 必须有「对每个目录都装一遍」的循环
    expect(text).toMatch(/for\s+\w+\s+in\s+\$SKILLS_DIRS/);
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
    expect(oneLiner).toContain('SKILLS_DIRS=$(');
    // `if ... && elif ...` 不是合法 shell，粘贴过去直接语法错
    expect(oneLiner).not.toMatch(/\bif\b[\s\S]*&&[\s\S]*\belif\b/);
  });

  it('ai-defect-resolve 内外两版的协议契约不漂移', () => {
    // 这两版是**有意不同**的：仓库版 13KB 面向内部，后端内嵌版 5KB 是精简外发兜底包。
    // 盲目合并会把内部文档整篇发给外部，所以不合并 —— 但协议契约（端点、scope、
    // 状态字段）必须始终一致，否则外部 Agent 按外发版调用会打到不存在的接口。
    const internal_ = read('.claude/skills/ai-defect-resolve/SKILL.md');
    const templates = read('prd-api/src/PrdAgent.Api/Controllers/Api/OfficialSkills/OfficialSkillTemplates.cs');
    const external = /AiDefectResolveSkillMd\s*=\s*"""([\s\S]*?)\n""";/.exec(templates)?.[1] ?? '';
    expect(external.length).toBeGreaterThan(1000);

    const CONTRACT = /agent\/workflow\/[a-z-]+|defect-agent:[a-z-]+|defect-agent-workflow\.v\d|defect_resolution_traces|functionalVerdict|evidenceStatus|reportVerdict|hasNext/g;
    const marks = (text: string): string[] => [...new Set(text.match(CONTRACT) ?? [])].sort();
    // 外发版出现的每一个契约标记，仓库版都必须有
    const drifted = marks(external).filter((m) => !marks(internal_).includes(m));
    expect(drifted).toEqual([]);
  });

  it('findmapskills 只有一份正文（后端不再内嵌第二份）', () => {
    const templates = read('prd-api/src/PrdAgent.Api/Controllers/Api/OfficialSkills/OfficialSkillTemplates.cs');
    // 历史上这里内嵌过一份完整 SKILL.md，注释写着「两边都要改」，实测已开始漂移
    expect(templates).not.toContain('FindMapSkillsSkillMd');
    expect(templates).not.toContain('FindMapSkillsReadme');
    expect(templates).not.toContain('两边都要改');
  });
});

describe('引导脚本的退出码语义', () => {
  const PRESETS = ['pm-project', 'dev-project', 'qa-project', 'cds-only'];

  it.each(PRESETS)('%s: 必需包没装上时以非零码退出', (key) => {
    // 半装的项目不能被当成装好了：脚本以前只打一行 warning 就 exit 0，
    // 一键脚本 / CI 会带着残缺技能集继续往下跑，等到用不了才发现。
    // 这里用一个必定连不上的地址跑真脚本，断言退出码非零。
    const script = buildBootstrapScript(findPreset(key)!, 'http://127.0.0.1:1', 'http://127.0.0.1:1');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bootstrap-'));
    try {
      const file = path.join(dir, 'bootstrap.sh');
      fs.writeFileSync(file, script);
      const r = spawnSync('sh', [file], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
      const err = r.stderr ?? '';
      // 环境本身缺 curl/unzip/tar 时脚本会走依赖自检分支，那不是本用例要测的路径
      if (err.includes('缺少这些命令')) return;
      expect(r.status).not.toBe(0);
      expect(err).toContain('未安装');
      expect(err).toContain('安装未完成');
      // 失败时不许再喊「安装完成」
      expect(r.stdout ?? '').not.toContain('安装完成');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('全部装上时正常退出（脚本本身语法合法）', () => {
    for (const key of PRESETS) {
      const script = buildBootstrapScript(findPreset(key)!, 'https://cds.test', 'https://up.test');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bootstrap-syn-'));
      try {
        const file = path.join(dir, 'bootstrap.sh');
        fs.writeFileSync(file, script);
        const r = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
        expect({ key, status: r.status, stderr: r.stderr }).toEqual({ key, status: 0, stderr: '' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
