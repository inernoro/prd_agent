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

  it('caps overly long ids within docker name limit', () => {
    const name = branchAppNetworkName('x'.repeat(200));
    expect(name.startsWith('cds-br-')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('keeps ids up to 56 safe chars unhashed (prefix-aware cap: cds-br- + 56 = 63, within docker limit)', () => {
    const id = 'a'.repeat(56);
    const name = branchAppNetworkName(id);
    expect(name).toBe(`cds-br-${id}`);
    expect(name.length).toBe(63);
  });

  it('57-60 char ids are hashed and stay <=63 (prefix accounted for, Codex P2 二修)', () => {
    for (const len of [57, 58, 60]) {
      const name = branchAppNetworkName('b'.repeat(len));
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/-[0-9a-f]{8}$/); // hash suffix present
    }
  });

  it('long ids sharing the first 60 safe chars still get distinct networks (Codex P2: no collision)', () => {
    // Two ids identical for the first 80 chars but differing in the tail. The old
    // `.slice(0,60)` would map both to the same cds-br-* network → reintroducing the
    // cross-branch DNS collision this layer prevents. The hash suffix keeps them apart.
    const base = 'feature-very-long-branch-name-that-exceeds-sixty-characters-easily';
    const a = branchAppNetworkName(`${base}-alpha`);
    const b = branchAppNetworkName(`${base}-beta`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(b.length).toBeLessThanOrEqual(63);
  });

  it('is deterministic across calls (same id → same network name)', () => {
    const id = 'z'.repeat(120);
    expect(branchAppNetworkName(id)).toBe(branchAppNetworkName(id));
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
