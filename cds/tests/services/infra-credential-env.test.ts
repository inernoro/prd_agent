import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cdsEnvPrefix,
  credentialSourceKeys,
  deriveInfraCredentialEnv,
  knownCredentialEnvKeys,
  describeCredentialSources,
} from '../../src/services/infra-credential-env.js';
import { INFRA_CATALOG } from '../../src/services/infra-catalog.js';
import { assertInfraAuthenticationConfigured } from '../../src/services/infra-auth-policy.js';
import { detectInfraAuth } from '../../src/services/infra-exposure-audit.js';

/**
 * 消费方容器的连接凭据。
 *
 * 这组用例钉的是 2026-08-27 那次事故的判据：数据服务开了认证，而 CDS 只往容器发
 * 地址不发凭据，于是**每一个新建的容器启动即崩**（`NOAUTH`）。已经在跑的容器
 * 不受影响，所以面板上看着还有一半分支是好的——这正是它难被发现的原因。
 */
describe('从基础设施服务派生连接凭据', () => {
  const at = { host: '172.17.0.1', port: 10002 };
  // redis 必须由启动参数证明服务端真的在校验口令，所以它的用例都要带上这个。
  const redisAuthOn = { command: ['redis-server', '--aclfile', '/etc/redis/users.acl'] };

  it('redis 的 ACL 用户与口令都要发出来', () => {
    const out = deriveInfraCredentialEnv('redis', {
      REDIS_USERNAME: 'app',
      REDIS_PASSWORD: 'p4ss',
    }, at, redisAuthOn);
    expect(out.CDS_REDIS_USER).toBe('app');
    expect(out.CDS_REDIS_PASSWORD).toBe('p4ss');
    expect(out.CDS_REDIS_URL).toBe('redis://app:p4ss@172.17.0.1:10002');
  });

  it('只设了口令没有用户名时不发空的 USER', () => {
    // 发一个空字符串比不发更坏：消费方会以为「配好了，用户名就是空」。
    const out = deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'p4ss' }, at, redisAuthOn);
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
    expect(deriveInfraCredentialEnv('redis', {}, at, redisAuthOn)).toEqual({});
    expect(deriveInfraCredentialEnv('redis', undefined, at, redisAuthOn)).toEqual({});
    expect(deriveInfraCredentialEnv('redis', { REDIS_USERNAME: 'app' }, at, redisAuthOn)).toEqual({});
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
    const out = deriveInfraCredentialEnv('redis-mdimp', { REDIS_PASSWORD: 'x' }, at, redisAuthOn);
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

  it('凭据表认的键名与 infra-catalog 预设真实产出的一致（不是照记忆写的）', () => {
    // 形状 3：同一件事在两处各写一份，然后各自漂。memcached 就漂过——预设写的是
    // MEMCACHED_USER，这张表照别处常见的写法写成了 MEMCACHED_USERNAME，结果只发
    // 口令不发用户名，正好是「半套凭据」。
    //
    // 判据要点：**真跑一遍预设的 build()**，用它的实际输出对照这张表，而不是扫
    // 源码字面量——扫字面量在「改了预设、忘了改表」时照样绿。预设清单也不硬编码，
    // 直接遍历整个 catalog，新加带认证的预设自动进守卫。
    // 方向很关键：**从预设的产出反查**，不能从表里的键名出发。
    // 「表里的 userKey 在预设 env 里存在时才断言」是反的——键名漂了那个条件正好
    // 不成立，于是漂了守卫照样绿（第一版就是这么写的，用 mysql 试破，它没报）。
    const sources = credentialSourceKeys();
    const passwordKeys = new Set(sources.map((s) => s.passwordKey));
    let checked = 0;
    for (const entry of INFRA_CATALOG) {
      const secrets: Record<string, string> = {};
      for (const k of entry.secretKeys || []) secrets[k] = `fake-${k}`;
      const built = entry.build(secrets).env || {};
      const matched = sources.find((s) => built[s.passwordKey]);
      if (!matched) continue;

      // 预设自己的启动命令一起送进去：redis 这类服务要由它证明服务端真在校验口令。
      const out = deriveInfraCredentialEnv(entry.id, built, at, {
        command: entry.command, entrypoint: entry.entrypoint,
      });
      const prefix = cdsEnvPrefix(entry.id);
      expect(out, `预设 ${entry.id} 有 ${matched.passwordKey} 却没派生出口令`)
        .toHaveProperty(`CDS_${prefix}_PASSWORD`);

      // 预设自己声明了用户名（任何 *_USER / *_USERNAME 键），就必须一起发出去。
      // 这里不看表认哪个键——正因为表可能认错，才要拿预设的实际产出来判。
      const userishKeys = Object.keys(built).filter(
        (k) => /_(USER|USERNAME)$/.test(k) && !passwordKeys.has(k) && built[k],
      );
      if (userishKeys.length > 0) {
        expect(
          out,
          `预设 ${entry.id} 声明了 ${userishKeys.join(' / ')}，凭据表却没认出来，只发了口令（半套凭据）`,
        ).toHaveProperty(`CDS_${prefix}_USER`);
      }
      checked += 1;
    }
    // 一个都没对上 = 守卫在空跑（catalog 改了形状、或者表和预设完全脱节）。
    expect(checked, 'catalog 里没有任何预设命中凭据表，这条守卫在空跑').toBeGreaterThan(0);
  });

  it('只设了 root 口令的 mysql 也要发得出凭据（门禁明确接受这种）', () => {
    // 线上真有一台这样的库：只有 MYSQL_ROOT_PASSWORD，没有业务账号。
    // 门禁放行、服务真开着认证、而消费方一个键都收不到——最难查的一种状态。
    const out = deriveInfraCredentialEnv('mysql', {
      MYSQL_DATABASE: 'app', MYSQL_ROOT_PASSWORD: 'rp',
    }, at);
    expect(out.CDS_MYSQL_USER).toBe('root');
    expect(out.CDS_MYSQL_PASSWORD).toBe('rp');
  });

  it('业务账号与 root 口令同在时发业务账号，且不跨账号拼', () => {
    // 拆成「用户名候选表 + 口令候选表」各取第一个命中的，就会拼出
    // 「业务用户名 + root 口令」这种根本不存在的账号。
    const out = deriveInfraCredentialEnv('mysql', {
      MYSQL_USER: 'app', MYSQL_PASSWORD: 'ap', MYSQL_ROOT_PASSWORD: 'rp',
    }, at);
    expect(out.CDS_MYSQL_USER).toBe('app');
    expect(out.CDS_MYSQL_PASSWORD).toBe('ap');
    // 只设了业务用户名却没有业务口令时，退到 root 账号——用户名也要跟着换成 root。
    const fallback = deriveInfraCredentialEnv('mysql', {
      MYSQL_USER: 'app', MYSQL_ROOT_PASSWORD: 'rp',
    }, at);
    expect(fallback.CDS_MYSQL_USER).toBe('root');
    expect(fallback.CDS_MYSQL_PASSWORD).toBe('rp');
  });

  it('用户名可以省的服务用镜像默认名，不发空用户名', () => {
    expect(deriveInfraCredentialEnv('postgres', { POSTGRES_PASSWORD: 'p' }, at).CDS_POSTGRES_USER)
      .toBe('postgres');
    expect(deriveInfraCredentialEnv('mssql', { MSSQL_SA_PASSWORD: 'p' }, at).CDS_MSSQL_USER)
      .toBe('sa');
    expect(deriveInfraCredentialEnv('es', { ELASTIC_PASSWORD: 'p' }, at).CDS_ES_USER)
      .toBe('elastic');
    expect(deriveInfraCredentialEnv('ch', { CLICKHOUSE_PASSWORD: 'p' }, at).CDS_CH_USER)
      .toBe('default');
    // redis 只设口令时是**真的没有用户名**，不该凭空补一个。
    expect(deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'p' }, at, redisAuthOn))
      .not.toHaveProperty('CDS_REDIS_USER');
  });

  it('门禁认可的别名也要认（mongo / minio / mariadb / pg 的第二套键名）', () => {
    expect(deriveInfraCredentialEnv('mongodb', {
      MONGO_USERNAME: 'u', MONGO_PASSWORD: 'p',
    }, at).CDS_MONGODB_USER).toBe('u');
    expect(deriveInfraCredentialEnv('minio', {
      MINIO_ACCESS_KEY: 'ak', MINIO_SECRET_KEY: 'sk',
    }, at).CDS_MINIO_USER).toBe('ak');
    expect(deriveInfraCredentialEnv('maria', {
      MARIADB_USER: 'u', MARIADB_PASSWORD: 'p',
    }, at).CDS_MARIA_PASSWORD).toBe('p');
    expect(deriveInfraCredentialEnv('pg', { PGPASSWORD: 'p' }, at).CDS_PG_PASSWORD).toBe('p');
  });

  it('残缺的账号候选要跳过去试下一个，不能发出没有用户名的连接串', () => {
    // 只看口令选候选会中这个陷阱：有 MYSQL_PASSWORD 没有 MYSQL_USER 时选中业务账号，
    // 发出 `mysql://:口令@主机`——没有用户名，而旁边完整的 root 候选永远轮不到。
    const out = deriveInfraCredentialEnv('mysql', {
      MYSQL_PASSWORD: 'ap', MYSQL_ROOT_PASSWORD: 'rp',
    }, at);
    expect(out.CDS_MYSQL_USER).toBe('root');
    expect(out.CDS_MYSQL_PASSWORD).toBe('rp');
    expect(out.CDS_MYSQL_URL).toBe('mysql://root:rp@172.17.0.1:10002');
  });

  it('用户名是没展开的模板时作废该候选，但不放弃整类服务', () => {
    // 此前这里是 `continue` 掉整个服务类，于是 root 兜底候选根本轮不到——
    // 一台门禁认可的库就这么一个键都发不出去。
    const out = deriveInfraCredentialEnv('mysql', {
      MYSQL_USER: '${CDS_MYSQL_USER}', MYSQL_PASSWORD: 'ap', MYSQL_ROOT_PASSWORD: 'rp',
    }, at);
    expect(out.CDS_MYSQL_USER).toBe('root');
    expect(out.CDS_MYSQL_PASSWORD).toBe('rp');
  });

  it('声明了用户名却是占位符时，不许退到 defaultUser', () => {
    // 写了 POSTGRES_USER 就说明本意不是用默认超级用户；解析不出来时退到
    // `postgres` 等于悄悄换了个账号连库，比报错更难查。
    expect(deriveInfraCredentialEnv('postgres', {
      POSTGRES_USER: '${CDS_PG_USER}', POSTGRES_PASSWORD: 'p',
    }, at)).toEqual({});
  });

  it('redis 的口令要由启动参数证明服务端真在校验，证不了就一个键都不发', () => {
    // env 里放着 REDIS_PASSWORD、启动命令却既没 --requirepass 也没 --aclfile 的库
    // 是真实存在的。这种库不校验口令，消费方带着口令连过去会被
    // 「ERR Client sent AUTH, but no password is set」顶回来——发凭据反而把本来
    // 能裸连的消费方弄坏。与认证门禁同一口径。
    const noProof = { command: ['redis-server', '--appendonly', 'yes'] };
    expect(deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'p' }, at, noProof)).toEqual({});
    // 完全拿不到启动参数时同样不发：不能证明就不发。
    expect(deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'p' }, at)).toEqual({});
    // 两种真认证都要认，写在 entrypoint 里也算。
    expect(deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'p' }, at, {
      command: 'redis-server --requirepass p',
    }).CDS_REDIS_PASSWORD).toBe('p');
    expect(deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'p' }, at, {
      entrypoint: ['redis-server', '--aclfile', '/etc/redis/users.acl'],
    }).CDS_REDIS_PASSWORD).toBe('p');
    // 判据不许恒真：名字里带 aclfile 字样但没真开的不算。
    expect(deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'p' }, at, {
      command: 'redis-server --dir /var/lib/aclfile-backup',
    })).toEqual({});
  });

  /**
   * 口令**只写在启动参数里**的服务（台账 E78）。
   *
   * 认证门禁接受 `redis-server --requirepass <口令>`（它就是靠这个判「配了认证」的），
   * 而凭据派生上一版只读 env。两边合起来是最坏的一种状态：门禁放行、服务真的开着
   * 认证、消费方一个键都收不到——正是本模块要消灭的那个形状，却在自己身上又犯一次。
   */
  it('口令只写在启动参数上时也要派生得出来', () => {
    const out = deriveInfraCredentialEnv('redis', {}, at, {
      command: ['redis-server', '--requirepass', 'p4ss'],
    });
    expect(out.CDS_REDIS_PASSWORD).toBe('p4ss');
    expect(out.CDS_REDIS_URL).toBe('redis://:p4ss@172.17.0.1:10002');
    // 写成 `--requirepass=口令` 的等价形态同样要认（形状 1：换个写法就漏）。
    expect(deriveInfraCredentialEnv('redis', {}, at, {
      command: ['sh', '-c', 'exec redis-server --requirepass=p4ss'],
    }).CDS_REDIS_PASSWORD).toBe('p4ss');
  });

  /**
   * 命令行取值必须**逐字**保留大小写。
   *
   * 认证判据为了匹配开关名把 token 全转成了小写，取值若复用那份小写 token，
   * 派生出来的就是一个大小写被抹平的口令——它长得像凭据、也确实发出去了，
   * 消费方拿去认证必然失败，而错误只会说「认证失败」。
   * CDS 自己生成的口令是十六进制小写，正好不会暴露这个 bug（形状 6）。
   */
  it('命令行上的口令要逐字保留大小写', () => {
    const out = deriveInfraCredentialEnv('redis', {}, at, {
      command: ['redis-server', '--requirepass', 'AbC-XyZ-123'],
    });
    expect(out.CDS_REDIS_PASSWORD).toBe('AbC-XyZ-123');
  });

  /** env 更可信：命令行上的值可能是待 shell 展开的形态，只当兜底。 */
  it('env 与命令行都有口令时以 env 为准', () => {
    const out = deriveInfraCredentialEnv('redis', { REDIS_PASSWORD: 'from-env' }, at, {
      command: ['redis-server', '--requirepass', 'from-args'],
    });
    expect(out.CDS_REDIS_PASSWORD).toBe('from-env');
  });

  /**
   * nats 的两条真实形态都要覆盖（台账 E82）。
   *
   * 手工建的 nats 常把账号口令直接写在 `--user` / `--pass` 上；CDS 预设走的是另一条路
   * （在容器里写配置文件、不让明文进 argv），那种情况命令行上取不到，只能靠 env。
   * 只覆盖一条就会有一类 nats 连不上。
   */
  it('nats 的账号口令在命令行上或在 env 里都要认', () => {
    const fromArgs = deriveInfraCredentialEnv('nats', {}, at, {
      command: ['nats-server', '--user', 'app', '--pass', 'p4ss'],
    });
    expect(fromArgs.CDS_NATS_USER).toBe('app');
    expect(fromArgs.CDS_NATS_PASSWORD).toBe('p4ss');
    expect(fromArgs.CDS_NATS_URL).toBe('nats://app:p4ss@172.17.0.1:10002');

    const fromEnv = deriveInfraCredentialEnv('nats', {
      NATS_USER: 'app', NATS_PASSWORD: 'p4ss',
    }, at, { command: ['nats-server', '--config', '/etc/nats/nats.conf'], });
    // 走配置文件那条路时，命令行上没有认证开关，判据看不出「服务端在校验」，
    // 于是一个键都不发——不能证明就不发，与 redis 同一口径。
    expect(fromEnv).toEqual({});
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
describe('与认证门禁对齐', () => {
  /**
   * 门禁说「这台库配了认证」，凭据派生就必须能把那对凭据发出去。做不到就是最难查的
   * 一种状态：门禁放行、服务真开着认证、消费方一个键都收不到，分支照样连不上库。
   * 线上真中过（只有 MYSQL_ROOT_PASSWORD 的那台 mysql）。
   *
   * 两处键名各写一份必然漂（形状 3）。理想解是抽一份共享的键名表，两边都读它；
   * 那要动认证门禁本身，而门禁是安全件、这个 PR 已冻结，所以先用守卫钉住：
   * 扫门禁源码里 `hasValue(env, ...)` 认的键，逐个断言本表也认。
   * 往门禁加别名却忘了加到这里，这条会红。欠的那次收敛记在 doc/debt.cds.md。
   */
  const policySource = readFileSync(join(process.cwd(), 'src/services/infra-auth-policy.ts'), 'utf8');

  it('门禁 hasValue 认的每个 env 键，凭据表都认得出来', () => {
    const known = knownCredentialEnvKeys();
    const calls = [...policySource.matchAll(/hasValue\(\s*env\s*,([^)]*)\)/g)];
    // 判据自己不能空跑：门禁改了写法（比如不再用 hasValue）就该红，而不是静默通过。
    expect(calls.length, '门禁源码里一个 hasValue(env, ...) 都没扫到，这条守卫在空跑')
      .toBeGreaterThan(3);

    const missing: string[] = [];
    for (const call of calls) {
      for (const m of call[1].matchAll(/'([A-Za-z0-9_.]+)'/g)) {
        const key = m[1];
        // 带点的是 elasticsearch 那种 yaml 式开关（xpack.security.enabled），不是凭据键。
        if (key.includes('.')) continue;
        if (!known.has(key)) missing.push(key);
      }
    }
    expect(
      [...new Set(missing)],
      '门禁认这些键算「配了认证」，凭据表却认不出来 —— 这些库会门禁放行但消费方收不到凭据',
    ).toEqual([]);
  });

  /**
   * 同一台库，三处判据必须给同一个结论（台账 E81）。
   *
   * 这三处问的是同一件事「这台库在校验凭据吗」，却各写了一份实现：
   *
   * - `assertInfraAuthenticationConfigured`：建服务时拦不拦。
   * - `detectInfraAuth`：每日体检报不报「裸奔」。
   * - `deriveInfraCredentialEnv`：发不发凭据给消费方。
   *
   * 2026-08-27 它们真的分叉过：env 里有 `REDIS_PASSWORD`、启动命令没开认证的 redis，
   * 门禁判「拒绝创建」，体检判「已认证」（于是压掉裸奔告警），凭据派生判「不发」。
   * 一台库同时被判成三种状态，三条结论各自都有注释解释为什么自己是对的。
   *
   * 收敛之后只剩一份实现（后两者委派给 `detectInfraAuth`），这条守卫钉住它别再分家。
   */
  it('创建门禁 / 运行态体检 / 凭据派生，对同一台库结论一致', () => {
    const at = { host: '172.17.0.1', port: 10002 };
    const cases: { why: string; env: Record<string, string>; command?: string[]; authed: boolean }[] = [
      {
        why: 'env 有口令但启动没开认证 —— 就是分叉过的那一台',
        env: { REDIS_PASSWORD: 'p4ss' },
        command: ['redis-server', '--appendonly', 'yes'],
        authed: false,
      },
      { why: '什么都没配', env: {}, command: ['redis-server'], authed: false },
      {
        why: '口令只写在启动参数上',
        env: {},
        command: ['redis-server', '--requirepass', 'p4ss'],
        authed: true,
      },
      {
        why: 'ACL 文件 + env 口令',
        env: { REDIS_PASSWORD: 'p4ss' },
        command: ['redis-server', '--aclfile', '/etc/redis/users.acl'],
        authed: true,
      },
    ];

    for (const c of cases) {
      const gatePassed = (() => {
        try {
          assertInfraAuthenticationConfigured({
            dockerImage: 'redis:7', env: c.env, command: c.command,
          });
          return true;
        } catch {
          return false;
        }
      })();
      const audited = detectInfraAuth('redis', c.env, c.command) === true;
      const derived = Object.keys(
        deriveInfraCredentialEnv('redis', c.env, at, { command: c.command }),
      ).length > 0;

      expect({ gate: gatePassed, audit: audited }, `${c.why}：门禁与体检不一致`)
        .toEqual({ gate: c.authed, audit: c.authed });
      // 凭据派生只在「真的在校验」时才发键。它可能因为别的原因不发（比如根本没口令），
      // 所以只单向断言：判成裸奔时**一定**不发。
      if (!c.authed) {
        expect(derived, `${c.why}：判成没认证却还发了凭据`).toBe(false);
      }
    }
  });
});

describe('接线', () => {
  const stateSource = readFileSync(join(process.cwd(), 'src/services/state.ts'), 'utf8');

  it('getCdsEnvVars 真的把凭据派生接了进去', () => {
    expect(stateSource).toContain('deriveInfraCredentialEnv');
  });

  it('派生用的是服务自己的 env 与消费方实际连的地址', () => {
    const squashed = stateSource.split(/\s+/).join(' ');
    expect(squashed).toContain('deriveInfraCredentialEnv( svc.id, resolvedSvcEnv, { host: dockerHost, port: svc.hostPort },');
  });

  it('启动参数也送了进去，并且同样先解析过模板', () => {
    // 少了这一段，redis 就永远证明不了「服务端在校验口令」，凭据一个都发不出去；
    // 而不解析模板的话，`--requirepass ${CDS_REDIS_PASSWORD}` 这种写法虽然能命中
    // 判据、但拿到的是没展开的原文，下次改判据就会踩空。
    const squashed = stateSource.split(/\s+/).join(' ');
    expect(squashed).toContain('command: resolveCommandTemplate(svc.command, svcCustomEnv),');
    expect(squashed).toContain('entrypoint: resolveCommandTemplate(svc.entrypoint, svcCustomEnv),');
  });

  it('传进去的 env 先过了模板解析，而不是存储里的生值', () => {
    // 容器启动、数据工作台、数据操作三处都是先 resolveEnvTemplates 再用；
    // 这一处漏了就会把 `${CDS_MYSQL_PASSWORD}` 当成真口令发给消费方。
    const squashed = stateSource.split(/\s+/).join(' ');
    expect(squashed).toContain('const resolvedSvcEnv = resolveEnvTemplates( svc.env || {}, this.getCustomEnv(svc.projectId || \'default\'), )');
  });
});
