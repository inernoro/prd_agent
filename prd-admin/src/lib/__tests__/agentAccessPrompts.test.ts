import { describe, it, expect } from 'vitest';
import { buildDocStoreAgentPrompt, buildKeySecretsBlock } from '../agentAccessPrompts';

const KEY = 'sk-ak-test1234567890abcdef';
const BASE = 'https://map.example.com';

describe('buildKeySecretsBlock', () => {
  it('包含 Key 明文、chmod 600 与环境变量导入，且写明禁止入仓', () => {
    const block = buildKeySecretsBlock(KEY, BASE);
    expect(block).toContain(KEY);
    expect(block).toContain('chmod 600');
    expect(block).toContain('umask 077');
    expect(block).toContain(`export PRD_AGENT_BASE="${BASE}"`);
    expect(block).toContain('不要写进仓库');
  });
});

describe('buildDocStoreAgentPrompt', () => {
  it('可读可写（默认）：读写端点齐全', () => {
    const p = buildDocStoreAgentPrompt(KEY, { base: BASE });
    expect(p).toContain('GET  $PRD_AGENT_BASE/api/document-store/stores');
    expect(p).toContain('GET  $PRD_AGENT_BASE/api/document-store/entries/{entryId}');
    expect(p).toContain('POST $PRD_AGENT_BASE/api/document-store/stores');
    expect(p).toContain('PUT  $PRD_AGENT_BASE/api/document-store/entries/{entryId}/content');
    expect(p).toContain('Authorization: Bearer $PRD_AGENT_API_KEY');
    expect(p).toContain(KEY);
  });

  it('只读 Key：不给写入端点，避免 AI 照做后 403', () => {
    const p = buildDocStoreAgentPrompt(KEY, { writable: false, base: BASE });
    expect(p).toContain('GET  $PRD_AGENT_BASE/api/document-store/stores');
    expect(p).not.toContain('POST $PRD_AGENT_BASE/api/document-store/stores');
    expect(p).not.toContain('PUT  $PRD_AGENT_BASE');
  });

  it('文档空间指令不引用 marketplace 技能（findmapskills 只覆盖海鲜市场端点）', () => {
    const p = buildDocStoreAgentPrompt(KEY, { base: BASE });
    expect(p).not.toContain('findmapskills');
    expect(p).not.toContain('marketplace');
  });
});
