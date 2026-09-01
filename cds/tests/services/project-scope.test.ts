/**
 * project-scope —— 「这次 push 该不该惊动这个项目」判据测试。
 *
 * 重点不是「能匹配」，而是三条刻意的取舍不许被改掉：
 *   1. 未声明作用域 = 全通配（零回归）；
 *   2. 判不准时 fail-open（算命中）—— 漏判是静默退化，误判只是多部署一次；
 *   3. 作用域只来自服务 buildScope 的并集，没有第二份声明来源。
 */

import { describe, it, expect } from 'vitest';
import {
  decideProjectScope,
  pathInScope,
  resolveProjectScope,
  scopeEntryToRegExp,
} from '../../src/services/project-scope.js';

describe('resolveProjectScope', () => {
  it('取名下全部服务 buildScope 的并集并去重', () => {
    const scope = resolveProjectScope([
      { buildScope: ['prd-api/**', '.github/workflows/branch-image.yml'] },
      { buildScope: ['prd-admin/**', '.github/workflows/branch-image.yml'] },
    ]);
    expect(scope.sort()).toEqual(
      ['.github/workflows/branch-image.yml', 'prd-admin/**', 'prd-api/**'].sort(),
    );
  });

  it('部署模式里声明的 buildScope 也计入并集', () => {
    const scope = resolveProjectScope([
      { deployModes: { express: { buildScope: ['llmgw/serving/**'] }, dev: undefined } },
    ]);
    expect(scope).toEqual(['llmgw/serving/**']);
  });

  it('仓库根等价物等于没声明（复用 normalizeBuildScope 的拒收判据）', () => {
    expect(resolveProjectScope([{ buildScope: ['**'] }, { buildScope: ['.'] }])).toEqual([]);
  });

  it('没有任何服务时作用域为空', () => {
    expect(resolveProjectScope([])).toEqual([]);
    expect(resolveProjectScope(undefined)).toEqual([]);
  });
});

describe('scopeEntryToRegExp / pathInScope', () => {
  it('`foo/**` 匹配 foo 下的直接文件与深层文件，不匹配同前缀的兄弟目录', () => {
    const re = scopeEntryToRegExp('prd-api/**');
    expect(re.test('prd-api/Program.cs')).toBe(true);
    expect(re.test('prd-api/src/deep/nested/File.cs')).toBe(true);
    expect(re.test('prd-api')).toBe(true);
    expect(re.test('prd-apiary/x.cs')).toBe(false);
    expect(re.test('cds/src/x.ts')).toBe(false);
  });

  it('单个 `*` 不跨目录', () => {
    const re = scopeEntryToRegExp('cds/*.json');
    expect(re.test('cds/package.json')).toBe(true);
    expect(re.test('cds/web/package.json')).toBe(false);
  });

  it('不含通配符的条目按「它自己或它下面的一切」匹配', () => {
    expect(pathInScope(['cds'], 'cds/src/server.ts')).toBe(true);
    expect(pathInScope(['cds'], 'cds')).toBe(true);
    expect(pathInScope(['cds'], 'cdsx/src/server.ts')).toBe(false);
  });

  it('精确文件条目只匹配它自己', () => {
    const scope = ['.github/workflows/branch-image.yml'];
    expect(pathInScope(scope, '.github/workflows/branch-image.yml')).toBe(true);
    expect(pathInScope(scope, '.github/workflows/ci.yml')).toBe(false);
  });

  it('路径前的 ./ 与 / 会被归一掉', () => {
    expect(pathInScope(['cds/**'], './cds/src/a.ts')).toBe(true);
    expect(pathInScope(['cds/**'], '/cds/src/a.ts')).toBe(true);
  });

  it('作用域为空时任何路径都算命中', () => {
    expect(pathInScope([], 'anything/at/all.txt')).toBe(true);
  });
});

describe('decideProjectScope —— 三条取舍', () => {
  it('未声明作用域 = 全通配，且标记 unscoped 以便与「声明了但没命中」区分', () => {
    const decision = decideProjectScope([], ['doc/readme.md']);
    expect(decision.matched).toBe(true);
    expect(decision.unscoped).toBe(true);
    expect(decision.reason).toContain('全通配');
  });

  it('改动落在范围内：命中，并带上命中样例供投递记录写原因', () => {
    const decision = decideProjectScope(['cds/**'], ['cds/src/server.ts', 'doc/x.md']);
    expect(decision.matched).toBe(true);
    expect(decision.unscoped).toBe(false);
    expect(decision.matchedPaths).toEqual(['cds/src/server.ts']);
    expect(decision.reason).toContain('cds/src/server.ts');
  });

  it('改动全在范围外：不命中，原因里写清范围', () => {
    const decision = decideProjectScope(['cds/**'], ['prd-api/Program.cs', 'doc/x.md']);
    expect(decision.matched).toBe(false);
    expect(decision.reason).toContain('cds/**');
  });

  it('拿不到改动清单时 fail-open —— 漏判是静默退化，误判只是多部署一次', () => {
    const decision = decideProjectScope(['cds/**'], []);
    expect(decision.matched).toBe(true);
    expect(decision.unscoped).toBe(false);
    expect(decision.reason).toContain('无法判定');
  });

  it('本仓库的真实形态：只改 cds/** 时主项目不命中、自托管项目命中', () => {
    const mainScope = ['prd-api/**', 'prd-admin/**', 'llmgw/serving/**', '.github/workflows/branch-image.yml'];
    const selfScope = ['cds/**'];
    const changed = ['cds/src/services/credential-self-check.ts', 'cds/tests/services/credential-self-check.test.ts'];
    expect(decideProjectScope(mainScope, changed).matched).toBe(false);
    expect(decideProjectScope(selfScope, changed).matched).toBe(true);

    const changedApi = ['prd-api/src/PrdAgent.Api/Program.cs'];
    expect(decideProjectScope(mainScope, changedApi).matched).toBe(true);
    expect(decideProjectScope(selfScope, changedApi).matched).toBe(false);
  });
});

describe('compose 服务级 cds.build-scope 能真的落进 profile', () => {
  it('解析后的 profile 带上 buildScope，项目作用域因此不再是全通配', async () => {
    const { parseCdsCompose } = await import('../../src/services/compose-parser.js');
    const yaml = [
      'services:',
      '  cds:',
      '    image: node:20-slim',
      '    working_dir: /repo',
      '    volumes:',
      '      - .:/repo',
      '    ports:',
      '      - "9900"',
      '    labels:',
      '      cds.path-prefix: "/"',
      '      cds.build-scope: "cds/**"',
      '',
    ].join('\n');
    const parsed = parseCdsCompose(yaml)!;
    const profile = parsed.buildProfiles.find((p) => p.id === 'cds');
    expect(profile?.buildScope).toEqual(['cds/**']);

    const scope = resolveProjectScope(parsed.buildProfiles);
    expect(scope).toEqual(['cds/**']);
    expect(decideProjectScope(scope, ['prd-api/src/Program.cs']).matched).toBe(false);
    expect(decideProjectScope(scope, ['cds/src/server.ts']).matched).toBe(true);
  });

  it('没有声明 cds.build-scope 时 profile 不带该字段（作用域退回全通配 = 零回归）', async () => {
    const { parseCdsCompose } = await import('../../src/services/compose-parser.js');
    const yaml = [
      'services:',
      '  web:',
      '    image: node:20-slim',
      '    volumes:',
      '      - .:/repo',
      '    ports:',
      '      - "8000"',
      '',
    ].join('\n');
    const parsed = parseCdsCompose(yaml)!;
    expect(parsed.buildProfiles.find((p) => p.id === 'web')?.buildScope).toBeUndefined();
    expect(resolveProjectScope(parsed.buildProfiles)).toEqual([]);
  });
});
