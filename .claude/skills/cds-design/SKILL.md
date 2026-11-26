---
name: cds-design
description: CDS 设计（精准技能）。用户说「/cds-design」、「发布框架」、「帮我设计一个页面」、「为 xx 提出设计」、「改/修复 xx 页面的设计」、「出一版新设计」、「帮我实现 DSN-xxx」，或在 /cds 里说了设计相关的话时使用。这一轮的结果是发布到 CDS 的私有稿件和稿件地址；实现方按稿件的交接清单实现。不用于在稿件发布前直接改正式代码。
---

# CDS 设计（`/cds-design`）

> `/cds` 是范围技能：按 CDS 左侧菜单把一句话分到各个技能。设计相关的话都交到这里，本技能就是设计流程本身，不再跳转。
> 详细规则在核心技能的 `cds/reference/design-loop.md`（设计闭环）和 `cds/reference/design-intake.md`（接入与出稿）。两个技能装在同一个技能目录下。

## 一、先做两件事（每次都做）

1. **技能是最新的**：`node <技能根>/cds/scripts/skill-fresh.mjs`。用户说「获取最新代码」时也要跑：拉代码不会更新已经加载的技能。
   - 退出码 1 表示过期：按返回的新版路径加载文件。有归档地址时，按接入说明下载并核对摘要，在当前工作区更新后复用已有授权自检。
   - 通过「接入 CDS」安装的技能不在 git 里时，它对照 CDS 上的技能包版本。
   - 仓库里的 CLI 比线上 CDS 旧时也会报出来（设计发布自检会拒绝）：先改用仓库里更新的技能（main 或技能 PR 分支，用 `git archive` 取到仓库外的临时目录，不改当前分支）；需要更新技能包时，使用当前 CDS 接入说明提供的公开归档。
2. **有设计发布授权**：`cdscli setup-check --host <CDS 地址> --project <项目 ID> --design-access publish`。
   - 没有授权时，第一步只能是申请授权（`design-intake.md`），等用户在 CDS 里批准。
   - 不复制、不打印凭据。不知道 CDS 地址时问用户一次。

## 二、硬规则：这一轮的结果是 CDS 稿件地址

- 用户说设计（不管怎么说），结果必须是发布到 CDS 的私有稿件，并把稿件地址交给用户。
- 稿件发布之前不改正式代码。Artifact、本地 HTML 这些原型只是出稿过程，不能代替稿件。
- **应用框架是硬性条件，由门禁 G-10 判定**：
  - 原型用 `node <技能根>/cds/scripts/design/prototype-build.mjs --dir design/<目录> --checkout <正式仓库检出>` 在正式代码上构建：要演示的页面挂在正式的 AppShell 里，框架的壳、组件和令牌都来自正式代码；
  - 改动的正式文件放在 `src/overrides/`，在 `prototype.json` 登记；改动副本和原文件的差异就是交给实现方的源码差异；
  - 不手写 HTML，不自己抄一份令牌；
  - `spec/rules.md` 里的每条框架规则（R-xx）都要有通过的自检项，不能登记为例外。
- 用户同时要求实现时，先发布稿件，再按这份稿件的 `交接清单.md` 实现（见第四节）。

## 发布框架

1. 回读接入清单，确认项目中的框架编号和最新版。首发的 `expectedVersion` 为 0，续版沿用原框架编号。
2. 用现有设计发布授权调用 `cdscli framework publish` 或 MCP `cds_design_framework_publish`。回读框架版本、材料和来源。
3. 试用时在稿件中指定框架版本。项目默认版本按[框架采用流程](../cds/reference/design-intake.md#发布框架)切换。

## 三、设计（设计方）

按 `cds/reference/design-loop.md` 第一到第五节做，顺序固定：

1. **找到稿件**：读设计接入清单，按 `designKey`（`<模块>/<稿件>`）匹配。匹配到就同稿续版，没有就新建（`cdscli design scaffold`）。
2. **从 CDS 读上下文**：未关闭的评论、实施反馈、验收结果、实施基线。用户没说的不靠猜。
3. **出稿**：
   - 原型用 `prototype-build.mjs` 在正式代码上构建（见第二节），新稿件从 `cdscli design scaffold` 开始，它会生成 `prototype.json` 和入口；
   - `design.json` 写 `goals`（每个目标写「怎么算做到」和它的验收项）、验收项（带 `slots`）、画面清单（真实页面的 `impl` 地址）、演示数据（`demoData`）；
   - 从接入清单的 `acceptancePolicy` 读取方法和维度。填完 `acceptancePlan`、每条规则的 `dimension`，为没有规则的维度说明不适用理由。脚手架里的待定选项须根据稿件内容确认。
   - 源码差异要能在正式基线上直接编译。
4. **门禁**：`node <技能根>/cds/scripts/design/release.mjs check --dir design/<目录>`。
   - 跑门禁 G-01 到 G-11，同时生成 `交接清单.md`；
   - G-11 回执给出缺项字段和规则编号。按业务依据补齐后重新预检，随后用同一稿件身份发布。
5. **私有发布**：`cdscli design publish --private`，回读核对版本和来源提交。
6. **登记**：`release.mjs register --dir design/<目录> --commit <来源提交>`。它会打印稿件地址。
7. **程序交接检查**：`cdscli design handoff <稿件编号> --version <版号>`。记录固定版本回执，失败的入口和关键交互在同稿修正后重验。设计库封面由 CDS 从原型生成，交付包省略封面截图。
8. **交接**：在实施反馈线程回复，指向 `交接清单.md`，请实现方按验收项编号逐条回复。交接只走 CDS，不让用户转述。

## 四、实现（实现方：`/cds-design 实现 DSN-xxx`）

按 `cds/reference/design-loop.md` 第六节做：

1. 先核对固定版本的交接通过回执，按 `交接清单.md` 第五节逐条回复验收项编号；
2. 定实施基线，整份应用源码差异；
3. 用稿件的演示数据取证；
4. 跑验收（`/cds 跑 DSN-xxx 的验收`）；
5. 请设计方复核。

## 五、告诉用户（最多五行）

1. 稿件地址；
2. 版本和门禁结果；
3. 这一版解决了什么（来自目标）；
4. 交接清单是否已在 CDS 上交给实现方；
5. 还要用户做的事（例如在 CDS 批准授权、定稿）。
