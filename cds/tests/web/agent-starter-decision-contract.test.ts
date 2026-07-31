import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAgentStarterHarness,
  buildAgentStarterPrompt,
  buildRoleDecisionContract,
} from '../../web/src/lib/agent-starter';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Agent 上手助手角色决策协议', () => {
  it('按角色和经验生成不同的决策重点', () => {
    const newcomerPm = buildRoleDecisionContract('newcomer', 'pm');
    const experiencedQa = buildRoleDecisionContract('experienced', 'qa');

    expect(newcomerPm).toContain('当前角色：产品经理');
    expect(newcomerPm).toContain('用户价值、范围变化、验收结果');
    expect(newcomerPm).toContain('不要要求用户理解 Git、构建、部署或接口细节');
    expect(experiencedQa).toContain('当前角色：测试与验收');
    expect(experiencedQa).toContain('失败或未覆盖项与发布建议');
    expect(experiencedQa).toContain('可保留关键技术证据和风险');
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
    expect(prompt).toContain('业务目标、规则覆盖、待确认规则');
    expect(prompt).toContain('先检查目标项目的长期规则是否已包含角色决策回复受管区块');
    expect(prompt).toContain('如果不存在，把本提示词中的角色决策协议增量写入长期规则');
    expect(prompt).not.toContain('一键脚本已经把角色决策回复增量写入长期规则');
  });

  it('重复运行 harness 时替换受管规则且保留项目原有内容', () => {
    const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-starter-'));
    temporaryDirectories.push(projectDirectory);
    fs.writeFileSync(path.join(projectDirectory, 'AGENTS.md'), '# 项目原有规则\n');

    const runHarness = (experienceId: 'newcomer' | 'experienced', roleId: 'pm' | 'qa') => {
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
    };

    runHarness('newcomer', 'pm');
    runHarness('experienced', 'qa');

    const rules = fs.readFileSync(path.join(projectDirectory, 'AGENTS.md'), 'utf8');
    expect(rules).toContain('# 项目原有规则');
    expect(rules).toContain('当前角色：测试与验收');
    expect(rules).not.toContain('当前角色：产品经理');
    expect(rules.match(/CDS_AGENT_DECISION_CARD:START/g)).toHaveLength(1);
    expect(rules.match(/CDS_AGENT_DECISION_CARD:END/g)).toHaveLength(1);
    expect(fs.existsSync(path.join(projectDirectory, '.cds', 'credentials.json'))).toBe(false);
  });
});
