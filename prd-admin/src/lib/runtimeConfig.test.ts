import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPublicDeploymentConfig } from './runtimeConfig';

describe('readPublicDeploymentConfig', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('prefers configuration generated when the container starts', () => {
    window.__MAP_RUNTIME_CONFIG__ = {
      VITE_PUBLIC_DOCS_URL: ' https://docs.example.test/start ',
    };

    expect(readPublicDeploymentConfig('VITE_PUBLIC_DOCS_URL')).toBe('https://docs.example.test/start');
  });

  it('returns an empty string when deployment did not provide a value', () => {
    expect(readPublicDeploymentConfig('VITE_FRONT_END_PROJECT_REGISTRY_JSON')).toBe('');
  });
});
