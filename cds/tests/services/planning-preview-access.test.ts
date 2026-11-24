import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PlanningPreviewAccess, previewPolicyReturnUrl, previewReturnPath,
  type PreviewAccessClient, type PreviewAccessCommit, type PreviewAccessPerson,
} from '../../src/services/planning-preview-access.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';

describe('branch preview access', () => {
  it('binds paths to the intended route namespace', () => {
    expect(previewReturnPath('/branch-a/members/?mode=list#team', '/branch-a')).toBe('/branch-a/members/?mode=list#team');
    expect(previewReturnPath('/branch-b/members', '/branch-a')).toBeUndefined();
    expect(previewReturnPath('/branch-a/../branch-b', '/branch-a')).toBeUndefined();
    expect(previewReturnPath('/api/projects')).toBeUndefined();
  });

  it('uses the registered parent for policy links and omits private preview configuration', () => {
    const base = 'https://cds.fixture.test';
    expect(previewPolicyReturnUrl({
      enabled: true, providerId: 'cds-preview', authorizationUrl: base + '/preview/authorize',
      clientId: 'fixture-preview-a',
    })).toBe(base + '/preview-access?client=fixture-preview-a');
    for (const authorizationUrl of [
      base + '/preview/authorize?private=fixture', 'https://fixture:fixture@cds.fixture.test/preview/authorize',
      base + '/api/auth/private', 'http://cds.fixture.test/preview/authorize',
    ]) {
      expect(previewPolicyReturnUrl({ enabled: true, providerId: 'cds-preview', clientId: 'fixture-preview-a', authorizationUrl }))
        .toBeUndefined();
    }
  });

  it('keeps an approved return path private and notifies only the authorized recipient', async () => {
    const client: PreviewAccessClient = { id: 'fixture-preview-a', secret: 'a'.repeat(32), callback: 'https://a.fixture.test/auth/sso',
      commit: 'b'.repeat(40), projectId: 'fixture-a', branchId: 'fixture-branch', projectName: 'Fixture',
      branchName: 'test', pullRequest: 7, origin: 'https://a.fixture.test', path: '/members/' };
    const applicant = { id: 'applicant', username: 'applicant', name: 'Applicant', owner: false };
    const another = { id: 'another', username: 'another', name: 'Another', owner: false };
    const owner = { id: 'owner', username: 'owner', name: 'Owner', owner: true };
    const rows: PreviewAccessCommit[] = [];
    let approved = false;
    let valid = true;
    const service = new PlanningPreviewAccess({
      store: { read: async id => rows.filter(row => row.projectId === id), append: async row => { rows.push(row); return true; } },
      resolve: async id => valid && id === client.id ? client : undefined,
      allowed: async person => person.owner || (approved && (person.id === applicant.id || person.id === another.id)),
    });
    const projects = [client.projectId];
    const path = '/members/?view=team#last';
    const request = await service.request(client, applicant, '', path);
    expect(request?.returnPath).toBe(path);
    expect((await service.request(client, applicant, '', '/members/?view=other'))?.returnPath).toBe(path);
    expect(await service.findRequest(projects, request!.id, another)).toBeUndefined();
    expect((await service.findRequest(projects, request!.id, applicant))?.returnPath).toBe(path);
    expect(await service.notices(projects, owner)).toEqual({ pending: 1, approved: [] });
    expect(await service.notices(projects, applicant)).toEqual({ pending: 0, approved: [] });

    approved = true;
    expect(await service.notices(projects, applicant)).toEqual({ pending: 0, approved: [{ id: request!.id, project: 'Fixture' }] });
    expect(await service.notices(projects, another)).toEqual({ pending: 0, approved: [] });
    expect(await service.notices(projects, owner)).toEqual({ pending: 0, approved: [] });
    valid = false;
    expect(await service.notices(projects, applicant)).toEqual({ pending: 0, approved: [] });
    valid = true;
    approved = false;
    expect(await service.notices(projects, applicant)).toEqual({ pending: 0, approved: [] });
  });

  it('issues a callback fragment and consumes a matching ticket at most once', async () => {
    const client: PreviewAccessClient = { id: 'fixture-preview-a', secret: 'a'.repeat(32), callback: 'https://a.fixture.test/auth/sso',
      commit: 'b'.repeat(40), projectId: 'fixture-a', branchId: 'fixture-branch', projectName: 'Fixture',
      branchName: 'test', pullRequest: 7, origin: 'https://a.fixture.test', path: '/members/' };
    const person = { id: 'test-member', username: 'test-member', name: 'Fixture Member', owner: false };
    let now = 1;
    let allow = true;
    const service = new PlanningPreviewAccess({ now: () => now,
      store: { read: async () => [], append: async () => true },
      resolve: async id => id === client.id ? client : undefined,
      allowed: async (user, project) => allow && user.id === person.id && project === client.projectId,
    });
    const state = 's'.repeat(32);
    const issue = async () => {
      const destination = await service.issue(client, person, state, client.callback);
      expect(destination).toBeTruthy();
      return new URLSearchParams(new URL(destination!).hash.slice(1)).get('code');
    };
    const input = { grant_type: 'urn:cds:params:oauth:grant-type:ticket', client_id: client.id, state,
      redirect_uri: client.callback, client_secret: client.secret, code: await issue() };
    expect(await service.consume({ ...input, state: 'wrong-state' })).toBeUndefined();
    expect((await Promise.all([service.consume(input), service.consume(input)])).filter(Boolean)).toHaveLength(1);
    const future = { ...input, code: await issue() };
    now = 300_001;
    expect(await service.consume(future)).toBeUndefined();
    const revoked = { ...input, code: await issue() };
    allow = false;
    expect(await service.consume(revoked)).toBeUndefined();
  });
});

describe('preview project approvers', () => {
  const projectA = 'fixture-approval-a';
  const projectB = 'fixture-approval-b';
  const projects = [projectA, projectB];
  const human = (id: string, name: string): PreviewAccessPerson => ({ id, username: id, name, owner: false });
  const delegateA = human('delegate-a', 'Fixture Approver A');
  const delegateB = human('delegate-b', 'Fixture Approver B');
  const applicantA = human('applicant-a', 'Fixture Applicant A');
  const applicantB = human('applicant-b', 'Fixture Applicant B');
  const member = human('member-without-role', 'Fixture Project Member');
  const stranger = human('stranger', 'Fixture Stranger');
  const people = new Map([delegateA, delegateB, applicantA, applicantB, member, stranger].map(person => [person.id, person]));
  const preview = (projectId: string, suffix: string): PreviewAccessClient => ({
    id: `fixture-approval-preview-${suffix}`, secret: 'a'.repeat(32), callback: `https://${suffix}.fixture.test/auth/sso`,
    commit: 'b'.repeat(40), projectId, branchId: `fixture-approval-branch-${suffix}`, projectName: `Fixture ${suffix}`,
    branchName: `review-${suffix}`, pullRequest: 7, origin: `https://${suffix}.fixture.test`, path: '/members/',
  });
  const clientA = preview(projectA, 'a');
  const clientB = preview(projectB, 'b');
  const returnPath = '/members/?view=private-fixture#team';

  async function runWithLedger(run: (fixture: {
    create: () => PlanningPreviewAccess;
    activeClients: Map<string, PreviewAccessClient>;
    members: Map<string, Set<string>>;
    inactive: Set<string>;
  }) => Promise<void>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cds-preview-approver-ledger-'));
    const members = new Map([[projectA, new Set([delegateA.id, member.id])], [projectB, new Set([delegateB.id])]]);
    const activeClients = new Map([clientA, clientB].map(client => [client.id, client]));
    const inactive = new Set<string>();
    const eligible = (projectId: string, userId: string) => !inactive.has(userId) && !!members.get(projectId)?.has(userId);
    const create = () => new PlanningPreviewAccess({
      store: new FileProjectRevisionStore<PreviewAccessCommit>(dir),
      resolve: async clientId => activeClients.get(clientId),
      allowed: async (person, projectId) => person.owner || eligible(projectId, person.id),
      approver: async (projectId: string, userId: string) => eligible(projectId, userId) ? people.get(userId) : undefined,
    });
    try { await run({ create, activeClients, members, inactive }); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }

  it('persists project assignments across restart, keeps existing requests, and supports clearing', async () => {
    await runWithLedger(async ({ create }) => {
      const service = create();
      expect(service.setApprover).toBeTypeOf('function');
      const row = (await service.request(clientA, applicantA, '', returnPath))!;
      await service.setApprover(projectA, delegateA.id);
      await service.setApprover(projectB, delegateB.id);
      await service.setApprover(projectA, stranger.id).catch(() => undefined);
      const restarted = create();
      expect(await restarted.approver(projectA)).toMatchObject({ id: delegateA.id, name: delegateA.name });
      expect(await restarted.approver(projectB)).toMatchObject({ id: delegateB.id, name: delegateB.name });
      expect((await restarted.findRequest(projects, row.id, applicantA))?.returnPath).toBe(returnPath);
      expect(await restarted.findRequest(projects, row.id, delegateA)).toBeUndefined();
      await restarted.setApprover(projectA, null);
      expect(await create().approver(projectA)).toBeFalsy();
      expect(await create().approver(projectB)).toMatchObject({ id: delegateB.id });
    });
  });

  it('scopes tickets and the pending count to assigned projects while an approver keeps their own notifications', async () => {
    await runWithLedger(async ({ create, members }) => {
      const service = create();
      expect(service.visibleRequests).toBeTypeOf('function');
      await service.setApprover(projectA, delegateA.id);
      await service.setApprover(projectB, delegateB.id);
      const a = (await service.request(clientA, applicantA, '', returnPath))!;
      const b = (await service.request(clientB, applicantB, '', returnPath))!;
      const own = (await service.request(clientB, delegateA, '', returnPath))!;
      members.get(projectB)!.add(delegateA.id);

      expect((await service.visibleRequests(projects, delegateA)).map(row => row.id)).toEqual([a.id]);
      expect((await service.visibleRequests(projects, member)) ?? []).toEqual([]);
      expect((await service.visibleRequests(projects, stranger)) ?? []).toEqual([]);
      expect(await service.notices(projects, delegateA)).toEqual({ pending: 1, approved: [{ id: own.id, project: clientB.projectName }] });
      expect(await service.notices(projects, delegateB)).toEqual({ pending: 1, approved: [] });
      expect(await service.notices(projects, applicantB)).toEqual({ pending: 0, approved: [] });
      expect(await service.canApprove(projectB, b.id, applicantB.id, delegateA)).toBe(false);
    });
  });

  it('requires the current active project approver and the matching active client, request and recipient', async () => {
    await runWithLedger(async ({ create, activeClients, members, inactive }) => {
      const service = create();
      expect(service.canApprove).toBeTypeOf('function');
      await service.setApprover(projectA, delegateA.id);
      const a = (await service.request(clientA, applicantA, '', returnPath))!;
      const b = (await service.request(clientB, applicantB, '', returnPath))!;

      expect(await service.canApprove(projectA, a.id, applicantA.id, delegateA)).toBe(true);
      expect(await service.canApprove(projectA, a.id, applicantA.id, member)).toBe(false);
      expect(await service.canApprove(projectA, a.id, applicantA.id, stranger)).toBe(false);
      expect(await service.canApprove(projectA, b.id, applicantB.id, delegateA)).toBe(false);
      expect(await service.canApprove(projectA, a.id, applicantB.id, delegateA)).toBe(false);
      expect(await service.canApprove(projectB, a.id, applicantA.id, delegateA)).toBe(false);

      activeClients.delete(clientA.id);
      expect(await service.canApprove(projectA, a.id, applicantA.id, delegateA)).toBe(false);
      expect((await service.notices(projects, delegateA)).pending).toBe(0);
      expect(await service.visibleRequests(projects, delegateA)).toEqual([]);
      expect(await service.requests(projectA)).toEqual([a]);
      activeClients.set(clientA.id, { ...clientA, branchId: 'fixture-stale-callback-branch' });
      expect(await service.canApprove(projectA, a.id, applicantA.id, delegateA)).toBe(false);
      expect(await service.visibleRequests(projects, delegateA)).toEqual([]);
      activeClients.set(clientA.id, clientA);

      members.get(projectA)!.delete(delegateA.id);
      expect(await service.approver(projectA)).toBeFalsy();
      expect(await service.canApprove(projectA, a.id, applicantA.id, delegateA)).toBe(false);
      expect((await service.visibleRequests(projects, delegateA)) ?? []).toEqual([]);
      members.get(projectA)!.add(delegateA.id);
      inactive.add(delegateA.id);
      expect(await service.canApprove(projectA, a.id, applicantA.id, delegateA)).toBe(false);
    });
  });
});
