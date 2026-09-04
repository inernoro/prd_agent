import { describe, expect, it } from 'vitest';

import {
  findAgentRuntimeProviderDefinition,
  isAgentRuntimeProviderIsolationReady,
  listAgentRuntimeProviderDefinitions,
  normalizeAgentIsolationMode,
  normalizeAgentWorkloadKind,
} from '../../src/services/agent-runtime-provider-registry.js';

describe('agent runtime provider registry', () => {
  it('keeps design executors behind the CDS Remote Agent boundary', () => {
    const openDesign = findAgentRuntimeProviderDefinition('open-design');
    const codex = findAgentRuntimeProviderDefinition('codex');

    expect(openDesign).toMatchObject({
      adapterKind: 'design-daemon',
      executionOwner: 'cds-remote-agent',
      workloadKinds: ['design-artifact'],
      requiredIsolationMode: 'session-container',
      implementationStatus: 'planned',
    });
    expect(codex).toMatchObject({
      adapterKind: 'cli-adapter',
      executionOwner: 'cds-remote-agent',
      requiredIsolationMode: 'session-container',
    });
  });

  it('does not mutate the provider source when callers edit a returned catalog', () => {
    const first = listAgentRuntimeProviderDefinitions();
    first[0].workloadKinds.push('design-artifact');

    const second = listAgentRuntimeProviderDefinitions();
    expect(second[0].workloadKinds).toEqual(['general']);
  });

  it('normalizes only bounded workload and isolation values', () => {
    const provider = findAgentRuntimeProviderDefinition('claude-sdk')!;

    expect(normalizeAgentWorkloadKind('design-artifact')).toBe('design-artifact');
    expect(normalizeAgentWorkloadKind('unknown')).toBe('general');
    expect(normalizeAgentIsolationMode('shared-runtime', provider)).toBe('shared-runtime');
    expect(normalizeAgentIsolationMode(undefined, provider)).toBe('shared-runtime');
  });

  it('requires real per-session resource enforcement before session-container providers become ready', () => {
    const openDesign = findAgentRuntimeProviderDefinition('open-design')!;
    const futureReadyOpenDesign = {
      ...openDesign,
      implementationStatus: 'available' as const,
      supportedIsolationModes: ['session-container' as const],
    };
    const claude = findAgentRuntimeProviderDefinition('claude-sdk')!;

    expect(isAgentRuntimeProviderIsolationReady(futureReadyOpenDesign, false)).toBe(false);
    expect(isAgentRuntimeProviderIsolationReady(futureReadyOpenDesign, true)).toBe(true);
    expect(isAgentRuntimeProviderIsolationReady(claude, false)).toBe(true);
  });
});
