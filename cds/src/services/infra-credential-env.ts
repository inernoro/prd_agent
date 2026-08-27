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
 * ## 传进来的 env 必须是**解析过**的
 *
 * `InfraService.env` 存的是未展开的模板：compose 导入和手工建的服务里，
 * 值经常就是字面的 `${CDS_MYSQL_USER}`，到启动容器那一刻才 `resolveEnvTemplates`。
 * 线上真实数据里现在就有四个项目这样存着。
 *
 * 所以本模块**不接受生 env**：直接读的话，`${CDS_POSTGRES_PASSWORD}` 这个占位符
 * 会被当成真口令发出去，`_URL` 里还会变成 `%24%7B...%7D`——消费方拿到一个长得像
 * 凭据的东西，然后认证失败。比什么都不发更难查。
 *
 * 判据必须读**真正生效的那个值**，而不是它在存储里的样子。调用方先解析、再进来；
 * 下面的 `looksUnresolved` 是第二道闸：万一有人忘了解析，宁可一个键都不发。
 * 解析器对解不出来的模板返回空字符串（不是留下占位符），落到「没口令就什么都不发」
 * 那条路上，正好是我们要的行为。
 *
 * ## 已知边界
 *
 * 原始 `USER` / `PASSWORD` 交给消费方自己拼时，转义责任也在消费方。口令里如果
 * 出现该格式的保留字符（StackExchange 的 `,` 与 `=`），拼出来的串会被解析歪。
 * CDS 生成的口令是十六进制，不会命中；用户手工改过口令的服务才有这个风险。
 *
 * `_URL` **不带库名**，也不带 `authSource`：它的语义是「地址 + 凭据」。mongo 这一侧
 * 是有意的——不写库名时 authSource 按 URI 规范默认为 `admin`，正好是 root 账号所在的库；
 * 补上 `/<库名>` 却不同时补 `?authSource=admin` 会直接把认证打死。而 CDS 知道的
 * `MONGO_INITDB_DATABASE` 是**初始化用的库**，不等于消费方要读写的库（当前唯一消费方
 * prd-agent 就是另外用 `MongoDB__DatabaseName` 指定的）。mysql / postgres 的 `_URL`
 * 目前没有任何消费方，等真有人用再按引擎补库名，别现在凭空替他们决定。
 *
 * 两条边界都记在 `doc/debt.cds.md`。
 */

import { detectInfraAuth, readStartupFlagValue, type InfraKind } from './infra-exposure-audit.js';

/**
 * 一个账号：用户名与口令分别在哪个 env 键里。
 *
 * 必须成对绑定，不能拆成「用户名候选表 + 口令候选表」各自取第一个命中的——
 * mysql 同时带着业务账号（`MYSQL_USER` / `MYSQL_PASSWORD`）和 root 口令
 * （`MYSQL_ROOT_PASSWORD`）时，分开取会拼出「业务用户名 + root 口令」这种
 * 根本不存在的账号，而报错只会说「认证失败」。
 */
interface CredentialAccount {
  /** 用户名所在的 env 键；留空表示这个账号的用户名是固定的（见 defaultUser）。 */
  userKey?: string;
  /** userKey 缺值时用的固定用户名，取自镜像约定的管理员账号名。 */
  defaultUser?: string;
  /**
   * 这类账号的用户名**可以真的不存在**。
   *
   * 只有 redis 是这样：`--requirepass` 模式下就是没有用户名，发
   * `redis://:口令@主机` 完全正确。其余服务缺了用户名就是半套凭据，
   * 该候选作废、去试下一个（例如 mysql 退到 root），而不是发一个没有
   * 用户名的连接串出去。
   */
  userOptional?: boolean;
  /** 口令所在的 env 键。**它有值** = 这个账号成立。 */
  passwordKey: string;
  /**
   * 口令也可能**只写在启动参数里**（`redis-server --requirepass <口令>`、
   * `nats-server --pass <口令>`）。这类形态认证门禁是接受的，凭据派生必须
   * 跟着能取到值，否则会出现「门禁放行、服务真开着认证、消费方一个键都收不到」
   * ——本模块存在的理由本身（台账 E78 / E82）。
   *
   * env 优先：显式写在 env 里的值更可信，命令行只是兜底。
   */
  passwordFlags?: readonly string[];
  /** 用户名同理（nats 的 `--user`）。 */
  userFlags?: readonly string[];
}

/** 一类基础设施服务：它可能用哪几个账号，以及它的 URI scheme。 */
interface CredentialSource {
  /**
   * 这类服务「口令存在」不足以证明「服务端在校验它」时，用这个 kind 去问
   * **那一份共用的认证判据**（`detectInfraAuth`）。
   *
   * 不在这里自己写正则：创建门禁、运行态自检、凭据派生问的是同一件事，
   * 三处各写一份必然漂——2026-08-27 就漂过一次，redis 一边被判裸奔一边被判
   * 已认证（台账 E81）。现在只留一份，这里只负责说「我这类要不要问它」。
   */
  provenByAuthKind?: InfraKind;
  /**
   * 账号候选，**按优先级**：取第一个「口令键有值」的。
   *
   * 顺序即最小权限——业务账号排在管理员账号前面，两个都在时发业务账号。
   */
  accounts: readonly CredentialAccount[];
  /** 标准 URI 的 scheme；留空表示这类服务没有公认的 URI 形态，只发 USER/PASSWORD。 */
  scheme?: string;
  /** 给人看的说明，出现在测试与排障里。 */
  why: string;
}

/**
 * 键名有两个来源，都不是拍脑袋起的：官方镜像的 env 约定，以及 CDS 自己的
 * `infra-catalog` 预设（memcached 那种没有官方约定的）。
 *
 * ## 这张表必须覆盖认证门禁认可的每一种形态
 *
 * `infra-auth-policy.ts` 的门禁说某台库「配了认证」，本表就必须能把那对凭据派生
 * 出来——否则会出现最难查的一种状态：**门禁放行、服务真的开着认证、而消费方一个
 * 凭据都收不到**，分支容器照样连不上库。那正是本模块存在的理由。
 *
 * 线上真中过：一个项目的 mysql 只设了 `MYSQL_ROOT_PASSWORD`（门禁明确接受这种），
 * 而本表第一版只认 `MYSQL_USER` / `MYSQL_PASSWORD`，于是那台库一个键都发不出去。
 *
 * 两处键名各写一份就会漂（形状 3），所以配了守卫：扫门禁源码里 `hasValue` 认的键，
 * 逐个断言本表也认。往门禁加别名却忘了加到这里，CI 会红。
 */
const CREDENTIAL_SOURCES: readonly CredentialSource[] = [
  {
    accounts: [
      { userKey: 'MONGO_INITDB_ROOT_USERNAME', passwordKey: 'MONGO_INITDB_ROOT_PASSWORD' },
      { userKey: 'MONGO_USERNAME', passwordKey: 'MONGO_PASSWORD' },
      { userKey: 'MONGODB_USERNAME', passwordKey: 'MONGODB_PASSWORD' },
    ],
    scheme: 'mongodb',
    why: 'mongo 的 root 账号（官方镜像键名，外加门禁认可的两种别名）；开了 --auth 之后连接串必须带它',
  },
  {
    // redis 有两种认证：只设口令（--requirepass）与 ACL 用户（--aclfile）。
    // 前者没有用户名，后者有；同一对键名覆盖两种。
    // 这里**不设 defaultUser**：redis 只设口令时就是「没有用户名」，
    // 补一个 `default` 反而会让消费方拼出一个它没打算用的 ACL 用户。
    // `userOptional` 就是为这一种服务开的——别处缺用户名一律作废该候选。
    accounts: [{
      userKey: 'REDIS_USERNAME',
      passwordKey: 'REDIS_PASSWORD',
      // 口令只写在 `--requirepass` 上的 redis：门禁接受，这里也必须取得到。
      // `--aclfile` 那种取不到——ACL 文件内容不在命令行上，只能靠 env。
      passwordFlags: ['--requirepass'],
      userOptional: true,
    }],
    scheme: 'redis',
    // env 里有 REDIS_PASSWORD 不代表服务端在校验它：既没 --requirepass 也没
    // --aclfile 的 redis 是真实存在的，而带着口令连过去会被
    // 「ERR Client sent AUTH, but no password is set」顶回来——发凭据反而把
    // 本来能连的消费方弄坏。问共用判据，与门禁、运行态自检同一口径。
    provenByAuthKind: 'redis',
    why: 'redis 口令或 ACL 用户；必须由启动参数证明服务端真的在校验'
  },
  {
    accounts: [
      { userKey: 'MYSQL_USER', passwordKey: 'MYSQL_PASSWORD' },
      { userKey: 'MARIADB_USER', passwordKey: 'MARIADB_PASSWORD' },
      { defaultUser: 'root', passwordKey: 'MYSQL_ROOT_PASSWORD' },
      { defaultUser: 'root', passwordKey: 'MARIADB_ROOT_PASSWORD' },
      // 只有 root 口令也算配了认证（门禁明确接受，周期备份也固定用 root）。
      // 排在业务账号后面：两个都在时发权限小的那个。
    ],
    scheme: 'mysql',
    why: 'mysql / mariadb 的业务账号，没有业务账号时退到 root',
  },
  {
    // postgres 的超级用户名可以不设，镜像默认就叫 postgres。
    accounts: [
      { userKey: 'POSTGRES_USER', defaultUser: 'postgres', passwordKey: 'POSTGRES_PASSWORD' },
      { userKey: 'POSTGRES_USER', defaultUser: 'postgres', passwordKey: 'PGPASSWORD' },
    ],
    scheme: 'postgresql',
    why: 'postgres 超级用户；用户名不设时镜像默认是 postgres',
  },
  {
    accounts: [{ userKey: 'RABBITMQ_DEFAULT_USER', passwordKey: 'RABBITMQ_DEFAULT_PASS' }],
    scheme: 'amqp',
    why: 'rabbitmq 官方镜像的默认账号',
  },
  {
    accounts: [
      { userKey: 'MINIO_ROOT_USER', passwordKey: 'MINIO_ROOT_PASSWORD' },
      { userKey: 'MINIO_ACCESS_KEY', passwordKey: 'MINIO_SECRET_KEY' },
    ],
    why: 'minio 的 root 账号（含旧版 ACCESS_KEY/SECRET_KEY 别名）；S3 客户端不用 URI，只发 USER/PASSWORD',
  },
  {
    // 键名照抄 infra-catalog 的 memcached 预设（它写的是 MEMCACHED_USER，
    // 不是别处常见的 MEMCACHED_USERNAME）。memcached 没有官方镜像 env 约定，
    // 这一对是 CDS 自己定的，所以 SSOT 就是那个预设。
    accounts: [{ userKey: 'MEMCACHED_USER', passwordKey: 'MEMCACHED_PASSWORD' }],
    why: 'memcached 的认证账号（键名以 infra-catalog 预设为准）；客户端各家格式不一，只发 USER/PASSWORD',
  },
  {
    // 下面三类门禁都认，之前本表整个没有——门禁放行而消费方收不到凭据，
    // 与 mysql 只有 root 口令是同一种坏。
    accounts: [
      { defaultUser: 'sa', passwordKey: 'MSSQL_SA_PASSWORD' },
      { defaultUser: 'sa', passwordKey: 'SA_PASSWORD' },
    ],
    why: 'sqlserver 的 sa 账号；用户名固定，只有口令写在 env 里',
  },
  {
    // 直接建的 nats 常把账号口令写在 `--user` / `--pass` 上（门禁接受这种）。
    // 预设走的是另一条路（在容器内写配置文件、不让明文进 argv），那种情况下
    // 命令行上取不到值，只能靠 env——两条都要覆盖，缺一台就连不上。
    accounts: [{
      userKey: 'NATS_USER',
      passwordKey: 'NATS_PASSWORD',
      userFlags: ['--user'],
      passwordFlags: ['--pass'],
    }],
    scheme: 'nats',
    provenByAuthKind: 'nats',
    why: 'nats 账号；口令可能只在 --pass 上，也可能只在 env 里',
  },
  {
    accounts: [{ userKey: 'CLICKHOUSE_USER', defaultUser: 'default', passwordKey: 'CLICKHOUSE_PASSWORD' }],
    why: 'clickhouse 账号；用户名不设时镜像默认是 default',
  },
  {
    accounts: [{ defaultUser: 'elastic', passwordKey: 'ELASTIC_PASSWORD' }],
    why: 'elasticsearch 的内置 elastic 账号；用户名固定，只有口令写在 env 里',
  },
];

/** `CDS_<这里>_PORT` 用的那段大写标识，与既有命名保持一致。 */
export function cdsEnvPrefix(serviceId: string): string {
  return serviceId.toUpperCase().replace(/-/g, '_');
}

/**
 * 这个值还是个没展开的模板吗（`${...}`）。
 *
 * 调用方本该先 `resolveEnvTemplates`。忘了的话，这里当作「没有凭据」处理——
 * 发一个字面的 `${CDS_MYSQL_PASSWORD}` 出去，消费方会拿它去认证然后失败，
 * 比什么都不发难查得多。
 */
function looksUnresolved(value: string): boolean {
  return /\$\{[^}]*\}/.test(value);
}

/**
 * 把 command / entrypoint 拍平成 token 数组，交给共用的启动参数分词器。
 *
 * 传数组而不是拼好的字符串：`detectInfraAuth` / `readStartupFlagValue` 自己会分词，
 * 而它们的分词认引号（`--requirepass "带 空格的口令"`）。先 join 再让它切一遍，
 * 结果与真实 argv 一致；这里唯一的责任是「两处都要送进去」——memcached / nats
 * 的认证经常写在 entrypoint 那半边，只送 command 就漏了一半形态。
 */
function flattenStartup(startup: {
  command?: string | string[] | null;
  entrypoint?: string | string[] | null;
}): string[] {
  const one = (v?: string | string[] | null): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x));
    return v ? [String(v)] : [];
  };
  return [...one(startup.command), ...one(startup.entrypoint)];
}

/** 一个候选账号最终解析出来的凭据；解析不出完整一对时为 null。 */
interface ResolvedAccount {
  user: string;
  password: string;
}

/**
 * 把一个账号候选解析成真凭据——**在选中它之前**就要解析完。
 *
 * 只判「口令键有值」是不够的，两个方向都栽过：
 *
 * - 少判：mysql 有 `MYSQL_PASSWORD` 却没有 `MYSQL_USER` 时，只看口令会选中这个
 *   残缺候选并发出没有用户名的连接串，而后面那个完整的 root 候选永远轮不到。
 * - 漏找：口令可能**根本不在 env 里**（`redis-server --requirepass <口令>`、
 *   `nats-server --pass <口令>`）。认证门禁接受这种形态，凭据派生跟不上就会出现
 *   「门禁放行、服务真开着认证、消费方一个键都收不到」——本模块存在的理由本身。
 *
 * env 优先、命令行兜底：显式写在 env 里的值更可信（命令行可能是 `$REDIS_PASSWORD`
 * 这种待 shell 展开的形态，分词器会把它当没有值）。
 *
 * 用户名是占位符时该候选作废，但**不放弃整类服务**——继续试下一个候选。
 */
function resolveAccount(
  account: CredentialAccount,
  env: Record<string, string>,
  args: readonly string[],
): ResolvedAccount | null {
  const envPassword = env[account.passwordKey];
  let password = envPassword && !looksUnresolved(envPassword) ? envPassword : '';
  if (!password && account.passwordFlags?.length) {
    const fromArgs = readStartupFlagValue(env, args, ...account.passwordFlags);
    if (fromArgs && !looksUnresolved(fromArgs)) password = fromArgs;
  }
  if (!password) return null;

  let user = '';
  if (account.userKey) {
    const rawUser = env[account.userKey];
    // 有值但没展开 = 这个候选的用户名不可信，作废它（不要退到 defaultUser：
    // 声明了用户名就说明本意不是用默认管理员）。
    if (rawUser && looksUnresolved(rawUser)) return null;
    user = rawUser || '';
  }
  if (!user && account.userFlags?.length) {
    const fromArgs = readStartupFlagValue(env, args, ...account.userFlags);
    if (fromArgs && !looksUnresolved(fromArgs)) user = fromArgs;
  }
  if (!user) user = account.defaultUser || '';
  // 用户名缺席：只有「这类服务本来就没有用户名」才算完整（redis 的 --requirepass）。
  if (!user && account.userOptional !== true) return null;

  return { user, password };
}

/**
 * 从一个基础设施服务自己的 env，派生出消费方要用的凭据变量。
 *
 * @param serviceId 服务 id（决定变量名前缀）。
 * @param serviceEnv 该服务容器自己的 env，**必须已经过 `resolveEnvTemplates`**。
 *   还带着 `${...}` 的值一律当没有（见文件头「传进来的 env 必须是解析过的」）。
 * @param endpoint 消费方实际连过去的地址；URI 形态需要它。
 * @returns 要注入消费方容器的键值；这个服务没有可识别的凭据时返回空对象。
 */
export function deriveInfraCredentialEnv(
  serviceId: string,
  serviceEnv: Record<string, string> | undefined,
  endpoint?: { host: string; port: number | string },
  startup?: { command?: string | string[] | null; entrypoint?: string | string[] | null },
): Record<string, string> {
  const env = serviceEnv || {};
  const out: Record<string, string> = {};
  const prefix = cdsEnvPrefix(serviceId);
  // 调用方没传启动参数 = 「这台服务的启动命令我不知道」，与「知道且是空的」不同：
  // 前者不能拿来证明认证（下面 provenByAuthKind 那一段），所以要分得开。
  const args = startup === undefined ? null : flattenStartup(startup);

  for (const source of CREDENTIAL_SOURCES) {
    // 「口令存在」不等于「服务端在校验它」。这类服务必须由启动参数证明，
    // 证不了就一个键都不发——发出去会把本来能裸连的消费方弄坏
    // （`ERR Client sent AUTH, but no password is set`）。
    //
    // 判据问的是那一份共用的 `detectInfraAuth`，与创建门禁、每日体检同一口径。
    // 这里不自己写正则：三处各写一份必然漂，2026-08-27 已经漂过一次（台账 E81）。
    if (source.provenByAuthKind) {
      if (!args) continue;
      if (detectInfraAuth(source.provenByAuthKind, env, args) !== true) continue;
    }

    // 账号候选按优先级取第一个**完整可用**的。
    //
    // 只看口令是不够的（这里栽过）：mysql 有 MYSQL_PASSWORD 却没有 MYSQL_USER 时，
    // 只看口令会选中这个残缺候选，发出 `mysql://:口令@主机`——没有用户名的连接串，
    // 而旁边那个完整的 root 候选永远轮不到。完整性判定必须在**选之前**做。
    let resolved: ResolvedAccount | null = null;
    for (const candidate of source.accounts) {
      resolved = resolveAccount(candidate, env, args || []);
      if (resolved) break;
    }
    if (!resolved) continue;

    const { user, password } = resolved;

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
  return CREDENTIAL_SOURCES.map(
    (s) => `${s.accounts.map((a) => a.passwordKey).join(' | ')} -> ${s.why}`,
  );
}

/**
 * 这张表认的键名本身，给守卫用。
 *
 * 键名是「本表」与「infra-catalog 预设」之间的隐式契约，两边各写一份就会漂——
 * memcached 已经漂过一次（预设写 `MEMCACHED_USER`，这里写成了 `MEMCACHED_USERNAME`，
 * 于是只发口令不发用户名）。守卫要能真跑一遍预设、拿它的输出对照这张表，
 * 而不是去扫源码里的字面量；扫字面量的守卫在「改了预设、忘了改表」时照样绿。
 */
export function credentialSourceKeys(): readonly { userKey?: string; passwordKey: string }[] {
  return CREDENTIAL_SOURCES.flatMap(
    (s) => s.accounts.map((a) => ({ userKey: a.userKey, passwordKey: a.passwordKey })),
  );
}

/** 本表认得出的全部 env 键名（用户名与口令都算），给「与门禁对齐」那条守卫用。 */
export function knownCredentialEnvKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const s of CREDENTIAL_SOURCES) {
    for (const a of s.accounts) {
      if (a.userKey) keys.add(a.userKey);
      keys.add(a.passwordKey);
    }
  }
  return keys;
}
