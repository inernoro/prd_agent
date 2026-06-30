import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cameraTweenDurationMs, naturalCameraEase, rotateOrbitOffsetByPixels } from '../DocumentGalaxyView';

describe('rotateOrbitOffsetByPixels', () => {
  it('正向滑动使用触摸板自然方向', () => {
    const start = new THREE.Vector3(120, 80, 1050);
    const before = new THREE.Spherical().setFromVector3(start);
    const next = rotateOrbitOffsetByPixels(start, 180, 96, 1440, 900, 0.5);
    const after = new THREE.Spherical().setFromVector3(next);

    expect(after.theta).toBeGreaterThan(before.theta);
    expect(after.phi).toBeGreaterThan(before.phi);
  });

  it('双指滑动只改变观察方向，不改变相机距离', () => {
    const start = new THREE.Vector3(120, 80, 1050);
    const next = rotateOrbitOffsetByPixels(start, 180, -96, 1440, 900, 0.5);

    expect(next.distanceTo(start)).toBeGreaterThan(1);
    expect(next.length()).toBeCloseTo(start.length(), 8);
  });

  it('垂直滑动不会把相机翻过极点', () => {
    const start = new THREE.Vector3(0, 120, 1050);
    const next = rotateOrbitOffsetByPixels(start, 0, 100000, 1440, 900, 0.5);
    const spherical = new THREE.Spherical().setFromVector3(next);

    expect(spherical.phi).toBeGreaterThan(0);
    expect(spherical.phi).toBeLessThan(Math.PI);
    expect(next.length()).toBeCloseTo(start.length(), 8);
  });
});

describe('natural camera motion', () => {
  it('使用慢起步和慢停下的自然速度曲线', () => {
    expect(naturalCameraEase(0)).toBe(0);
    expect(naturalCameraEase(1)).toBe(1);
    expect(naturalCameraEase(0.1)).toBeLessThan(0.1);
    expect(naturalCameraEase(0.9)).toBeGreaterThan(0.9);
    expect(naturalCameraEase(0.5)).toBeCloseTo(0.5, 8);
  });

  it('飞行时长随距离增加但保持在可控范围', () => {
    const origin = new THREE.Vector3(0, 0, 0);
    const near = cameraTweenDurationMs(
      origin,
      new THREE.Vector3(20, 0, 0),
      new THREE.Vector3(0, 120, 1050),
      new THREE.Vector3(20, 120, 980),
    );
    const far = cameraTweenDurationMs(
      origin,
      new THREE.Vector3(900, 0, 0),
      new THREE.Vector3(0, 120, 1050),
      new THREE.Vector3(900, 360, 360),
    );

    expect(near).toBeGreaterThanOrEqual(620);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(1450);
  });
});
