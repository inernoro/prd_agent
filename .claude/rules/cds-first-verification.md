# 验证的权威位置（编译与测试各在哪里被证明）

**一句话**：每种改动的验证都有一个唯一权威位置，把它说清楚——「我本地有没有 SDK」是工作环境细节，不该出现在交付叙述里，更不能当成验证做没做的理由。
**什么时候撞上**：改了可执行代码，准备说「验证过了 / 编译通过 / 测试全绿」的时候。

> 判定口诀：**把「本地」两个字从你那句交付叙述里划掉，这句话还站得住吗？**
> 站不住，说明你交出去的是环境状态，不是验证结论。

---

## 一、这个仓库的验证权威位置

每一行都要能被第三个人照着核一遍，不需要问你。

| 改了什么 | 权威判据 | 在哪跑 | feature 分支会自动跑吗 |
|---|---|---|---|
| `prd-api/**/*.cs`（API 项目能不能编出来） | **Branch Image workflow 绿**，产出 `sha-<commit>` 镜像 | GitHub Actions `branch-image.yml` | 会，每次 push |
| `prd-api` 整个 sln 编译 + xUnit 全量 | **CI workflow 的 `Server Build & Test` job 绿** | GitHub Actions `ci.yml` | **不会**（见第三节） |
| `prd-admin` 的 tsc / lint / vitest | 本地 `pnpm` 跑一遍即可（快），CI 的 `Admin Dashboard Build` 是复核 | 本地 或 Actions | 同上 |
| 页面打得开、流程跑得通 | 预览域名上的真人路径 + 截图 | CDS 分支预览 | 会，push 即部署 |
| 后端接口行为 | 预览域名上打真实端点、断言返回值 | CDS 分支预览 | 会 |

CDS 在这张表里只负责**运行**，不负责编译：本仓库 `api-prd-agent` 走的是 express 模式，
`branch-image.yml` 的头注释写得很清楚——「把 prd-api / prd-admin 编译成 ghcr 镜像……
CDS 收到 workflow_run.completed 后按 SHA docker pull + run，**不再在 CDS 服务器本机编译**」。
所以「CDS 绿灯 = 编译通过」是隔了一层的推论：镜像得先绿，CDS 才拉得到。

## 二、Branch Image 绿 ≠ `dotnet build` 零 error

这条单独列出来，因为它最像对的、也最容易被当成终点。

`branch-image.yml` 走 `prd-api/Dockerfile`，里面只 `publish` **PrdAgent.Api 一个项目**，
**不编译 `PrdAgent.Tests`**。于是一个测试项目根本编译不过的提交，照样能拿到绿色的镜像。

所以：

- 要说「API 能编出来」→ 引 Branch Image 的 run 号
- 要说「`dotnet build` 零 error」或「测试全绿」→ 只能引 `ci.yml` 的 `Server Build & Test`

两者不许混着说。

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
但它的地位只到这里：它让你更快发现错误，它不构成「验证过了」这句话的依据。

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
[有] C# 测试：手动触发 CI #8146 在本分支跑 dotnet test，28 条守卫全绿
[有] 页面：预览域名真人路径打开，双主题截图见下（或：截图未做，缺登录口令）
```

规矩很简单：**给判据的名字和它的结论，不给你的环境状态。**

## 六、自查清单（写「验证」两个字之前）

- [ ] 我说的每一句「通过了」，都指得出是哪条流水线的哪个 job 吗？
- [ ] 我有没有把 Branch Image 的绿，当成 `dotnet build` 或测试的绿？
- [ ] 改了 `.cs` 的话，`ci.yml` 在这条分支上真跑过吗（自动不会跑）？
- [ ] 新加的测试文件，csproj 里链进去了吗？它真的被编译过吗？
- [ ] 本地能跑的我先跑了吗（快），还是白等了一轮 CI？
- [ ] 交付叙述里还有「本地」「我这边」「环境没有」这类词吗？划掉之后还成立吗？
- [ ] 有哪一项确实没做到吗？我是明说了，还是含混过去了？

## 七、例外

只改这些的，不需要走上面任何一条：`doc/`、`.claude/skills/`、`.claude/rules/`、
`changelogs/`、`README.md`、纯注释。凡是改动可执行代码（`.cs` / `.ts` / `.tsx` /
`.rs` / `.cjs` / Dockerfile / docker-compose 等）一律要，无例外。

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
