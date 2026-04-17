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
      // Use a non-framework dep so the base-stack runCommand is kept.
      // (Flask / Django / FastAPI would now flip into FU-03 overrides.)
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'requests\n');
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

  // ───────────────────────────────────────────────────────────
  // FU-03 framework detection — nixpacks-style sub-discriminator
  // ───────────────────────────────────────────────────────────
  describe('FU-03 framework detection — Node.js', () => {
    it('detects Next.js from dependencies', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'next-site',
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
        scripts: { build: 'next build', start: 'next start' },
      }));
      const r = detectStack(tmp);
      expect(r.stack).toBe('nodejs');
      expect(r.framework).toBe('nextjs');
      expect(r.dockerImage).toBe('node:20-alpine');
      expect(r.suggestedRunCommand).toContain('npm run build');
      expect(r.suggestedRunCommand).toContain('npm start');
      expect(r.suggestedBuildCommand).toBe('npm run build');
      expect(r.containerPort).toBe(3000);
      expect(r.signals).toContain('deps:next');
    });

    it('detects Next.js from next.config.js even without dep', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x' }));
      fs.writeFileSync(path.join(tmp, 'next.config.js'), 'module.exports = {};\n');
      const r = detectStack(tmp);
      expect(r.framework).toBe('nextjs');
      expect(r.signals).toContain('next.config');
    });

    it('detects NestJS from @nestjs/core dependency', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'nest-api',
        dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0', express: '^4.0.0' },
        scripts: { 'start:prod': 'node dist/main' },
      }));
      const r = detectStack(tmp);
      expect(r.framework).toBe('nestjs');
      expect(r.dockerImage).toBe('node:20-alpine');
      expect(r.suggestedRunCommand).toBe('npm run start:prod');
      expect(r.signals).toContain('deps:@nestjs/core');
    });

    it('detects Express as fallback (after ruling out Nest/Next)', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'express-app',
        dependencies: { express: '^4.18.0' },
      }));
      fs.writeFileSync(path.join(tmp, 'server.js'), '// entry\n');
      const r = detectStack(tmp);
      expect(r.framework).toBe('express');
      expect(r.dockerImage).toBe('node:20-alpine');
      expect(r.suggestedRunCommand).toBe('node server.js');
    });

    it('detects Express with index.js entry fallback', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'express-bare',
        dependencies: { express: '^4.18.0' },
      }));
      fs.writeFileSync(path.join(tmp, 'index.js'), '// entry\n');
      const r = detectStack(tmp);
      expect(r.framework).toBe('express');
      expect(r.suggestedRunCommand).toBe('node index.js');
    });

    it('detects Remix from @remix-run scoped dependency', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'remix-app',
        dependencies: { '@remix-run/node': '^2.0.0', '@remix-run/react': '^2.0.0' },
      }));
      const r = detectStack(tmp);
      expect(r.framework).toBe('remix');
      expect(r.dockerImage).toBe('node:20-alpine');
      expect(r.suggestedRunCommand).toBe('npm start');
      expect(r.suggestedBuildCommand).toBe('npm run build');
    });

    it('detects Remix from classic `remix` package', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'remix-classic',
        dependencies: { remix: '^1.0.0' },
      }));
      const r = detectStack(tmp);
      expect(r.framework).toBe('remix');
    });

    it('detects Vite+React as static site with nginx image', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'vite-react-app',
        devDependencies: { vite: '^5.0.0' },
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
      }));
      const r = detectStack(tmp);
      expect(r.framework).toBe('vite-react');
      expect(r.dockerImage).toBe('nginx:alpine');
      expect(r.suggestedBuildCommand).toBe('npm run build');
      expect(r.containerPort).toBe(80);
    });

    it('NestJS beats Express when both deps present', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'nest-on-express',
        dependencies: { '@nestjs/core': '^10.0.0', express: '^4.0.0' },
      }));
      const r = detectStack(tmp);
      expect(r.framework).toBe('nestjs');
    });

    it('Next.js beats Vite+React when both signals present', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'mixed',
        dependencies: { next: '^14.0.0', react: '^18.0.0', vite: '^5.0.0' },
      }));
      const r = detectStack(tmp);
      expect(r.framework).toBe('nextjs');
    });

    it('leaves framework undefined for a plain Node.js app', () => {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'plain',
        dependencies: { lodash: '^4.0.0' },
      }));
      const r = detectStack(tmp);
      expect(r.stack).toBe('nodejs');
      expect(r.framework).toBeUndefined();
    });
  });

  describe('FU-03 framework detection — Python', () => {
    it('detects Django from requirements.txt', () => {
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'django==4.2\npsycopg2\n');
      const r = detectStack(tmp);
      expect(r.stack).toBe('python');
      expect(r.framework).toBe('django');
      expect(r.dockerImage).toBe('python:3.12-slim');
      expect(r.suggestedRunCommand).toContain('manage.py runserver');
      expect(r.containerPort).toBe(8000);
    });

    it('detects Django from manage.py even without the dep line', () => {
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), '# empty\n');
      fs.writeFileSync(path.join(tmp, 'manage.py'), '#!/usr/bin/env python\n');
      const r = detectStack(tmp);
      expect(r.framework).toBe('django');
      expect(r.signals).toContain('manage.py');
    });

    it('detects FastAPI with uvicorn main:app command', () => {
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'fastapi[all]==0.110.0\nuvicorn\n');
      const r = detectStack(tmp);
      expect(r.framework).toBe('fastapi');
      expect(r.suggestedRunCommand).toContain('uvicorn main:app');
      expect(r.suggestedRunCommand).toContain('--host 0.0.0.0');
    });

    it('detects Flask with flask run command', () => {
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'Flask==3.0.0\n');
      const r = detectStack(tmp);
      expect(r.framework).toBe('flask');
      expect(r.suggestedRunCommand).toContain('flask run');
      expect(r.containerPort).toBe(5000);
    });

    it('Django beats FastAPI when both in requirements', () => {
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'django\nfastapi\n');
      const r = detectStack(tmp);
      expect(r.framework).toBe('django');
    });

    it('detects FastAPI from pyproject.toml dependency string', () => {
      fs.writeFileSync(path.join(tmp, 'pyproject.toml'),
        '[tool.poetry]\nname = "x"\n[tool.poetry.dependencies]\npython = "^3.12"\nfastapi = "^0.110"\n');
      const r = detectStack(tmp);
      expect(r.framework).toBe('fastapi');
    });

    it('leaves framework undefined for a plain Python project', () => {
      fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'requests\nnumpy\n');
      const r = detectStack(tmp);
      expect(r.stack).toBe('python');
      expect(r.framework).toBeUndefined();
    });
  });

  describe('FU-03 framework detection — Ruby', () => {
    it('detects Rails from `gem "rails"` in Gemfile', () => {
      fs.writeFileSync(path.join(tmp, 'Gemfile'),
        "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n");
      const r = detectStack(tmp);
      expect(r.stack).toBe('ruby');
      expect(r.framework).toBe('rails');
      expect(r.dockerImage).toBe('ruby:3.3-slim');
      expect(r.suggestedRunCommand).toContain('rails server');
      expect(r.containerPort).toBe(3000);
    });

    it('leaves framework undefined for a non-Rails Ruby project', () => {
      fs.writeFileSync(path.join(tmp, 'Gemfile'),
        "source 'https://rubygems.org'\ngem 'sinatra'\n");
      const r = detectStack(tmp);
      expect(r.stack).toBe('ruby');
      expect(r.framework).toBeUndefined();
    });
  });
});
