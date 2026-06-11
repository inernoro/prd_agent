import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '../../stores/toolboxStore';

describe('toolbox classification', () => {
  it('keeps the tech doc format agent in the agent section', () => {
    const item = BUILTIN_TOOLS.find((tool) => tool.agentKey === 'tech-doc-format-agent');

    expect(item).toBeTruthy();
    expect(item?.kind).toBe('agent');
    expect(item?.routePath).toBe('/tech-doc-format-agent');
    expect(item?.wip).toBe(true);
  });
});
