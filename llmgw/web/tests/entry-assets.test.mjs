import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PORTRAIT_ASSETS } from '../src/components/entry/portraitMotionAsset.ts';
import { samplePortrait as gateway } from '../src/components/entry/portraitTimeline.ts';
import { samplePortrait as map } from '../../../prd-admin/src/components/effects/portraitTimeline.ts';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('日夜各用自己的 CDN 海报与视频，夜景仍与 MAP 入场素材同源', () => {
  for (let frame = 0; frame <= 432; frame++) assert.deepEqual(gateway(frame / 60), map(frame / 60));
  const runtime = readJson('../../../e2e/fixtures/media/gateway-portrait-cdn.json');
  const sources = readJson('../../../.design/map-cinematic-entry/portrait-cdn-sources.json');
  const night = readJson('../../../e2e/fixtures/media/portrait-motion.source.json');
  assert.equal(night.authoringMethod, 'imagegen-edgedrawing-optical-flow');
  assert.deepEqual(night.eyeKeyframes, ['closed', 'quarter', 'half', 'three-quarter', 'open']);
  assert.deepEqual(Object.fromEntries(Object.entries(sources.night).map(([file, asset]) => [file, asset.sha256])), night.sourceImages);
  const distinctUrls = new Set();
  for (const theme of ['dark', 'light']) {
    for (const plate of ['open', 'closed', 'motion']) {
      const expected = runtime[theme][plate];
      const url = new URL(PORTRAIT_ASSETS[theme][plate]);
      assert.equal(url.href, expected.url);
      assert.equal(url.origin, 'https://cfi.miduo.org');
      assert.ok(url.pathname.includes(expected.sha256.slice(0, 16)), '文件名固定到内容哈希');
      assert.ok(expected.bytes > 0);
      distinctUrls.add(url.href);
    }
  }
  assert.equal(distinctUrls.size, 6);
  assert.deepEqual(sources.daylightAuthoring.eyeKeyframes, night.eyeKeyframes);
  assert.equal(sources.daylightAuthoring.sha256, runtime.light.motion.sha256);
  for (const [file, expected] of [['companion.webp', runtime.dark.open], ['companion-sleep.webp', runtime.dark.closed], [night.fileName, runtime.dark.motion]]) {
    const original = new URL(`../../../prd-admin/public/media/entry/${file}`, import.meta.url);
    assert.equal(sha256(readFileSync(original)), expected.sha256);
  }
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
