import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { rotateOrbitOffsetByPixels } from '../DocumentGalaxyView';

describe('rotateOrbitOffsetByPixels', () => {
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
