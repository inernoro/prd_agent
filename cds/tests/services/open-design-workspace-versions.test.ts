import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import type { AgentWorkspaceRuntimeCapability } from '../../src/services/agent-workspace-session-runtime.js';
import { OpenDesignWorkspaceVersions } from '../../src/services/open-design-workspace-versions.js';

const repository = 'ghcr.io/inernoro/prd_agent/opendesign-runtime';
const oldImage = `${repository}@sha256:${'a'.repeat(64)}`;
const newImage = `${repository}@sha256:${'b'.repeat(64)}`;
const badImage = `${repository}@sha256:${'c'.repeat(64)}`;
const origin = 'https://preview.example.test';
const healthy = { available: true, resourcePolicyEnforcedPerSession: true, reason: null };
const newRun = { continuing: false };
const continuedRun = { continuing: true };

describe('CDS OpenDesign session versions', () => {
  let root: string;

  async function setup() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-od-version-test-'));
    const filename = path.join(root, 'state.json');
    const state = new StateService(filename, root);
    const now = new Date().toISOString();
    const project = {
      id: 'opendesign-preview', slug: 'opendesign-preview', name: 'OpenDesign preview',
      kind: 'shared-service' as const, createdAt: now, updatedAt: now,
    };
    state.addProject(project);
    await state.flush();
    const verify = vi.fn(async (_image: string): Promise<AgentWorkspaceRuntimeCapability> => healthy);
    const versions = new OpenDesignWorkspaceVersions(state, oldImage, verify);
    return { filename, projectId: project.id, state, versions, verify };
  }

  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('persists a task pin across fresh sessions, restart, cutover and rollback', async () => {
    const { filename, projectId, versions, verify } = await setup();
    expect(await versions.pin(projectId, origin, 'task-a', newRun)).toBe(oldImage);
    expect(await versions.pin(projectId, origin, 'preexisting-on-baseline', continuedRun)).toBe(oldImage);
    await versions.change(projectId, origin, { action: 'activate', image: newImage, expectedImage: oldImage });
    expect(verify).toHaveBeenCalledWith(newImage);
    const restartedState = new StateService(filename, root);
    restartedState.load();
    const restored = new OpenDesignWorkspaceVersions(restartedState, oldImage, verify);
    expect(await restored.pin(projectId, origin, 'task-a', continuedRun)).toBe(oldImage);
    expect(await restored.pin(projectId, origin, 'task-b', newRun)).toBe(newImage);
    expect(await restored.pin(projectId, origin, 'preexisting-on-baseline', continuedRun)).toBe(oldImage);
    await expect(restored.pin(projectId, origin, 'unknown-old-work', continuedRun))
      .rejects.toMatchObject({ code: 'workspace_run_version_unconfirmed' });
    expect(await restored.pin(projectId, origin, 'prior-receipt', {
      continuing: true, previousImageDigest: newImage.split('@')[1],
    })).toBe(newImage);
    await expect(restored.pin(projectId, origin, 'task-a', {
      continuing: true, previousImageDigest: newImage.split('@')[1],
    })).rejects.toMatchObject({ code: 'workspace_run_version_unconfirmed' });
    expect(await restored.pin(projectId, 'https://another-map.example.test', 'task-b', newRun)).toBe(oldImage);
    await restored.change(projectId, origin, { action: 'rollback', expectedImage: newImage });
    expect(await restored.pin(projectId, origin, 'task-c', newRun)).toBe(oldImage);
    expect(await restored.pin(projectId, origin, 'task-b', continuedRun)).toBe(newImage);
  });

  it('holds the active version throughout validation and after a failing candidate', async () => {
    const { projectId, versions, verify } = await setup();
    let finish!: () => void;
    verify.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ available: false, resourcePolicyEnforcedPerSession: false, reason: 'Daemon did not start' });
    }));
    const update = versions.change(projectId, origin, { action: 'activate', image: badImage, expectedImage: oldImage });
    const outcome = expect(update).rejects.toMatchObject({ code: 'workspace_version_unhealthy' });
    expect(versions.view(projectId, origin)).toMatchObject({ activeImage: oldImage, checkingImage: badImage });
    expect(await versions.pin(projectId, origin, 'during-check', newRun)).toBe(oldImage);
    finish();
    await outcome;
    expect(versions.view(projectId, origin)).toMatchObject({ activeImage: oldImage, checkingImage: null });
    expect(await versions.pin(projectId, origin, 'after-failure', newRun)).toBe(oldImage);
  });

  it('rejects stale writes and mutable or foreign image references before verifying anything', async () => {
    const { projectId, versions, verify } = await setup();
    for (const image of [`${repository}:latest`, `docker.io/example/image@sha256:${'b'.repeat(64)}`]) {
      await expect(versions.change(projectId, origin, { action: 'activate', image, expectedImage: oldImage }))
        .rejects.toMatchObject({ code: 'workspace_version_image_invalid' });
    }
    await expect(versions.change(projectId, origin, { action: 'activate', image: newImage, expectedImage: badImage }))
      .rejects.toMatchObject({ code: 'workspace_version_conflict' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not admit an unconfirmed change and keeps the accepted version during a delayed upload', async () => {
    const { filename, projectId, state, versions, verify } = await setup();
    vi.spyOn(state, 'flush').mockRejectedValueOnce(new Error('simulated state-store write failure'));
    await expect(versions.change(projectId, origin, { action: 'activate', image: newImage, expectedImage: oldImage }))
      .rejects.toMatchObject({ code: 'workspace_version_persist_failed' });
    expect(versions.view(projectId, origin).activeImage).toBe(oldImage);
    const restored = new StateService(filename, root);
    restored.load();
    expect(new OpenDesignWorkspaceVersions(restored, oldImage, verify).view(projectId, origin).activeImage).toBe(oldImage);

    await expect(versions.change(projectId, origin, { action: 'activate', image: newImage, expectedImage: oldImage }, () => false))
      .rejects.toMatchObject({ code: 'workspace_version_conflict' });
    await versions.change(projectId, origin, { action: 'activate', image: newImage, expectedImage: oldImage });
    expect(await versions.pin(projectId, origin, 'slow-upload', { continuing: false, admittedImage: oldImage })).toBe(oldImage);
    expect(await versions.pin(projectId, origin, 'after-update', newRun)).toBe(newImage);
  });
});
