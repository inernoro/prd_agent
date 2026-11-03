import { describe, expect, it } from 'vitest';
import {
  buildConnectionPrompt,
  buildSkillPrompt,
  CLIENT_KINDS,
  CLIENT_REGISTRY,
  DEFAULT_CLIENT,
  skillManifestUrl,
} from '../clientRegistry';
import type { MapAgentSkillManifestDto } from '@/services/contracts/mcpConsole';

const endpoint = 'https://map.example.test/prefix/api/mcp';
const manifest: MapAgentSkillManifestDto = {
  key: 'map-agent', version: '1.2.3', sha256: 'a'.repeat(64),
  downloadUrl: 'https://map.example.test/prefix/api/official-skills/map-agent/download',
  workBuddyDownloadUrl: 'https://map.example.test/prefix/api/official-skills/map-agent/download?client=workbuddy',
  workBuddySha256: 'b'.repeat(64),
  installerUrl: 'https://map.example.test/prefix/api/official-skills/map-agent/installer',
  supportedHosts: ['.agents/skills', '.claude/skills'], workBuddyInstall: 'download-import',
};

describe('客户端连接配置', () => {
  it('Codex 默认首选，WorkBuddy 紧随，保留 Claude 两种入口', () => {
    expect(DEFAULT_CLIENT).toBe('codex');
    expect(CLIENT_KINDS).toEqual(['codex', 'workbuddy', 'claude-code', 'claude-desktop']);
  });

  it('WorkBuddy 按官方远程 HTTP 格式保留实际端点和鉴权头', () => {
    const parsed = JSON.parse(CLIENT_REGISTRY.workbuddy.config(endpoint, 'sk-test'));
    expect(parsed).toEqual({ mcpServers: { map: {
      type: 'streamableHttp', url: endpoint, headers: { Authorization: 'Bearer sk-test' },
    } } });
  });

  it('Codex 使用 http_headers，字符串中的引号及换行不会变成额外配置', () => {
    const config = CLIENT_REGISTRY.codex.config(endpoint, 'key"\n[malicious]');
    expect(config).toContain('http_headers = { Authorization = "Bearer key\\"\\n[malicious]" }');
    expect(config.split('\n')).toHaveLength(3);
    expect(config).not.toContain('[mcp_servers.map.headers]');
  });

  it('版本清单沿用实例地址和部署路径前缀，删除连接 URL 的查询参数', () => {
    expect(skillManifestUrl(`${endpoint}?secret=never-copy#fragment`))
      .toBe('https://map.example.test/prefix/api/official-skills/map-agent/manifest');
  });
});

describe('技能与完整接入指令', () => {
  it('完整指令同时包含连接、安装、摘要核验和真实调用自检', () => {
    const prompt = buildConnectionPrompt('codex', endpoint, 'sk-private', manifest);
    expect(prompt).toContain('Bearer sk-private');
    expect(prompt).toContain(manifest.sha256);
    expect(prompt).toContain(manifest.installerUrl);
    expect(prompt).toContain(' install --manifest-url ');
    expect(prompt).toContain('--project .');
    expect(prompt).toContain('--client codex');
    expect(prompt).toContain('调用一条只读工具自检');
  });

  it('已连接用户的检查与更新指令不携带业务密钥，并保护本地修改', () => {
    const check = buildSkillPrompt('codex', manifest, endpoint, 'check');
    const update = buildSkillPrompt('codex', manifest, endpoint, 'update');
    expect(check).toContain(' check --manifest-url ');
    expect(check).toContain('--client codex');
    expect(update).toContain(' update --manifest-url ');
    expect(update).toContain('--client codex');
    expect(update).toContain('保留原文件');
    expect(update).not.toContain('Bearer');
    expect(update).not.toContain('~/.claude');
  });

  it('WorkBuddy 使用 ZIP 导入，不能把线上版本宣称为本机版本', () => {
    const install = buildSkillPrompt('workbuddy', manifest, endpoint, 'install');
    const check = buildSkillPrompt('workbuddy', manifest, endpoint, 'check');
    expect(install).toContain('添加技能入口导入');
    expect(install).toContain(manifest.workBuddyDownloadUrl);
    expect(install).toContain(manifest.workBuddySha256);
    expect(install).toContain('不要声称已安装');
    expect(install).not.toContain('--project');
    expect(check).toContain('不要把线上版本当作已装版本');
  });

  it('版本读取失败仍给出安装清单入口，明确禁止跳过技能', () => {
    const prompt = buildConnectionPrompt('codex', endpoint, 'sk-private', null);
    expect(prompt).toContain('/api/official-skills/map-agent/manifest');
    expect(prompt).toContain('不要跳过技能安装');
  });
});
