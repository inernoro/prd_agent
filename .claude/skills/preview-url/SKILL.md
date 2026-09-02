---
name: preview-url
description: 调 cdscli 读取当前分支在 CDS 实际发布的预览验收地址。默认零参数；项目归属与作用域判定在服务端完成，多项目仓库逐行输出 [项目 · 入口] URL，API 不可用时明确失败。AI / 任何 skill 一律不得自己 slugify 或猜测 host。触发词:"预览地址"、"验收地址"、"preview url"、"/preview"。
---

# 预览验收地址生成

> **版本**：v1.2.0 | **状态**：已落地 | **触发**：`/preview`、"预览地址"、"验收地址"、"preview url" | **运行时 SSOT**：服务端 `POST /api/preview-dispatch`（老版本 CDS 回退 `GET /api/branches` 的 `previewUrl` / `previewUrls`）

唯一执行入口：

```bash
python3 <当前项目技能根>/cds/cli/cdscli.py --human preview-url
```

默认零参数。可选 `--changed-since <ref>`：按「相对该 ref 的改动」把结果收窄到真正被波及的项目；不给就列出全部可见项目的入口。技能根必须按当前宿主的实际项目级安装位置解析：Codex / 通用 Agent Skills 通常是 `.agents/skills`，Cursor 是 `.cursor/skills`，Claude Code 是 `.claude/skills`。禁止在不知道宿主时硬编码某一个目录。

`cdscli` 会读取当前项目 `.cds/credentials.json` 中的项目级连接，把仓库、分支（以及可选的改动清单）交给 CDS，由**服务端**判定项目归属与作用域。只有一个入口时输出一行；多个入口逐行输出。

一个仓库可以同时喂多个 CDS 项目，同名分支天然可以属于好几个 —— 所以「我属于哪个项目」这件事**客户端不再推算**。多项目命中时每行带上项目名：

```
[MAP] https://<入口>/
[CDS Self] https://<入口>/
```

某个项目有多个入口时，标签展开成 `[项目名 · 入口名]`，避免同项目两行同名分不出该点哪个。

## 触发词

- "预览地址" / "验收地址" / "preview url" / `/preview`

## 为什么强制走 cdscli

CDS 的预览路由、根域、多入口和项目别名都是运行时状态。入口按公开 `previewDomain` 上实际发布的逻辑表面计算，不按根域数量计算：同一公开域名可同时有主应用、模型网关控制台以及其他声明了 `cds.subdomain` 的独立服务入口。`rootDomains` 可能包含隐藏、备用或内部域名，API 与 Agent 都不得向用户暴露。`computePreviewSlug` 只负责后端内部 slug，不能证明某个公网 URL 已发布。对 Agent 而言，预览地址的唯一事实来源是 CDS API 返回的 `previewUrl` / `previewUrls`。

`cdscli preview-url` 的内部决策：

1. 加载项目级 CDS 连接上下文。
2. `POST /api/preview-dispatch`：只交仓库、分支与可选改动清单；服务端算出「本次波及哪些项目、各自有哪些已发布入口」，并与 push 分发共用同一份作用域判据。可见性由服务端按凭据过滤（项目级凭据只看得到自己那个项目）。
3. 直接输出服务端给的地址行。取不到地址时**分三种情形说清**：本次与该项目无关 / 波及但 CDS 上还没有这条分支 / 分支在但还没有已发布入口 —— 不压成一句「取不到地址」。
4. 服务端不支持该端点（老版本 CDS）才回退到 `GET /api/branches` 匹配当前分支的旧路径。
5. 缺凭据、API 异常、地址字段缺失时直接失败，不输出推算值。

**任何 skill / 文档 / commit message 都不得**：
- 手写 `tr '/' '-'` / 在脑子里 slugify
- 拼 `${BRANCH_ID}.miduo.org`（v1 老公式）
- 拼 `${projectSlug}-${branchSlug}.miduo.org`（v2 老公式）
- 写自己的 Python `slugify` 函数

## 历史公式

- v1（2026-04 之前）：`${branchSlug}.miduo.org` — legacy
- v2（2026-04-26 ceb2c01）：`${projectSlug}-${branchSlug}.miduo.org`
- v3（2026-04-27 起）：`${tail}-${prefix}-${projectSlug}.miduo.org`

这些只是历史说明，不是 Agent 生成 URL 的授权。新地址只能从 CDS API 取得。

## 多入口输出

CDS API 若返回两个真实入口，human 模式会保持 CDS 顺序逐行打印。比如本系统至少可能在同一个公开域名体系下同时返回主应用与 `llmgw-web` 模型网关控制台；这两条是不同逻辑入口，不是两个 `rootDomains` 的同义词。隐藏、备用或内部域名不得出现在输出中。给用户交付时所有公开入口都要列出，并按各入口的真实路由追加对应深链。不得只选一条，也不得给模型网关错误追加主应用页面路径。

## 输出格式（回复里这样贴）

```markdown
【预览】<cdscli 输出的第 1 个实际地址>{功能页深链}
【预览】<cdscli 输出的第 2 个实际地址>{功能页深链}
```

涉及具体页面路径时：

```markdown
**验收路径**:
1. 打开上述每个 CDS 实际入口的 `{page-path}`
2. {具体验收步骤}
```

## 注意事项

1. 项目安装 CDS 技能包或完成右上角快速接入后，`preview-url` 必须同时可发现；缺失即接入未完成。
2. 代码 push 后交付消息必须调本技能并包含【预览】行。
3. CDS 还在构建/部署中时，先等待 CDS Deploy 就绪再重试；命令失败时如实报告，禁止补一个推算 URL。
