# CDS FU-02 · MapAuthStore (Mongo 后端) 设计稿

> **版本**:v0.1 | **日期**:2026-04-16 | **类型**:design | **状态**:草案,等下一棒承接

## 一、管理摘要

- **解决什么问题**:CDS 当前的 `MemoryAuthStore` 把用户 + session 存在进程内存,CDS 重启就全部丢失。多实例部署无法共享登录态。
- **方案概述**:新增 `MongoAuthStore` 实现同一 `AuthStore` 接口,用两个 collection(`cds_users` / `cds_sessions`)落地。通过 `CDS_AUTH_BACKEND=memory|mongo` 启动时选择。
- **业务价值**:(1) 重启不掉用户 (2) 为未来多实例部署做准备 (3) P5 team-workspace 的前置依赖
- **影响范围**:仅 CDS 内部 — `auth-service.ts` 初始化时换一个实现;接口签名不变
- **预计风险**:中等 — 认证是登录路径,错了整站无法登录。缓解:保留 memory 后端作为回滚

---

## 二、产品定位

### 和 Phase D(state 存储后端)的关系

这是**两套独立的存储系统**,不要混:

| 系统 | 管什么 | 已完成? | collection |
|---|---|---|---|
| **State backing store**(Phase D) | CDS 业务 state(branches / profiles / infra / routing) | ✅ 2026-04-14 | `cds_state`(单 doc) |
| **AuthStore**(本设计 FU-02) | 用户身份 + 会话 | ❌ 本期 | `cds_users` + `cds_sessions` |

两个系统共用同一个 MongoDB 实例,但**独立演进**——state 可以用 json 后端,auth 用 mongo 后端;反之亦可。

### 何时启动

**前置依赖**:无强前置,随时可做。但和 P5 team-workspace 前置绑定(P5 需要多用户长会话)。

---

## 三、现状分析

### 当前 AuthStore 接口(已落地)

```ts
// cds/src/infra/auth-store/memory-store.ts
export interface AuthStore {
  getOrCreateUser(githubProfile: GithubProfile): Promise<User>;
  createSession(userId: string, ip?: string, userAgent?: string): Promise<Session>;
  validateSession(token: string): Promise<{ user: User; session: Session } | null>;
  revokeSession(token: string): Promise<void>;
  listSessionsForUser(userId: string): Promise<Session[]>;
}

export class MemoryAuthStore implements AuthStore {
  // 所有 state 存在 private Map 里
}
```

### 数据模型(当前 in-memory)

```ts
interface User {
  id: string;              // 内部 UUID
  githubId: number;        // GitHub 数字 id(不可变)
  githubLogin: string;     // 用户名(可能变,不作主键)
  name: string;
  email: string | null;
  avatarUrl: string | null;
  orgs: string[];          // GitHub orgs 列表(用于白名单)
  isSystemOwner: boolean;  // 第一个登录的用户(CDS admin)
  createdAt: string;
  lastLoginAt: string;
}

interface Session {
  id: string;              // 内部 UUID
  userId: string;
  token: string;           // 随机 32 字节 base64url(Cookie 里存的就是这个)
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;       // 默认 30 天
}
```

### 问题

1. CDS 重启 → 所有用户 + session 消失,每个人要重新 OAuth
2. 不能水平扩展(两个 CDS 实例不共享登录态)
3. P5 team-workspace 要跟 User 关联 → 没有持久 User 就做不下去

---

## 四、核心设计

### 4.1 新增 `MongoAuthStore`

文件路径:`cds/src/infra/auth-store/mongo-store.ts`

```ts
import type { AuthStore, User, Session } from './types.js';

export interface IMongoHandle {
  connect(): Promise<void>;
  usersCollection(): IMongoCollection<User>;
  sessionsCollection(): IMongoCollection<Session>;
  close(): Promise<void>;
}

export class MongoAuthStore implements AuthStore {
  constructor(private handle: IMongoHandle) {}

  async init(): Promise<void> {
    await this.handle.connect();
    // Indexes 由 DBA 手动维护(遵守 no-auto-index.md 规则):
    //   cds_users.githubId        unique
    //   cds_users.githubLogin     non-unique
    //   cds_sessions.token        unique
    //   cds_sessions.userId       non-unique
    //   cds_sessions.expiresAt    TTL(可选,但建议)
  }

  async getOrCreateUser(profile: GithubProfile): Promise<User> {
    const users = this.handle.usersCollection();
    const existing = await users.findOne({ githubId: profile.id });
    if (existing) {
      // Update login/avatar/orgs on each login
      const updated = { ...existing, githubLogin: profile.login, ...profile.avatar... };
      await users.replaceOne({ _id: existing.id }, updated);
      return updated;
    }
    // First user ever = system owner
    const isFirst = (await users.countDocuments()) === 0;
    const newUser: User = {
      id: randomUUID(),
      githubId: profile.id,
      githubLogin: profile.login,
      // ... etc
      isSystemOwner: isFirst,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    await users.insertOne(newUser);
    return newUser;
  }

  async createSession(userId: string, ip?: string, ua?: string): Promise<Session> {
    const sessions = this.handle.sessionsCollection();
    const session: Session = {
      id: randomUUID(),
      userId,
      token: randomBytes(32).toString('base64url'),
      ip: ip ?? null,
      userAgent: ua ?? null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400e3).toISOString(),
    };
    await sessions.insertOne(session);
    return session;
  }

  async validateSession(token: string): Promise<{ user: User; session: Session } | null> {
    if (!token) return null;
    const sessions = this.handle.sessionsCollection();
    const session = await sessions.findOne({ token });
    if (!session) return null;
    // Expiry check
    if (new Date(session.expiresAt) < new Date()) {
      await sessions.deleteOne({ _id: session.id });
      return null;
    }
    const users = this.handle.usersCollection();
    const user = await users.findOne({ id: session.userId });
    if (!user) {
      // Orphan session (user deleted); clean up
      await sessions.deleteOne({ _id: session.id });
      return null;
    }
    return { user, session };
  }

  async revokeSession(token: string): Promise<void> {
    await this.handle.sessionsCollection().deleteOne({ token });
  }

  async listSessionsForUser(userId: string): Promise<Session[]> {
    return this.handle.sessionsCollection().find({ userId }).toArray();
  }
}
```

### 4.2 启动时选择后端

`cds/src/index.ts`(已有 `CDS_AUTH_MODE` 开关,新增 `CDS_AUTH_BACKEND`):

```ts
const authBackend = process.env.CDS_AUTH_BACKEND ?? 'memory';

let authStore: AuthStore;
if (authBackend === 'mongo') {
  const handle = createMongoAuthHandle(config.mongoUri, config.mongoDb);
  const store = new MongoAuthStore(handle);
  await store.init();  // connect + seed first-owner logic
  authStore = store;
  console.log('[auth] backend=mongo');
} else {
  authStore = new MemoryAuthStore();
  console.log('[auth] backend=memory (default)');
}

const authService = new AuthService(authStore, config.jwt);
```

### 4.3 迁移路径(memory → mongo)

首次切换时:
1. CDS 运行 memory 后端 → 所有用户正在使用
2. 停 CDS(接受"所有人要重新登录"一次)
3. 启动时设置 `CDS_AUTH_BACKEND=mongo`
4. 重启 → MongoAuthStore.init() 连接空 collection
5. 用户重新走 OAuth → 首个用户自动标记 `isSystemOwner`
6. 其余用户陆续登录

**不做"in-memory → mongo 自动导入"**:太复杂,收益不对称(只省一次登录)。直接接受"切后端 = 所有人重登"。

---

## 五、测试计划

新增 `cds/tests/infra/auth-store/mongo-store.test.ts`:

### 必测路径

| 场景 | 断言 |
|---|---|
| init 空 collection | 不抛 error |
| 第一个 getOrCreateUser | `isSystemOwner === true` |
| 第二个 getOrCreateUser | `isSystemOwner === false` |
| 重新登录已有用户 | 更新 `githubLogin` + `lastLoginAt`,保持 `id` 不变 |
| createSession + validateSession | 同一 token 能读出 user |
| validateSession 过期 token | 自动删除 + 返回 null |
| validateSession orphan(user 被删) | 自动删除 session + 返回 null |
| revokeSession | token 失效 |
| listSessionsForUser | 列出用户所有活跃 session |

### Mock 策略

不引入 testcontainers 或真 mongo。和 `MongoStateBackingStore` 一样,mock `IMongoHandle` 接口,每个 collection 用 Map 模拟 `findOne/insertOne/deleteOne/replaceOne`。

---

## 六、回滚策略

如果 mongo 后端出问题:
1. `export CDS_AUTH_BACKEND=memory`(或 unset)
2. 重启 CDS
3. 所有用户再走一次 OAuth(短暂不便,但可立即恢复)

Mongo 的 collection 保留,下次切回来还能读到历史 session(过期的会被 validateSession 的清理路径自动 GC)。

---

## 七、和 LIM-02(单租户 token)的关系

**LIM-02**:Device Flow token 存 state.json 单 slot,两个用户登录相互覆盖。

**FU-02 不直接解决 LIM-02**,但为它奠定基础:

- 本期把 **User session** 放到 mongo(多实例 + 多用户 session 隔离)
- 下一步把 **Device Flow token** 从 state.json 挪到 `cds_users` 下(每用户一个 token)→ LIM-02 就能关闭

所以 LIM-02 的关闭时机:FU-02 落地 + P5 team-workspace 启动之间。

---

## 八、验收标准

- [ ] `cds/src/infra/auth-store/mongo-store.ts` 新建,实现 `AuthStore` 完整接口
- [ ] `cds/src/infra/auth-store/mongo-handle.ts` 新建(和 `state-store/mongo-handle.ts` 一致的 pattern)
- [ ] `cds/src/index.ts` 按 `CDS_AUTH_BACKEND` 分发
- [ ] `cds/tests/infra/auth-store/mongo-store.test.ts` 覆盖上表 9 条场景,全绿
- [ ] 现有 602+ tests 零回归
- [ ] 文档:`doc/guide.cds-env.md` 增加 `CDS_AUTH_BACKEND` 章节
- [ ] Backlog matrix FU-02 状态改 `done`

**预估工作量**:4-5 小时(~1 session)。

---

## 九、关联文档

- `doc/design.cds-multi-project.md` — P5 team-workspace 的前置
- `doc/rule.cds-mongo-migration.md` — Mongo 迁移规范(遵守相同的双写/回滚要求)
- `.claude/rules/no-auto-index.md` — 索引由 DBA 手动创建,不要代码自动建
- `doc/plan.cds-backlog-matrix.md` §FU-02 — 本设计的登记源头
