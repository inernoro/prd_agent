export type CdsConnectTarget =
  | { kind: 'existing'; projectId: string }
  | { kind: 'new' };

interface BuildPromptOptions {
  cdsOrigin: string;
  target: CdsConnectTarget;
}

export const PROJECT_SKILL_PATHS = [
  { agent: 'Codex / 通用 Agent Skills', path: '.agents/skills' },
  { agent: 'Cursor', path: '.cursor/skills' },
  { agent: 'Claude Code', path: '.claude/skills' },
] as const;

export function buildCdsAgentPrompt({ cdsOrigin, target }: BuildPromptOptions): string {
  const connectArgs = target.kind === 'new'
    ? '--new-project'
    : `--project ${target.projectId}`;
  const targetLabel = target.kind === 'new'
    ? '首次接入，需要创建一个新项目'
    : `连接已有项目 ${target.projectId}`;

  return [
    '请帮我接入 CDS。整个过程不要向我索要或展示任何密钥，也不要修改系统环境变量、shell profile 或全局 PATH。',
    '',
    `目标：${targetLabel}`,
    '',
    '1. 下载技能包',
    `从 ${cdsOrigin}/api/export-skill 下载 tar.gz。包内 skills/ 目录必须包含 cds、cds-deploy-pipeline、cds-project-scan、preview-url。`,
    '',
    '2. 按当前 Agent 安装到项目级技能目录',
    '先识别你当前运行在 Codex、Cursor、Claude Code 还是其他支持 Agent Skills 的宿主，再选择该宿主的项目级技能目录。',
    '已知目录：Codex/通用 Agent Skills 用 .agents/skills，Cursor 用 .cursor/skills，Claude Code 用 .claude/skills。',
    '不要安装到用户主目录。旧版本如需备份，放到当前项目 .cds/skill-backups，不要留在技能扫描目录。',
    '安装完成后确认四个技能各只有一个可发现版本；缺 preview-url 视为接入未完成。',
    '',
    '3. 发起页面授权',
    `运行 cds 技能内的 cli/cdscli.py connect --host ${cdsOrigin} ${connectArgs} --agent <当前 Agent 名称>。`,
    '命令会等待 CDS 页面批准。告诉我去 CDS 右下角点击批准，然后继续等待，不要改用复制密钥的旧流程。',
    '',
    '4. 自动验证',
    '授权完成后运行 cdscli auth check，并确认当前 git 仓库没有新增可提交的凭据文件、shell 配置没有变化。',
    '随后必须调用 preview-url 技能，由它运行当前宿主项目技能目录中的 cdscli.py --human preview-url。',
    '预览地址只能使用 CDS API 返回的 previewUrl / previewUrls；主应用、模型网关等独立命名服务都属于实际入口，CDS 返回几条就全部列出。禁止把 rootDomains 数量当成入口数量，也禁止根据分支名、项目名、profileId、CDS host 或旧公式自行拼接。',
    '如当前分支尚未在 CDS 创建或部署，preview-url 应明确失败并说明原因，不得伪造一个看似可用的地址。',
    '如果目标是新项目，接下来可直接用 cdscli onboard <Git 仓库 URL> 创建并部署，创建权限使用一次后会自动切换为项目级权限。',
  ].join('\n');
}
