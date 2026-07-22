# 其他项目接入 CDS 技能

本文面向 Codex、Cursor、Claude Code 及其他支持 Agent Skills 的宿主。默认采用项目级安装和页面批准，不要求用户复制密钥，也不修改电脑的终端配置。

## 用户看到的流程

1. 在 CDS 右上角选择「一键部署 → 接入 Agent」。
2. 选择「连接已有项目」或「创建一个新项目」。
3. 复制接入口令给当前 Agent。
4. Agent 安装技能并发起授权申请。
5. 用户在 CDS 右下角点击批准。
6. Agent 自动验证连接，调用 `preview-url` 核对 CDS API 的真实预览入口，再继续扫描、部署和冒烟测试。

## 技能安装位置

下载包使用通用 `skills/<name>/SKILL.md` 结构。Agent 必须先识别宿主，再复制到当前项目对应目录：

| Agent | 项目级目录 |
|------|-----------|
| Codex / 通用 Agent Skills | `.agents/skills` |
| Cursor | `.cursor/skills` |
| Claude Code | `.claude/skills` |

默认禁止安装到用户主目录。旧技能备份放在当前项目 `.cds/skill-backups`，禁止把 `.bak` 目录留在技能扫描目录。

完整技能包必须包含 `cds`、`cds-deploy-pipeline`、`cds-project-scan`、`preview-url` 四个技能。缺少 `preview-url` 视为接入未完成。

## 安全接入

假设 CLI 位于当前 Agent 的项目技能目录：

```bash
# 连接已有项目
python3 <skills-root>/cds/cli/cdscli.py connect \
  --host https://cds.example \
  --project <projectId> \
  --agent <agentName>

# 首次创建项目
python3 <skills-root>/cds/cli/cdscli.py connect \
  --host https://cds.example \
  --new-project \
  --agent <agentName>
```

命令发起申请后会持续显示等待状态。用户批准后：

- 已有项目：保存该项目专属授权。
- 新项目：保存一次性建项目授权；创建成功后自动换成项目专属授权。
- 凭据写入当前 git 项目的 `.cds/credentials.json`，权限为 `0600`。
- CLI 将凭据文件加入 `.git/info/exclude`，不会污染 `git status`，也不会被提交。
- CLI 不修改 `.bashrc`、`.zshrc`、全局 PATH 或系统环境变量。
- CLI 不在 stdout 中输出密钥。

## 首次部署其他仓库

在目标仓库目录运行：

```bash
python3 <skills-root>/cds/cli/cdscli.py onboard https://github.com/org/repo
```

`onboard` 会创建 CDS 项目、克隆仓库、检测运行方式并提示缺少的项目参数。创建动作如果使用一次性授权，CLI 会自动切换到新项目的专属授权。

后续部署：

```bash
python3 <skills-root>/cds/cli/cdscli.py deploy
```

## 验证清单

```bash
python3 <skills-root>/cds/cli/cdscli.py auth check
python3 <skills-root>/cds/cli/cdscli.py --human preview-url
git status --short
```

通过标准：

- `auth check` 成功。
- `preview-url` 只输出 CDS API 返回的 `previewUrl` / `previewUrls`；多入口时全部列出。
- 当前分支尚未创建或部署时，`preview-url` 明确失败，不根据分支名或 CDS host 推算。
- `git status` 不出现 `.cds/credentials.json`。
- 用户终端启动文件没有变化。
- 对另一个 CDS 项目执行写操作时返回 `project_mismatch` 或权限拒绝。
- 重启 Agent 后仍可从当前项目配置读取正确授权。

## 升级

```bash
python3 <skills-root>/cds/cli/cdscli.py update
python3 <skills-root>/cds/cli/cdscli.py version
```

升级备份位于 `.cds/skill-backups`，不在 Agent 技能扫描范围内，因此不会出现多个可发现的 CDS 版本。

## 旧版兼容

已有环境变量仍可使用，但只作为兼容来源。只有用户明确要求旧流程时才运行：

```bash
python3 <skills-root>/cds/cli/cdscli.py init --legacy-env
```

新用户禁止使用该方式。
