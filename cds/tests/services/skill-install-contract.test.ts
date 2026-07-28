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

describe('匿名路由白名单两处登记一致', () => {
  // CDS 有两道各自独立的门：github 模式走 middleware/github-auth.ts 的 PUBLIC_PATHS，
  // 其余走 server.ts 的 isPublicAccessRequestRoute。**两边都登记才真的匿名可达**，
  // 只改一边的后果是「本地能跑、换个鉴权模式就 401」，而客户拿到的正是那条
  // 「一条命令」——他打不开就整条路走不下去。两个文件都不导出判定函数，
  // 故这里做源码级一致性断言（同 skill-install-contract 的跨语言守法）。
  const authSrc = read('cds/src/middleware/github-auth.ts');
  const serverSrc = read('cds/src/server.ts');

  // 本 PR 引入的匿名入口：预设清单、现场生成的引导脚本、套装清单、技能包下载
  const RULES: Array<[string, RegExp]> = [
    ['预设清单', /'\/api\/bootstrap\/presets'/],
    ['引导脚本（带预设名）', /\/\^\\\/api\\\/bootstrap\\\/\[a-z0-9-\]\+\$\//],
    ['套装清单', /'\/api\/skills\/bundles'/],
    ['技能包下载（带 key）', /\/\^\\\/api\\\/skills\\\/\[a-z0-9-\]\+\\\/download\$\//],
  ];

  it.each(RULES)('%s 在 github-auth 与 server 两处都登记', (_label, rule) => {
    expect(rule.test(authSrc), 'github-auth.ts 的 PUBLIC_PATHS 缺这条').toBe(true);
    expect(rule.test(serverSrc), 'server.ts 的 isPublicAccessRequestRoute 缺这条').toBe(true);
  });

  it('CDS 技能包路径确实能被下载规则命中（cds-pack 不是特例）', () => {
    // 引导脚本第一步就打这个地址；它必须落进 [a-z0-9-]+/download 这条通配里
    const downloadRule = /^\/api\/skills\/[a-z0-9-]+\/download$/;
    expect(downloadRule.test('/api/skills/cds-pack/download')).toBe(true);
    expect(downloadRule.test('/api/skills/pm-starter/download')).toBe(true);
    // 不该放行的形态
    expect(downloadRule.test('/api/skills/../secret/download')).toBe(false);
  });
});

describe('分发技能里不出现写死的宿主路径', () => {
  // 客户项目可能只有 .cursor 或只有 .agents。技能正文里写死
  // `python3 .claude/skills/...` 的话，qa-starter 装上了但预览/归档命令当场找不到文件。
  // 这些技能是随套装/技能包发出去的，必须按运行时解析出的技能根走。
  const DISTRIBUTED = [
    '.claude/skills/create-visual-test-to-kb',
    '.claude/skills/acceptance-checklist',
    '.claude/skills/acceptance-test-design',
    '.claude/skills/acceptance-scenario-orchestrator',
    '.claude/skills/task-handoff-checklist',
    '.claude/skills/cds',
    '.claude/skills/cds-project-scan',
    '.claude/skills/cds-deploy-pipeline',
    '.claude/skills/cds-release',
    '.claude/skills/preview-url',
  ];

  const walkFiles = (dir: string): string[] => {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out: string[] = [];
    const rec = (d: string): void => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) { rec(p); continue; }
        if (/\.(md|json)$/i.test(n)) out.push(p);
      }
    };
    rec(abs);
    return out;
  };

  it.each(DISTRIBUTED)('%s 不写死 .claude/skills 的可执行路径', (dir) => {
    const offenders: string[] = [];
    for (const file of walkFiles(dir)) {
      const text = fs.readFileSync(file, 'utf8');
      // 只管「会被执行」的形态；纯文字描述技能装在哪里不算
      if (/(python3?|bash|node)\s+\.claude\/skills\//.test(text) || /SKILL=\.claude\/skills\//.test(text)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders, `这些文件写死了 .claude/skills 可执行路径：\n${offenders.join('\n')}`).toEqual([]);
  });

  it.each(DISTRIBUTED)('%s 用到 $SKILLS_ROOT 的代码块自带解析', (dir) => {
    const offenders: string[] = [];
    for (const file of walkFiles(dir)) {
      if (!file.endsWith('.md')) continue;
      const text = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n');
      const blocks = [...text.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1]);
      for (const b of blocks) {
        // 没定义就是空路径，命令会去找 /cds/cli/... —— 比写死更难查
        if (b.includes('$SKILLS_ROOT') && !b.includes('SKILLS_ROOT=')) {
          offenders.push(path.relative(REPO_ROOT, file));
          break;
        }
      }
    }
    expect(offenders, `这些文件的代码块用了 $SKILLS_ROOT 却没就近解析：\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('每个可复制的安装/更新命令都自带宿主识别', () => {
  // $SKILLS_DIRS 是循环变量的来源。文档里若把「识别宿主」和「解压」拆进两个代码块，
  // 用户换个 shell 只复制后半段时，SKILLS_DIRS 为空 -> for 循环零次迭代 -> 命令
  // 正常退出但一个技能都没装/没更新。这种「看着成功其实没做」最难自查，故逐块守。
  const FILES = [
    '.claude/skills/findmapskills/SKILL.md',
    '.claude/skills/findmapskills/README.md',
    '.claude/skills/sdd-init/reference/role-playbooks.md',
    '.claude/rules/skill-install-contract.md',
  ];

  it.each(FILES)('%s 的每个代码块要么不用 $SKILLS_DIRS，要么自己初始化它', (rel) => {
    // 先剥掉 blockquote 前缀：`> \`\`\`bash` 这种引用块同样是用户会复制的命令
    const text = read(rel).split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n');
    const blocks = [...text.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1]);

    const offenders = blocks.filter(
      (b) => b.includes('$SKILLS_DIRS') && !/SKILLS_DIRS=(""|\$\()/.test(b),
    );
    expect(offenders, `这些代码块用了 $SKILLS_DIRS 却没就近初始化：\n${offenders.join('\n---\n')}`)
      .toEqual([]);
  });
});
