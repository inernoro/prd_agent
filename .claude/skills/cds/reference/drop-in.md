# 其他项目接入 cds 技能

本文面向"我刚下载了 cds 技能 tar.gz，怎么在自己项目里用起来"。

## 三分钟上手

```bash
# 1. 解压到你项目的 .claude/skills/ 下
tar -xzf cds-skill-*.tar.gz
mv cds/skills/cds your-project/.claude/skills/cds

# 2. 把 CLI 加到 PATH（推荐 alias）
echo 'alias cdscli="python3 $(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"' >> ~/.bashrc
source ~/.bashrc

# 3. 首次初始化
cdscli init

# 4. 验证
cdscli auth check
cdscli project list --human
```

## init 向导的三个问题

### Q1: CDS 地址

```
输入 CDS 地址（如 cds.miduo.org）: ____
```

- 只填域名，不带 `https://`
- 如果不知道，问 CDS 运维拿 Dashboard URL

### Q2: 认证方式

| 选项 | 何时选 |
|------|--------|
| **A. 静态 AI_ACCESS_KEY** | 你已经 `export AI_ACCESS_KEY=xxx` 在 `.bashrc`；或运维发给你 |
| **B. 动态配对** | 没静态 key，但能打开 Dashboard 点批准 |
| **C. 项目级 cdsp_* 通行证** | 运维给你发了"只能操作某项目"的 key（前缀 cdsp_）|

99% 情况选 **A**。B/C 适用于权限最小化场景。

### Q3: 默认 projectId（可选）

填了之后每次 `cdscli branch list` 自动带 `--project=<id>`。回车跳过也行。

## 首次部署流程

假设你已经 init 完 + 选好 projectId：

```bash
# 你的项目还没在 CDS 上注册过
cdscli scan --apply-to-cds <projectId>
# → 生成 compose YAML + 提交到 CDS 待审批
# → 给你一个链接，去 Dashboard 点批准

# 审批完成后
git add .
git commit -m "feat: first deploy"
git push -u origin feat/foo

cdscli deploy
# → 自动 push + pull + deploy + smoke
```

## 常见问题

### Q: cdscli: command not found

没设 alias。手动运行：`python3 .claude/skills/cds/cli/cdscli.py auth check`

### Q: init 之后还是 401

三个 env 可能冲突：
- `~/.bashrc` 有旧 `AI_ACCESS_KEY`
- `~/.cdsrc` 是 init 写的
- 当前 shell 有手工 export

解决：`unset AI_ACCESS_KEY CDS_PROJECT_KEY && source ~/.cdsrc && cdscli auth check`

### Q: scan 扫出来的 YAML 不对

MVP 扫描器只识别少数栈。把 YAML 改改再提交：

```bash
cdscli scan > /tmp/compose.yaml
# 手工编辑 /tmp/compose.yaml
# 然后手工 POST
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "$CDS/api/projects/<id>/pending-import" \
  -X POST -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile y /tmp/compose.yaml '{agentName:"cdscli",purpose:"manual",composeYaml:$y}')"
```

### Q: 我没有 Python 3

Python 3 是操作系统自带工具。macOS / Ubuntu / WSL 全部自带。真没有：
```bash
# Ubuntu
sudo apt install -y python3
# macOS (Homebrew)
brew install python@3
```

### Q: 如何升级 cds 技能

```bash
# 重新从 Dashboard 下载最新 tar.gz
cd your-project
rm -rf .claude/skills/cds
tar -xzf cds-skill-<latest>.tar.gz -C .claude/skills/
# init 不用重跑，~/.cdsrc 仍然有效
```

## 目录结构

```
your-project/
└── .claude/
    └── skills/
        └── cds/
            ├── SKILL.md              ← Claude Code 自动加载
            ├── cli/
            │   └── cdscli.py         ← 所有 CDS API 封装
            └── reference/
                ├── api.md            ← API 端点清单
                ├── auth.md           ← 双层认证决策树
                ├── scan.md           ← 扫描规则
                ├── smoke.md          ← 分层冒烟
                ├── diagnose.md       ← 故障模式库
                └── drop-in.md        ← 本文
```

## 配合哪些技能用

```
cds 技能                              其他技能配合
─────────────────────────────────────────────
cdscli deploy         ←→  /handoff (部署后生成交接清单)
cdscli help-me-check  ←→  /verify  (修复后交叉验证)
cdscli scan           ←→  /uat     (接入后做人工验收)
```

不重叠。cds 技能负责"跟 CDS 打交道"，其他技能负责"代码/产品/流程"。
