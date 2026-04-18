# 维护者工作流（prd_agent/cds 仓库维护者专用）

> 这篇给 **我**（`inernoro/prd_agent` 的维护者）看。
> 消费方下载用户的升级流程在 [drop-in.md](drop-in.md)，两码事。

---

## 核心认知

这个技能的"源码"就住在 **prd_agent 仓库本身**的 `.claude/skills/cds/` 下。
CDS 服务端的 `/api/export-skill` 端点每次被调用时，都是**实时**从
`{config.repoRoot}/.claude/skills/cds/` 把当前代码打包成 tar.gz 返回。
所以你改一下 → commit push → CDS 下次 self-update 拉到新代码 →
下一个点 📦 的用户就拿到新版，**没有发布、构建、CI 环节**。

```
维护者改技能 → commit → push origin
                          ↓
                CDS 定期 self-update (或运维手动)
                          ↓
         .claude/skills/cds/ 已是新代码
                          ↓
   其他人下载 📦 / `cdscli update` → 拿到新版
```

## 改技能的三种常见场景

### 场景 A：CDS 加了新 REST 端点，要给 CLI 加对应命令

1. 改 `cli/cdscli.py`：
   - 在 "NEW: init wizard, scan, smoke..." 段后新增 `cmd_xxx()` 函数
   - 复用 `_call()` / `_request()` / `ok()` / `die()` 辅助
   - 返回 `ok({...})` 形 `{ok, data, trace}` JSON（`--human` 走分支）
2. 在 `_build_parser()` 结尾前加 subparser：
   ```python
   xx = sub.add_parser("xxx", help="说明")
   xx.add_argument("id", help="...")
   xx.set_defaults(func=cmd_xxx)
   ```
3. **bump VERSION** —— 改 `cdscli.py` 顶部的 `VERSION = "x.y.z"`。
   规则：加端点/命令 = minor（0.1.0 → 0.2.0）；修 bug = patch（0.2.0 → 0.2.1）；
   破坏性改动 = major（实际上社区极少跨 major）。
4. 本地测：
   ```bash
   CLI="python3 $(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"
   $CLI --help          # 新命令在列表里
   $CLI xxx --help      # 子 help 展开
   $CLI xxx <args>      # 真连 noroenrn 跑一次
   ```
5. 如果端点需要 reference 文档（比如新端点的契约、认证要求），**同时改**
   `reference/api.md` 加一行。**不要让 reference 和 CLI 失同步**。
6. commit → push → 其它人用 `cdscli update` 或 📦 重下即可升级。

### 场景 B：CDS 改了某个响应字段（schema drift）

举例：`/api/projects` 把 `runningServiceCount` 改名为 `activeServiceCount`。

1. 改 `cli/cdscli.py` 里用到该字段的所有地方：
   ```bash
   grep -n "runningServiceCount" .claude/skills/cds/cli/cdscli.py
   ```
2. 改 `SKILL.md` + `reference/api.md` 的示例。
3. bump minor VERSION（字段改名是消费方可感知的变化）。
4. 本地跑 `cdscli project list --human` 确认字段没了。
5. **留个兼容回退**：读新字段，同时 fallback 读旧字段，这样即使消费方
   CDS 还是老版本 CLI 也能继续用：
   ```python
   count = p.get("activeServiceCount", p.get("runningServiceCount", 0))
   ```

### 场景 C：加根因模式（帮助诊断失败）

每次生产遇到新种类的报错日志，**立刻**把它加进 `cmd_help_me_check` 的
`patterns` 列表：

```python
patterns = [
    (r"error CS\d+", "C# 编译错误", "..."),
    (r"your new pattern here", "可读原因", "具体修复建议"),
    # ...
]
```

这是**单向增长**的列表——永远不要删，哪怕模式过时也留着，因为老 CDS
上的 bug 还在用老错误文案。bump patch VERSION。

## VERSION 字段的"两处对齐"

VERSION 字符串现在住在两个地方，**都要 bump**：

1. `cdscli.py` 的 `VERSION = "0.2.0"`（CLI 自身知道）
2. 服务端 `/api/cli-version` 读取 **同一个** cdscli.py（自动同步，不用改）

所以只要你 bump `cdscli.py` 里的 VERSION 常量就够了。服务端下次启动会通过
`readBundledCliVersion()` 重新读这个值（60s 缓存）。

## 发版 checklist（prd_agent 维护者清单）

```
改动前：
- [ ] 明确改的是哪一类：新命令 / schema drift / 根因模式 / 文档
- [ ] 如果涉及 CDS API 变更，CDS 那头已经改好并自更新到 noroenrn

改动：
- [ ] cli/cdscli.py 代码 + 新 help 文案
- [ ] reference/*.md 对应章节
- [ ] SKILL.md 如果影响顶层命令表，同步
- [ ] VERSION 常量 bump

本地验证：
- [ ] python3 cdscli.py --help 正常列出
- [ ] python3 cdscli.py <new-cmd> --help 子 help 正常
- [ ] python3 cdscli.py <new-cmd> <args> 真连 noroenrn 成功
- [ ] tar -czf /tmp/t.tar.gz -C /tmp/fake-root .claude/
      然后解到别的目录 → cdscli.py 独立跑得通（测 drop-in 完整性）

push 前：
- [ ] changelogs/YYYY-MM-DD_cds-skill-xxx.md 加碎片
- [ ] commit 消息写明新 VERSION + 主要变更

push 后：
- [ ] noroenrn 手动 self-update 验证新 cdscli 生效
- [ ] 点一次 📦 下载 tar.gz 抽查内容
- [ ] 没有惊吓 → 收工
```

## 反面案例（我自己犯过的错，记在这里避免复发）

| ❌ 我做过什么 | 结果 | ✅ 应该怎么做 |
|---------|------|---------|
| 改了 CLI 没 bump VERSION | 消费方 `cdscli version` 一直显示老版本，没人知道该升级 | 代码改动 = VERSION bump，机械动作，不要想 |
| 改了端点没改 reference/api.md | AI 助手在其他会话继续用旧 API 名字，人肉 debug 半天 | grep 所有 reference/ 和 SKILL.md 里的旧名字 |
| 在 SKILL.md 顶部写新触发词但没在 cli/ 加命令 | 用户喊 `/cds-xxx` 发现"命令不存在" | SKILL 触发词必须有对应 CLI 命令支撑 |
| 改 compose YAML 生成逻辑忘了本地跑 | 推到 noroenrn 发现 YAML 语法错 | scan 一次本地目录 → head 10 肉眼验证 |
| 删 patterns 里老模式（觉得过时） | 老分支 bug 不再匹配，help-me-check 退化 | patterns 只增不减，纯追加 |

## 升级影响追踪

想知道哪些用户还在用老 cdscli？看 CDS 的 Activity Monitor 里的请求头：
每个 cdscli 请求都带 `X-CdsCli-Version: x.y.z`。做 dashboard 统计即可。
（当前还没做这个面板，但数据已经在了。）

## 何时要 breaking change（major bump）

罕见。真正破坏性的只有：
- CLI 移除某个命令（比如合并两个命令为一个）
- CLI 改 CLI 参数语义（`--foo` 从布尔变成 string）
- JSON 输出结构翻天覆地

这种时候：
1. major bump（1.0.0 → 2.0.0）
2. 顶部 README 写 **Migration** 段
3. 给旧命令留**别名**，打 DeprecationWarning 一到两个 minor 版后再删
4. 周知消费方：在 Dashboard 项目卡片弹一次 toast "cds 技能 v2.0 发布，请 `cdscli update`"

## 相关文件速查

| 文件 | 谁改 | 何时改 |
|------|------|-------|
| `cli/cdscli.py` | 维护者 | 新命令 / 根因模式 / 输出改版 |
| `SKILL.md` | 维护者 | 顶层命令表 / 触发词 / 快速场景 |
| `reference/api.md` | 维护者 | CDS API 契约变化 |
| `reference/diagnose.md` | 维护者 | 新根因 + 决策树扩展 |
| `reference/auth.md` | 维护者 | 鉴权链路变化（rare）|
| `reference/scan.md` | 维护者 | 扫描启发式 / compose 规范 |
| `reference/smoke.md` | 维护者 | 冒烟策略 / 端点优先级 |
| `reference/drop-in.md` | 维护者 | 消费方接入体验变化 |
| `reference/maintainer.md` | 维护者 | 本文件 —— self-referential |
| `cds/src/routes/branches.ts` `/api/cli-version` | 维护者 | 实际上不用改，读 cdscli.py 的 VERSION |
| `cds/src/routes/branches.ts` `/api/export-skill` | 维护者 | 打包逻辑需要变时（新增 reference 子目录等）|
