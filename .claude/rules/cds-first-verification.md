# 验证的权威位置（编译与测试各在哪里被证明）

**一句话**：每种改动的验证都有一个唯一权威位置，把它说清楚——「我本地有没有 SDK」是工作环境细节，不该出现在交付叙述里，更不能当成验证做没做的理由。
**什么时候撞上**：改了可执行代码，准备说「验证过了 / 编译通过 / 测试全绿」的时候。

> 判定口诀：**把「本地」两个字从你那句交付叙述里划掉，这句话还站得住吗？**
> 站不住，说明你交出去的是环境状态，不是验证结论。

---

## 一、这个仓库的验证权威位置

每一行都要能被第三个人照着核一遍，不需要问你。

**这张表是快照，不是 SSOT——SSOT 是 `.github/workflows/`。** 它写于 2026-09-15，而流水线会增减：
本条规则自己在 review 里被连着纠正了七轮，每一轮都是某一行少算了一条 workflow 或多算了一个步骤
（Admin 不跑 lint、Desktop 不跑 lint 与 vitest、cds 有三条流水线而不是一条、脚本与 Dockerfile
其实大多有 CI……）。所以引用这张表之前，**先扫一眼你改的路径出现在哪些 workflow 的触发条件里**：

```bash
grep -rn "你改的路径前缀" .github/workflows/ | grep -v "^.*#"
```

表与 `.github/workflows/` 对不上时，以后者为准，并把表改回来。

**这张表也不打算穷举 workflow。** 仓库里有十几条，还会增减；把它们的触发条件和步骤在这里抄一份，
就是让同一份判据存在两处、各自漂移（`predicate-and-wiring-discipline.md` 形状 3）。
所以表只负责一件 `.github/workflows/` 一眼看不出来的事：**哪些检查压根没有远端判据**
（Admin 与 Desktop 的 lint、Desktop 的 vitest、Integration / Manual 测试、`prd-video`、
`docker-compose*.yml`、清单外的脚本）——那才是会让人误报「已验证」的地方。
「我这条路径会触发哪几条流水线」一律现查，不要背表。

| 改了什么 | 权威判据 | 在哪跑 | 什么时候才有结论 |
|---|---|---|---|
| `prd-api/**/*.cs`（API 项目能不能编出来） | **Branch Image workflow 绿**，产出 `sha-<commit>` 镜像 | GitHub Actions `branch-image.yml` | **push 之后**（它由 push 触发），每次 push 都跑 |
| `prd-api` 整个 sln 编译 + 非集成非手工的 xUnit | **CI workflow 的 `Server Build & Test` job 绿** | GitHub Actions `ci.yml` | push 之后，且 **feature 分支不自动跑**（见第三节） |
| `prd-api` 的 Integration / Manual 类测试 | 本地**按 `--filter FullyQualifiedName~<类名>` 点名跑受影响的那几条**，并写清它各自要什么前置（见第二节末）。**不许去掉 filter 全跑**——那一档里有会真的打外部服务、真的花钱的用例 | 只能本地 | 没有任何 CI 会跑它们 |
| `prd-admin` 的 **tsc + vite build** | **Branch Image workflow 的 `Build prd-admin image` 绿**——`prd-admin/Dockerfile` 里跑的 `pnpm run build` 就是 `tsc && vite build`，编不过镜像就建不出来（本地 `pnpm build` 跑一遍更快） | GitHub Actions `branch-image.yml` | push 之后，**每次 push 都跑**（它由 push 触发、`prd-admin/**` 在它的 path filter 里） |
| `prd-admin` 的 **vitest** | CI 的 `Admin Dashboard Build` job 绿（本地 `pnpm test` 跑一遍更快） | 本地 或 Actions | 本地即时；那个 job 在 `ci.yml` 里，**普通 feature 分支 push 不会跑**——要么开 PR 到 main/develop，要么手动 dispatch。镜像构建不覆盖它：`pnpm run build` 里没有测试 |
| `prd-admin` 的 **lint** | 只有本地 `pnpm lint`——`Admin Dashboard Build` 没有 lint 步骤（它只跑 Type check / Run tests / Build，而 `build` 就是 `tsc && vite build`） | **只能本地** | 本地即时 |
| `prd-desktop/src-tauri/**/*.rs` | CI 的 `Desktop Client Check` job 绿：`cargo check`（dev + release）、`cargo fmt --check`、`cargo clippy -- -D warnings` | 本地 或 Actions | 同在 `ci.yml` 里：**feature 分支 push 不会跑**，要开 PR 到 main/develop 或手动 dispatch |
| `prd-desktop` 前端 `.ts/.tsx` | tsc 与 vite build 由同一个 job 复核；**lint 与 vitest 只能本地**——那个 job 没有这两步，而 `prd-desktop/src` 下确实有五个测试文件 | tsc/build：本地或 Actions；lint/test：**只能本地** | tsc/build 同上一行（开 PR 或 dispatch 才跑）；lint 与 vitest 本地即时 |
| `cds/**` | **不止一条流水线**，用下面那条命令列全再逐条看（至少有 `CDS Build & Test`、专用的 `CDS CI`、所有分支都跑的 `CDS Prebuilt`，改到端口巡检相关文件还会多一条）。任一条绿都不代表其余绿 | 本地 或 Actions | 各条触发范围不同，以命令列出的为准 |
| `llmgw/**` | 编译有远端判据，两条：① 三家的镜像都在 `branch-image.yml` 里构建（`console-api` 跑 `dotnet publish`、`web` 跑 `pnpm build`），push 即触发；② `Server Build & Test` 也覆盖 `serving` **与 `console-api`**——前者直接在 `PrdAgent.sln` 里，后者虽不是 sln 的项目条目，但 `PrdAgent.Api.Tests` 对它有 `ProjectReference`，于是被传递编译、相关测试照跑（`ci.yml` 的 server 过滤器也含 `llmgw/console-api/**`）。**此外还有开 PR 才触发的检查**，用下面那条命令列全。其余校验见 `llmgw/AGENTS.md` | 本地 或 Actions | 见命令列出的各条 |
| 发布链路脚本与部分技能脚本 | CI 的 `Production Release Script Test` job 绿。它跑的是一份**显式清单**（`exec_dep.sh`、`scripts/lib/*`、`scripts/tests/test_*.py`、`*.test.mjs`、cdscli、周报/日报技能的脚本……），清单见 `ci.yml` 的 `release-script-test` path filter | 本地 或 Actions | 它在 `ci.yml` 里，所以**普通 feature 分支 push 不会跑**——要么开 PR 到 main/develop，要么手动 dispatch |
| Dockerfile | 已接线的那几个由镜像构建作业验：`prd-api` / `prd-admin` / `llmgw` 三家走 `branch-image.yml`；`cds/Dockerfile` 走 `cds.yml` 的 `Docker Build Check`（注意 `cds-prebuilt.yml` 建的是 `Dockerfile.dist`，验不到这一个） | Actions | `branch-image.yml` 由 push 触发、所有分支都跑；**`Docker Build Check` 在 `cds.yml` 里，feature 分支 push 不跑**——要开 PR 到 main/develop |
| `prd-video/**`、`docker-compose*.yml`、**不在上面那份清单里的** `scripts/**` 与技能脚本 | **没有任何 CI job 会验它们**（`grep -rn "prd-video" .github/workflows/` 零命中）——只能本地跑（模块自己的 `AGENTS.md` + AGENTS.md §5.2），跑不了就在交付里明说没验过 | 只能本地 | 本地即时 |
| 页面打得开、流程跑得通 | 预览域名上的真人路径 + 截图 | CDS 分支预览 | push 即部署 |
| 后端接口行为 | 预览域名上打真实端点、断言返回值 | CDS 分支预览 | push 即部署 |

**push 前能拿到的只有本地那一栏。** 后端三条权威判据全部在 push 之后才有结论——这不是
可以绕过的，是流水线的形状。所以 AGENTS.md §5.2「校验全绿才准 push」对 `.cs` 的落法是：
本地有 SDK 就先 build 一遍当 push 前门禁，没有就照推，**但 push 后必须回来看 Branch Image
与 CI 的结论，红了当场修**——「推完就不管」和「本地没 SDK 所以不验证」是同一种错。

CDS 在这张表里只负责**运行**，不负责编译：本仓库 `api-prd-agent` 走的是 express 模式，
`branch-image.yml` 的头注释写得很清楚——「把 prd-api / prd-admin 编译成 ghcr 镜像……
CDS 收到 workflow_run.completed 后按 SHA docker pull + run，**不再在 CDS 服务器本机编译**」。
所以「CDS 绿灯 = 编译通过」是隔了一层的推论：镜像得先绿，CDS 才拉得到。

## 二、Branch Image 绿 ≠ `dotnet build` 零 error

这条单独列出来，因为它最像对的、也最容易被当成终点。

`branch-image.yml` 走 `prd-api/Dockerfile`，里面只 `publish` **PrdAgent.Api 一个项目**，
**不编译 `PrdAgent.Tests`**。于是一个测试项目根本编译不过的提交，照样能拿到绿色的镜像。

**别把这条读成「镜像绿一律不算编译绿」**：它对 prd-api 成立，是因为那个 Dockerfile 恰好
只 publish 一个项目、把测试项目落在外面。`prd-admin/Dockerfile` 里跑的是
`pnpm run build`（= `tsc && vite build`），所以 Admin 镜像绿**就是**类型检查与打包的权威
结论，而且每次 push 都有——它只是不跑 vitest。一条流水线覆盖到哪为止，看它实际执行的
那条命令，不看它叫什么名字。

所以：

- 要说「API 能编出来」→ 引 Branch Image 的 run 号
- 要说「`dotnet build` 零 error」→ 只能引 `ci.yml` 的 `Server Build & Test`
- 要说测试→ 同上，但**那一档不是全量**：`ci.yml` 跑的是
  `--filter "Category!=Integration&Category!=Manual"`，而仓库里确实有这两类用例
  （`ImageGenIntegrationTests`、`ApiRequestLogTwoPhaseStorageTests` 等，它们要真
  MongoDB 与 ffmpeg，CI 上跑不了）。所以那个 job 绿只证明**非集成、非手工的 xUnit 全绿**。
  改动碰到那两类用例时，没有任何 CI 会验它——要么本地点名跑，要么在交付里明说这部分
  没验过。写成「xUnit 全量通过」就是在夸大。

  **点名跑，不要去掉 filter 全跑**：这一档不只是「要真 MongoDB 与 ffmpeg」那么无害。
  `ImageGenIntegrationTests` 会拿 `VVEAI_API_KEY` / `VOLCES_API_KEY` **真的去生图**——
  真实请求、真实费用、真实副作用；`ReferenceImageIntegrationTests`、
  `LlmResolutionGoldenIntegrationTests` 同样依赖真服务或线上数据。一句
  `dotnet test`（无 filter）会把与本次改动毫无关系的外部调用一起打出去，
  还会因为缺任一凭据而红在不相干的地方。所以按 `--filter FullyQualifiedName~<类名>`
  只跑你这次真的动到的那几条，并在交付里写清它要哪个凭据 / 哪个本地服务。

三者不许混着说。

## 三、feature 分支不自动跑 `dotnet test`，要自己触发

`ci.yml` 的触发条件是：

```yaml
on:
  push:         branches: [main, develop]
  pull_request: branches: [main, develop]
  workflow_dispatch:
```

在一条 feature 分支上，**没有任何东西会跑 xUnit**。新加的守卫从落地到合并之前
可以一次都没被编译过，更不用说跑过——它静静躺在那里，看上去像一层防护。

改了 `.cs`（尤其是新增或修改 `prd-api/tests/**`）之后，必须二选一：

1. **手动触发**：把 `ci.yml` dispatch 到当前分支，等它绿；
2. **开 PR 到 main/develop**，让 `pull_request` 触发。

做不到就明说「这批测试还没在 CI 上跑过」，不许写「测试全绿」。

**推论**：本仓库的 `PrdAgent.Tests` 不 `ProjectReference` `PrdAgent.Api`，被测的 Api 源文件
是靠 csproj 里的 `<Compile Include ... Link="..."/>` 一个个链进去的。新增被测文件忘了链
→ 编译不过 → 而 feature 分支没人跑 → 永远发现不了。加测试时连 csproj 一起改，
并按上面的方式真跑一次。

## 四、本地 SDK 是加速器，不是权威

本地能跑就先跑——**把编译交给 CI 是最慢的一种编译**，一轮往返十几分钟，而本地十几秒。

但要分清两种情况，别把这句话念成「本地永远不算数」：

- **第一节表里给出了远端判据的**（sln 编译、非集成非手工 xUnit、各家镜像构建……以表为准，
  别照这个括号背）：本地只是加速器，它让你更快发现错误，但「验证过了」这句话要引那条
  流水线的结论。注意「有判据」不等于「这次 push 就有结论」——第四列写的才是什么时候有。
- **第一节标着「只能本地」的**（Admin 与 Desktop 的 lint、Desktop 的 vitest、Integration /
  Manual 测试、清单外的脚本）：**本地跑绿就是它的验证结论**，没有第二个地方能给。
  交付里如实写清跑了哪条命令、结果如何即可，不必也不该去等一个不存在的远端绿灯。

`which dotnet` 是空的不等于机器上没有 SDK，它常装在 PATH 之外，断言之前先找一遍：

```bash
which dotnet || ls /opt/dotnet8/dotnet    # 有就 export PATH=/opt/dotnet8:$PATH
```

本地跑测试还要会读失败：`Category!=Integration&Category!=Manual` 这一档有大量用例依赖
真 MongoDB（27017/27018）与 ffmpeg，缺这两样会有两百来条「Connection refused」。
那是环境缺件不是回归——**判断有没有引入回归看失败原因，不看失败条数**。

找遍了确实没有，那就照第一节的表走远端，并且**不要在交付里提这件事**：
读你交付消息的人要知道的是判据和它的结论，不是你机器上装了什么。

## 五、交付话术

```
[缺] C# 本地仍没有 SDK，所以先用等价脚本核对了解析口径……
[缺] CDS 绿灯，编译通过
[缺] 测试全绿（其实 feature 分支没跑过 xUnit）

[有] C# 编译：Branch Image #6489 绿，镜像 sha-2df49f7 已产出（只覆盖 API 项目）
[有] C# 测试：手动触发 CI #8146 跑 dotnet test（非集成非手工那一档），28 条守卫全绿
[有] 页面：预览域名真人路径打开，双主题截图见下（或：截图未做，缺登录口令）
```

规矩很简单：**给判据的名字和它的结论，不给你的环境状态。**

## 六、自查清单（写「验证」两个字之前）

- [ ] 我说的每一句「通过了」，都指得出是哪条流水线的哪个 job 吗？
- [ ] 我有没有把 Branch Image 的绿，当成 `dotnet build` 或测试的绿？
- [ ] 我说的「测试全绿」，包含 Integration / Manual 吗？CI 那一档不跑它们。
- [ ] 改了 `.cs` 的话，`ci.yml` 在这条分支上真跑过吗（普通 feature push 不会跑——开 PR 到 main/develop 或手动 dispatch 才跑）？
- [ ] 新加的测试文件，csproj 里链进去了吗？它真的被编译过吗？
- [ ] 本地能跑的我先跑了吗（快），还是白等了一轮 CI？
- [ ] 我说的「lint 过了」是本地真跑的吗？没有任何 CI job 会跑 ESLint。
- [ ] 改的是脚本 / Dockerfile 吗？先去 `ci.yml` 的 `release-script-test` path filter 里查一眼它在不在清单里——在清单里就有远端判据，不在才是「只能本地」。
- [ ] 改的是 `cds/**` 吗？那里**至少**三条流水线（`CDS Build & Test` / `CDS CI` / `CDS Prebuilt`），改到端口巡检相关文件还会多一条——按触发条件现查一遍，别按固定条数收工；任一条绿都不代表其余绿。
- [ ] 我引用第一节那张表之前，`grep` 过 `.github/workflows/` 确认它还是对的吗？表是快照，流水线会增减。
- [ ] 交付叙述里还有「本地」「我这边」「环境没有」这类词吗？划掉之后还成立吗？
- [ ] 有哪一项确实没做到吗？我是明说了，还是含混过去了？

## 七、例外

只改这些的，不需要走上面任何一条：`doc/`、`.claude/rules/`、`changelogs/`、`README.md`、
纯注释，以及技能目录里的**纯元数据**（`SKILL.md`、`reference/` 下的说明文档）。

**技能目录不整个豁免**：`.claude/skills/` 底下有大量可执行脚本（`cdscli.py`、各技能的
`scripts/*.py|mjs`），它们在第一节的表里是有判据的——一部分在 `release-script-test` 的
清单里，其余只能本地跑。按文件类型判，不按目录判。

凡是改动可执行代码（`.cs` / `.ts` / `.tsx` / `.rs` / `.py` / `.mjs` / `.cjs` /
Dockerfile / docker-compose 等）一律要，无例外。

## 八、历史背景

三次，一次比一次深。

**2026-04-15**：AI 在沙箱里发现没有 dotnet，于是在交付里写「dotnet build 环境无 dotnet
SDK 未能运行；C# 代码已两次通读自审」，把编译验证转嫁给用户。本规则第一版由此诞生，
当时的结论是「用 CDS 兜底」。

**2026-08-30**：一处 Shouldly 重载（`ShouldContain(实际, 说明)` 必须写成 `customMessage:`，
否则解析到 `IEnumerable<char>` 那个重载）本地一编译就报，而当时判定「本地无 SDK、交给 CI」，
CI 六个 `error CS1503`、测试整步跳过，白烧一轮往返。教训：本地能跑就先跑。

**2026-09-15**：用户问「『C# 本地仍没有 SDK』这样的描述如何去掉，我们有 CDS 系统、
远程部署好了并且做了接入，为什么还参照本地来运行」。照这个问题回头查，发现的不只是措辞：

- 规则里「走 CDS 远端编译」这个事实已经过时——本仓库 prd-api 走 express 模式，
  编译早就搬到 GitHub Actions 了；
- 更糟的是，当时那条分支上新加的 14 条 xUnit 守卫**从落地起一次都没编译过**：
  `ci.yml` 在 feature 分支不触发，而 `branch-image.yml` 不编译测试项目，两条流水线
  恰好把测试项目漏在中间。手动 dispatch 一次，`error CS0234` 当场现形，
  连带又暴露出一条早就欠着的 `DataSyncScope` 涟漪。

所以这一版把参照系整个换掉：**不再讲「本地还是远端」，只讲「哪条判据、在哪跑、跑没跑」。**
措辞只是表层，参照系错了之后，连「验证过了」这句话本身都是空的。

## 九、与其他规则的关系

- `predicate-and-wiring-discipline.md` 形状 7（守卫自己没接上线）：第三节那件事就是它在
  仓库级别的实例——守卫写了、CI 有、但那条 CI 在这条分支上不跑。
- `external-cause-first.md`：「我本地没有 SDK」是内因，读的人要的是外因与结论。
  第五节的话术规矩是它在交付叙述上的落地。
- `cds-auto-deploy.md`：push 即部署，讲的是「运行」这一段；本条讲「编译与测试」那一段。
- `e2e-verification.md` / `real-visual-acceptance.md` / `closed-loop-acceptance.md`：
  第一节表里最后两行的展开——接口 200 不等于功能对，产物要真的出现在截图里。
- `AGENTS.md` §8.1（自测优先）：本条给出「自测跑在哪儿、凭什么说跑过了」的具体判据。
