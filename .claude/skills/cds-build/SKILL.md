---
name: cds-build
description: 实现 CDS 中获准的设计稿。用户说「/cds-build 帮我实现 DSN-xxx」、粘贴交付页复制的实施提示词，或用 /cds 要求按稿件实现时使用。按已锁定版本读取私有交付、完成代码和验收，并在 CDS 原处回填证据。
---

# 按 CDS 稿件实现

## 1. 接入当前项目

- 从输入提取稿件编号和可选版本。稿件链接用于定位既有 CDS 实例、项目和固定版，编号或项目冲突时先核对。只有编号时使用当前仓库已绑定的 CDS 项目。
- 加载同一技能包的 `cds` 技能。直接从仓库加载时，核心说明在 `.claude/skills/cds`。根据稿件所属实例和项目打开 `<CDS 地址>/api/agent/setup.md?target=existing&project=<项目 ID>&skills=cds-build`。缺少技能或版本过旧时，按接入说明下载、校验完整归档并安装到当前工作区。
- 在当前工作区用 `cdscli --workspace-credential setup-check --host <CDS 地址> --project <项目 ID> --skills cds-build --design-access read` 自检。已有该项目的设计只读权限时直接继续。缺少所需权限时，运行 `cdscli --workspace-credential connect --host <CDS 地址> --project <项目 ID> --design-access read --agent <智能体名称>`。系统所有者在项目列表右下角「授权申请」核对项目与智能体，点击「批准设计只读」。等待中断时，在同一工作区重跑原接入命令继续领取，保存后再次自检。
- 主机绑定冲突时，用 `cdscli auth inspect --strict` 脱敏核对凭据来源、主机和项目。目标是另一台 CDS 时，保留原绑定，在目标仓库的独立工作区按该实例的说明继续。
- 当前工作区已有可用的普通项目绑定但缺少设计权限时，保留原绑定，在同一仓库的独立工作区自检并按需申请。
- 凭据已吊销时停止申请，请系统所有者在「项目列表 → 项目操作 → Agent Key → 已签发密钥」核对原项目的撤销记录。仍获授权的项目成员可在原稿同版「交付 → 反馈」接续。
- 用 `cdscli --workspace-credential design intake --project <项目>` 或已确认绑定同一凭据的 MCP 查找精确 `designId`。后续的 CLI 读稿和反馈命令均带 `--workspace-credential`，继续使用已通过自检的工作区绑定。

## 2. 固定实施目标

- 使用接入清单的 `implementationTargetVersion`。历史实例尚无此字段时，从 `upgrade.status === "active"` 读取 `upgrade.targetVersion`，否则读取 `baselineVersion`。值为 `null` 或未登记时，先请有权评审人定实施版本。请求中明确指定的版本须与实施目标一致。新版发布期间继续使用已锁定的版本。
- 用 `cds_design_read` 的 `view: "delivery"` 或 `cdscli --workspace-credential design delivery <稿件> --version <目标版>` 读交付索引、验收规则和实现画面。读包内原文时，使用 MCP 的 `view: "file"` 或给该 CLI 命令加 `--file <包内路径>`。从索引打开 `交接清单.md` 和需要的源码差异。
- 用 `view: "handoff"` 或 `cdscli --workspace-credential design handoff <稿件> --version <目标版>` 回读交接检查。检查失败、待运行或无法回读时，在原反馈记录缺失条件和处理人，等固定目标满足交接门禁后开始修改代码。使用历史稿时以 CDS 返回的该版交接状态为依据。
- 读取当前工程提交和 CDS 的已实现版本。用 `cds_design_read` 的 `view: "diff"` 或 `cdscli --workspace-credential design diff <稿件> --from <已实现版> --to <目标版>` 核对净变化。先用程序检查源码差异是否能直接应用。已签收且当前实现与目标一致时，回读原提交和验收回执即可。

## 3. 实现并回填

- 首次写实施反馈（包括交接阻塞说明）前，用 `cdscli --workspace-credential setup-check --host <CDS 地址> --project <项目 ID> --skills cds-build --design-access feedback` 核对同一项目的反馈权限。自检通过就复用现有授权。确认缺少反馈权限（`design_scope_required`）时，运行 `cdscli --workspace-credential connect --host <CDS 地址> --project <项目 ID> --design-access feedback --agent <智能体名称>`。若原工作区有可用的普通项目绑定，按第一节在独立工作区接入。
- 系统所有者在项目列表右下角「授权申请」核对项目与智能体，点击「批准实施反馈」。等待中断时重跑同一条 connect 继续原申请。领取后再次用 `--design-access feedback` 自检。
- 已有同版实施反馈就回原线程。首次登记用 `cdscli --workspace-credential design feedback-create <稿件编号> --version <目标版> --category implementation --title "<标题>" --body "<反馈内容>"`，回读回执的稿件编号、版本和反馈编号。
- 先按 [CDS 设计闭环](../cds/reference/design-loop.md#六实现方按交接清单实现) 在同版反馈里回复验收项、做法和待澄清点，再按项目规则写测试和实现。按交付清单推进，发现不兼容的差异时，把文件和理由写回同一线程。
- 同一验收运行使用目标稿件版本、同一实现提交以及该稿件指定的演示数据。请获准的项目成员绑定实现画面，使用项目已有的验收写权限上传或生成证据并逐项记录结论。把运行编号和实现提交留在稿件里，请设计方独立复核。
- 回复固定稿件链接、实施版本、实现提交、验收运行和仍待处理的条件。定实施基线、签收和正式发布各自使用已有角色与授权。遇到缺失条件时在原线程记录精确的待办和处理人。
