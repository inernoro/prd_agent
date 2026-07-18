# CDS 后端部署冻结 · 分支 api 跑旧代码 · debt · 债务台账

> **版本**：v1.0 | **日期**：2026-06-19 | **状态**：开发中

| 字段 | 内容 |
|---|---|
| 模块 | CDS 部署管线（分支 worktree 构建 → api 容器运行） |
| 状态 | open（阻塞中，需 CDS 主机层介入；2026-06-19 发现） |
| 关联 | `cds/src/services/worktree.ts`、`cds/cds-compose.yml`(api 服务 `dotnet build && dotnet run --no-build`)、分支 `claude/visual-agent-redesign-9vt3lm`、提交 `6a459698` |
| 提出 | 图生视频成片下载修复 + 额度提醒推了 5 次都"不生效"，逐层排查后定位为 CDS 部署冻结，非代码问题 |


## 债务主题：构建成功 ≠ 运行的是新代码

某分支的 prd-api 在 CDS 上**始终执行旧的后端代码**，无论往 GitHub 推多少次、用何种方式部署。前端（prd-admin，static/vite 模式）改动能正常部署；后端（.NET 源码模式）`.cs` 改动**进不到运行进程**。

### 复现与证据（2026-06-18 ~ 06-19，分支 `claude/visual-agent-redesign-9vt3lm`）

跨副本可信的判定信号：图生视频下载端点 `GET /api/v1/videos/{id}/content` 的 LLM 日志 `answerText`：
- 旧代码：把 mp4 字节按字符串读 → `answerText` = `\0\0\0 ftypisom…mdat…`（原始 mp4 当字符串）。
- 新代码（应有）：先无损读字节 + 魔数嗅探 → `answerText` = `[binary:application/json, N bytes]`，下载成功落 COS。

所有部署方式跑完，日志恒为**旧行为**：

| 尝试 | 结果 |
|---|---|
| `git push` + GitHub webhook 自动部署 | 旧代码 |
| 强制 `POST /api/branches/:id/deploy` | 旧代码（dll mtime 不变，只重启没重编） |
| 删除分支 + `branch create` 重建 worktree | 旧代码 |
| 强制 `POST /api/branches/:id/pull`（返回 `head=6a459698, updated=false`）+ 重新部署 | 旧代码 |

`/pull` 确认 CDS 仓库侧引用已是 `6a459698`，构建日志显示 `PrdAgent.Infrastructure -> …dll` 编译成功、`API listening` 正常启动、无 `error CS`，**但运行进程仍是旧下载代码**。

`branch exec --profile api-prd-agent` 一度回报 worktree HEAD=`97329c58`（一个不在本分支历史里的旧/孤儿提交）且 `git reset --hard` 不持久 —— 说明 exec 起的是一次性容器，不能代表真正在跑的部署，也不能用来修。

### 已排除
- 不是代码编译错误（CDS 构建成功，本地 ImplicitUsings 校验通过，重建后 api 正常 listening）。
- 不是 CDS 仓库没拿到提交（`/pull` 报 `6a459698`）。
- 不是 2 副本竞争（该项目 api+admin 各 1 容器，2/2 指两个服务非两副本）。
- 不是 CDS 版本旧（`cds version` 报 0.6.8 = latest）。

### 仍未定位（留给下一手）
为什么"构建成功的 dll"与"运行进程的行为"对不上。候选方向：
1. **Debug/Release 输出路径错配**：`cds-compose.yml` api 命令是 `dotnet build --no-restore --no-incremental`（构建日志落 `bin/Release`）然后 `dotnet run --project … --no-build`（`dotnet run` 默认 Debug，找 `bin/Debug`）。若靠 props 强制 Release 才一致；一旦不一致，`--no-build` 可能跑到旧/别处产物。需在真正运行的容器里核对运行的 dll 路径与 mtime。
2. **`git worktree add origin/<branch>` 用的远程跟踪引用**与 `/pull` 更新的引用不是同一个，导致 worktree 源码停在旧提交（exec 看到的 `97329c58` 可能是真相而非 throwaway 假象——需在**真正运行的**容器而非一次性 exec 容器里核对）。
3. CDS deploy 实际"只替换容器、复用旧编译产物"，没真正 `rm -rf bin && build`。

### 一锤定音的验证（需 CDS 宿主机 shell）
```bash
WT=/root/inernoro/prd_agent/.cds-worktrees/prd-agent/prd-agent-claude-visual-agent-redesign-9vt3lm
cd "$WT" && git rev-parse HEAD
grep -c LooksBinary prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs   # 期望 1
# 若 HEAD 不是 6a459698：git fetch origin && git reset --hard 6a459698，再强制 clean rebuild
# 核对真正运行的容器跑的是哪个 dll：docker exec <api容器> sh -c 'ls -la …/bin/Release/net8.0/PrdAgent.Infrastructure.dll; ps aux|grep dotnet'
```

---

## 被这条债务卡住、已就绪未生效的两处修复（代码在 `6a459698`，待部署修好后复验）

### 1. 图生视频成片下载鲁棒修复
`LlmGateway.ExecuteRawWithResolutionAsync` 改为**先 `ReadAsByteArrayAsync` 无损读全部字节，再判二进制/文本**，并新增 `LooksBinary()` 按文件魔数嗅探（mp4 `ftyp` / png / jpeg / gif / webp / 标称文本却以 NUL 开头）。根因：OpenRouter `GET /videos/{id}/content` 回的是真 mp4 字节却把 `Content-Type` 标成 `application/json`，旧逻辑用 `ReadAsStringAsync` 损坏字节 → `BinaryContent` 空 → `DownloadVideoBytesAsync` 在 HTTP 200 下误判失败「视频下载失败: HTTP 200」。同时下载失败 error 附诊断 `(ct=…, binLen=…, textLen=…)` 随 run 落库便于跨副本复盘。

复验脚本（绕过拆分镜，2-3 分钟出结果）：`direct` 模式 `POST /api/video-agent/runs`（`{mode:'direct', directFirstFrameUrl:<公开图 URL>, directPrompt, directAspectRatio, directDuration}`）→ 轮询 `GET /api/video-agent/runs/{id}` 到 terminal。已验证：**提额后生成链路跑通**（提交 → Wan 2.6 渲染 → 进 `downloading` 95%），只差下载落库（本修复）。

### 2. 大模型额度用尽 / key 限额主动提醒（用户 2026-06-19 提出"额度不够就要及时提醒出来"）
- `LlmGateway` 在上游非 2xx 时识别限额类错误（OpenRouter `Key limit exceeded`、HTTP 402、`insufficient credits` / `quota exceeded` / `billing limit`）→ 返回专门错误码 `LLM_QUOTA_EXCEEDED` + 清晰中文提示（替代笼统的 `LLM_ERROR`）。
- 通过 `IPoolFailoverNotifier.NotifyQuotaExceededAsync`（复用 `PoolFailoverNotifier.UpsertNotificationAsync` 去重 upsert）发 error 级**主动站内告警**（key `llm-quota-exceeded`），覆盖 chat（拆分镜）/ image（关键帧）/ video（图生视频）全部走网关的调用。
- 背景：2026-06-19 这把 OpenRouter key 触顶（`Key limit exceeded (total limit)`），导致拆分镜空态、关键帧失败、视频提交失败，但全程**静默**——用户从各功能"全死"反推才发现是额度。提醒上线后，额度不足应一眼可见。
- 后续可加：额度恢复后自动关闭该告警（参考 `PoolFailoverNotifier` 的 recovered 路径）；额度阈值预警（用尽前提示）。

---

## 影响面与临时绕过
- 该分支预览当前为 **running**（已从 error 救回），但后端跑旧代码：图生视频出片、额度提醒在此分支预览上不可见，直到 CDS 部署修复。
- 其它分支是否同样冻结未逐一验证；若是 CDS 管线通病，影响所有走源码模式的 .NET 分支部署。
- 临时绕过：无 agent 侧手段（push/deploy/重建/pull/exec 均试过）。只能 CDS 宿主机层介入。
