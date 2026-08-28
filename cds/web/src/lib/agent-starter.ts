export type AgentExperienceId = 'newcomer' | 'experienced';
export type AgentRoleId = 'pm' | 'owner' | 'domain-expert' | 'dev' | 'qa';

export interface AgentExperienceProfile {
  id: AgentExperienceId;
  label: string;
  eyebrow: string;
  description: string;
  promptRule: string;
}

export interface AgentRoleCardField {
  label: string;
  rule: string;
}

export interface AgentRoleProfile {
  id: AgentRoleId;
  label: string;
  description: string;
  defaultBundleKey: 'pm-starter' | 'dev-starter' | 'qa-starter';
  promptRule: string;
  decisionFields: readonly string[];
  /** 理解方向：这个角色把需求读成什么。 */
  lens: string;
  /** 接到任务先确认的问题，决定 Agent 的提问方向。 */
  intake: readonly string[];
  /** 决策卡标题，角色之间不得重名。 */
  cardTitle: string;
  /** 角色专属段落，替换掉此前所有角色共用的一套字段。 */
  fields: readonly AgentRoleCardField[];
  /** 角色专属禁止项。 */
  forbid: readonly string[];
}

export const AGENT_EXPERIENCE_PROFILES: readonly AgentExperienceProfile[] = [
  {
    id: 'newcomer',
    label: '小登',
    eyebrow: 'AI 开发经验 1 年以内',
    description: '我只说目标，Agent 帮我处理分支、提交、部署和预览。',
    promptRule: '把我当作刚开始使用 AI 开发的业务用户。少用术语，每一步先说结论和对我的影响；能自动完成的不要反问。',
  },
  {
    id: 'experienced',
    label: '老登',
    eyebrow: 'AI 开发经验 1 年以上',
    description: '我熟悉 AI 协作，希望更快看到计划、风险和结果。',
    promptRule: '我熟悉 AI 开发协作。保持简洁，优先给计划、关键风险、证据和结果；基础术语不必逐项解释。',
  },
] as const;

export const AGENT_ROLE_PROFILES: readonly AgentRoleProfile[] = [
  {
    id: 'pm',
    label: '产品经理',
    description: '关注用户、问题、范围、优先级和验收。',
    defaultBundleKey: 'pm-starter',
    promptRule: '我的角色是产品经理。默认用产品语言说明用户价值、范围、验收和风险，不要把技术选型题直接丢给我。',
    decisionFields: ['用户价值', '范围变化', '验收结果'],
    lens: '把每个需求读成「哪一类用户、在什么场景、原来卡在哪、现在能多做哪个动作」，实现方式不是需要我确认的内容。',
    intake: [
      '这次要解决的是哪一类用户的什么问题',
      '做完之后用户能多做哪一个动作',
      '这次明确不做什么',
    ],
    cardTitle: '产品交付卡',
    fields: [
      { label: '用户能做什么', rule: '用用户动作描述本次产出，禁止用模块名、接口名、表名代替。' },
      { label: '影响面', rule: '说明谁会看到变化、牵动哪些既有流程；判断不了写「影响面未确认」。' },
      { label: '范围变化', rule: '对照最初需求写清增加、缩减、挂起了什么；没变化写「与原需求一致」。' },
      { label: '验收结果', rule: '写清哪条用户路径被真实走通、在哪个环境走的；没走通直说未验证。' },
      { label: '需要你拍板', rule: '写「无」，或只提一个产品取舍问题：做不做、先做哪个、按哪种口径。' },
    ],
    forbid: ['把技术方案讲成交付内容', '范围缩水时仍写「已完成」'],
  },
  {
    id: 'owner',
    label: '业务专家 / 需求专家',
    description: '负责把业务目标、需求规则、例外情况和验收标准讲清楚。',
    defaultBundleKey: 'pm-starter',
    promptRule: '我的角色是业务专家或需求专家。优先把业务目标、需求规则、例外情况和验收标准讲清楚，技术实现由你负责。',
    decisionFields: ['规则覆盖', '业务假设', '待确认规则'],
    lens: '把每个需求读成「一组业务规则加例外分支」，先对齐规则口径，再谈怎么实现。',
    intake: [
      '这条业务的正常流程是什么',
      '有哪些例外情况和禁止情况',
      '判定标准由谁定、以哪份口径为准',
    ],
    cardTitle: '规则交付卡',
    fields: [
      { label: '已覆盖规则', rule: '逐条列出本次真正实现的业务规则，最多五条，一条一行。' },
      { label: '未覆盖或按默认处理', rule: '列出没做的规则和例外分支；没有写「无」，不得省略这一段。' },
      { label: '我做的业务假设', rule: '列出你在口径不明时自行选择的判断，一条都不许只留在实现里。' },
      { label: '验证证据', rule: '写清用哪组真实业务数据或场景验过、结果是什么；没验直说。' },
      { label: '需要你确认的规则', rule: '写「无」，或只提一条口径不明的规则。' },
    ],
    forbid: ['用技术术语代替规则表述', '把自行假设的口径当成用户已确认'],
  },
  {
    id: 'domain-expert',
    label: '领域专家',
    description: '关注业务规则、例外情况和专业准确性。',
    defaultBundleKey: 'pm-starter',
    promptRule: '我的角色是领域专家。优先确认专业规则、例外条件和结果准确性；技术实现由你负责，并用业务流程解释。',
    decisionFields: ['专业结论', '判断依据', '不确定项'],
    lens: '把每个需求读成「一个专业判断题」，先问结论是否成立、依据能否追溯，再谈功能做成什么样。',
    intake: [
      '这次要给出的专业结论是什么',
      '判断依据来自哪份数据或口径',
      '哪些边界条件会推翻这个结论',
    ],
    cardTitle: '专业结论卡',
    fields: [
      { label: '专业结论', rule: '一句话说明本次产出在专业上是否成立、成立到什么程度。' },
      { label: '判断依据', rule: '写清依据的数据、口径或来源；来源不明必须写「依据不足」，不得补一个看似合理的说法。' },
      { label: '不确定项', rule: '列出可能推翻结论的边界条件和数据缺口；没有写「无」。' },
      { label: '验证证据', rule: '写清用哪份真实数据或案例核对过、核对结果是什么。' },
      { label: '需要你复核', rule: '写「无」，或只提一个必须由你判定的专业问题。' },
    ],
    forbid: ['没有依据就下结论', '用「应该没问题」替代依据'],
  },
  {
    id: 'dev',
    label: '开发',
    description: '关注架构、实现、验证和可维护性。',
    defaultBundleKey: 'dev-starter',
    promptRule: '我的角色是开发。可以使用必要的技术术语，但结论必须关联真实代码、运行证据和部署路径。',
    decisionFields: ['核心改动', '验证证据', '影响面与技术风险'],
    lens: '把每个需求读成「改哪几处代码、怎么证明它对、会牵动谁」，实现细节自己负责，不把技术选型反问给我。',
    intake: [
      '入口和数据流经过哪几层',
      '现有实现里有没有同类写法可以复用',
      '这次改动会牵动哪些调用方和共享状态',
    ],
    cardTitle: '工程交付卡',
    fields: [
      { label: '核心改动', rule: '按模块或文件一句话一条，最多五条，写改了什么行为而不是改了哪个文件名。' },
      { label: '验证方式与结果', rule: '写清跑了哪些命令、测试或真实路径以及结果；没跑的必须写「未运行」。' },
      { label: '影响面与回归风险', rule: '列出受牵连的调用方、数据、部署或共享状态；没有写「无」。' },
      { label: '未做的部分', rule: '列出本次留下的技术债、临时方案或跳过的分支；没有写「无」。' },
      { label: '需要你决定', rule: '写「无」，或只提一个业务取舍问题；技术选型自己拍板。' },
    ],
    forbid: ['把编译通过当作功能验收', '把没运行的检查写成已运行'],
  },
  {
    id: 'qa',
    label: '测试与验收',
    description: '关注场景、断言、证据和回归。',
    defaultBundleKey: 'qa-starter',
    promptRule: '我的角色是测试与验收。优先说明场景、行为断言、证据和回归范围，不把接口成功等同于用户验收通过。',
    decisionFields: ['验收结论', '场景与断言', '未覆盖项与发布建议'],
    lens: '把每个需求读成「一组可断言的场景」，只认真实运行过的证据，不认实现描述。',
    intake: [
      '这次要验的用户路径有哪几条',
      '每条路径的通过判据是什么',
      '哪些旧功能可能被这次改动打到',
    ],
    cardTitle: '验收结论卡',
    fields: [
      { label: '验收结论', rule: '只能写通过、有条件通过、未通过三选一，并给出一句话理由。' },
      { label: '已验场景与断言', rule: '按「场景 → 断言 → 实际结果」写，最多五条；产物类功能必须等产物真的出现才算通过。' },
      { label: '未覆盖或阻塞', rule: '列出没验到的场景和原因；没有写「无」。' },
      { label: '回归范围', rule: '说明这次改动可能影响的旧功能验没验、结论是什么。' },
      { label: '缺陷与严重级', rule: '逐条写缺陷和严重级；没有写「无」，不得用「整体正常」概括。' },
      { label: '需要你决定', rule: '写「无」，或只提一个放行与否的业务问题。' },
    ],
    forbid: ['把接口返回成功当作验收通过', '把加载中或超时的截图当作产物已生成'],
  },
] as const;

export interface AgentStarterPromptInput {
  experienceId: AgentExperienceId;
  roleId: AgentRoleId;
  selectedSkillKeys: string[];
  includeCds: boolean;
  cdsPrompt: string;
}

function experienceProfile(id: AgentExperienceId): AgentExperienceProfile {
  return AGENT_EXPERIENCE_PROFILES.find((item) => item.id === id) || AGENT_EXPERIENCE_PROFILES[0];
}

function roleProfile(id: AgentRoleId): AgentRoleProfile {
  return AGENT_ROLE_PROFILES.find((item) => item.id === id) || AGENT_ROLE_PROFILES[0];
}

/** 所有角色共享的开头段落：状态枚举与进度位置，防止阶段完成冒充整体完成。 */
const SHARED_CARD_HEAD: readonly string[] = [
  '【任务状态】只能使用：已完成，可使用 / 已完成，待验收 / 部分完成，待决策 / 执行中 / 被阻塞，需提供信息 / 未通过，已停止。',
  '【当前阶段】说明本阶段是否结束，以及产出了什么。',
  '【整体任务】说明整体是否结束；未结束时明确还差什么。阶段完成不得冒充整体完成。',
] as const;

/** 所有角色共享的结尾段落：一个动作、一个可点击入口、一种登录方式。 */
const SHARED_CARD_TAIL: readonly string[] = [
  '【下一步】只给一个默认推荐动作，并写明由 Agent 还是用户执行。',
  '【验收入口】给真实可点击的最终深链；没有或不适用时直说，不得猜测地址。',
  '【登录方式】写无需登录、安全获取方式或当前阻塞；不得把密码写入仓库、PR、报告或公开日志。',
] as const;

/** 决策卡的一段：段名 + 填写规则 + 是不是这个角色专属。 */
export interface AgentDecisionCardSection {
  label: string;
  rule: string;
  /** true = 角色专属段落；false = 五个角色共享的不变量。 */
  roleSpecific: boolean;
}

/**
 * 决策卡的结构化模型 —— 文本契约与界面预览的**唯一内容来源**。
 *
 * 之前界面预览是把生成好的契约整段丢进 <pre>，想改排版就只能在预览侧另写一份
 * 文案，于是「微调样式」很容易滑成「顺手改了措辞」。改成一个模型两个渲染器：
 * buildRoleDecisionContract 渲染成文本写进 AGENTS.md，界面按同一批字符串排版。
 * 两边的段名与规则必然逐字一致，样式怎么调都不会动到约束本身。
 */
export interface AgentDecisionCardModel {
  roleLabel: string;
  cardTitle: string;
  /** 卡片抬头那句「当前角色：…」。 */
  headline: string;
  lens: string;
  intake: readonly string[];
  decisionFields: readonly string[];
  depthRule: string;
  sections: readonly AgentDecisionCardSection[];
  /** 段落总数，与「固定 N 段」同源。 */
  sectionCount: number;
  /** 全角色共享的禁止项。 */
  sharedForbid: string;
  /** 本角色额外禁止项。 */
  roleForbid: readonly string[];
}

function parseSharedSection(line: string, roleSpecific: boolean): AgentDecisionCardSection {
  const match = /^【(.+?)】([\s\S]*)$/.exec(line);
  return { label: match?.[1] ?? line, rule: match?.[2] ?? '', roleSpecific };
}

export function buildRoleDecisionCardModel(
  experienceId: AgentExperienceId,
  roleId: AgentRoleId,
): AgentDecisionCardModel {
  const experience = experienceProfile(experienceId);
  const role = roleProfile(roleId);
  const depthRule = experience.id === 'newcomer'
    ? '少用术语，必须解释结果对用户的影响；不要要求用户理解 Git、构建、部署或接口细节。'
    : '保持简洁，可保留关键技术证据和风险，但仍只给一个默认推荐动作。';
  const sections: AgentDecisionCardSection[] = [
    ...SHARED_CARD_HEAD.map((line) => parseSharedSection(line, false)),
    ...role.fields.map((field) => ({ label: field.label, rule: field.rule, roleSpecific: true })),
    ...SHARED_CARD_TAIL.map((line) => parseSharedSection(line, false)),
  ];

  return {
    roleLabel: role.label,
    cardTitle: role.cardTitle,
    headline: `当前角色：${role.label}。每次最终回复必须以「${role.cardTitle}」收尾，不得只给执行日志，也不得换用其他角色的卡片格式。`,
    lens: role.lens,
    intake: role.intake,
    decisionFields: role.decisionFields,
    depthRule,
    sections,
    sectionCount: sections.length,
    sharedForbid:
      '禁止使用“基本完成”“应该可以”“大概没问题”。没有真实验证证据时，不得标记“已完成，可使用”或“已完成，待验收”。',
    roleForbid: role.forbid,
  };
}

export function buildRoleDecisionContract(
  experienceId: AgentExperienceId,
  roleId: AgentRoleId,
): string {
  const model = buildRoleDecisionCardModel(experienceId, roleId);

  return [
    '<!-- CDS_AGENT_DECISION_CARD:START -->',
    '## 角色决策回复（强制）',
    '',
    model.headline,
    `理解方向：${model.lens}`,
    `接到任务先确认：${model.intake.join('；')}。以上问题没答清之前，不要直接开工。`,
    `角色关注点：${model.decisionFields.join('、')}。与这三项无关的细节不进卡片正文。`,
    model.depthRule,
    '',
    `### ${model.cardTitle}`,
    ...model.sections.map((section) => `【${section.label}】${section.rule}`),
    '',
    `${model.cardTitle}固定 ${model.sectionCount} 段，按上面顺序逐段填写，不得增删、合并或改名段落。`,
    model.sharedForbid,
    `本角色额外禁止：${model.roleForbid.join('；')}。`,
    '<!-- CDS_AGENT_DECISION_CARD:END -->',
  ].join('\n');
}

export function buildAgentStarterPrompt(input: AgentStarterPromptInput): string {
  const experience = experienceProfile(input.experienceId);
  const role = roleProfile(input.roleId);
  const decisionContract = buildRoleDecisionContract(input.experienceId, input.roleId);
  const skills = input.selectedSkillKeys.length > 0
    ? input.selectedSkillKeys.map((key) => `- ${key}`).join('\n')
    : '- 当前没有额外方法论技能，先使用项目已有能力';
  const cdsSection = input.includeCds
    ? [
        '',
        '九、CDS 接入与部署',
        '本次已选择接入 CDS。项目扫描、环境变量、构建、复制集、日志和预览问题全部交给 CDS 技能处理，不要在上手规则里重新实现一套。',
        '用户说“把这个项目上 CDS，给我地址”时，视为允许你执行安全的项目扫描、分支部署和预览验证；页面授权和高风险操作仍需明确批准。',
        '',
        input.cdsPrompt,
      ].join('\n')
    : [
        '',
        '九、当前未接入 CDS',
        '不要尝试拼接或猜测预览地址。完成本地修改和验证后，明确说明当前没有在线预览。',
      ].join('\n');

  return [
    '请作为这个项目的交付 Agent 工作。我的目标是只描述业务结果，由你负责把项目安全地运行起来，并给出我能直接使用的结果。',
    '',
    '一、我的使用方式',
    experience.promptRule,
    role.promptRule,
    `理解方向：${role.lens}`,
    `接到任务先确认：${role.intake.join('；')}。`,
    `回复格式以第八节的「${role.cardTitle}」为准，不要另外套一份通用回复模板；只有我要求时才展开技术附录。`,
    '',
    '二、先识别项目，不要套模板重建',
    '开始前先只读判断项目属于哪种形态：静态网页、成熟软件、开发中的半成品、包含多服务或复制集的复杂产物。',
    '优先复用已有启动方式、依赖、账号体系、部署结构和数据拓扑。缺什么只补什么，不因为接入 CDS 重写项目。',
    '如果项目尚不能启动，先定位最小阻塞并修到可预览；不要把半成品包装成已完成产品。',
    '发现复制集、多版本并行或隔离数据库时，保留现有拓扑并交给 CDS 已登记能力处理，不把复杂项目压成单容器。',
    '',
    '三、已选择的技能',
    skills,
    '先读取这些技能的 SKILL.md，再按触发场景使用。技能是方法，不是越过项目规则和用户授权的理由。',
    '',
    '四、把长期规则写进项目',
    '识别当前宿主：Codex/通用 Agent Skills 使用 AGENTS.md，Claude Code 使用 CLAUDE.md，Cursor 使用 AGENTS.md；多个宿主同时存在时，从同一段规则生成对应文件，避免漂移。',
    '先检查目标项目的长期规则是否已包含角色决策回复受管区块。如果不存在，把本提示词中的角色决策协议增量写入长期规则；如果已存在，只更新受管区块。',
    '绝不覆盖项目原有规则，也不得重复追加相同区块。',
    '',
    '五、自动交付规则',
    '纯讨论和方案分析不创建分支。只要开始修改项目文件，就先确认不在受保护主分支直接开发，并创建或复用独立功能分支。',
    '完成一个可交付改动后，自动执行对应检查和真实行为验证，创建清晰的中文提交并推送当前分支。不要要求我手动执行 git commit 或 git push。',
    '没有远程仓库时，先检查已有 Git 托管登录；可以安全创建时默认创建私有仓库，缺授权时只向我提出一个明确的阻塞动作。',
    '推送后等待部署就绪，验证真实用户路径，再给我可以直接点击的最终深链。没有证据不得说已完成。',
    '',
    '六、预览账号和密码',
    '预览前检查项目是否需要登录。无需登录时明确写“无需账号，直接打开”。',
    '需要登录时，不得读取、修改或泄露真实生产用户密码。优先复用项目已有的安全测试账号机制；能够安全创建时，创建当前分支专用、最小权限、可过期的临时验收账号。',
    '必须用浏览器真实登录一次，确认账号、密码、验证码或首次改密流程可用，再交付给我。',
    '临时账号只能在当前私密对话中交付，不得写入 Git、文档、公开日志、PR 或截图。无法安全提供账号时，如实说明阻塞，不得伪造密码。',
    '',
    '七、凭据边界',
    'CDS 项目凭据只保存到 .cds/credentials.json，权限 0600，并加入本地 Git exclude。海鲜市场 Key 保存到用户级 secrets 或 Keychain。',
    '.env 只允许保存项目运行需要且已被忽略的配置；不要把 CDS 管理凭据、海鲜市场 Key 或已有用户密码塞进 .env。',
    '任何 Key、令牌和生产密码都不得出现在对话、提交、PR、报告或公开日志中。',
    '',
    '八、角色决策回复',
    decisionContract,
    cdsSection,
  ].join('\n');
}

export interface AgentStarterHarnessInput {
  cdsOrigin: string;
  prdAgentOrigin?: string;
  experienceId: AgentExperienceId;
  roleId: AgentRoleId;
  selectedSkillKeys: string[];
  includeCds: boolean;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * 受管区块替换例程的唯一来源。
 *
 * 完整上手脚本和只换卡片的脚本都嵌入这一段，任何一方另写一份都会让
 * 「标记不完整时怎么办」「原有规则怎么保留」出现两种行为。
 * 调用方需自备 say / fail / TMP_DIR。
 */
export function buildAgentContractInstaller(decisionContract: string): string {
  return `install_agent_contract() {
  target="$1"
  clean="$TMP_DIR/$(basename "$target").rules"
  if [ -f "$target" ]; then
    if ! awk '
      /<!-- CDS_AGENT_DECISION_CARD:START -->/ {
        if (managed || seen) invalid = 1
        managed = 1
        seen = 1
        next
      }
      /<!-- CDS_AGENT_DECISION_CARD:END -->/ {
        if (!managed) invalid = 1
        managed = 0
        next
      }
      END {
        if (managed) invalid = 1
        exit invalid
      }
    ' "$target"; then
      fail "$target 中的角色决策受管标记不完整或重复，已保留原文件。请修复标记后重试。"
    fi
    awk '
      /<!-- CDS_AGENT_DECISION_CARD:START -->/ { managed = 1; next }
      /<!-- CDS_AGENT_DECISION_CARD:END -->/ { managed = 0; next }
      !managed { print }
    ' "$target" > "$clean"
  else
    : > "$clean"
  fi
  [ ! -s "$clean" ] || printf '\\n' >> "$clean"
  cat >> "$clean" <<'AGENT_RULES'
${decisionContract}
AGENT_RULES
  cat "$clean" > "$target" || fail "无法更新 $target，已保留原文件路径。"
}

install_agent_contract AGENTS.md
if [ -d .claude ] || [ -f CLAUDE.md ]; then
  install_agent_contract CLAUDE.md
fi`;
}

export function buildAgentStarterHarness(input: AgentStarterHarnessInput): string {
  const safeSkills = [...new Set(input.selectedSkillKeys)].filter((key) => /^[a-z0-9-]+$/.test(key));
  const origin = input.cdsOrigin.replace(/\/+$/, '');
  const prdAgentOrigin = String(input.prdAgentOrigin || '').trim().replace(/\/+$/, '');
  const skills = safeSkills.join(' ');
  const selectedSkillsJson = JSON.stringify(safeSkills);
  const decisionContract = buildRoleDecisionContract(input.experienceId, input.roleId);

  return `#!/bin/sh
# CDS Agent 上手助手生成。不含任何密钥，不修改 shell profile 或用户主目录。
set -eu

CDS_ORIGIN=${shellQuote(origin)}
PRD_AGENT_BASE=${shellQuote(prdAgentOrigin)}
EXPERIENCE=${shellQuote(input.experienceId)}
ROLE=${shellQuote(input.roleId)}
SKILL_KEYS=${shellQuote(skills)}
INCLUDE_CDS=${input.includeCds ? '1' : '0'}
SKILLS_DIRS=""

say() { echo "[上手助手] $1"; }
fail() { echo "[上手助手] 失败: $1" >&2; exit 1; }

missing=""
for cmd in curl unzip tar; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
[ -z "$missing" ] || fail "缺少命令:$missing。请安装后重新运行。"

for host in .agents .cursor .claude; do
  [ -d "$host" ] && SKILLS_DIRS="$SKILLS_DIRS $host/skills"
done
[ -n "$SKILLS_DIRS" ] || SKILLS_DIRS=".agents/skills"
for dir in $SKILLS_DIRS; do mkdir -p "$dir"; done

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

install_dir() {
  src="$1"; name="$2"
  for target in $SKILLS_DIRS; do
    rm -rf "$target/$name"
    cp -R "$src" "$target/$name"
  done
}

if [ "$INCLUDE_CDS" = "1" ]; then
  say "下载 CDS 技能包"
  curl -fsSL --max-time 120 -o "$TMP_DIR/cds-pack.tar.gz" "$CDS_ORIGIN/api/skills/cds-pack/download"
  tar -tzf "$TMP_DIR/cds-pack.tar.gz" >/dev/null 2>&1 || fail "CDS 技能包格式不正确"
  tar -xzf "$TMP_DIR/cds-pack.tar.gz" -C "$TMP_DIR"
  [ -d "$TMP_DIR/skills" ] || fail "CDS 技能包缺少 skills 目录"
  for dir in "$TMP_DIR/skills"/*/; do
    [ -d "$dir" ] && install_dir "$dir" "$(basename "$dir")"
  done
fi

for key in $SKILL_KEYS; do
  say "安装技能 $key"
  zip="$TMP_DIR/$key.zip"
  out="$TMP_DIR/$key"
  if ! curl -fsSL --max-time 180 -o "$zip" "$CDS_ORIGIN/api/skills/$key/download"; then
    say "技能 $key 暂时不可用，已跳过；其余能力继续安装"
    continue
  fi
  mkdir -p "$out"
  if ! unzip -qo "$zip" -d "$out"; then
    say "技能 $key 下载包损坏，已跳过；其余能力继续安装"
    continue
  fi
  for dir in "$out"/*/; do
    [ -d "$dir" ] && install_dir "$dir" "$(basename "$dir")"
  done
done

mkdir -p .cds
cat > .cds/bootstrap.json <<JSON
{
  "version": 1,
  "experience": "$EXPERIENCE",
  "role": "$ROLE",
  "includeCds": ${input.includeCds ? 'true' : 'false'},
  "cdsHost": "$CDS_ORIGIN",
  "skillsDirs": "$SKILLS_DIRS",
  "selectedSkills": ${selectedSkillsJson},
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

touch .gitignore
grep -qxF '.env' .gitignore 2>/dev/null || printf '%s\n' '.env' >> .gitignore
grep -qxF '.cds/credentials.json' .gitignore 2>/dev/null || printf '%s\n' '.cds/credentials.json' >> .gitignore
if [ ! -f .env ]; then
  cat > .env <<ENV
CDS_HOST=$CDS_ORIGIN
PRD_AGENT_BASE=$PRD_AGENT_BASE
ENV
fi

if git rev-parse --git-dir >/dev/null 2>&1; then
  exclude_file=$(git rev-parse --git-path info/exclude)
  grep -qxF '/.cds/credentials.json' "$exclude_file" 2>/dev/null || printf '%s\n' '/.cds/credentials.json' >> "$exclude_file"
fi

${buildAgentContractInstaller(decisionContract)}

say "安装完成。已写入角色决策规则，没有写入任何 CDS 凭据。"
echo "下一步: 把 CDS 页面生成的启动提示词交给当前项目里的 Agent。"
`;
}

export interface AgentRoleCardHarnessInput {
  experienceId: AgentExperienceId;
  roleId: AgentRoleId;
}

/**
 * 只换角色决策卡的最小脚本。
 *
 * 换角色此前要重跑整个上手向导：重下技能、重写 .env、重建 .cds/bootstrap.json。
 * 这个脚本只做受管区块替换——不联网、不下技能、不碰 .env、不碰任何凭据文件——
 * 所以既能用来换角色，也能用来把落后的卡片刷成当前定义。
 *
 * 受管区块的识别与替换逻辑与完整安装脚本共用 buildAgentContractInstaller，
 * 不允许各写一份（一份改了另一份没改，就会出现两种替换行为）。
 */
export function buildRoleCardHarness(input: AgentRoleCardHarnessInput): string {
  const role = roleProfile(input.roleId);
  const decisionContract = buildRoleDecisionContract(input.experienceId, input.roleId);

  return `#!/bin/sh
# CDS 角色决策卡更新脚本。只替换受管区块，不下载技能、不写凭据、不联网。
set -eu

say() { echo "[角色决策卡] $1"; }
fail() { echo "[角色决策卡] 失败: $1" >&2; exit 1; }

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

say "目标角色：${role.label}（${role.cardTitle}）"

${buildAgentContractInstaller(decisionContract)}

say "已更新角色决策卡。项目原有规则保持不变，未写入任何凭据。"
echo "下一步: 让当前项目里的 Agent 重新读取长期规则，之后的回复会改用${role.cardTitle}。"
`;
}
