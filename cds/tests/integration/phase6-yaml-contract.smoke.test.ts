import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCdsCompose } from '../../src/services/compose-parser.js';

/**
 * Phase 6 准备(2026-05-01)— cdscli scan 输出 ↔ CDS parseCdsCompose 契约测试。
 *
 * 北极星目标的最后一公里:任意 schemaful DB 项目接入 CDS 端到端跑通。
 * Phase 1-5 已经把 cdscli scan 改造完毕,但生成器和消费器是两个独立代码库
 * (cdscli.py / compose-parser.ts),如果一边改了 schema 另一边没跟,生成的
 * yaml 部署时被 silently 漏字段,Phase 6 实战会原地踩坑。
 *
 * 本测试用合成的 Prisma+MySQL 项目跑 cdscli scan,把输出 yaml 喂给真正的
 * parseCdsCompose,断言 Phase 1-5 的关键字段都被正确解析为 CdsComposeConfig:
 *   - 项目元信息 / x-cds-env(Phase 1)
 *   - infra services + volumes(Phase 3)
 *   - app services + command(含 wait-for + ORM migration,Phase 3+4)
 *   - x-cds-deploy-modes(Phase 4.3)
 *
 * 任意一项 fail = cdscli 生成的 yaml 部署时会丢字段。
 */

const CLI = path.resolve(__dirname, '..', '..', '..', '.claude', 'skills', 'cds', 'cli', 'cdscli.py');

function makeSyntheticPrismaProject(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-phase6-'));
  fs.mkdirSync(path.join(tmp, 'backend', 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'backend', 'prisma', 'schema.prisma'),
    'generator client { provider = "prisma-client-js" }\n' +
    'datasource db { provider = "mysql"; url = env("DATABASE_URL") }\n' +
    'model User { id Int @id; email String @unique }\n');
  fs.writeFileSync(path.join(tmp, 'backend', 'package.json'), JSON.stringify({
    name: 'backend',
    scripts: { dev: 'node server.js' },
    dependencies: { '@prisma/client': '^5' },
    prisma: { seed: 'node prisma/seed.js' },
  }, null, 2));
  fs.writeFileSync(path.join(tmp, 'init.sql'), '-- bootstrap\n');
  fs.writeFileSync(path.join(tmp, 'docker-compose.yml'), `
services:
  mysql:
    image: mysql:8
    ports: ['3306:3306']
    environment:
      MYSQL_ROOT_PASSWORD: rootdev
      MYSQL_DATABASE: app
    volumes:
      - "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro"
      - "mysql_data:/var/lib/mysql"
  backend:
    image: node:20
    working_dir: /app
    volumes: ['./backend:/app']
    ports: ['3000:3000']
    environment:
      DATABASE_URL: mysql://app:appdev@mysql:3306/app
    command: npm run dev
    depends_on:
      - mysql

volumes:
  mysql_data:
`);
  return tmp;
}

function runScan(root: string): { yaml: string; signals: any } {
  const out = execSync(`python3 "${CLI}" scan "${root}"`, { encoding: 'utf-8', timeout: 30_000 });
  const parsed = JSON.parse(out);
  return { yaml: parsed.data.yaml, signals: parsed.data.signals };
}

describe('Phase 6 prep — cdscli scan 输出 ↔ CDS parseCdsCompose 契约', () => {
  it('Prisma+MySQL 合成项目:scan 生成的 yaml 能被 CDS 完整解析', () => {
    const tmp = makeSyntheticPrismaProject();
    try {
      const { yaml: yamlOut, signals } = runScan(tmp);

      // signals 验证(cdscli 端)
      expect(signals.orms).toEqual({ backend: 'prisma' });
      expect(signals.schemafulInfra).toContain('mysql');
      expect(signals.deployModes).toContain('backend');

      // 关键:把 yaml 喂给真正的 CDS 解析器
      const config = parseCdsCompose(yamlOut);
      expect(config).not.toBeNull();
      const c = config!;

      // 项目元信息(Phase 1)
      expect(c.project?.name).toBeTruthy();

      // x-cds-env 含 Phase 1 嵌套引用所需变量(Phase 8 命名规范:CDS_* 前缀)
      expect(c.envVars).toHaveProperty('CDS_MYSQL_DATABASE');
      expect(c.envVars).toHaveProperty('CDS_DATABASE_URL');
      expect(c.envVars.CDS_DATABASE_URL).toContain('${CDS_MYSQL_DATABASE}');

      // infra services(Phase 3 — volumes carry over)
      const mysqlInfra = c.infraServices.find(s => s.id === 'mysql');
      expect(mysqlInfra).toBeDefined();
      expect(mysqlInfra!.dockerImage).toMatch(/^mysql:/);
      expect(mysqlInfra!.containerPort).toBe(3306);
      // init.sql + 命名 volume 都被 carry over
      const volSources = mysqlInfra!.volumes.map(v => v.name);
      expect(volSources).toContain('./init.sql');
      expect(volSources).toContain('mysql_data');

      // app services(Phase 3+4 — wait-for + migration + working_dir + volumes)
      const backend = c.buildProfiles.find(p => p.id === 'backend');
      expect(backend).toBeDefined();
      expect(backend!.dockerImage).toMatch(/^node:/);
      expect(backend!.workDir).toBe('backend');  // 相对 mount 解出来
      expect(backend!.containerWorkDir).toBe('/app');
      expect(backend!.command).toContain('nc -z mysql 3306');  // Phase 3 wait-for
      expect(backend!.command).toContain('npx prisma migrate deploy');  // Phase 4 migration
      expect(backend!.command).toContain('npm run dev');  // 用户原 command 保留
      expect(backend!.dependsOn).toContain('mysql');

      // x-cds-deploy-modes(Phase 4.3 — dev 含 seed)
      expect(backend!.deployModes).toBeDefined();
      expect(backend!.deployModes!.dev).toBeDefined();
      expect(backend!.deployModes!.dev.command).toContain('npx prisma db seed');
      expect(backend!.deployModes!.dev.command).toContain('npm run dev');
      // prod mode label 也应该有(命令为空走默认)
      expect(backend!.deployModes!.prod).toBeDefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('普通 Node 项目(无 ORM):yaml 不含 deploy-modes,但 wait-for 仍能被解析', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-phase6-noorm-'));
    try {
      fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'app', 'package.json'), '{"name":"app"}');
      fs.writeFileSync(path.join(tmp, 'docker-compose.yml'), `
services:
  redis:
    image: redis:7
    ports: ['6379:6379']
  app:
    image: node:20
    working_dir: /app
    volumes: ['./app:/app']
    ports: ['3000:3000']
    command: npm start
`);
      const { yaml: yamlOut, signals } = runScan(tmp);
      expect(signals.orms || {}).toEqual({});
      expect(signals.deployModes || []).toEqual([]);

      const config = parseCdsCompose(yamlOut);
      expect(config).not.toBeNull();
      const app = config!.buildProfiles.find(p => p.id === 'app');
      expect(app).toBeDefined();
      // 无 ORM 不注入 migration,但 redis 触发 wait-for(redis 在 schemaful_targets)
      expect(app!.command).toContain('nc -z redis 6379');
      expect(app!.command).not.toContain('prisma');
      expect(app!.command).not.toContain('dotnet ef');
      // 不输出 deploy-modes
      expect(app!.deployModes).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
