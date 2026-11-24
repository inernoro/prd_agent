import { describe, expect, it } from 'vitest';
import type { McpCapabilityDto } from '@/services/contracts/mcpConsole';
import { accessLevel, changeCapabilityAccess } from '../editAuthorization';
const knowledge: McpCapabilityDto = { key:'knowledge',title:'知识库',summary:'',readScope:'docs:read',writeScope:'docs:write',writeNeedsApproval:false,availableToMe:true,writeAvailableToMe:true,granted:false,todayCalls:0,tools:[] };
describe('编辑实际 MCP 授权', () => {
  it('降低一项能力时保留独立接口和其他平台能力', () => {
    const next = changeCapabilityAccess(['docs:read','docs:write','agent.workflow:invoke','visual:use'],knowledge,'read');
    expect(next).toEqual(['agent.workflow:invoke','visual:use','docs:read']);
  });
  it('关闭一项能力时不会撤销独立接口', () => {
    expect(changeCapabilityAccess(['DOCS:READ','docs:write','agent.foo:invoke'],knowledge,'none')).toEqual(['agent.foo:invoke']);
  });
  it('只有写档的能力不虚构只读 scope', () => {
    const visual = { ...knowledge,readScope:null,writeScope:'visual:use' };
    expect(changeCapabilityAccess([],visual,'write')).toEqual(['visual:use']);
    expect(accessLevel(visual,['visual:use'])).toBe('write');
  });
  it('只有读档的能力不虚构执行权限', () => {
    const market = {...knowledge,readScope:'skills:read',writeScope:null};
    expect(accessLevel(market,['skills:read'])).toBe('read');
    expect(changeCapabilityAccess([],market,'read')).toEqual(['skills:read']);
  });
  it('开启执行时同时包含该能力的读取权限', () => {
    expect(changeCapabilityAccess([],knowledge,'write')).toEqual(['docs:read','docs:write']);
  });
});
