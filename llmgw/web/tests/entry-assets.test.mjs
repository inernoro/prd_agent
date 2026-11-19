import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPortraitAssets } from '../src/components/entry/portraitMotionAsset.ts';
import { createPortraitAssets as createMapPortraitAssets } from '../../../prd-admin/src/components/effects/portraitMotionAsset.ts';
import { samplePortrait as gateway } from '../src/components/entry/portraitTimeline.ts';
import { samplePortrait as map } from '../../../prd-admin/src/components/effects/portraitTimeline.ts';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('日夜各用自己的 CDN 海报与视频，夜景仍与 MAP 入场素材同源', () => {
  for (let frame = 0; frame <= 432; frame++) assert.deepEqual(gateway(frame / 60), map(frame / 60));
  const runtime = readJson('../../../e2e/fixtures/media/gateway-portrait-cdn.json');
  const origin = new URL(runtime.dark.open.url).origin;
  const assets = createPortraitAssets(origin);
  const alternateOrigin = 'https://media.example.com';
  const alternateAssets = createPortraitAssets(` ${alternateOrigin}/ `);
  const sources = readJson('../../../.design/map-cinematic-entry/portrait-cdn-sources.json');
  const night = readJson('../../../e2e/fixtures/media/portrait-motion.source.json');
  assert.equal(night.authoringMethod, 'imagegen-edgedrawing-optical-flow');
  assert.deepEqual(night.eyeKeyframes, ['closed', 'quarter', 'half', 'three-quarter', 'open']);
  assert.deepEqual(Object.fromEntries(Object.entries(sources.night).map(([file, asset]) => [file, asset.sha256])), night.sourceImages);
  const distinctUrls = new Set();
  for (const theme of ['dark', 'light']) {
    for (const [plate, expected] of Object.entries(runtime[theme])) {
      const url = new URL(assets[theme][plate]);
      assert.equal(url.href, expected.url);
      assert.equal(url.origin, origin);
      assert.equal(alternateAssets[theme][plate], `${alternateOrigin}${url.pathname}`);
      assert.ok(url.pathname.includes(expected.sha256.slice(0, 16)), '文件名固定到内容哈希');
      assert.ok(expected.bytes > 0);
      distinctUrls.add(url.href);
    }
  }
  assert.equal(distinctUrls.size, 7);
  assert.deepEqual(sources.daylightAuthoring.eyeKeyframes, night.eyeKeyframes);
  assert.equal(sources.daylightSelectedEdit.method, 'seedance-official-downloads-aligned-recut');
  assert.equal(sources.daylightSelectedEdit.sha256, runtime.light.motion.sha256);
  assert.equal(sources.daylightSelectedEdit.durationSeconds, runtime.light.motion.durationSeconds);
  assert.equal(sources.daylightSelectedEdit.openingPosterSha256, runtime.light.opening.sha256);
  assert.equal(sources.daylightSelectedEdit.settledPosterSha256, runtime.light.open.sha256);
  assert.deepEqual(createMapPortraitAssets(origin), assets.dark);
  assert.deepEqual(createMapPortraitAssets(` ${alternateOrigin}/ `), alternateAssets.dark);
  assert.equal(runtime.dark.motion.sha256, night.sha256);
  assert.equal(runtime.dark.open.sha256, night.sourceImages['companion.webp']);
  assert.equal(runtime.dark.closed.sha256, night.sourceImages['companion-sleep.webp']);
  const geometry = file => readFileSync(new URL(file, import.meta.url));
  assert.deepEqual(geometry('../src/components/entry/portraitGeometry.ts'), geometry('../../../prd-admin/src/components/effects/portraitGeometry.ts'));
});
test('进入音效有实际信号、无削波，起止归零且不超过两秒', () => {
  for (const cue of ['scan','verified','reveal']) {
    const bytes = readFileSync(new URL(`../public/media/entry/${cue}.wav`,import.meta.url));
    assert.equal(bytes.toString('ascii',0,4),'RIFF');
    const rate = bytes.readUInt32LE(24); const size = bytes.readUInt32LE(40);
    assert.ok(size / 2 / rate <= 2);
    let peak = 0; let energy = 0;
    for (let i = 44; i < bytes.length; i += 2) { const sample = bytes.readInt16LE(i); peak = Math.max(peak,Math.abs(sample)); energy += sample * sample; }
    assert.ok(peak > 300 && peak < 10000);
    assert.ok(Math.sqrt(energy / (size / 2)) / 32768 > .04, '提示音有足够的整体能量，而非只有一个瞬时峰值');
    assert.equal(bytes.readInt16LE(44),0); assert.ok(Math.abs(bytes.readInt16LE(bytes.length-2)) < 2);
  }
});
