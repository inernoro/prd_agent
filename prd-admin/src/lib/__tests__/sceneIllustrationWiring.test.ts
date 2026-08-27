import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LANDING_PREVIEW_SLOTS } from '@/lib/landingPreviewSlots';

/**
 * 守卫：注册表里的每一幕，在首页上都真的有地方会渲染它。
 *
 * 为什么需要这条：配图的 slot 是从 `SceneFrame` 的 `id` **推**出来的
 * （`scene-layers` → `landing.layers`），推导两头都可能单独改 —— 改了幕的 id、
 * 或者往注册表加一幕却没有对应的幕，页面上都只是「静默不显示」，编译过、测试绿、
 * 通读也挑不出（`predicate-and-wiring-discipline` 形状 2：链路只建了一半）。
 *
 * 所以两头都断言：注册表 → 页面（每一幕都有渲染点），页面 → 注册表（每个 scene-*
 * 的 id 都在注册表里），少一头就只能防住一个方向的漂移。
 */

const HOME_DIR = path.resolve(__dirname, '../../pages/home');

function readHomeSources(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.tsx')) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(HOME_DIR);
  return out.join('\n');
}

describe('首页配图接线（每一幕都要有渲染点）', () => {
  const source = readHomeSources();
  /** 页面上出现过的幕 id：`id="scene-xxx"` */
  const sceneIds = new Set(
    Array.from(source.matchAll(/id="scene-([a-z0-9-]+)"/g), (m) => m[1]),
  );
  /** 手写 slot 的幕（不走 SceneFrame 的，比如 Hero） */
  const explicitSlots = new Set(
    Array.from(source.matchAll(/slot="landing\.([a-z0-9-]+)"/g), (m) => m[1]),
  );

  it('注册表里的每一幕，页面上都有对应的渲染点', () => {
    const missing = LANDING_PREVIEW_SLOTS
      .map((s) => s.id)
      .filter((id) => !sceneIds.has(id) && !explicitSlots.has(id));
    expect(
      missing,
      `这些幕在 landingPreviewSlots 里登记了，但 pages/home 下既没有 id="scene-{id}"、`
        + `也没有 slot="landing.{id}" —— 生成出来的图永远不会显示：${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('页面上每个 scene-* 的幕，注册表里都登记了', () => {
    const known = new Set(LANDING_PREVIEW_SLOTS.map((s) => s.id));
    const unregistered = [...sceneIds].filter((id) => !known.has(id));
    expect(
      unregistered,
      `这些幕在首页上存在，但 landingPreviewSlots 里没有对应条目，管理员没法给它配图：`
        + `${unregistered.join(', ')}`,
    ).toEqual([]);
  });

  it('SceneFrame 真的在渲染配图组件（删掉这行不该悄悄变绿）', () => {
    const frame = fs.readFileSync(path.join(HOME_DIR, 'scenes/SceneFrame.tsx'), 'utf8');
    expect(frame).toContain('<SceneIllustration');
  });
});
