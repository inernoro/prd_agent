/**
 * Unit tests for the P4 Part 18 (G10) stack detector. Each test
 * lays down a tiny tmp directory with the minimum files needed to
 * trigger a specific detector and asserts the returned StackDetection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectStack } from '../../src/services/stack-detector.js';

describe('stack-detector', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-stack-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an unknown detection for an empty directory', () => {
    const result = detectStack(tmp);
    expect(result.stack).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('returns a stack=unknown / path not found for a missing path', () => {
    const result = detectStack(path.join(tmp, 'no-such-dir'));
    expect(result.stack).toBe('unknown');
    expect(result.summary).toContain('路径不存在');
  });

  describe('Node.js', () => {
    it('detects a pnpm project from packageManager field', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'test',
        packageManager: 'pnpm@9.0.0',
        scripts: { start: 'node server.js', build: 'tsc' },
        engines: { node: '22' },
      }));
      const r = detectStack(tmp);
      expect(r.stack).toBe('nodejs');
      expect(r.dockerImage).toBe('node:22-slim');
      expect(r.installCommand).toContain('pnpm');
      expect(r.buildCommand).toBe('pnpm run build');
      expect(r.runCommand).toBe('pnpm start');
      expect(r.signals).toContain('package.json');
    });

    it('detects pnpm from pnpm-lock.yaml when no packageManager field', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { dev: 'vite' },
      }));
      fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), '');
      const r = detectStack(tmp);
      expect(r.installCommand).toContain('pnpm');
      expect(r.runCommand).toBe('pnpm run dev');
    });

    it('falls back to yarn when yarn.lock is present', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x' }));
      fs.writeFileSync(path.join(tmp, 'yarn.lock'), '');
      const r = detectStack(tmp);
      expect(r.installCommand).toContain('yarn');
    });

    it('falls back to npm when only package-lock.json is present', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'x',
        scripts: { start: 'node main.js' },
      }));
      fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{}');
      const r = detectStack(tmp);
      expect(r.installCommand).toBe('npm ci');
      expect(r.runCommand).toBe('npm start');
    });

    it('defaults to node:20-slim when engines.node is absent', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      const r = detectStack(tmp);
      expect(r.dockerImage).toBe('node:20-slim');
    });

    it('parses port from script flag (next dev -p 4000)', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'next-app',
        scripts: { dev: 'next dev -p 4000' },
      }));
      const r = detectStack(tmp);
      expect(r.containerPort).toBe(4000);
    });
  });

  describe('Go', () => {
    it('detects Go from go.mod and pulls go version', () => {
      fs.writeFileSync(path.join(tmp, 'go.mod'), 'module example.com/app\n\ngo 1.21\n');
      const r = detectStack(tmp);
      expect(r.stack).toBe('go');
      expect(r.dockerImage).toBe('golang:1.21-alpine');
      expect(r.buildCommand).toBe('go build -o app .');
      expect(r.runCommand).toBe('./app');
    });
  });

  describe('Rust', () => {
    it('detects Rust from Cargo.toml and extracts binary name', () => {
      fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname = "my-service"\nversion = "0.1.0"\n');
      const r = detectStack(tmp);
      expect(r.stack).toBe('rust');
      expect(r.runCommand).toBe('./target/release/my-service');
    });
  });

  describe('Python', () => {
    it('detects pip project with requirements.txt + main.py', () => {
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'flask\n');
      fs.writeFileSync(path.join(tmp, 'main.py'), 'print("hi")\n');
      const r = detectStack(tmp);
      expect(r.stack).toBe('python');
      expect(r.installCommand).toBe('pip install -r requirements.txt');
      expect(r.runCommand).toBe('python main.py');
    });

    it('detects poetry from pyproject.toml [tool.poetry]', () => {
      fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.poetry]\nname = "x"\n');
      const r = detectStack(tmp);
      expect(r.installCommand).toContain('poetry');
      expect(r.summary).toContain('poetry');
    });

    it('uses manage.py runserver for Django projects', () => {
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'django\n');
      fs.writeFileSync(path.join(tmp, 'manage.py'), '#!/usr/bin/env python\n');
      const r = detectStack(tmp);
      expect(r.runCommand).toContain('runserver');
    });
  });

  describe('Java', () => {
    it('detects Maven from pom.xml', () => {
      fs.writeFileSync(path.join(tmp, 'pom.xml'), '<project></project>');
      const r = detectStack(tmp);
      expect(r.stack).toBe('java');
      expect(r.installCommand).toContain('mvn');
      expect(r.buildCommand).toContain('mvn');
    });

    it('detects Gradle from build.gradle.kts', () => {
      fs.writeFileSync(path.join(tmp, 'build.gradle.kts'), 'plugins { }\n');
      const r = detectStack(tmp);
      expect(r.stack).toBe('java');
      expect(r.installCommand).toContain('gradle');
    });
  });

  describe('Ruby + PHP', () => {
    it('detects Ruby from Gemfile', () => {
      fs.writeFileSync(path.join(tmp, 'Gemfile'), "source 'https://rubygems.org'\n");
      const r = detectStack(tmp);
      expect(r.stack).toBe('ruby');
      expect(r.installCommand).toContain('bundle');
    });

    it('detects PHP from composer.json', () => {
      fs.writeFileSync(path.join(tmp, 'composer.json'), '{}');
      const r = detectStack(tmp);
      expect(r.stack).toBe('php');
      expect(r.installCommand).toContain('composer');
    });
  });

  describe('Dockerfile', () => {
    it('detects Dockerfile and flags manual setup required', () => {
      fs.writeFileSync(path.join(tmp, 'Dockerfile'), 'FROM alpine:3\n');
      const r = detectStack(tmp);
      expect(r.stack).toBe('dockerfile');
      expect(r.manualSetupRequired).toBe(true);
      expect(r.summary).toContain('Dockerfile');
    });

    it('Dockerfile beats package.json in priority (so users with a Dockerfile see the explicit message first)', () => {
      fs.writeFileSync(path.join(tmp, 'Dockerfile'), 'FROM node:20\n');
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x' }));
      const r = detectStack(tmp);
      expect(r.stack).toBe('dockerfile');
    });
  });
});
