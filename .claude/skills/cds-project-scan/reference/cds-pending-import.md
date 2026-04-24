# Reference: Submitting YAML to CDS via `pending-import`

Detailed bash recipes for Phase 8 of `cds-project-scan`. Only applicable when the target CDS instance已安装 `POST /api/projects/:projectId/pending-import` 接口（随 `cds-project-scan` 配对引入的新能力，老版本 CDS 不具备）。

---

## 目录

- [契约](#契约)
- [前置检查](#前置检查)
- [标准提交脚本](#标准提交脚本)
- [返回解析](#返回解析)
- [失败模式与修复](#失败模式与修复)
- [端到端示例](#端到端示例)

---

## 契约

```
POST {CDS}/api/projects/{projectId}/pending-import
  Headers:
    X-AI-Access-Key: {AI_ACCESS_KEY}
    Content-Type: application/json
  Body: {
    "agentName":   "cds-project-scan",
    "purpose":     "自动扫描并提交 CDS 配置",
    "composeYaml": "<完整 YAML 字符串>"
  }
  → 201 { "importId": "abc123" }
  → 401 未认证 / X-AI-Access-Key 无效
  → 404 projectId 不存在
  → 409 项目尚未 clone ready（未挂仓库 / repoPath 为空）
```

审批流程：AI 提交后，人类在 CDS Dashboard `project-list` 页面看到待批列表，手动 review YAML 并批准。

---

## 前置检查

提交之前，**必须**全部满足，否则当场终止并打印修复建议：

1. **CDS 版本确认**：向用户展示「提示：CDS 一方需要安装我新增的 `pending-import` 功能后才可用（见 CLAUDE.md 更新记录）」——老版本 CDS 调用会返回 404，不是脚本 bug。
2. **环境变量**：`CDS_HOST` + `AI_ACCESS_KEY` 均已设置。任一缺失 → 打印 `export` 提示让用户手动补齐。
3. **`projectId`**：来自用户输入或 `--apply-to-cds <projectId>` 参数。通常是用户先在 CDS Dashboard 创建一个**空项目**，再从 URL 或项目卡片复制项目 ID。**禁止**AI 自己猜。
4. **YAML 已生成**：Phase 6 完成，`$GENERATED_YAML` 变量有内容（包含 `x-cds-project` 头）。

```bash
# 前置检查模板
[[ -z "$CDS_HOST" ]]       && echo "✗ CDS_HOST 未设置"       && exit 1
[[ -z "$AI_ACCESS_KEY" ]]  && echo "✗ AI_ACCESS_KEY 未设置"  && exit 1
[[ -z "$PROJECT_ID" ]]     && echo "✗ PROJECT_ID 未设置（从 CDS 项目卡片复制）" && exit 1
[[ -z "$GENERATED_YAML" ]] && echo "✗ 还没生成 YAML，先走 Phase 1-6" && exit 1
```

---

## 标准提交脚本

与 cds-deploy-pipeline 保持认证风格一致：`X-AI-Access-Key` header + `$CDS_HOST` + `$AI_ACCESS_KEY`。**所有命令在同一个 Bash 调用中用 `&&` 链接**，避免 Shell 变量跨调用丢失（见 cds-deploy-pipeline 规则 #13）。

```bash
CDS="https://$CDS_HOST"

# 用 jq 拼装 JSON body（避免 YAML 字符串中的引号/换行破坏 JSON）
# 如果环境没有 jq，用 python3 兜底（见"无 jq 兜底"）
RESP=$(curl -sf -w "\n%{http_code}" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  "$CDS/api/projects/$PROJECT_ID/pending-import" \
  -X POST \
  -d "$(jq -n \
        --arg yaml  "$GENERATED_YAML" \
        --arg agent "cds-project-scan" \
        --arg purpose "自动扫描并提交 CDS 配置" \
        '{agentName:$agent, purpose:$purpose, composeYaml:$yaml}')")

HTTP_CODE=$(echo "$RESP" | tail -n 1)
BODY=$(echo "$RESP" | sed '$d')

case "$HTTP_CODE" in
  201)
    IMPORT_ID=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['importId'])")
    echo "✓ 提交成功，importId=$IMPORT_ID"
    echo ""
    echo "➡️  请到 https://$CDS_HOST/project-list?pendingImport=$IMPORT_ID 审批"
    ;;
  401) echo "✗ 401 认证失败：检查 AI_ACCESS_KEY 是否与 CDS 服务端配置一致（见 cds-deploy-pipeline 双层认证架构）"; exit 1 ;;
  404) echo "✗ 404 项目不存在：确认 projectId=$PROJECT_ID 真的存在于 $CDS/project-list；或 CDS 版本过旧未安装 pending-import 接口（需先升级 CDS）"; exit 1 ;;
  409) echo "✗ 409 项目未 clone ready：该 CDS 项目还没挂仓库，先去 Dashboard → 项目 → 仓库设置完成 clone 再重试"; exit 1 ;;
  *)   echo "✗ 未知错误 HTTP $HTTP_CODE: $BODY"; exit 1 ;;
esac
```

---

## 返回解析

成功返回：

```json
{ "importId": "abc123" }
```

打印给用户的 URL 格式：

```
https://$CDS_HOST/project-list?pendingImport=$IMPORT_ID
```

query param `?pendingImport=abc123` 让前端自动滚动到对应待批卡片。

---

## 失败模式与修复

| HTTP | 原因 | AI 给用户的建议 |
|------|------|-----------------|
| 401  | `X-AI-Access-Key` 未配置或不匹配 | 参考 `cds-deploy-pipeline` 的双层认证架构。本地 `$AI_ACCESS_KEY` 必须与 CDS master 进程的 `process.env.AI_ACCESS_KEY` 或 customEnv 一致。 |
| 404  | (a) `projectId` 拼错；(b) CDS 老版本未部署 pending-import 接口 | (a) 让用户重新从 CDS Dashboard 项目卡片复制 ID；(b) 告知用户需要升级 CDS（pending-import 是 `cds-project-scan` 配对引入的新能力） |
| 409  | 项目未挂仓库，`repoPath` 为空 | 引导用户去 CDS Dashboard → 项目 → Settings → Repository 完成 git clone 后重试 |
| 5xx  | CDS 内部错误 | 让用户查看 CDS 宿主机日志 `cds/cds.log`，AI 不在同一台机器无法直接看 |

---

## 端到端示例

用户对 `prd_agent` 项目说 `/cds-scan --apply-to-cds proj_abc123`：

```
[Phase 1-6] 扫描 → 生成 YAML → 用户确认
[Phase 7]   打印 CDS Dashboard 手动导入说明（默认路径）
[Phase 8]   检测到 --apply-to-cds 参数：
  ⚠ 前置提示：CDS 一方需要安装我新增的 pending-import 功能后才可用
  ✓ CDS_HOST = cds.miduo.org
  ✓ AI_ACCESS_KEY 已配置
  ✓ PROJECT_ID = proj_abc123
  ⏳ POST /api/projects/proj_abc123/pending-import
  ✓ HTTP 201  importId = imp_xyz789
  ➡️ 请到 https://cds.miduo.org/project-list?pendingImport=imp_xyz789 审批
```

---

## 与默认流程的关系

Phase 8 是**可选升级**，不替代 Phase 7。没有 `AI_ACCESS_KEY` 的用户（或 CDS 老版本）仍然走复制粘贴 YAML 的默认流程。两者并存，按需启用。
