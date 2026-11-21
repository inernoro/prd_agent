import { describe, expect, it } from 'vitest';
import {
  PlanningPreviewAccess, previewPolicyReturnUrl, previewReturnPath,
  type PreviewAccessClient, type PreviewAccessCommit,
} from '../../src/services/planning-preview-access.js';

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
