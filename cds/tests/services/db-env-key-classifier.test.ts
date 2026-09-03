/**
 * 库名变量分类器 SSOT（收敛 1）。
 *
 * 三个入口（项目设置页签 / 复制集定位 / 库探测）对「这个服务用哪些库名变量」必须给同一个答案，
 * 答案只能来自 replica-db-clone 的这一份分类器：白名单家族（会被分支独立库改写）、框架家族
 * （.NET 双下划线等，按项目约定不加后缀）、引擎中立家族（DB_NAME，引擎从同 env 的连接串读）。
 *
 * 守卫：项目设置视图不许再自己拿 PER_BRANCH_DB_ENV_KEYS 过滤——那正是「.NET 项目在项目设置里
 * 被提示没声明库名变量、复制集却能定位」这条口径分裂的来源。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDbEnvKeys } from '../../src/services/replica-db-clone.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('classifyDbEnvKeys：三家族一次分完', () => {
  it('白名单 / 框架 / 引擎中立三家族各归各的引擎，并标出会不会被分支独立库改写', () => {
    const out = classifyDbEnvKeys({
      CDS_MYSQL_DATABASE: 'shop',
      MongoDB__DatabaseName: 'prdagent',
      DB_NAME: 'imp',
      SPRING_DATASOURCE_URL: 'jdbc:mysql://mysql:3306/imp',
      PORT: '3000',
      EMPTY_POSTGRES_DB: '',
    });
    expect(out).toEqual([
      { key: 'CDS_MYSQL_DATABASE', engine: 'mysql', family: 'whitelist', rewritten: true },
      { key: 'MongoDB__DatabaseName', engine: 'mongo', family: 'framework', rewritten: false },
      { key: 'DB_NAME', engine: 'mysql', family: 'neutral', rewritten: false },
    ]);
  });

  it('引擎中立 key 在同 env 没有唯一关系型连接串时不认（fail-closed）', () => {
    expect(classifyDbEnvKeys({ DB_NAME: 'imp' })).toEqual([]);
    expect(classifyDbEnvKeys({
      DB_NAME: 'imp', A_URL: 'jdbc:mysql://a/imp', B_URL: 'postgres://b/imp',
    })).toEqual([]);
  });

  it('空值不算声明', () => {
    expect(classifyDbEnvKeys({ CDS_POSTGRES_DB: '' })).toEqual([]);
  });
});

describe('来源守卫：项目设置视图的清单必须来自这一份分类器', () => {
  const src = fs.readFileSync(path.join(CDS_ROOT, 'src/routes/project-db-isolation.ts'), 'utf8');
  it('project-db-isolation.ts 引用 classifyDbEnvKeys，不再自己拿白名单过滤', () => {
    expect(src).toContain("classifyDbEnvKeys");
    expect(src).not.toMatch(/PER_BRANCH_DB_ENV_KEYS\.filter/);
  });
});
