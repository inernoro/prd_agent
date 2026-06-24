# CDS 构建耗时与发布版/热加载机制 · 设计

> **版本**：v1.0 | **日期**：2026-06-20 | **状态**：已落地

## 管理摘要（30 秒）

用户反馈两件事：CDS 构建经常超过 10 分钟；"发布版"与"热加载版"两套机制说不清、有时会冲突。

排查结论，构建慢主要有三个根源：

1. **Java（以及 Go/Rust/Python）每次都重新下载依赖。** CDS 原本只给 Node 和 .NET 项目挂了依赖缓存目录，Java 项目的 `.m2`/`.gradle` 没有任何持久缓存，所以每起一次容器就把整棵依赖树从 Maven Central 冷下载一遍。这是 10 分钟构建的头号嫌疑。
2. **构建超时上限就是 10 分钟。** 每个构建配置的超时默认 `600000ms`，慢构建撞到这个天花板就直接失败——10 分钟不是巧合，是配置上限。
3. **自动发布会触发"第二次"构建。** 项目可以设置"运行 N 分钟后自动切发布版"。这次切换会把源码/热加载容器换成发布版容器并重新构建一次，用户看不到原因，于是体感成了"莫名其妙又构建了一遍"。

本次改动：把"按镜像推断该挂哪个依赖缓存"的逻辑收敛到一个单一数据源（SSOT），并补齐 Java/Go/Rust/Python——Java 项目从此不再重复下载依赖；把自动发布这次隐形的模式切换显式记录到分支状态，让"为什么又构建了"看得见。构建超时本就可按构建配置调，已确认无代码缺口，本文档把它说清楚。

下面先讲清楚"发布版 vs 热加载版"到底是什么、什么时候自动切换（用户最困惑的部分），再讲构建流水线时间花在哪、本次具体改了什么。

---

## 一、发布版 vs 热加载版（用户最困惑的部分）

CDS 给同一个分支提供两种运行形态，由"部署模式（deploy mode）"决定。模式归类的唯一判断逻辑在 `cds/src/services/deploy-runtime.ts` 的 `isReleaseDeployMode()`：模式 id 或名称里命中 `prod/production/release/static/publish/dist/built/发布/生产/正式/构建` 等关键词，就算"发布版"，否则算"源码/热加载版"。

| 维度 | 热加载版（源码） | 发布版（release） |
|------|------------------|-------------------|
| 触发 | 默认形态；新分支建好就是这个 | 用户在"项目设置 → 新分支默认运行模式"选了发布模式，或运行满 N 分钟被自动发布 |
| 源码挂载 | 把仓库 worktree 挂进容器（`-v 源码:/app`），改文件即时生效 | 预构建镜像模式（`prebuiltImage`）跳过源码挂载，应用全在镜像里 |
| 构建命令 | 装依赖 + 起开发服务（如 `pnpm dev`） | 走生产构建（如 `pnpm build` 后跑产物） |
| 依赖缓存 | 走 cacheMounts（pnpm/.m2/nuget 等命名缓存目录） | 同样走 cacheMounts；预构建镜像模式只挂缓存不挂源码 |
| 重启行为 | 改源码刷新即可，不必重建容器 | 切到发布版 = 停旧容器 + 以发布版重建一次（一次真实构建） |
| 当前真实态记录 | `ServiceState.deployedMode` 记录容器**实际**以哪个模式启动 | 同左——这是"现在跑的是不是发布版"的唯一真相来源 |

判断口诀：**模式名里有"发布/生产/构建/release/prod"字样的就是发布版，否则是热加载版。**

### 自动发布什么时候介入

项目设置里有一个"运行 N 分钟后自动切发布版"（`Project.autoPublishAfterMinutes`）。逻辑在 `cds/src/services/auto-lifecycle.ts`：

- 调度器每 30 秒一拍，以容器进入 running 的时刻（`lastReadyAt`）为锚点计时。
- 分支运行满 N 分钟、且还没"收敛"到发布版时，自动把可切的构建配置写上发布模式 override，然后调用重部署——停掉热加载容器，以发布版重建。
- "收敛"的判定（`branchAutoPublishConverged`）很讲究：不仅配置要是发布版，容器**真的**以发布版跑起来（`deployedMode` 命中发布版且 status=running）才算数；纯源码 sidecar（压根没有发布模式可切）不算阻塞项，避免反复无意义重启。

**这就是用户说的"冲突"的来源**：自动发布在后台静默地把容器重建了一次。它本身不是 bug（有收敛保护，不会反复重建），问题在于**这次模式跃迁没有任何持久的可见标记**——分支卡片上看不出"我现在是被自动发布过的版本"，于是用户只感知到"容器莫名又构建了一遍"。

---

## 二、构建流水线：时间花在哪

一次分支部署的阶段（`cds/src/executor/routes.ts` 调度 + `cds/src/services/container.ts` 执行）：

```
worktree（准备源码工作区）
  → pull（拉最新代码）
  → build（逐个构建配置跑 install + build + run，docker run）
  → TCP 探测（端口 accept）
  → HTTP 探测（"/" 返回，4xx 也算 HTTP 存活）
  → runtime-ready（分支标记 running）
```

时间几乎都耗在 `build` 这一步的 `docker run`（执行 install/build 命令）。两个关键参数：

- **就绪探测超时**：`waitForReadiness` 默认 180s（TCP→HTTP 两段，HTTP 探 `/`，详见 `container.ts:1183`）。这是"等应用起来"的等待上限，不是构建上限。
- **构建超时**：`profile.buildTimeout ?? 600000`（10 分钟），作为 `docker run` 这条命令的 shell exec 超时（`container.ts:1049`）。慢构建撞到这里就失败。

### 为什么 Java 会撞 10 分钟

构建命令里 `mvn dependency:resolve` / `gradlew` 需要把依赖下载到 `~/.m2` / `~/.gradle`。CDS 容器以 root 跑，对应 `/root/.m2`、`/root/.gradle`。如果这两个目录没有挂成持久的命名缓存，那么：

- 每次部署、每个分支、每次重建 → 容器都是全新的 → 依赖树全部重新从远程仓库下载。
- 大型 Spring 项目的依赖动辄几百 MB，冷下载几分钟很正常，叠加构建本身就容易超过 10 分钟。

而 Node/.NET 项目早就有 pnpm/nuget 缓存挂载，所以同样体量却快得多——这正是用户观察到的差异。

---

## 三、根因小结

| 现象 | 根因 | 位置 |
|------|------|------|
| Java/Go/Rust/Python 反复下载依赖、构建 >10 分钟 | 镜像→缓存挂载推断只覆盖 node/dotnet，其他栈拿不到任何依赖缓存 | `routes/projects.ts` `defaultCacheMountsFor` + `services/state.ts` `migrateCacheMounts`（各抄一份，都只有 node/dotnet） |
| 构建撞 10 分钟天花板直接失败 | `buildTimeout` 默认 600000ms 即为上限 | `types.ts` + `container.ts:1049` |
| "发布版/热加载冲突"、容器莫名又构建 | 自动发布静默重建容器，模式跃迁无持久可见标记 | `services/auto-lifecycle.ts` 成功重部署路径只写一条 activity log，分支态无标记 |

---

## 四、本次改动

### 1. 依赖缓存挂载 SSOT，补齐 Java/Go/Rust/Python

新增 `cds/src/services/cache-catalog.ts`：一张"镜像名子串 → 依赖缓存目录"的目录表，`buildCacheMounts(image, cacheBase)` 按镜像推断该挂哪些缓存目录。覆盖：

- node → `/pnpm/store`
- dotnet → `/root/.nuget/packages`
- **java（temurin/jdk/openjdk/maven/gradle）→ `/root/.m2` + `/root/.gradle`**（新）
- **go（golang）→ `/go/pkg/mod`**（新）
- **rust（rust/cargo）→ `/usr/local/cargo/registry`**（新）
- **python → `/root/.cache/pip`**（新）

两个原本各抄一份逻辑的调用点改为统一引用该 SSOT：

- `routes/projects.ts` 的 `defaultCacheMountsFor`（新建构建配置时挂缓存）
- `services/state.ts` 的 `migrateCacheMounts`（加载存量构建配置时按镜像缺啥补啥的合并语义，不覆盖用户自定义挂载）

效果：Java 项目首次下载依赖后落进命名缓存，之后所有部署/重建/跨分支复用缓存，不再重复冷下载。存量 Java 项目下次加载 state 时自动补挂 `.m2`/`.gradle`。

挂载落地路径不变：`container.ts:556` 的 `profile.cacheMounts` 已经把每条 cacheMount 翻成 `-v hostPath:containerPath` 的 docker 卷挂载，无需改动。

### 2. 把自动发布的模式跃迁变得可观测

`BranchEntry` 新增 `lastPublishAt` / `lastPublishReason` 两个字段（`types.ts`），与 `lastStopReason` 是兄弟字段但语义不同：这是"成功切到发布版"而非"被停止"。

`auto-lifecycle.ts` 在自动发布成功重部署后，把原因短语（如"项目设置：启动满 30 分钟，已自动切到发布版并重新部署（web=prod）"）写到 `lastPublishReason`/`lastPublishAt`。注意成功重部署路径**不能**钉 `lastStoppedAt`——分支仍在运行，钉了会让 UI 误报"已停止"。这样分支卡片/抽屉就能展示"这次是被自动发布过的版本"，把原本隐形的重建说清楚。

未改动自动发布的触发逻辑本身：收敛判定（`branchAutoPublishConverged`）已经保证已是发布版的分支不会被重复构建，这一层幂等保护本就存在，本次只补可观测性。

### 3. 构建超时已可配，无代码缺口

`buildTimeout` 已是每个构建配置的可选字段，默认 600000ms，从 compose 解析（`compose-parser.ts`）一路透传到 `docker run` 的执行超时（`container.ts:1049`），并在 `executor/routes.ts` 的 profile 契约里传递。慢栈（大型 Java）可在构建配置里调高这个值。本次确认链路完整，未改代码，仅在此文档说明配置位置，供需要时调整（UI 暴露该字段可作为后续增强）。

---

## 五、验证

- `cd cds && pnpm build`（tsc）通过。
- `cd cds && pnpm test`（vitest 全量）通过：2002 passed / 1 skipped。
- 新增/扩展单测：
  - `tests/services/cache-catalog.test.ts`：断言 Java 镜像产出 `.m2`+`.gradle`，各栈缓存目录正确，hostPath 用 cacheBase 拼前缀、按 containerPath 去重。
  - `tests/services/auto-lifecycle-redeploy.test.ts`：扩展断言自动发布成功路径写 `lastPublishReason`/`lastPublishAt` 且不钉 `lastStoppedAt`。
  - 既有 `isReleaseDeployMode` / `branchAutoPublishConverged` 收敛语义测试保持绿（`auto-lifecycle-converged.test.ts`）。

CDS 改动需远端容器实跑才能端到端验证 Java 缓存效果（本环境无 Docker），缓存挂载落地路径已被 `container.test.ts` 既有用例覆盖（cacheMounts → `-v` 翻译）。

---

## 六、后续建议（未实现，记录待评估）

- 在构建配置 UI 暴露 `buildTimeout`，让用户对大型 Java 项目直接调高超时，而不是改 compose。
- 分支卡片消费 `lastPublishReason`，在"已自动发布"时显示一枚可见徽章（前端，本次只铺后端字段）。
- 评估构建产物层缓存（如 Gradle build cache / Maven 增量），进一步压缩重复构建时间。

## 关联

- `cds/src/services/cache-catalog.ts` —— 依赖缓存挂载 SSOT
- `cds/src/services/deploy-runtime.ts` —— 发布版/热加载模式归类 SSOT
- `cds/src/services/auto-lifecycle.ts` —— 自动发布调度
- `.claude/rules/cross-project-isolation.md` —— 共享缓存/卷的隔离边界
- `doc/design.cds.multi-project.md` —— CDS 多项目设计
