# 角色技能套装 · 设计

> **版本**：v1.0 | **日期**：2026-07-28 | **状态**：已落地

**一句话**：外部用户搜岗位搜不到技能、装完二十个也不知道从哪开始，本文用角色套装解决这两层问题。
**谁该读**：做技能对外分发的产品与工程师。
**读完能做什么**：说清套装怎么按角色打包与引导。

---

## 一、管理摘要

**解决什么问题**：海鲜市场已经能把本仓库的优质技能虚拟上架、匿名下载，但外部用户（尤其非技术角色）拿到的是「一堆按功能分类的散装技能」——搜「产品经理」搜不到东西，装完二十个技能之后面对空仓库不知从哪开始。技能是零件，缺的是把零件串成工作方法的机床。

**当前决策**：加两层——

1. **角色套装（bundle）**：声明式清单，一条 curl 装齐一个角色需要的全部技能，与技能共用 `official-{key}` 匿名下载通道。
2. **`sdd-init` 入口技能**：装完套装后跑一次，把 CLAUDE.md 规则骨架、`doc/` 七类文档骨架和角色路线图落到用户自己的项目里。

**代价与边界**：套装内容是提交期静态声明，不支持用户自定义组合；首批落地 `pm-starter`（产品经理），`dev-starter`（开发）与 `qa-starter`（测试/验收）已于 2026-07-28 补齐，三者均含 `sdd-init` 与角色专属技能清单，不再是仅有角色标签、没有套装。

**为什么不新增数据库集合**：套装复用既有的虚拟注入机制（不入库、部署即更新），新增一个集合会带来迁移、seeder、上传对象存储一整套维护成本，而套装内容本就该随代码版本走。

## 二、背景

改动前的事实（均已核对代码）：

| 能力 | 状态 |
|---|---|
| 打包链路 | `scripts/bundle-official-skills.mjs` → 内嵌 JSON → 虚拟注入市场，已通 |
| 匿名下载 | `GET /api/official-skills/{key}/download`，无鉴权，已通 |
| 技能依赖 | 硬编码在 Controller 的 `BundledSkillDependencies`，2 条，对外不可见 |
| 角色维度 | 无 |
| 套装 | 无 |
| 落地适配 | 无 |

另一个被忽略的事实：白名单是按「可移植性」挑的，不是按「角色价值」挑的，导致对产品经理最值钱的四个技能（`product-document-generator` / `plan-first` / `doc-writer` / `flow-trace`）明明零仓库绑定，却一个都没上架。

## 三、方案

### 3.1 三层结构

```
声明层   scripts/skill-bundles.json      角色标签 + 套装清单 + 技能依赖（唯一事实源）
   ↓  提交期生成 + 强校验
数据层   official-skills.generated.json  catalog v3：skills[] 带 roles/requires，新增 bundles[]
   ↓  EmbeddedResource 编进 API 镜像
服务层   OfficialSkillsController        套装合并打包、依赖递归展开、匿名 bundles 列表
         OfficialMarketplaceSkillInjector 套装作为市场一等条目注入（排在散装技能之前）
```

### 3.2 关键决策

**依赖表从代码搬到声明层**。原先 Controller 里硬编码的 `BundledSkillDependencies` 改由 catalog 的 `requires` 驱动，与套装共用同一套递归展开逻辑（`ExpandWithRequires`）。一处声明，单技能下载和套装打包都受益。

**套装与技能共用下载命名空间**。`/api/official-skills/{key}/download` 同时接受技能 key 和套装 key，前端、`findmapskills`、curl 全都不用分叉。代价是 key 可能相撞——由打包脚本在提交期强校验拦住，运行时不会出现。

**套装 DTO 形状与技能 DTO 对齐**。市场卡片不用分叉渲染，靠 `kind = "bundle"` 和 `includes` 区分。

**角色标签由后端下发**。前端不维护 `pm → 产品经理` 的映射表（对齐 `frontend-architecture` 的单一数据源原则），走匿名端点 `GET /api/official-skills/bundles` 取 `roleLabels`。

### 3.3 套装 zip 的结构

```
pm-starter.zip
├── INSTALL.md              解压后看到的第一份说明：装到哪、下一句说什么、这套里有什么
├── bundle.manifest.json    机器可读清单（key/version/roles/skills）
├── sdd-init/               ← 入口技能
├── skill-validation/
└── ...（其余成员技能，各自的 requires 已递归展开）
```

## 四、目标体验

外部用户三步，全程不需要注册账号、不需要 API key：

```
curl -sSLo pm.zip "https://<域名>/api/official-skills/pm-starter/download"
SKILLS_DIRS=$(for h in .claude .cursor .agents; do [ -d "$h" ] && printf '%s/skills ' "$h"; done); [ -n "$SKILLS_DIRS" ] || SKILLS_DIRS=.agents/skills
for d in $SKILLS_DIRS; do mkdir -p "$d" && unzip -o pm.zip -d "$d"; done
```

打开你的 AI 编码工具，说：`/sdd-init`。上面第二、三行是项目级多宿主安装的标准写法（`.claude` / `.cursor` / `.agents` 存在几个装几个，不写用户主目录），与全仓统一的技能安装位置约定同源。

API key 只在「往市场上传技能」时才需要，不挡在门口。

## 五、`sdd-init` 的职责

| 阶段 | 做什么 |
|---|---|
| 探测 | 项目根、是否 git、已有骨架、已装技能、项目类型；能推断的一律不问 |
| 提问 | 最多 2 个（项目一句话简介、文档目录），其余用默认值 |
| 生成 | `CLAUDE.md`（八条核心规则）、[doc/rule.doc.naming.md](./rule.doc.naming.md)、第一份 `spec.*`、`changelogs/` |
| 报告 | 已生成 / 已跳过 / 已装技能 / 缺什么 / 下一步做什么（具体到敲哪个命令） |

硬约束：不覆盖已有文件、探测不到就写「待补」不编造、生成内容禁 emoji。

八条核心规则是从本仓库四十余条规则里选出的最小可用集：先方案后动手、完成的标准是跑通、自测优先、文档七类前缀、变更记录碎片、不许空白等待、验收必须闭环、不假定不存在的能力。一次给外部用户四十条规则等于零条。

## 六、校验与自测

| 层 | 手段 |
|---|---|
| 提交期 | `bundle-official-skills.mjs` 校验：套装引用的技能存在、套装 key 不与技能 key 相撞、角色已定义、依赖不悬空、无自依赖；任一失败 exit 1 |
| 端到端 | `scripts/test-official-skill-bundles.mjs` 在 Node 里等价重放后端组装逻辑：真解压到临时目录，断言每个技能有 SKILL.md、frontmatter `name` 等于目录名、分发内容零 emoji、入口技能在位；含三个负向用例验证校验真的会拦 |
| 后端 | `OfficialSkillCatalogTests` 覆盖套装注册、key 不撞、成员齐全、zip 含 INSTALL.md、fork 返回套装下载地址、套装排在散装之前、成员都带角色 |

## 七、已知边界

见 [doc/debt.skill.role-bundle.md](./debt.skill.role-bundle.md)。

## 八、关联

- [doc/design.skill.marketplace-open-api.md](./design.skill.marketplace-open-api.md) —— 海鲜市场开放接口
- [doc/design.skill.unified-skill-system.md](./design.skill.unified-skill-system.md) —— 技能系统领域边界
- [doc/debt.platform.md](./debt.platform.md) —— 对外产物 de-emoji（本次落了第一步）
- `.claude/skills/sdd-init/SKILL.md` —— 入口技能
- `scripts/skill-bundles.json` —— 角色与套装事实源
