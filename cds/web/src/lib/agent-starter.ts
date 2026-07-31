export type AgentExperienceId = 'newcomer' | 'experienced';
export type AgentRoleId = 'pm' | 'owner' | 'domain-expert' | 'dev' | 'qa';

export interface AgentExperienceProfile {
  id: AgentExperienceId;
  label: string;
  eyebrow: string;
  description: string;
  promptRule: string;
}

export interface AgentRoleProfile {
  id: AgentRoleId;
  label: string;
  description: string;
  defaultBundleKey: 'pm-starter' | 'dev-starter' | 'qa-starter';
  promptRule: string;
  decisionFields: readonly string[];
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
  },
  {
    id: 'owner',
    label: '业务专家 / 需求专家',
    description: '负责把业务目标、需求规则、例外情况和验收标准讲清楚。',
    defaultBundleKey: 'pm-starter',
    promptRule: '我的角色是业务专家或需求专家。优先把业务目标、需求规则、例外情况和验收标准讲清楚，技术实现由你负责。',
    decisionFields: ['业务目标', '规则覆盖', '待确认规则'],
  },
  {
    id: 'domain-expert',
    label: '领域专家',
    description: '关注业务规则、例外情况和专业准确性。',
    defaultBundleKey: 'pm-starter',
    promptRule: '我的角色是领域专家。优先确认专业规则、例外条件和结果准确性；技术实现由你负责，并用业务流程解释。',
    decisionFields: ['专业结论', '判断依据', '不确定项与业务风险'],
  },
  {
    id: 'dev',
    label: '开发',
    description: '关注架构、实现、验证和可维护性。',
    defaultBundleKey: 'dev-starter',
    promptRule: '我的角色是开发。可以使用必要的技术术语，但结论必须关联真实代码、运行证据和部署路径。',
    decisionFields: ['工程状态', '核心改动与验证证据', '技术风险'],
  },
  {
    id: 'qa',
    label: '测试与验收',
    description: '关注场景、断言、证据和回归。',
    defaultBundleKey: 'qa-starter',
    promptRule: '我的角色是测试与验收。优先说明场景、行为断言、证据和回归范围，不把接口成功等同于用户验收通过。',
    decisionFields: ['验收结论', '覆盖范围', '失败或未覆盖项与发布建议'],
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

export function buildRoleDecisionContract(
  experienceId: AgentExperienceId,
  roleId: AgentRoleId,
): string {
  const experience = experienceProfile(experienceId);
  const role = roleProfile(roleId);
  const depthRule = experience.id === 'newcomer'
    ? '少用术语，必须解释结果对用户的影响；不要要求用户理解 Git、构建、部署或接口细节。'
    : '保持简洁，可保留关键技术证据和风险，但仍只给一个默认推荐动作。';

  return [
    '<!-- CDS_AGENT_DECISION_CARD:START -->',
    '## 角色决策回复（强制）',
    '',
    `当前角色：${role.label}。每次最终回复必须以简短决策卡收尾，不得只给执行日志。`,
    `角色重点：${role.decisionFields.join('、')}。`,
    depthRule,
    '',
    '【任务状态】只能使用：已完成，可使用 / 已完成，待验收 / 部分完成，待决策 / 执行中 / 被阻塞，需提供信息 / 未通过，已停止。',
    '【当前阶段】说明本阶段是否结束，以及产出了什么。',
    '【整体任务】说明整体是否结束；未结束时明确还差什么。阶段完成不得冒充整体完成。',
    '【角色结论】围绕当前角色重点，用一到三句话说明结果和影响。',
    '【完成边界】明确本次做了什么、没有做什么。',
    '【验证证据】只写实际运行或验收过的内容；未验证必须直说。',
    '【需要你决定】写“无”，或只提出一个必须由用户决定的业务问题；技术实现默认由 Agent 负责。',
    '【下一步】只给一个默认推荐动作，并写明由 Agent 还是用户执行。',
    '【验收入口】给真实可点击的最终深链；没有或不适用时直说，不得猜测地址。',
    '【登录方式】写无需登录、安全获取方式或当前阻塞；不得把密码写入仓库、PR、报告或公开日志。',
    '',
    '决策卡默认不超过 10 行。禁止使用“基本完成”“应该可以”“大概没问题”。没有真实验证证据时，不得标记“已完成，可使用”或“已完成，待验收”。',
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
    '回复默认使用：一句话结论、对业务意味着什么、当前进度、需要我决定、风险和边界、下一步。只有我要求时才展开技术附录。',
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
  experienceId: AgentExperienceId;
  roleId: AgentRoleId;
  selectedSkillKeys: string[];
  includeCds: boolean;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function buildAgentStarterHarness(input: AgentStarterHarnessInput): string {
  const safeSkills = [...new Set(input.selectedSkillKeys)].filter((key) => /^[a-z0-9-]+$/.test(key));
  const origin = input.cdsOrigin.replace(/\/+$/, '');
  const skills = safeSkills.join(' ');
  const selectedSkillsJson = JSON.stringify(safeSkills);
  const decisionContract = buildRoleDecisionContract(input.experienceId, input.roleId);

  return `#!/bin/sh
# CDS Agent 上手助手生成。不含任何密钥，不修改 shell profile 或用户主目录。
set -eu

CDS_ORIGIN=${shellQuote(origin)}
PRD_AGENT_BASE='https://map.ebcone.net'
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

install_agent_contract() {
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
  [ ! -s "$clean" ] || printf '\n' >> "$clean"
  cat >> "$clean" <<'AGENT_RULES'
${decisionContract}
AGENT_RULES
  cat "$clean" > "$target" || fail "无法更新 $target，已保留原文件路径。"
}

install_agent_contract AGENTS.md
if [ -d .claude ] || [ -f CLAUDE.md ]; then
  install_agent_contract CLAUDE.md
fi

say "安装完成。已写入角色决策规则，没有写入任何 CDS 凭据。"
echo "下一步: 把 CDS 页面生成的启动提示词交给当前项目里的 Agent。"
`;
}
