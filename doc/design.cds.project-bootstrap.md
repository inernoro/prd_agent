# CDS 项目初始化（Project Bootstrap） · 设计

> **版本**：v1.0 | **日期**：2026-07-28 | **状态**：草案

**一句话**：帮外部团队从零建项目：不要求对方注册内部平台，走一条从提示词到技能到规则骨架的完整路。
**谁该读**：做对外交付的产品与工程师。
**读完能做什么**：说清外部用户拿到的是一整套还是一堆散件。

---

## 一、管理摘要

**解决什么问题**：我们要帮别人（产品经理、老板、非技术团队）从零建项目时，对方接不进 MAP——MAP 是我们的内部平台，让客户注册账号才能拿技能是不成立的。但所有人都要上 CDS 拿云端预览。**CDS 天然就是那个中介**。

现在 CDS 的「接入智能体」弹窗里有三个孤立的 tab：给你一段提示词、给你一个技能压缩包、给你一个外链。没有一条路是走到黑的——用户拿到提示词之后，方法论技能一个都没装，规则和文档骨架也不会自己长出来。

**当前决策**：在 CDS 加一栏「项目初始化」，产出**一条命令 + 一句话**：

- 一条命令：CDS 现场生成的引导脚本，真的把 CDS 技能包 + 方法论套装装到对方项目里
- 一句话：`/sdd-init`，由技能接手生成 AGENTS.md、`doc/` 七类骨架、新人引导路线图

**关键取舍**：技能内容的事实源留在 MAP，CDS 只做代理和缓存。对方只需要记住一个域名（CDS），但技能内容不会出现两份、不会漂移，自托管的 CDS 也能用。

**这不是新造轮子**：CDS 已经有弹窗、有提示词生成器、有技能打包端点，MAP 已经有匿名技能分发和角色套装，`sdd-init` 骨架生成器也已就位。本设计是把这些零件串成一条路。

## 二、背景

### 2.1 现有零件盘点

| 零件 | 位置 | 现状 |
|---|---|---|
| 接入智能体弹窗 | `cds/web/src/components/SkillDownloadDialog.tsx` | 三个 tab：自动接入 / 手动安装 / 海鲜市场 |
| 任务提示词生成器 | `cds/web/src/lib/agent-onboarding.ts` | `buildCdsAgentPrompt` + 24 个 mission 注册表 |
| CDS 技能打包 | `GET /api/export-skill` | 打 tar.gz 发 5 个 CDS 技能 |
| MAP 匿名技能分发 | `GET /api/official-skills/{key}/download` | 无需账号，已验证可用 |
| MAP 角色套装 | `GET /api/official-skills/bundles` | `pm-starter` 等，含依赖递归展开 |
| 骨架生成器 | `.claude/skills/sdd-init` | 生成 CLAUDE.md、doc 七类骨架、路线图 |

### 2.2 缺口

1. **三个 tab 互不相连**。用户复制走提示词之后，方法论技能一个没装——提示词不会自己装技能。
2. **没有「整体初始化」这个概念**。24 个 mission 全是单点任务（部署、排障、发布），没有「从零把一个项目立起来」。
3. **`export-skill` 依赖本地源码**。它从 `config.repoRoot/.claude/skills` 现场打包，客户自托管的 CDS 上没有这个目录，这条路直接断。
4. **规则靠提示词传递必然漂移**。把 AGENTS.md 全文塞进提示词是复制粘贴规则，改一次要通知所有人重新复制。`findmapskills` 已经吃过这个亏——SKILL.md 一份、`OfficialSkillTemplates.cs` 一份，代码注释至今写着「两边都要改」。

### 2.3 为什么不是「写一份更长的提示词」

一份四千字的初始化提示词看起来很全，但：提示词越长 AI 执行漂移越大；无法版本化；改一次全员重新复制；最关键的是**它只能描述「去装技能」，不能真的装**。

结论：**提示词退化成一句话，内容沉淀成技能包。**

## 三、目标与非目标

**目标**

1. 任何一个空项目，两步之内拥有：方法论技能、harness、SDD 文档骨架、协作规则、新人引导。
2. 对方只需要记住 CDS 一个域名，不需要 MAP 账号。
3. 规则和技能跟着版本走，改一次全世界生效。
4. 自托管 CDS 同样可用。

**非目标**

1. 不做技能的自定义勾选组合（走预设，见债务 D2）。
2. 不替代 `cdscli connect` 的项目授权流程，初始化脚本只装技能，授权仍走页面批准。
3. 首版不做 Windows 原生脚本（走 WSL / Git Bash）。
4. 不在初始化阶段生成任何业务代码。

## 四、方案决策

### 4.1 分发架构：CDS 代理 MAP + 缓存兜底

| 方案 | 优点 | 代价 | 采用 |
|---|---|---|---|
| CDS 代理 MAP | 单一入口；内容单一事实源；自托管可用 | 首次拉取依赖 MAP 可达 | 是 |
| 脚本直接 curl MAP | 改动最小 | 对方依赖两个域名；「CDS 才是对外系统」的定位不成立 | 否 |
| CDS 自带一份技能 | 完全自足 | 两处维护必然漂移，已有前科 | 否 |

代理的具体行为：

- 回源 `${MAP_BASE}/api/official-skills/...`，`MAP_BASE` 走 CDS 配置，默认公共 MAP，自托管客户可指向自己的实例
- 命中缓存直接返回；未命中回源并落缓存
- **MAP 不可达但有缓存**：返回缓存，响应头标注为陈旧，脚本照常安装并提示「用的是本地缓存版本」
- **MAP 不可达且无缓存**：明确报错说清楚「拉不到技能，不是你的项目有问题」，不静默降级、不装半包

这条兜底是必须的：客户现场装环境时网络最不可控，而「装到一半失败且不说为什么」是最伤的体验。

### 4.2 产物形态：一条命令 + 一句话

不是一段提示词，是两个可执行动作。命令负责「把东西装进来」，提示词负责「把东西用起来」，职责不混。

### 4.3 规则沉淀为技能，不写进提示词

从现有初始化提示词里萃取出真正有价值的四样，做成一个 `phase0-guard` 技能随套装分发：

1. **Phase 0 边界**：明确允许做什么、禁止做什么，防止 AI 一上来就编数据库实体和业务 API
2. **六段式回复规范**：一句话结论 / 对业务意味着什么 / 当前进度 / 需要你决定 / 风险和边界 / 下一步
3. **术语翻译表**：Git、Commit、Deploy、Preview、Key 等的大白话对照
4. **文档读者分层**：老板 30 秒、产品经理 3 分钟、技术人员再往下看

这四样是那份提示词里真正值钱的部分，值得保留；但它们该以技能形态分发，不该以复制粘贴形态传播。

## 五、架构

```
客户的空项目
     │
     │  一条命令
     ▼
CDS  GET /api/bootstrap/{preset}          现场生成引导脚本（内嵌 CDS host + preset）
     │
     ├─ GET /api/export-skill              CDS 自己的 5 个技能（已有）
     └─ GET /api/skills/{key}/download     代理 MAP + 缓存兜底（新增）
              │
              └──回源──> MAP /api/official-skills/{key}/download（匿名，已有）
     │
     ▼
项目级技能目录（.claude/skills 或 .agents/skills 或 .cursor/skills）
     │
     │  一句话：/sdd-init
     ▼
AGENTS.md / CLAUDE.md + doc 七类骨架 + changelogs + 新人引导路线图
```

### 5.1 引导脚本契约

脚本由 CDS 生成，必须满足「快启动零摩擦」纪律：大包大揽、依赖自检、失败给平台特定命令。

执行顺序：

1. **依赖自检**：`curl` / `unzip` / `tar`。缺失时给 Debian、RHEL、macOS 三种安装命令让用户复制，不是丢一句「请安装」。
2. **探测宿主技能目录**：`.claude/` `.cursor/` `.agents/` 三个宿主**存在几个装几个**（不是取第一个命中的——早期首命中写法会让同时装了多个 Agent 的仓库出现「装完了但当前 Agent 看不见」），一个都没有时兜底建 `.agents/skills`。可用 `--skills-dir` 覆盖。**默认项目级**——装到用户级的话，人一走团队什么都没有。
3. **装 CDS 技能包**（5 个，走匿名的 `cds-pack` 端点——已有的 `export-skill` 需要登录，而客户此刻还没有凭据）
4. **装方法论套装**（按预设）
5. **写种子文件** `.cds/bootstrap.json`：预设、CDS 主机、技能目录、安装时间、装了哪些技能。`sdd-init` 读它来判断角色和上下文。
6. **打印下一步**：明确告诉用户下一句对 AI 说什么。

硬约束：脚本不含任何密钥；不改 shell profile、不改 PATH、不写用户主目录；重复执行幂等（覆盖技能目录，不碰 AGENTS.md 等用户文件——那是 `sdd-init` 的职责）。

### 5.2 关于 `curl | sh`

管道执行有供应链风险，UI 上**默认展示两步版本**（先下载、可阅读、再执行），管道版作为折叠起来的快捷方式。给非技术用户的默认必须是安全的那个。

### 5.3 预设清单

| 预设 | 给谁 | 装什么 | 之后 |
|---|---|---|---|
| `pm-project` | 产品经理或老板主导的新项目 | CDS 技能包 + `pm-starter` + `phase0-guard` | `/sdd-init` |
| `cds-only` | 只想接 CDS，不要方法论 | CDS 技能包 | `cdscli connect` |
| `dev-project` | 开发主导的新项目 | CDS 技能包 + `dev-starter` | `/sdd-init` |
| `qa-project` | 测试或验收主导的项目 | CDS 技能包 + `qa-starter` | `/sdd-init` |

四个预设已全部落地（`phase0-guard` 含在三个角色套装里）。

### 5.4 CDS 新栏交互

`SkillDownloadDialog` 增加「项目初始化」tab 并**排在第一位**——从零建项目是新用户最常见的入口，把它藏在第四个位置等于没有。

这一栏展示：预设选择卡片（默认 `pm-project`）、这个预设会装什么（技能清单实时从代理端点拉，不硬编码）、两步命令、下一句提示词。

遵守 CDS 前端纪律：颜色只走主题 token（双主题都要看一遍）、z-index 查表、内容填满画布。

## 六、接口设计

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /api/bootstrap/{preset}` | 匿名 | 返回引导脚本（`text/x-shellscript`），内嵌 CDS 主机与预设 |
| `GET /api/bootstrap/presets` | 匿名 | 预设清单，供 UI 渲染 |
| `GET /api/skills/{key}/download` | 匿名 | 代理 MAP 技能/套装，带缓存与陈旧标记 |
| `GET /api/skills/bundles` | 匿名 | 代理 MAP 角色套装清单 |
| `GET /api/skills/cds-pack/download` | 匿名 | CDS 自己的五个技能，本地优先、缺失回源上游公共 CDS |

匿名是有意的：客户在拿到任何凭据之前就要能装技能。真正需要授权的是 CDS 项目绑定，那一步仍走页面批准，不因为这里匿名而放宽。

## 七、验收标准

1. 一台干净机器、一个空目录，两步之内拿到完整 harness，全程不需要 MAP 账号。
2. 断开 MAP 之后重跑：命中缓存能装成功并提示用的是缓存版本；无缓存时明确报错说清原因。
3. 三种宿主目录（`.claude` / `.agents` / `.cursor`）都能正确识别。
4. 重复执行两次，用户已有的 AGENTS.md 和文档不被覆盖。
5. 自托管 CDS（无本地 `.claude/skills`）走代理端点仍能装到方法论套装。
6. 生成脚本内零密钥，执行后 shell profile 与用户主目录无改动。

## 八、风险与已知边界

见 [doc/debt.cds.md](./debt.cds.md)。

## 九、关联

- [doc/design.skill.role-bundle.md](./design.skill.role-bundle.md) —— 角色套装与 `sdd-init`
- [doc/design.skill.marketplace-open-api.md](./design.skill.marketplace-open-api.md) —— MAP 技能开放接口
- `.claude/rules/quickstart-zero-friction.md` —— 引导脚本的大包大揽纪律
- `.claude/rules/anti-detour.md` —— 少绕路：能一步做完不让用户走多步
- `.claude/rules/cds-theme-tokens.md` —— CDS 前端双主题与 z-index 纪律

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 | 作用 |
|------|------|------|
| 九、关联 | `cds/web/src/components/SkillDownloadDialog.tsx` | 接入智能体弹窗 |
