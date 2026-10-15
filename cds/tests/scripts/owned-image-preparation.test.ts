import { expect, it } from 'vitest';
import { prepareOwnedDockerImages } from '../../scripts/application-docker-inner-drill.js';

it('独立能力镜像与基础镜像准备重叠，原期限和至多两个在途不变', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const calls: Array<[string, number]> = []; let active = 0, maximum = 0;
  const pending = prepareOwnedDockerImages(async (image, timeout) => {
    calls.push([image, timeout]); active++; maximum = Math.max(maximum, active);
    try { if (image === 'mongo:7.0') await held; } finally { active--; }
  }, 'owned-capability');
  try { await Promise.resolve(); expect(calls.map(v => v[0])).toContain('owned-capability'); }
  finally { release(); await pending; }
  expect(maximum).toBe(2);
  expect(calls).toContainEqual(['owned-capability', 600_000]);
  for (const image of ['mongo:7.0', 'registry:2', 'node:22-alpine']) expect(calls).toContainEqual([image, 120_000]);
});

it('独立拉取失败仍等其他在途完成，不提前交回清理责任', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let settled = false; const completed: string[] = [];
  const pending = prepareOwnedDockerImages(async image => {
    if (image === 'owned-capability') throw new Error('owned pull failure');
    if (image === 'mongo:7.0') await held;
    completed.push(image);
  }, 'owned-capability').then(() => { settled = true; }, error => { settled = true; throw error; });
  const result = pending.catch(error => error);
  await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  release(); expect((await result).message).toBe('owned pull failure');
  expect(completed).toEqual(['mongo:7.0', 'registry:2', 'node:22-alpine']);
});
