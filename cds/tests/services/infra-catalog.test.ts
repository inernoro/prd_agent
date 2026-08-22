import { describe, it, expect } from 'vitest';
import {
  INFRA_CATALOG,
  getInfraCatalogEntry,
  infraCatalogIds,
  recommendedVolumePathsFromCatalog,
  getInfraCatalogPublic,
} from '../../src/services/infra-catalog.js';
import { detectInfraAuth } from '../../src/services/infra-exposure-audit.js';

/**
 * Infra catalog SSOT tests.
 *
 * Guards two things:
 *   1. Backward compatibility — the historical 5 presets (mongodb/postgres/mysql/
 *      redis/rabbitmq) must produce byte-identical env + connection strings, so
 *      existing projects keep working after the registry refactor.
 *   2. The catalog is the single source of truth — new infra (kafka/nats/...) is
 *      reachable, and the public view never leaks secrets.
 *
 * See doc/spec.cds.compose-contract.md and cds/src/routes/projects.ts createInfraPreset.
 */

describe('infra-catalog SSOT', () => {
  it('has unique ids and includes the historical presets plus the new message queues', () => {
    const ids = infraCatalogIds();
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    for (const required of ['mongodb', 'postgres', 'mysql', 'redis', 'rabbitmq', 'kafka', 'nats']) {
      expect(ids).toContain(required);
    }
  });

  it('every entry builds at least one app-visible connection env var', () => {
    for (const entry of INFRA_CATALOG) {
      const secrets: Record<string, string> = {};
      for (const k of entry.secretKeys || []) secrets[k] = 'SEKRET';
      const built = entry.build(secrets);
      expect(Object.keys(built.envVars || {}).length).toBeGreaterThan(0);
    }
  });

  it('reproduces the legacy postgres preset exactly', () => {
    const pg = getInfraCatalogEntry('postgres');
    expect(pg).toBeDefined();
    const built = pg!.build({ password: 'pw123' });
    expect(pg!.dockerImage).toBe('postgres:16-alpine');
    expect(pg!.containerPort).toBe(5432);
    expect(built.env).toEqual({ POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw123', POSTGRES_DB: 'app' });
    expect(built.envVars).toEqual({
      DATABASE_URL: 'postgresql://app:pw123@postgres:5432/app',
      POSTGRES_URL: 'postgresql://app:pw123@postgres:5432/app',
    });
  });

  it('reproduces the legacy rabbitmq preset (image + url + volume path)', () => {
    const rmq = getInfraCatalogEntry('rabbitmq');
    expect(rmq!.dockerImage).toBe('rabbitmq:3-management-alpine');
    const built = rmq!.build({ password: 'secret9' });
    expect(built.env).toEqual({ RABBITMQ_DEFAULT_USER: 'app', RABBITMQ_DEFAULT_PASS: 'secret9' });
    expect(built.envVars).toEqual({ RABBITMQ_URL: 'amqp://app:secret9@rabbitmq:5672' });
    expect(recommendedVolumePathsFromCatalog('rabbitmq:3-management-alpine')).toEqual(['/var/lib/rabbitmq']);
  });

  /**
   * 这条原来叫「redis preset stays password-free (legacy behaviour)」，逐字要求
   * redis 建出来**没有口令**——它把一个真实漏洞锁成了契约：谁给 redis 补认证，
   * 谁的 CI 先红。而公网暴露一旦发生，一个没有 requirepass 的 redis 就是裸奔。
   *
   * 现在反过来断言：redis 必须带口令，且口令**不许出现在启动命令行里**
   * （那会散进宿主 ps、CDS 记录的 docker run 字符串和容器事件日志）。
   */
  it('redis 预设带口令，且口令只走 env 不进命令行', () => {
    const entry = getInfraCatalogEntry('redis')!;
    expect(entry.secretKeys).toEqual(['password']);

    const built = entry.build({ password: 'p4ssw0rd' });
    expect(built.env).toEqual({ REDIS_PASSWORD: 'p4ssw0rd' });
    expect(built.envVars).toEqual({ REDIS_URL: 'redis://:p4ssw0rd@redis:6379' });

    // 启动命令必须是数组形态（每个 token 单独 shell-quote），且只引用变量名。
    const cmd = entry.command as string[];
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd.join(' ')).toContain('--requirepass "$REDIS_PASSWORD"');
    expect(cmd.join(' ')).not.toContain('p4ssw0rd');
    // 必须经过镜像自己的 entrypoint：它只在第一个参数是 redis-server 时才修
    // /data 属主并降权到 redis 用户。直接 `sh -c 'exec redis-server …'` 会让
    // entrypoint 走兜底分支，redis 以 root 起（Codex P1，2026-08-17）。
    // 注意这里只能证明「命令写对了」——**进程真以谁的身份跑**由
    // redis-preset-privilege.docker.test.ts 用真容器判。
    expect(cmd.join(' ')).toContain('docker-entrypoint.sh redis-server');
    // `${VAR}` 会被 CDS 的模板替换吃掉（宿主侧没有这个变量 → 展开成空 →
    // redis 拿到空口令 FATAL 无限重启，2026-05-29 真出过）。必须是不带花括号的 $VAR。
    expect(cmd.join(' ')).not.toContain('${REDIS_PASSWORD}');
  });

  it('kafka uses KRaft (no zookeeper) and advertises itself as kafka:9092', () => {
    const kafka = getInfraCatalogEntry('kafka')!;
    expect(kafka.category).toBe('queue');
    const built = kafka.build({});
    expect(built.env?.KAFKA_PROCESS_ROLES).toContain('controller');
    expect(built.env?.KAFKA_ADVERTISED_LISTENERS).toContain('kafka:9092');
    expect(built.envVars?.KAFKA_BROKERS).toBe('kafka:9092');
  });

  it('sqlserver password satisfies complexity policy (3 of 4 classes)', () => {
    const built = getInfraCatalogEntry('sqlserver')!.build({ saPassword: 'abc123def' });
    expect(built.env?.MSSQL_SA_PASSWORD).toBe('abc123defAa1_');
    expect(built.envVars?.SQLSERVER_URL).toContain('abc123defAa1_');
  });

  it('volume heuristic still covers custom images not in the catalog', () => {
    expect(recommendedVolumePathsFromCatalog('bitnami/postgresql:15')).toEqual(['/var/lib/postgresql/data']);
    expect(recommendedVolumePathsFromCatalog('mariadb:11')).toEqual(['/var/lib/mysql']);
    expect(recommendedVolumePathsFromCatalog('nginx:alpine')).toBeNull();
  });

  it('public catalog view exposes connection key NAMES but never secret values', () => {
    const pub = getInfraCatalogPublic();
    const pg = pub.find((p) => p.id === 'postgres')!;
    expect(pg.connectionEnvKeys).toContain('DATABASE_URL');
    expect(pg.categoryLabel).toBe('数据库');
    expect(pg.hasPersistence).toBe(true);
    // The serialized public view must not contain any built secret VALUE.
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain('postgresql://'); // no connection-string values
    // 断言的是「秘密的值不许出现」，不是「字面量 password 不许出现」——
    // 后者把 `MEMCACHED_PASSWORD` 这种**键名**也一并禁掉了，而键名正是这个视图
    // 存在的理由（`S3_SECRET_KEY` 一直都在里面）。判据换成哨兵值：拿一个不会
    // 自然出现的串当密钥去 build 每个预设，它一旦漏进公共视图就红。
    const SENTINEL = 'zzsentinelsecretzz';
    for (const entry of INFRA_CATALOG) {
      const secrets = Object.fromEntries((entry.secretKeys || []).map((k) => [k, SENTINEL]));
      const built = entry.build(secrets);
      // 先自证哨兵确实进了 build 的产物，否则下面那条断言可能是恒真的空转。
      if ((entry.secretKeys || []).length > 0) {
        expect(JSON.stringify(built), `${entry.id} 的 build 没有用到生成的密钥`).toContain(SENTINEL);
      }
    }
    expect(serialized).not.toContain(SENTINEL);
  });
});

/**
 * 接线守卫：catalog 补的认证，必须真的被**暴露审计**认出来。
 *
 * 这两个模块各自看着都对，却可能对不上：catalog 生成 `REDIS_PASSWORD`，而审计
 * 若只认 `REDIS_PASS`，公网上的库照样被报成「无认证 critical」——补了认证的库
 * 继续刷红，真裸奔的那些反而淹没在里面。反过来更糟：审计认了、catalog 其实没给，
 * 一个裸奔库被标成「已配置认证」。所以判据只能是「拿 catalog 真的建出来的东西
 * 去喂审计」，不能两边各自断言自己那一半。
 */
describe('catalog 的认证能被暴露审计认出来', () => {
  it('redis：建出来的 env + 启动命令都判为已认证', () => {
    const entry = getInfraCatalogEntry('redis')!;
    const built = entry.build({ password: 'hex0123456789' });
    const cmd = entry.command as string[];

    // env 这一路（数据面板、备份探测走的也是它）
    expect(detectInfraAuth('redis', built.env, [])).toBe(true);
    // 容器的真实形状：env 有值 + Cmd 里引用它。`sh -c` 把整条语句塞进一个 Cmd
    // 元素，审计必须自己再拆一层才比得中 --requirepass。
    expect(detectInfraAuth('redis', built.env, cmd)).toBe(true);
    // 引用了一个没有值的变量 = redis 拿到空口令（会 FATAL），不许判成已认证
    expect(detectInfraAuth('redis', {}, cmd)).toBe(false);
    // 直接写明文的 compose 配法照样认
    expect(detectInfraAuth('redis', {}, ['sh', '-c', 'redis-server --requirepass hunter2'])).toBe(true);
    // 空口令不算认证
    expect(detectInfraAuth('redis', {}, ['sh', '-c', 'redis-server --requirepass ""'])).toBe(false);
    // 两路都没有才该判裸奔——对照组，防止判据恒真
    expect(detectInfraAuth('redis', {}, [])).toBe(false);
  });

  it('memcached / kafka / nats：建出来的东西也判为已认证', () => {
    // 这三个原来一个都没有认证（catalog 无 secretKeys，连接串是裸的），
    // 审计那边则硬编码 `return false`。两侧同批补齐之后，判据必须真的对得上：
    // 拿 catalog 真建出来的 env + 启动命令去喂审计，不许两边各自断言自己那一半。
    for (const id of ['memcached', 'kafka', 'nats']) {
      const entry = getInfraCatalogEntry(id)!;
      expect(entry.secretKeys?.length, `${id} 没有要生成的密钥`).toBeGreaterThan(0);
      const built = entry.build({ password: 'hex0123456789' });
      const cmd = [
        ...(Array.isArray(entry.entrypoint) ? entry.entrypoint : entry.entrypoint ? [entry.entrypoint] : []),
        ...(Array.isArray(entry.command) ? entry.command : entry.command ? [entry.command] : []),
      ];
      expect(detectInfraAuth(id, built.env, cmd), `${id} 建出来却判成无认证`).toBe(true);
    }
  });

  it('kafka：监听器名字骗不过判据，看的是映射解析出的生效协议', () => {
    // 名字是部署方随便取的。旧判据看「广播地址是不是 PLAINTEXT:// 开头」，
    // 于是把监听器改名叫 CLIENT、协议仍是明文，就能骗过它——读的是名字，
    // 不是生效的那个值（形状 6）。
    expect(detectInfraAuth('kafka', {
      KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
      KAFKA_ADVERTISED_LISTENERS: 'CLIENT://kafka:9092',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CLIENT:PLAINTEXT',
    }, []), '名字叫 CLIENT、协议是明文，居然判成已认证').toBe(false);

    // 反过来：名字叫 CLIENT 但映射到 SASL_PLAINTEXT，就是真的认证。
    expect(detectInfraAuth('kafka', {
      KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
      KAFKA_ADVERTISED_LISTENERS: 'CLIENT://kafka:9092',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,CLIENT:SASL_PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    }, [])).toBe(true);

    // SSL 只加密不认证，同样不算。
    expect(detectInfraAuth('kafka', {
      KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
      KAFKA_ADVERTISED_LISTENERS: 'CLIENT://kafka:9092',
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CLIENT:SSL',
    }, [])).toBe(false);
  });

  it('kafka 监听器名不许带下划线——镜像表达不出来，容器会起不来', () => {
    // 2026-08-21 真容器实测：监听器名写成 SASL_PLAINTEXT 时，JAAS 那条 env 只能叫
    // KAFKA_LISTENER_NAME_SASL_PLAINTEXT_..._SASL_JAAS_CONFIG，而镜像把下划线**全部**
    // 转成点，得到的属性名少了监听器名里那个下划线 → configure 脚本
    // `!1: unbound variable` 直接退出。这条守的是「名字里别再出现下划线」。
    const env = getInfraCatalogEntry('kafka')!.build({ password: 'hex0123456789' }).env || {};
    const names = new Set<string>();
    for (const key of ['KAFKA_LISTENERS', 'KAFKA_ADVERTISED_LISTENERS'] as const) {
      for (const entry of String(env[key] || '').split(',')) {
        const name = entry.split('://')[0]?.trim();
        if (name) names.add(name);
      }
    }
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(name, `监听器名 ${name} 带下划线，镜像的 env→属性转换表达不出来`).not.toContain('_');
    }
  });

  it('nats 口令不许出现在会变成 argv 的位置', () => {
    // 2026-08-21 真容器实测：`sh -c 'exec nats-server --pass "$NATS_PASSWORD"'` 只挡住了
    // 宿主那一侧，exec 之后展开的明文就是容器 argv，/proc/1/cmdline 一读就有。
    // redis 同样写法没事是因为它自己改写 argv（E34），那是特例不是通则。
    const entry = getInfraCatalogEntry('nats')!;
    const cmd = (Array.isArray(entry.command) ? entry.command : [entry.command || '']).join(' ');
    // exec 出去的那一段里不许引用口令变量。
    const execPart = cmd.slice(cmd.indexOf('exec'));
    expect(execPart, 'exec 的参数里引用了口令变量，展开后就是容器 argv')
      .not.toContain('NATS_PASSWORD');
    // 口令要落到容器内的配置文件里，并且那份文件只有本进程读得到。
    expect(cmd).toContain('authorization');
    expect(cmd).toContain('chmod 600');
  });

  it('对照组：把认证配置拿掉就必须判成裸奔（防判据恒真）', () => {
    // 上一条如果判据恒真，它照样全绿。这里逐个把生效的那一处拿掉。
    expect(detectInfraAuth('memcached', {}, ['sh', '-c', 'exec docker-entrypoint.sh memcached']))
      .toBe(false);
    // kafka：SASL 机制开着，但**自我广播地址**还是明文——客户端拿到的重定向
    // 指向明文协议，等于没开。这一档必须判 false（形状 8）。
    expect(detectInfraAuth('kafka', {
      KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
      KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:9092',
    }, [])).toBe(false);
    expect(detectInfraAuth('kafka', { KAFKA_ADVERTISED_LISTENERS: 'SASL_PLAINTEXT://kafka:9092' }, []))
      .toBe(false);
    expect(detectInfraAuth('nats', {}, ['sh', '-c', 'exec /nats-server'])).toBe(false);
    // 引用了一个没有值的变量 = 空口令，不许判成已认证
    expect(detectInfraAuth('nats', {}, ['sh', '-c', 'exec /nats-server --user "$NATS_USER" --pass "$NATS_PASSWORD"']))
      .toBe(false);
    // 只加载一份配置文件不算数：文件里可以什么都没有。
    expect(detectInfraAuth('nats', {}, ['sh', '-c', 'exec /nats-server -c /tmp/x.conf'])).toBe(false);
    // 写了 authorization 块却没加载它，同样不算。
    expect(detectInfraAuth('nats', {}, ['sh', '-c', 'printf "authorization { user: a }" > /tmp/x.conf; exec /nats-server']))
      .toBe(false);
  });
});

/**
 * 认证判据的**结构化**收口（Codex #1382 第四轮 P1）。
 *
 * 上一轮是「遇到一种语法加一种」——先拆 `sh -c`，再补引号。第三次又来
 * `"$X";`（尾巴粘分隔符）时就该停手换判据了：与其穷举 shell 语法，不如认一条
 * 结构性规则——**证明不了这里有口令，就不算有**。这一组用例钉的是那条规则，
 * 不是某几种写法。
 */
describe('认证判据：证明不了就不算有', () => {
  const cmd = (s: string): string[] => ['sh', '-c', s];

  it('带 $ 的展开必须能解析出真值，否则一律判未认证', () => {
    // 尾巴粘着 shell 分隔符 / 运算符
    expect(detectInfraAuth('redis', {}, cmd('exec redis-server --requirepass "$REDIS_PASSWORD";'))).toBe(false);
    expect(detectInfraAuth('redis', {}, cmd('redis-server --requirepass "$REDIS_PASSWORD" && true'))).toBe(false);
    // 花括号形态、拼接形态：同样证明不了
    expect(detectInfraAuth('redis', {}, cmd('redis-server --requirepass "${REDIS_PASSWORD}"'))).toBe(false);
    expect(detectInfraAuth('redis', {}, cmd('redis-server --requirepass pre$SUFFIX'))).toBe(false);
  });

  it('变量真有值时才算已认证', () => {
    expect(detectInfraAuth('redis', { REDIS_PASSWORD: 'x' }, cmd('exec redis-server --requirepass "$REDIS_PASSWORD";'))).toBe(true);
    expect(detectInfraAuth('redis', {}, cmd('redis-server --requirepass hunter2'))).toBe(true);
  });

  /**
   * 反方向也不能误伤：单引号里 shell 不做展开，`'p$ss'` 是货真价实的密码。
   * 把它判成「没配」就是那种「说库没密码」的假警报，比不报警更糟。
   */
  it('单引号字面量含 $ 不算展开，仍判为已认证', () => {
    expect(detectInfraAuth('redis', {}, cmd("redis-server --requirepass 'p$ss'"))).toBe(true);
  });

  it('空口令与完全没配都判未认证', () => {
    expect(detectInfraAuth('redis', {}, cmd('redis-server --requirepass ""'))).toBe(false);
    expect(detectInfraAuth('redis', {}, cmd('redis-server'))).toBe(false);
  });
});
