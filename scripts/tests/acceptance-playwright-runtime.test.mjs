import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadPlaywright } from '../../.claude/skills/create-visual-test-to-kb/scripts/playwright-runtime.mjs';
import { isConfiguredCdsTargetHost } from '../../.claude/skills/create-visual-test-to-kb/scripts/report-view.mjs';

const runtime = { chromium: { launch() {} } };

test('验收运行时在全局包缺失时发现项目 e2e 的 Playwright', () => {
  const attempted = [];
  const result = loadPlaywright({ env: {}, root: '/fixture', load(candidate) {
    attempted.push(candidate);
    if (candidate === '/fixture/e2e/node_modules/@playwright/test') return runtime;
    throw new Error('missing');
  } });
  assert.equal(result, runtime);
  assert.deepEqual(attempted, ['playwright', '/fixture/e2e/node_modules/@playwright/test']);
});

test('显式运行时配置失效时报告恢复动作且不静默换版本', () => {
  assert.throws(() => loadPlaywright({ env: { PWPATH: '/missing' }, load() {
    throw new Error('missing');
  } }), /修复 PWPATH/);
});

test('取证、标注和线上打开校验共用同一运行时解析入口', () => {
  for (const name of ['harness', 'annotate', 'verify-open']) {
    const source = readFileSync(new URL(`../../.claude/skills/create-visual-test-to-kb/scripts/${name}.mjs`, import.meta.url), 'utf8');
    assert.match(source, /import \{ loadPlaywright \} from '\.\/playwright-runtime\.mjs'/);
    assert.match(source, /loadPlaywright\(\)/);
    assert.doesNotMatch(source, /\/opt\/node22\/lib\/node_modules\/playwright/);
  }
});

test('报告凭据只注入当前 CDS_HOST 的精确主机', () => {
  assert.equal(isConfiguredCdsTargetHost('miduo.org', 'https://miduo.org'), true);
  assert.equal(isConfiguredCdsTargetHost('CDS.MIDUO.ORG', 'https://cds.miduo.org/'), true);
  assert.equal(isConfiguredCdsTargetHost('miduo.org.evil.example', 'https://miduo.org'), false);
  assert.equal(isConfiguredCdsTargetHost('reports.miduo.org', 'https://miduo.org'), false);
  assert.equal(isConfiguredCdsTargetHost('miduo.org', ''), false);
});
