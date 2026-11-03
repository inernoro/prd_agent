import type { MapAgentSkillManifestDto } from '@/services/contracts/mcpConsole';

export type ClientKind = 'codex' | 'workbuddy' | 'claude-code' | 'claude-desktop';
export type SkillAction = 'install' | 'check' | 'update';

interface ClientConfig {
  label: string;
  configLocation: string;
  skillLocation: string;
  config: (endpoint: string, key: string) => string;
}

/** 命令参数与 TOML 字符串分别转义，不能把 JSON 转义当作 shell 转义。 */
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const httpConfig = (type: string, endpoint: string, key: string) => JSON.stringify({
  mcpServers: { map: { type, url: endpoint, headers: { Authorization: `Bearer ${key}` } } },
}, null, 2);

export const CLIENT_REGISTRY: Record<ClientKind, ClientConfig> = {
  codex: {
    label: 'Codex',
    configLocation: '在受信任项目的 .codex/config.toml 合并以下段落；已有 map 配置时替换对应段落。',
    skillLocation: '在当前项目安装到 .agents/skills；已有 .claude 时也会同步安装。',
    config: (endpoint, key) => `[mcp_servers.map]\nurl = ${JSON.stringify(endpoint)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${key}`)} }`,
  },
  workbuddy: {
    label: 'WorkBuddy',
    configLocation: '打开 WorkBuddy 的 MCP 配置，合并到现有 mcpServers，再启用 MAP。',
    skillLocation: '下载技能 ZIP，在 WorkBuddy「添加技能」中导入；更新也导入新版 ZIP。',
    config: (endpoint, key) => httpConfig('streamableHttp', endpoint, key),
  },
  'claude-code': {
    label: 'Claude Code',
    configLocation: '在当前项目的终端执行；已有 map 连接时先检查原配置。',
    skillLocation: '在当前项目安装到已有的 .claude/skills 或 .agents/skills。',
    config: (endpoint, key) => `claude mcp add --transport http map ${shellQuote(endpoint)} --header ${shellQuote(`Authorization: Bearer ${key}`)}`,
  },
  'claude-desktop': {
    label: 'Claude 桌面',
    configLocation: '粘进支持远程 HTTP MCP 的 Claude 配置，保留其它已有连接。',
    skillLocation: '下载技能 ZIP，通过客户端提供的技能导入入口安装。',
    config: (endpoint, key) => httpConfig('http', endpoint, key),
  },
};

export const CLIENT_KINDS = Object.keys(CLIENT_REGISTRY) as ClientKind[];
export const DEFAULT_CLIENT: ClientKind = 'codex';

export function skillManifestUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  if (!url.pathname.endsWith('/api/mcp')) throw new Error('连接地址不完整，请刷新接入台后重试');
  url.pathname = url.pathname.slice(0, -'/api/mcp'.length) + '/api/official-skills/map-agent/manifest';
  url.search = '';
  url.hash = '';
  return url.toString();
}

const SKILL_ACTION_LABELS: Record<SkillAction, string> = {
  install: '安装', check: '检查', update: '更新',
};

/** 这是给智能体执行的操作指令；网页不猜测本机已安装的版本或安装结果。 */
export function buildSkillPrompt(
  client: ClientKind,
  manifest: MapAgentSkillManifestDto,
  endpointUrl: string,
  action: SkillAction,
): string {
  const downloadUrl = client === 'workbuddy' ? manifest.workBuddyDownloadUrl : manifest.downloadUrl;
  const sha256 = client === 'workbuddy' ? manifest.workBuddySha256 : manifest.sha256;
  const instructions = [
    `请在 ${CLIENT_REGISTRY[client].label} 中${SKILL_ACTION_LABELS[action]} MAP 配套技能 ${manifest.key}。`,
    `当前服务发布版本：${manifest.version}；下载包 SHA-256：${sha256}。`,
    `版本清单：${skillManifestUrl(endpointUrl)}`,
    `技能 ZIP：${downloadUrl}`,
    `安装器：${manifest.installerUrl}`,
  ];
  if (client === 'workbuddy' || client === 'claude-desktop') {
    instructions.push(
      action === 'check'
        ? '读取已导入技能的版本，与版本清单对比；无法读取本地技能时说明未完成检查，不要把线上版本当作已装版本。'
        : '下载并校验 ZIP，通过客户端的添加技能入口导入。已有版本先检查本地修改并保留备份，再导入新版；无法操作导入入口时给出下载文件和具体步骤，不要声称已安装。',
      '不要猜测本地技能目录，也不要为这个客户端创建第三套技能宿主目录。',
    );
  } else {
    instructions.push(
      '下载 Python 安装器到临时目录，检查后在当前项目执行（不要写入用户主目录）：',
      `python3 <临时目录>/map-agent-installer.py ${action} --manifest-url ${shellQuote(skillManifestUrl(endpointUrl))} --project . --client ${client === 'codex' ? 'codex' : 'claude'}`,
      CLIENT_REGISTRY[client].skillLocation,
      '本地内容有修改时先报告冲突，保留原文件，不要强制覆盖。',
    );
  }
  instructions.push(
    '后续使用同一版本清单检查新版；更新前核对本地改动，更新后重新检查版本与技能可发现性。',
    '完成后报告实际安装位置、已装版本、可发现的技能名称及检查结果；客户端需要重新加载技能时明确提示。',
    '连接 MCP 后列出实际工具并调用一条只读工具自检。不能以下载成功或配置保存成功代替调用成功。',
  );
  return instructions.join('\n');
}

export function buildConnectionPrompt(
  client: ClientKind,
  endpointUrl: string,
  key: string,
  manifest: MapAgentSkillManifestDto | null,
): string {
  return [
    `请帮我接入 MAP 到 ${CLIENT_REGISTRY[client].label}。`,
    CLIENT_REGISTRY[client].configLocation,
    '合并以下连接配置，保留其它已有服务；密钥仅用于本机连接，不写入项目版本库或公开技能包。',
    CLIENT_REGISTRY[client].config(endpointUrl, key),
    manifest
      ? buildSkillPrompt(client, manifest, endpointUrl, 'install')
      : `再读取 ${skillManifestUrl(endpointUrl)}，按该清单下载、校验并安装 map-agent 技能；清单读取失败时报告失败，不要跳过技能安装。`,
  ].join('\n\n');
}
