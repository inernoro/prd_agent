import { describe, expect, it } from 'vitest';
import { autoPicks, grantableToolCount, picksToScopes, samePicks } from '../scopePlan';
import type { McpCapabilityDto, McpToolDto } from '@/services/contracts/mcpConsole';

function cap(over: Partial<McpCapabilityDto>): McpCapabilityDto {
  return {
    key: 'knowledge',
    title: '知识库',
    summary: '读写你的文档空间',
    readScope: 'document-store:read',
    writeScope: 'document-store:write',
    writeNeedsApproval: false,
    availableToMe: true,
    writeAvailableToMe: true,
    granted: false,
    todayCalls: 0,
    tools: [],
    ...over,
  };
}

describe('「跟着我的权限走」这一档包含什么', () => {
  it('我没有的能力不进默认档', () => {
    const picks = autoPicks([cap({ key: 'market', availableToMe: false })]);
    expect(picks.market).toBeUndefined();
  });

  it('只有读权限位的人，默认档不替他长出写入', () => {
    // 服务端签发那一步会拒；这里若给上，用户会在最后一步才被打回来
    const picks = autoPicks([cap({ writeAvailableToMe: false })]);
    expect(picks.knowledge).toEqual({ read: true, write: false });
  });

  it('只有写入档、没有只读档的能力（视觉创作），默认档就是写入', () => {
    const picks = autoPicks([cap({ key: 'visual', readScope: null, writeScope: 'visual-agent:use' })]);
    expect(picks.visual).toEqual({ read: false, write: true });
    expect(picksToScopes([cap({ key: 'visual', readScope: null, writeScope: 'visual-agent:use' })], picks))
      .toEqual(['visual-agent:use']);
  });

  it('改过又改回来，仍然算「没动过」—— 不该因为点开看过一眼就失去自动档', () => {
    const caps = [cap({})];
    const defaults = autoPicks(caps);
    expect(samePicks({ ...defaults }, defaults)).toBe(true);
    expect(samePicks({ knowledge: { read: true, write: false } }, defaults)).toBe(false);
  });

  it('整块关掉也算动过', () => {
    const caps = [cap({})];
    expect(samePicks({}, autoPicks(caps))).toBe(false);
  });
});

describe('他真能给出去的工具数', () => {
  const tool = (over: Partial<McpToolDto>): McpToolDto => ({
    name: 'map_web_list_pages',
    description: '',
    requiredScope: 'web-pages:read',
    isWrite: false,
    granted: false,
    ...over,
  });

  it('只有读权限的人，写入档那几个工具不算进去', () => {
    // 整块能力对他是可用的（availableToMe 为真），但写入 scope 签发时会被交集校验打回来 ——
    // 按整块数会告诉他「发布、分享都能给它」，等他签的时候才被拒
    const readOnly = cap({
      writeAvailableToMe: false,
      readScope: 'web-pages:read',
      writeScope: 'web-pages:write',
      tools: [
        tool({}),
        tool({ name: 'map_web_publish_page', requiredScope: 'web-pages:write', isWrite: true }),
      ],
    });
    expect(readOnly.tools.length).toBe(2);
    expect(grantableToolCount(readOnly)).toBe(1);
  });

  it('读写都有的人，两档都算', () => {
    const full = cap({
      readScope: 'web-pages:read',
      writeScope: 'web-pages:write',
      tools: [
        tool({}),
        tool({ name: 'map_web_publish_page', requiredScope: 'web-pages:write', isWrite: true }),
      ],
    });
    expect(grantableToolCount(full)).toBe(2);
  });

  it('只有写入档的能力（视觉创作），按整块的可用性算', () => {
    const visual = cap({
      key: 'visual',
      readScope: null,
      writeScope: 'visual-agent:use',
      writeAvailableToMe: true,
      tools: [tool({ name: 'map_visual_generate', requiredScope: 'visual-agent:use', isWrite: true })],
    });
    expect(grantableToolCount(visual)).toBe(1);
  });
});
