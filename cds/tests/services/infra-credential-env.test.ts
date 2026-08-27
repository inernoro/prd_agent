import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cdsEnvPrefix,
  deriveInfraCredentialEnv,
  describeCredentialSources,
} from '../../src/services/infra-credential-env.js';

/**
 * 消费方容器的连接凭据。
 *
 * 这组用例钉的是 2026-08-27 那次事故的判据：数据服务开了认证，而 CDS 只往容器发
 * 地址不发凭据，于是**每一个新建的容器启动即崩**（`NOAUTH`）。已经在跑的容器
 * 不受影响，所以面板上看着还有一半分支是好的——这正是它难被发现的原因。
 */
describe('从基础设施服务派生连接凭据', () => {
  const at = { host: '172.17.0.1', port: 10002 };

  it('redis 的 ACL 用户与口令都要发出来', () => {
    const out = deriveInfraCredentialEnv('redis', {
      REDIS_USERNAME: 'app',
      REDIS_PASSWORD: 'p4ss',
    }, at);
    expect(out.CDS_REDIS_USER).toBe('app');
    expect(out.CDS_REDIS_PASSWORD).toBe('p4ss');
    expect(out.CDS_REDIS_URL).toBe('redis://app:p4ss@172.17.0.1:10002');
  });

  it('只设了口令没有用户名时不发空的 USER', () => {
    // 发一个空字符串比不发更坏：消费方会以为「配好了，用户名就是空」。
    const out = deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'p4ss' }, at);
    expect(out).not.toHaveProperty('CDS_REDIS_USER');
    expect(out.CDS_REDIS_PASSWORD).toBe('p4ss');
    expect(out.CDS_REDIS_URL).toBe('redis://:p4ss@172.17.0.1:10002');
  });

  it('mongo 认的是官方镜像那两个键', () => {
    const out = deriveInfraCredentialEnv('mongodb', {
      MONGO_INITDB_ROOT_USERNAME: 'app',
      MONGO_INITDB_ROOT_PASSWORD: 'secret',
      MONGO_INITDB_DATABASE: 'prdagent',
    }, { host: '172.17.0.1', port: 10001 });
    expect(out.CDS_MONGODB_USER).toBe('app');
    expect(out.CDS_MONGODB_PASSWORD).toBe('secret');
    expect(out.CDS_MONGODB_URL).toBe('mongodb://app:secret@172.17.0.1:10001');
  });

  it('口令里的保留字符必须百分号编码', () => {
    // 不编码的话，`@` 会让 URI 把口令后半段当成主机名——连到完全不存在的地方，
    // 而报错只会说「连不上」。同期 review 在 nacos 登录表单上抓到的是同一类错误。
    const out = deriveInfraCredentialEnv('mongodb', {
      MONGO_INITDB_ROOT_USERNAME: 'a@b',
      MONGO_INITDB_ROOT_PASSWORD: 'p@ss:w/rd?#',
    }, { host: 'h', port: 1 });
    expect(out.CDS_MONGODB_URL).toBe('mongodb://a%40b:p%40ss%3Aw%2Frd%3F%23@h:1');
    // 原始值不编码——消费方自己拼别的格式时要的是原文。
    expect(out.CDS_MONGODB_PASSWORD).toBe('p@ss:w/rd?#');
  });

  it('没有口令就什么都不发（没开认证的服务不该凭空多出凭据）', () => {
    expect(deriveInfraCredentialEnv('redis', {}, at)).toEqual({});
    expect(deriveInfraCredentialEnv('redis', undefined, at)).toEqual({});
    expect(deriveInfraCredentialEnv('redis', { REDIS_USERNAME: 'app' }, at)).toEqual({});
  });

  it('没有公认 URI 形态的服务只发 USER/PASSWORD', () => {
    const out = deriveInfraCredentialEnv('minio', {
      MINIO_ROOT_USER: 'root', MINIO_ROOT_PASSWORD: 'k',
    }, at);
    expect(out.CDS_MINIO_USER).toBe('root');
    expect(out.CDS_MINIO_PASSWORD).toBe('k');
    expect(out).not.toHaveProperty('CDS_MINIO_URL');
  });

  it('拿不到地址时只发 USER/PASSWORD，不拼半截 URI', () => {
    const out = deriveInfraCredentialEnv('mongodb', {
      MONGO_INITDB_ROOT_USERNAME: 'a', MONGO_INITDB_ROOT_PASSWORD: 'b',
    });
    expect(out.CDS_MONGODB_USER).toBe('a');
    expect(out).not.toHaveProperty('CDS_MONGODB_URL');
  });

  it('变量名前缀与既有的 PORT/HOST 一套口径（同一个服务 id 派生同一个前缀）', () => {
    expect(cdsEnvPrefix('redis-mdimp')).toBe('REDIS_MDIMP');
    const out = deriveInfraCredentialEnv('redis-mdimp', { REDIS_PASSWORD: 'x' }, at);
    // 已有命名是 CDS_REDIS_MDIMP_PORT；凭据必须落在同一个前缀下，
    // 否则模板里 `${CDS_REDIS_MDIMP_PORT}` 与 `${CDS_REDIS_MDIMP_PASSWORD}` 会指到两台机器。
    expect(out).toHaveProperty('CDS_REDIS_MDIMP_PASSWORD');
  });

  it('同一个服务只命中一类，不会被后面的表项覆盖', () => {
    // 一台容器同时带着两套键名（例如迁移中途），先命中的那类说了算，
    // 不能出现「USER 来自 mongo、PASSWORD 来自 mysql」这种拼接。
    const out = deriveInfraCredentialEnv('weird', {
      MONGO_INITDB_ROOT_USERNAME: 'm', MONGO_INITDB_ROOT_PASSWORD: 'mp',
      MYSQL_USER: 'y', MYSQL_PASSWORD: 'yp',
    }, at);
    expect(out.CDS_WEIRD_USER).toBe('m');
    expect(out.CDS_WEIRD_PASSWORD).toBe('mp');
  });

  it('值还是没展开的模板时，一个键都不发', () => {
    // InfraService.env 存的是未展开模板，线上真有四个项目的 MYSQL_USER / MINIO_ROOT_USER
    // 就是字面的 `${...}`。把占位符当口令发出去，消费方会拿它去认证然后失败——
    // 比什么都不发难查得多。调用方本该先解析，这里是第二道闸。
    expect(deriveInfraCredentialEnv('mysql', {
      MYSQL_USER: '${CDS_MYSQL_USER}',
      MYSQL_PASSWORD: '${CDS_MYSQL_PASSWORD}',
    }, at)).toEqual({});
    // 口令解出来了、用户名没有 = 半套凭据，同样不发。
    expect(deriveInfraCredentialEnv('mysql', {
      MYSQL_USER: '${CDS_MYSQL_USER}',
      MYSQL_PASSWORD: 'real',
    }, at)).toEqual({});
    // 反过来也一样。
    expect(deriveInfraCredentialEnv('mysql', {
      MYSQL_USER: 'app',
      MYSQL_PASSWORD: '${CDS_MYSQL_PASSWORD}',
    }, at)).toEqual({});
  });

  it('解析器把解不出来的模板变成空串，正好落到「没口令就不发」', () => {
    // resolveEnvTemplates 对解不出来的模板返回空字符串而不是留占位符，
    // 所以调用方解析过之后，缺值的服务自然什么都不发。
    expect(deriveInfraCredentialEnv('mysql', { MYSQL_USER: '', MYSQL_PASSWORD: '' }, at)).toEqual({});
  });

  it('每一类都写得出「为什么认这两个键」', () => {
    const described = describeCredentialSources();
    expect(described.length).toBeGreaterThan(0);
    for (const line of described) expect(line).toMatch(/ -> .+/);
  });
});

/**
 * 判据建好了没人调用，是本仓库反复栽过的形状（形状 2）。这次事故本身就是它的
 * 另一半：有人把 profile 改成引用 `${CDS_REDIS_URL}`，而那个名字从来没被生产过。
 */
describe('接线', () => {
  const stateSource = readFileSync(join(process.cwd(), 'src/services/state.ts'), 'utf8');

  it('getCdsEnvVars 真的把凭据派生接了进去', () => {
    expect(stateSource).toContain('deriveInfraCredentialEnv');
  });

  it('派生用的是服务自己的 env 与消费方实际连的地址', () => {
    const squashed = stateSource.split(/\s+/).join(' ');
    expect(squashed).toContain('deriveInfraCredentialEnv(svc.id, resolvedSvcEnv, { host: dockerHost, port: svc.hostPort })');
  });

  it('传进去的 env 先过了模板解析，而不是存储里的生值', () => {
    // 容器启动、数据工作台、数据操作三处都是先 resolveEnvTemplates 再用；
    // 这一处漏了就会把 `${CDS_MYSQL_PASSWORD}` 当成真口令发给消费方。
    const squashed = stateSource.split(/\s+/).join(' ');
    expect(squashed).toContain('const resolvedSvcEnv = resolveEnvTemplates( svc.env || {}, this.getCustomEnv(svc.projectId || \'default\'), )');
  });
});
