/**
 * 把基础设施服务自己的账号口令，派生成消费方容器能用的连接凭据变量。
 *
 * ## 为什么需要这一层
 *
 * CDS 一直只往消费方容器注入 `CDS_HOST` / `CDS_<服务>_PORT` / `CDS_<服务>_HOST`
 * ——**只有地址，没有凭据**。数据服务没开认证时这够用；开了之后就不够了：
 * 应用连上去直接 `NOAUTH`，而 CDS 明明自己存着那对账号口令。
 *
 * 2026-08-27 真炸过：prd-agent 的 redis 改成 `--aclfile` 认证、mongo 改成
 * `--auth` 之后，**每一个新建的分支容器启动即崩**。已经在跑的容器没事——它们的
 * 连接建立在改动之前，于是面板上还有一半分支显示 running，把这件事盖住了。
 * 同一时刻 18 条分支里 5 条 error，全是这个原因。
 *
 * 期间还有人把 build profile 改成引用 `${CDS_REDIS_URL}` / `${CDS_MONGODB_URL}`
 * ——**这两个名字在 CDS 里一次都没定义过**。改完之后容器连地址都拿不到了
 * （模板解析不出来，键直接被丢掉），比改之前更糟。那是判据接了一半：
 * 消费侧写好了，生产侧根本没建（predicate-and-wiring-discipline 形状 2）。
 *
 * 本文件补的就是生产侧。
 *
 * ## 为什么按 env 键名认，而不是按服务 id 认
 *
 * 同一个项目可以有第二台同类型服务（`redis-2`、`mysql-mdimp`），id 会带后缀或
 * 完全自定义；而**镜像要求的 env 键名是固定的**（mongo 就是认
 * `MONGO_INITDB_ROOT_USERNAME`）。按键名认，改名、多实例都不影响。
 *
 * ## 派生出来的三个变量，各自什么时候用
 *
 * - `CDS_<服务>_USER` / `CDS_<服务>_PASSWORD`：原始值，不做任何转义。给那些
 *   连接串格式不是 URI 的客户端用（例如 StackExchange.Redis 要
 *   `host:port,user=U,password=P`），由消费方自己按它的格式拼。
 * - `CDS_<服务>_URL`：标准 URI，userinfo 段**已做百分号编码**。口令里带 `@`
 *   `:` `/` `?` `#` 时，不编码会让 URI 被解析成完全不同的主机——这正是同期
 *   review 在 nacos 登录表单上抓到的同一类错误，不能在这里再犯一次。
 *
 * ## 已知边界
 *
 * 原始 `USER` / `PASSWORD` 交给消费方自己拼时，转义责任也在消费方。口令里如果
 * 出现该格式的保留字符（StackExchange 的 `,` 与 `=`），拼出来的串会被解析歪。
 * CDS 生成的口令是十六进制，不会命中；用户手工改过口令的服务才有这个风险。
 * 记在 `doc/debt.cds.md`。
 */

/** 一类基础设施服务：账号口令在它自己容器 env 的哪两个键里，以及它的 URI scheme。 */
interface CredentialSource {
  /** 用户名所在的 env 键；留空表示这类服务没有用户名概念（例如只设口令的 redis）。 */
  userKey?: string;
  /** 口令所在的 env 键。 */
  passwordKey: string;
  /** 标准 URI 的 scheme；留空表示这类服务没有公认的 URI 形态，只发 USER/PASSWORD。 */
  scheme?: string;
  /** 给人看的说明，出现在测试与排障里。 */
  why: string;
}

/**
 * 键名来自各官方镜像的约定，不是拍脑袋起的。新增一类服务时照抄它镜像文档里
 * 的键名，并在 `why` 里写清出处。
 */
const CREDENTIAL_SOURCES: readonly CredentialSource[] = [
  {
    userKey: 'MONGO_INITDB_ROOT_USERNAME',
    passwordKey: 'MONGO_INITDB_ROOT_PASSWORD',
    scheme: 'mongodb',
    why: 'mongo 官方镜像的 root 账号；开了 --auth 之后连接串必须带它',
  },
  {
    // redis 有两种认证：只设口令（--requirepass）与 ACL 用户（--aclfile）。
    // 前者没有用户名，后者有；同一对键名覆盖两种，缺 username 时自然为空。
    userKey: 'REDIS_USERNAME',
    passwordKey: 'REDIS_PASSWORD',
    scheme: 'redis',
    why: 'redis 口令或 ACL 用户；ACL 模式下用户名不可省',
  },
  {
    userKey: 'MYSQL_USER',
    passwordKey: 'MYSQL_PASSWORD',
    scheme: 'mysql',
    why: 'mysql 官方镜像的业务账号（不是 root）',
  },
  {
    userKey: 'POSTGRES_USER',
    passwordKey: 'POSTGRES_PASSWORD',
    scheme: 'postgresql',
    why: 'postgres 官方镜像的超级用户',
  },
  {
    userKey: 'RABBITMQ_DEFAULT_USER',
    passwordKey: 'RABBITMQ_DEFAULT_PASS',
    scheme: 'amqp',
    why: 'rabbitmq 官方镜像的默认账号',
  },
  {
    userKey: 'MINIO_ROOT_USER',
    passwordKey: 'MINIO_ROOT_PASSWORD',
    why: 'minio 的 root 账号；S3 客户端不用 URI，只发 USER/PASSWORD',
  },
  {
    userKey: 'MEMCACHED_USERNAME',
    passwordKey: 'MEMCACHED_PASSWORD',
    why: 'memcached 的 SASL 账号；客户端各家格式不一，只发 USER/PASSWORD',
  },
];

/** `CDS_<这里>_PORT` 用的那段大写标识，与既有命名保持一致。 */
export function cdsEnvPrefix(serviceId: string): string {
  return serviceId.toUpperCase().replace(/-/g, '_');
}

/**
 * 从一个基础设施服务自己的 env，派生出消费方要用的凭据变量。
 *
 * @param serviceId 服务 id（决定变量名前缀）。
 * @param serviceEnv 该服务容器自己的 env（CDS 状态里存着）。
 * @param endpoint 消费方实际连过去的地址；URI 形态需要它。
 * @returns 要注入消费方容器的键值；这个服务没有可识别的凭据时返回空对象。
 */
export function deriveInfraCredentialEnv(
  serviceId: string,
  serviceEnv: Record<string, string> | undefined,
  endpoint?: { host: string; port: number | string },
): Record<string, string> {
  const env = serviceEnv || {};
  const out: Record<string, string> = {};
  const prefix = cdsEnvPrefix(serviceId);

  for (const source of CREDENTIAL_SOURCES) {
    const password = env[source.passwordKey];
    // 没有口令就不是「开了认证」，什么都不发——别造出空口令让消费方以为配好了。
    if (!password) continue;
    const user = source.userKey ? (env[source.userKey] || '') : '';

    if (user) out[`CDS_${prefix}_USER`] = user;
    out[`CDS_${prefix}_PASSWORD`] = password;

    if (source.scheme && endpoint && endpoint.host && endpoint.port) {
      // userinfo 段必须百分号编码：口令里一个 `@` 就能把主机名解析歪。
      const userinfo = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
      out[`CDS_${prefix}_URL`] = `${source.scheme}://${userinfo}@${endpoint.host}:${endpoint.port}`;
    }
    // 一个服务只可能命中一类；命中即停，避免同名键被后面的表项覆盖。
    break;
  }

  return out;
}

/** 给排障与测试用：当前认得出哪几类服务的凭据，以及为什么。 */
export function describeCredentialSources(): readonly string[] {
  return CREDENTIAL_SOURCES.map((s) => `${s.passwordKey} -> ${s.why}`);
}
