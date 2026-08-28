import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_PROFILES,
  buildAgentContractInstaller,
  buildAgentStarterHarness,
  buildAgentStarterPrompt,
  buildRoleCardHarness,
  buildRoleDecisionContract,
  type AgentRoleId,
} from '../../web/src/lib/agent-starter';

function cardBody(roleId: AgentRoleId): string {
  return buildRoleDecisionContract('newcomer', roleId);
}

function sectionLabels(card: string): string[] {
  return [...card.matchAll(/^【(.+?)】/gm)].map((match) => match[1]);
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runHarness(
  projectDirectory: string,
  experienceId: 'newcomer' | 'experienced',
  roleId: 'pm' | 'qa',
): void {
  const script = buildAgentStarterHarness({
    cdsOrigin: 'https://cds.example.test',
    experienceId,
    roleId,
    selectedSkillKeys: [],
    includeCds: false,
  });
  const scriptPath = path.join(projectDirectory, 'starter.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  execFileSync('sh', [scriptPath], { cwd: projectDirectory, stdio: 'pipe' });
}

describe('Agent 上手助手角色决策协议', () => {
  it('按角色和经验生成不同的决策重点', () => {
    const newcomerPm = buildRoleDecisionContract('newcomer', 'pm');
    const experiencedQa = buildRoleDecisionContract('experienced', 'qa');

    expect(newcomerPm).toContain('当前角色：产品经理');
    expect(newcomerPm).toContain('用户价值、范围变化、验收结果');
    expect(newcomerPm).toContain('不要要求用户理解 Git、构建、部署或接口细节');
    expect(experiencedQa).toContain('当前角色：测试与验收');
    expect(experiencedQa).toContain('未覆盖项与发布建议');
    expect(experiencedQa).toContain('可保留关键技术证据和风险');
  });

  it('五个角色的决策卡正文两两不同，标题不重名', () => {
    const cards = AGENT_ROLE_PROFILES.map((profile) => ({
      id: profile.id,
      title: profile.cardTitle,
      body: cardBody(profile.id),
    }));

    expect(new Set(cards.map((card) => card.title)).size).toBe(cards.length);
    expect(new Set(cards.map((card) => card.body)).size).toBe(cards.length);

    for (const card of cards) {
      const others = cards.filter((item) => item.id !== card.id);
      // 只有角色名不同不算差异：去掉角色名和标题后，段落集合仍必须不同。
      for (const other of others) {
        expect(sectionLabels(card.body)).not.toEqual(sectionLabels(other.body));
      }
    }
  });

  it('每个角色至少有三个专属段落，防止退回共用模板', () => {
    for (const profile of AGENT_ROLE_PROFILES) {
      const mine = sectionLabels(cardBody(profile.id));
      const others = new Set(
        AGENT_ROLE_PROFILES
          .filter((item) => item.id !== profile.id)
          .flatMap((item) => sectionLabels(cardBody(item.id))),
      );
      const exclusive = mine.filter((label) => !others.has(label));
      expect(exclusive.length, `${profile.label} 缺少专属段落`).toBeGreaterThanOrEqual(3);
    }
  });

  it('每个角色的卡片写明理解方向、先确认的问题和角色禁止项', () => {
    for (const profile of AGENT_ROLE_PROFILES) {
      const card = cardBody(profile.id);
      expect(card).toContain(`理解方向：${profile.lens}`);
      for (const question of profile.intake) expect(card).toContain(question);
      for (const forbidden of profile.forbid) expect(card).toContain(forbidden);
      expect(card).toContain(`### ${profile.cardTitle}`);
    }
  });

  it('所有角色保留共享不变量，且声明的段落数与实际段落数一致', () => {
    for (const profile of AGENT_ROLE_PROFILES) {
      const card = cardBody(profile.id);
      expect(card).toContain('【任务状态】只能使用：已完成，可使用');
      expect(card).toContain('【当前阶段】');
      expect(card).toContain('【整体任务】');
      expect(card).toContain('【下一步】');
      expect(card).toContain('【验收入口】');
      expect(card).toContain('【登录方式】');

      const declared = card.match(/固定 (\d+) 段/);
      expect(declared, `${profile.label} 未声明段落数`).not.toBeNull();
      expect(sectionLabels(card).length).toBe(Number(declared?.[1]));
    }
  });

  it('启动提示词直接携带选中角色的决策协议', () => {
    const prompt = buildAgentStarterPrompt({
      experienceId: 'newcomer',
      roleId: 'owner',
      selectedSkillKeys: [],
      includeCds: false,
      cdsPrompt: '',
    });

    expect(prompt).toContain('八、角色决策回复');
    expect(prompt).toContain('当前角色：业务专家 / 需求专家');
    expect(prompt).toContain('规则覆盖、业务假设、待确认规则');
    expect(prompt).toContain('回复格式以第八节的「规则交付卡」为准');
    expect(prompt).toContain('先检查目标项目的长期规则是否已包含角色决策回复受管区块');
    expect(prompt).toContain('如果不存在，把本提示词中的角色决策协议增量写入长期规则');
    expect(prompt).not.toContain('一键脚本已经把角色决策回复增量写入长期规则');
  });

  it('重复运行 harness 时替换受管规则且保留项目原有内容', () => {
    const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-starter-'));
    temporaryDirectories.push(projectDirectory);
    fs.writeFileSync(path.join(projectDirectory, 'AGENTS.md'), '# 项目原有规则\n');

    runHarness(projectDirectory, 'newcomer', 'pm');
    runHarness(projectDirectory, 'experienced', 'qa');

    const rules = fs.readFileSync(path.join(projectDirectory, 'AGENTS.md'), 'utf8');
    expect(rules).toContain('# 项目原有规则');
    expect(rules).toContain('当前角色：测试与验收');
    expect(rules).not.toContain('当前角色：产品经理');
    expect(rules.match(/CDS_AGENT_DECISION_CARD:START/g)).toHaveLength(1);
    expect(rules.match(/CDS_AGENT_DECISION_CARD:END/g)).toHaveLength(1);
    expect(fs.existsSync(path.join(projectDirectory, '.cds', 'credentials.json'))).toBe(false);
  });

  it('更新符号链接规则文件时保留链接并写入共享目标', () => {
    const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-starter-symlink-'));
    temporaryDirectories.push(projectDirectory);
    const sharedRulesPath = path.join(projectDirectory, 'shared-rules.md');
    const agentRulesPath = path.join(projectDirectory, 'AGENTS.md');
    fs.writeFileSync(sharedRulesPath, '# 共享规则\n');
    fs.symlinkSync('shared-rules.md', agentRulesPath);

    runHarness(projectDirectory, 'newcomer', 'pm');

    expect(fs.lstatSync(agentRulesPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sharedRulesPath, 'utf8')).toContain('当前角色：产品经理');
  });

  it('只换卡片的脚本只改受管区块，不碰技能、.env 和凭据', () => {
    const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-role-card-'));
    temporaryDirectories.push(projectDirectory);
    fs.writeFileSync(path.join(projectDirectory, 'AGENTS.md'), '# 项目原有规则\n');

    // 先用完整脚本装成产品经理，再用最小脚本换成测试与验收。
    runHarness(projectDirectory, 'newcomer', 'pm');
    const envBefore = fs.readFileSync(path.join(projectDirectory, '.env'), 'utf8');

    const cardScript = path.join(projectDirectory, 'card.sh');
    fs.writeFileSync(cardScript, buildRoleCardHarness({ experienceId: 'experienced', roleId: 'qa' }), { mode: 0o700 });
    execFileSync('sh', [cardScript], { cwd: projectDirectory, stdio: 'pipe' });

    const rules = fs.readFileSync(path.join(projectDirectory, 'AGENTS.md'), 'utf8');
    expect(rules).toContain('# 项目原有规则');
    expect(rules).toContain('当前角色：测试与验收');
    expect(rules).not.toContain('当前角色：产品经理');
    expect(rules.match(/CDS_AGENT_DECISION_CARD:START/g)).toHaveLength(1);
    // 最小脚本不得动这些：.env 内容不变，凭据文件仍不存在。
    expect(fs.readFileSync(path.join(projectDirectory, '.env'), 'utf8')).toBe(envBefore);
    expect(fs.existsSync(path.join(projectDirectory, '.cds', 'credentials.json'))).toBe(false);
  });

  it('只换卡片的脚本不联网、不下载技能', () => {
    const script = buildRoleCardHarness({ experienceId: 'newcomer', roleId: 'dev' });
    expect(script).not.toContain('curl');
    expect(script).not.toContain('/api/skills/');
    expect(script).not.toContain('bootstrap.json');
    expect(script).toContain('工程交付卡');
  });

  it('两个脚本共用同一份受管区块替换例程', () => {
    const contract = buildRoleDecisionContract('newcomer', 'pm');
    const installer = buildAgentContractInstaller(contract);
    const full = buildAgentStarterHarness({
      cdsOrigin: 'https://cds.example.test',
      experienceId: 'newcomer',
      roleId: 'pm',
      selectedSkillKeys: [],
      includeCds: false,
    });
    const cardOnly = buildRoleCardHarness({ experienceId: 'newcomer', roleId: 'pm' });

    expect(full).toContain(installer);
    expect(cardOnly).toContain(installer);
  });

  it('受管标记不完整时停止安装并保留全部原规则', () => {
    const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-starter-malformed-'));
    temporaryDirectories.push(projectDirectory);
    const agentRulesPath = path.join(projectDirectory, 'AGENTS.md');
    const originalRules = [
      '# 项目原有规则',
      '<!-- CDS_AGENT_DECISION_CARD:START -->',
      '未完成的受管内容',
      '这行后续规则不得丢失',
      '',
    ].join('\n');
    fs.writeFileSync(agentRulesPath, originalRules);

    expect(() => runHarness(projectDirectory, 'newcomer', 'pm')).toThrow();
    expect(fs.readFileSync(agentRulesPath, 'utf8')).toBe(originalRules);
  });
});
