import { describe, expect, it } from 'vitest';
import {
  branchAppNetworkName,
  branchNetworkIsolationEnabled,
  resolveAppNetworkPlan,
} from '../../src/services/branch-network.js';

describe('branchAppNetworkName', () => {
  it('prefixes with cds-br- and keeps safe slugs', () => {
    expect(branchAppNetworkName('miduo-backend-master')).toBe('cds-br-miduo-backend-master');
  });

  it('sanitizes illegal docker network chars', () => {
    expect(branchAppNetworkName('feature/Auth Login')).toBe('cds-br-feature-Auth-Login');
  });

  it('falls back to a default when empty', () => {
    expect(branchAppNetworkName('')).toBe('cds-br-branch');
  });

  it('caps overly long ids', () => {
    const name = branchAppNetworkName('x'.repeat(200));
    expect(name.startsWith('cds-br-')).toBe(true);
    expect(name.length).toBeLessThanOrEqual('cds-br-'.length + 60);
  });
});

describe('branchNetworkIsolationEnabled', () => {
  it('defaults to on (isolation is the per-branch default sandbox)', () => {
    expect(branchNetworkIsolationEnabled({})).toBe(true);
    expect(branchNetworkIsolationEnabled({ CDS_BRANCH_NETWORK_ISOLATION: '1' })).toBe(true);
    expect(branchNetworkIsolationEnabled({ CDS_BRANCH_NETWORK_ISOLATION: 'on' })).toBe(true);
  });

  it('only the global env kill-switch disables it', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
      expect(branchNetworkIsolationEnabled({ CDS_BRANCH_NETWORK_ISOLATION: v })).toBe(false);
    }
  });
});

describe('resolveAppNetworkPlan', () => {
  it('isolated: runs on the per-branch network with app aliases, then connects to shared infra net (no alias)', () => {
    const plan = resolveAppNetworkPlan({
      isolated: true,
      sharedNetwork: 'cds-proj-miduo-backend',
      branchId: 'miduo-backend-master',
      aliases: ['apigateway', 'imp-api'],
    });
    expect(plan.runNetwork).toBe('cds-br-miduo-backend-master');
    expect(plan.runAliases).toEqual(['apigateway', 'imp-api']);
    // connect target = shared infra net, and crucially NO alias is carried there
    expect(plan.connectNetworks).toEqual(['cds-proj-miduo-backend']);
  });

  it('two branches with the same app alias never collide (different run networks)', () => {
    const a = resolveAppNetworkPlan({ isolated: true, sharedNetwork: 'cds-proj-p', branchId: 'br-a', aliases: ['apigateway'] });
    const b = resolveAppNetworkPlan({ isolated: true, sharedNetwork: 'cds-proj-p', branchId: 'br-b', aliases: ['apigateway'] });
    expect(a.runNetwork).not.toBe(b.runNetwork);
    // same alias, but on disjoint per-branch networks → no shared-network DNS collision
    expect(a.runAliases).toEqual(b.runAliases);
  });

  it('not isolated (default off / legacy): identical to current behavior — shared net + app aliases, no extra connect', () => {
    const plan = resolveAppNetworkPlan({
      isolated: false,
      sharedNetwork: 'cds-proj-p',
      branchId: 'br-a',
      aliases: ['apigateway'],
    });
    expect(plan.runNetwork).toBe('cds-proj-p');
    expect(plan.runAliases).toEqual(['apigateway']);
    expect(plan.connectNetworks).toEqual([]);
  });

  it('degrades safely if the branch net would equal the shared net', () => {
    // contrived: shared net already named like the branch net → avoid self-connect
    const plan = resolveAppNetworkPlan({
      isolated: true,
      sharedNetwork: 'cds-br-x',
      branchId: 'x',
      aliases: ['svc'],
    });
    expect(plan.runNetwork).toBe('cds-br-x');
    expect(plan.connectNetworks).toEqual([]);
  });

  it('filters empty aliases', () => {
    const plan = resolveAppNetworkPlan({ isolated: true, sharedNetwork: 'cds-proj-p', branchId: 'b', aliases: ['a', '', 'b'] });
    expect(plan.runAliases).toEqual(['a', 'b']);
  });
});
