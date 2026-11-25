/**
 * /cds 一句话的路由表：按 CDS 左侧菜单分组，把用户会说的话接到 Agent 任务（agent-mission-registry）上。
 *
 * 输入只有一份：.claude/skills/cds/reference/menu-intents.json（用户怎么说 → 哪个任务或哪一节文档）。
 * 页面、要读的技能、cdscli 命令族、风险等级都从注册表取，不手写；输出两份：
 *   - reference/menu.md：完整路由表和每个任务的步骤；
 *   - SKILL.md 里 <!-- cds-menu:start --> … <!-- cds-menu:end --> 之间的摘要。
 * 校验不通过（任务不存在、任务没人说、菜单不在左侧导航、文档小节不存在）就返回错误，不写文件。
 */
import {
  AGENT_MISSION_DEFINITIONS, getAgentCapabilitiesForMission, type AgentPageContextId,
} from '../shared/agent-mission-registry.js';

export type MenuIntent = { say: string[]; mission?: string; read?: string; doc?: { file: string; section: string } };
export type MenuGroup = { menu: string; say: string; intents: MenuIntent[] };
export type MenuIntents = { note?: string; menus: MenuGroup[] };
export type MenuSources = {
  intents: MenuIntents;
  /** AppShell.tsx 源码：菜单名必须是左侧导航里真实的 aria-label */
  appShell: string;
  /** 技能目录里的文件：路径 → 内容（用来核对 read 和 doc 指向的文件和小节） */
  skillFiles: Record<string, string>;
};

export const MENU_BLOCK_START = '<!-- cds-menu:start（程序生成，改 reference/menu-intents.json 后运行 cds/scripts/sync-cds-menu-routes.ts） -->';
export const MENU_BLOCK_END = '<!-- cds-menu:end -->';
const riskText = { 'read-only': '只读', protocol: '只读', write: '会写入', destructive: '含删除、覆盖或回滚，执行前要明确授权' } as const;
const riskRank = { 'read-only': 0, protocol: 0, write: 1, destructive: 2 } as const;

const missionOf = (id: string) => (AGENT_MISSION_DEFINITIONS as Record<string, (typeof AGENT_MISSION_DEFINITIONS)[AgentPageContextId] | undefined>)[id];
const headings = (text: string) => [...text.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map(match => match[1]);
const quote = (say: string) => `\`/cds ${say}\``;

function facts(id: AgentPageContextId) {
  const mission = AGENT_MISSION_DEFINITIONS[id];
  const capabilities = getAgentCapabilitiesForMission(id);
  const skills = [...new Set([...(mission.requiredSkills ?? []), ...capabilities.map(item => item.preferredSkill)].filter(skill => skill !== 'cds'))];
  const commands = [...new Set(capabilities.flatMap(item => (item.cliFamily ?? '').split(/\s*\/\s*/)).filter(Boolean))];
  const risk = capabilities.reduce<keyof typeof riskRank>((worst, item) => riskRank[item.risk] > riskRank[worst] ? item.risk : worst, 'read-only');
  return { mission, skills, commands, risk, page: mission.pagePath('PROJECT_ID').replace('PROJECT_ID', '<项目>') };
}

export function buildCdsMenuRoutes({ intents, appShell, skillFiles }: MenuSources) {
  const errors: string[] = [];
  const menuLabels = new Set([...appShell.matchAll(/aria-label="([^"]+)"/g)].map(match => match[1]));
  const used = new Set<string>();
  for (const group of intents.menus) {
    if (!menuLabels.has(group.menu)) errors.push(`菜单「${group.menu}」不在左侧导航里`);
    if (!group.intents.length) errors.push(`菜单「${group.menu}」没有任何说法`);
    for (const intent of group.intents) {
      if (!intent.say.length || intent.say.some(text => !text.trim())) errors.push(`菜单「${group.menu}」有空说法`);
      if (!intent.mission && !intent.doc) errors.push(`「${intent.say[0]}」既没有任务也没有文档`);
      if (intent.mission) { if (missionOf(intent.mission)) used.add(intent.mission); else errors.push(`「${intent.say[0]}」指向不存在的任务 ${intent.mission}`); }
      if (intent.read && !(intent.read in skillFiles)) errors.push(`「${intent.say[0]}」要读的文件不存在：${intent.read}`);
      if (intent.doc) {
        const text = skillFiles[intent.doc.file];
        if (text === undefined) errors.push(`「${intent.say[0]}」指向的文件不存在：${intent.doc.file}`);
        else if (!headings(text).includes(intent.doc.section)) errors.push(`「${intent.say[0]}」指向的小节不存在：${intent.doc.file}「${intent.doc.section}」`);
      }
    }
  }
  for (const id of Object.keys(AGENT_MISSION_DEFINITIONS)) if (!used.has(id)) errors.push(`任务 ${id}（${AGENT_MISSION_DEFINITIONS[id as AgentPageContextId].shortLabel}）没有对应的说法`);
  const says = intents.menus.flatMap(group => group.intents.flatMap(intent => intent.say));
  for (const text of new Set(says)) if (says.filter(other => other === text).length > 1) errors.push(`说法重复：${text}`);
  if (errors.length) return { errors, menu: '', block: '' };

  const menu: string[] = [
    '# /cds 一句话路由（按 CDS 菜单）', '',
    '> 程序生成，不要手改。改说法在 `menu-intents.json`，页面、技能、命令和风险来自 CDS 的 Agent 任务注册表（`agent-mission-registry.ts`）。', '',
    '用户说 `/cds <一句话>`：先按下表找到菜单和任务，读「先读」里的技能和文档，按「步骤」做；写操作按「风险」确认。一句话对不上任何一行时，列出菜单名问一次。', '',
  ];
  for (const group of intents.menus) {
    menu.push(`## ${group.menu}`, '', '| 你可以说 | 任务 | 先读 | 命令 | 风险 |', '| --- | --- | --- | --- | --- |');
    for (const intent of group.intents) {
      const say = intent.say.map(quote).join('、');
      if (intent.mission) {
        const { mission, skills, commands, risk } = facts(intent.mission as AgentPageContextId);
        const read = [...skills.map(skill => `${skill}/SKILL.md`), ...(intent.read ? [intent.read] : [])];
        menu.push(`| ${say} | ${mission.title} | ${read.length ? read.map(file => `\`${file}\``).join('、') : '本技能'} | ${commands.length ? commands.map(command => `\`cdscli ${command}\``).join('、') : '—'} | ${riskText[risk]} |`);
      } else menu.push(`| ${say} | ${intent.doc!.section} | \`${intent.doc!.file}\`「${intent.doc!.section}」 | — | 见文档 |`);
    }
    menu.push('');
    for (const intent of group.intents.filter(item => item.mission)) {
      const { mission, page } = facts(intent.mission as AgentPageContextId);
      menu.push(`### ${mission.title}`, '', `${mission.summary} 页面：\`${page}\`。`, '', '步骤：', ...mission.steps.map((step, index) => `${index + 1}. ${step}`), '',
        `完成标准：${mission.completion.join('；')}。`, '');
    }
  }
  const block = [MENU_BLOCK_START, '', '| 菜单 | 你可以说 |', '| --- | --- |',
    ...intents.menus.map(group => `| ${group.menu} | ${group.intents.flatMap(intent => intent.say.slice(0, 2)).slice(0, 4).map(text => `\`/cds ${text}\``).join('、')} |`), '',
    '完整路由、每个任务要读的技能、命令和步骤见 [按菜单的路由表](reference/menu.md)。', MENU_BLOCK_END].join('\n');
  return { errors, menu: menu.join('\n').replace(/\n+$/, '\n'), block };
}

/** 把 SKILL.md 里标记之间的内容换成新的摘要；没有标记时返回 null */
export function replaceMenuBlock(skill: string, block: string) {
  const start = skill.indexOf(MENU_BLOCK_START), end = skill.indexOf(MENU_BLOCK_END);
  if (start < 0 || end < start) return null;
  return skill.slice(0, start) + block + skill.slice(end + MENU_BLOCK_END.length);
}
