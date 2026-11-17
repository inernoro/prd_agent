import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { samplePortrait as gateway } from '../src/components/entry/portraitTimeline.ts';
import { samplePortrait as map } from '../../../prd-admin/src/components/effects/portraitTimeline.ts';

test('两个独立构建的角色几何、素材与逐帧轨迹保持一致', () => {
  for (let frame = 0; frame <= 432; frame++) assert.deepEqual(gateway(frame / 60), map(frame / 60));
  for (const file of ['portraitGeometry.ts','companion.webp','companion-sleep.webp','portrait-motion.mp4']) {
    const code = file.endsWith('.ts');
    const ours = new URL(code ? `../src/components/entry/${file}` : `../public/media/entry/${file}`, import.meta.url);
    const original = new URL(code ? `../../../prd-admin/src/components/effects/${file}` : `../../../prd-admin/public/media/entry/${file}`, import.meta.url);
    assert.deepEqual(readFileSync(ours),readFileSync(original));
  }
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
