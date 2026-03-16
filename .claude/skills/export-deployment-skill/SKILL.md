---
name: export-deployment-skill
description: Exports the CDS project scan skill and generated compose YAML as a portable zip package for offline deployment. Packages skill files, reference docs, and generated configuration into a single archive. Trigger words: "导出部署技能", "export deployment skill", "导出技能包", "/export-skill".
---

# Export Deployment Skill — 导出部署技能压缩包

将 `/cds-scan` 技能及其生成的 CDS Compose 配置打包为可离线分发的 zip 压缩包，方便在无 Claude Code 环境下参考和部署。

## 目录

- [强制规则](#强制规则)
- [执行流程](#执行流程)
- [输出格式](#输出格式)
- [端到端示例](#端到端示例)
- [异常处理](#异常处理)

## 强制规则

1. **禁止**将敏感信息（API Key、密码、Token）写入压缩包内的配置文件，必须用 `"TODO: 请填写实际值"` 替代
2. **禁止**在未确认输出路径前直接写入文件
3. **必须**先执行 `/cds-scan` 生成最新配置（或复用已有 `cds-compose.yml`）
4. **必须**在打包前展示文件清单供用户确认
5. **必须**输出 zip 文件的绝对路径，方便用户下载或传输

## 执行流程

复制此 checklist 跟踪进度：

```
导出部署技能进度：
- [ ] Phase 1: 检查现有 CDS 配置
- [ ] Phase 2: 收集技能文件
- [ ] Phase 3: 展示打包清单 → 用户确认
- [ ] Phase 4: 生成 zip 压缩包
- [ ] Phase 5: 输出结果
```

### Phase 1: 检查现有 CDS 配置

检查项目根目录是否已有 CDS 配置文件：

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
ls -la "$PROJECT_ROOT"/cds-compose.yml "$PROJECT_ROOT"/docker-compose*.yml 2>/dev/null
```

**分支判断**：

| 情况 | 处理 |
|------|------|
| 已有 `cds-compose.yml` | 使用 AskUserQuestion 询问：使用现有配置 / 重新扫描生成 |
| 无 CDS 配置 | 自动触发 `/cds-scan` 生成 → 将结果保存为 `cds-compose.yml` |

### Phase 2: 收集技能文件

从项目中收集以下文件（按类别）：

**A. CDS 技能文档**（来自 `.claude/skills/cds-project-scan/`）：

```
skills/
├── SKILL.md                          # 主技能文档
└── reference/
    ├── tech-detection.md             # 技术栈检测规则
    └── infra-init.md                 # 基础设施初始化指南
```

**B. 生成的部署配置**：

```
config/
└── cds-compose.yml                   # CDS Compose YAML
```

**C. 项目元信息**：

```
README.md                             # 自动生成的使用说明
```

### Phase 3: 展示打包清单 → 用户确认

> **关键检查点。禁止跳过。**

以 Markdown 列表展示即将打包的文件：

```markdown
## 打包清单

### 技能文档 (Skills)
- skills/SKILL.md — CDS 扫描技能主文档
- skills/reference/tech-detection.md — 技术栈检测规则
- skills/reference/infra-init.md — 基础设施初始化指南

### 部署配置 (Config)
- config/cds-compose.yml — CDS Compose YAML (已生成)

### 说明文件
- README.md — 使用说明（含导入步骤）

总计: N 个文件，预计大小 ~XX KB
```

使用 AskUserQuestion 确认：
- **确认打包**
- **需要调整**（添加/移除文件）
- **取消**

### Phase 4: 生成 zip 压缩包

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
EXPORT_DIR=$(mktemp -d)
PACK_NAME="cds-deployment-skill-$(date +%Y%m%d-%H%M%S)"
PACK_DIR="$EXPORT_DIR/$PACK_NAME"

# 创建目录结构
mkdir -p "$PACK_DIR/skills/reference" "$PACK_DIR/config"

# A. 复制技能文档
cp "$PROJECT_ROOT/.claude/skills/cds-project-scan/SKILL.md" "$PACK_DIR/skills/"
cp "$PROJECT_ROOT/.claude/skills/cds-project-scan/reference/tech-detection.md" "$PACK_DIR/skills/reference/"
cp "$PROJECT_ROOT/.claude/skills/cds-project-scan/reference/infra-init.md" "$PACK_DIR/skills/reference/"

# B. 复制部署配置
cp "$PROJECT_ROOT/cds-compose.yml" "$PACK_DIR/config/" 2>/dev/null || echo "# 请先运行 /cds-scan 生成配置" > "$PACK_DIR/config/cds-compose.yml"

# C. 生成 README
cat > "$PACK_DIR/README.md" << 'READMEEOF'
# CDS 部署技能包

本压缩包包含 CDS (Cloud Dev Space) 项目部署所需的技能文档和配置。

## 包含内容

| 目录 | 内容 | 用途 |
|------|------|------|
| `skills/` | CDS 扫描技能文档 | 了解扫描规则和配置生成逻辑 |
| `config/` | CDS Compose YAML | 直接导入 CDS Dashboard |

## 使用方式

### 方式 1：CDS Dashboard 导入（推荐）

1. 启动 CDS：`cd cds && ./exec_cds.sh --background`
2. 打开 CDS Dashboard → `http://<服务器IP>:9900`
3. 设置 → **一键导入** → 粘贴 `config/cds-compose.yml` 内容 → 确认应用
4. CDS 自动拉起所有基础设施和应用服务

### 方式 2：配合 Claude Code 使用

1. 将 `skills/` 目录复制到目标项目的 `.claude/skills/cds-project-scan/`
2. 在 Claude Code 中使用 `/cds-scan` 触发扫描

## 注意事项

- `config/cds-compose.yml` 中标记为 `TODO: 请填写实际值` 的字段需要手动补全
- 敏感信息（API Key、密码等）不包含在此压缩包中
READMEEOF

# D. 打包
cd "$EXPORT_DIR" && zip -r "$PROJECT_ROOT/$PACK_NAME.zip" "$PACK_NAME/"

# E. 清理临时目录
rm -rf "$EXPORT_DIR"

echo "✅ 已导出: $PROJECT_ROOT/$PACK_NAME.zip"
```

### Phase 5: 输出结果

输出打包结果摘要：

```markdown
## ✅ 部署技能包导出完成

- 📦 文件：`{PROJECT_ROOT}/{PACK_NAME}.zip`
- 📊 大小：XX KB
- 📄 包含 N 个文件

### 下一步
1. 将 zip 传输到目标服务器
2. 解压后按 README.md 说明导入 CDS Dashboard
3. 补全 `TODO` 标记的环境变量
```

## 输出格式

zip 压缩包内部结构：

```
cds-deployment-skill-20260316-143000/
├── README.md                           # 使用说明
├── skills/
│   ├── SKILL.md                        # CDS 扫描技能主文档
│   └── reference/
│       ├── tech-detection.md           # 技术栈检测规则
│       └── infra-init.md               # 基础设施初始化指南
└── config/
    └── cds-compose.yml                 # CDS Compose YAML 配置
```

## 端到端示例

**输入**：用户说 `导出部署技能`

**Phase 1**：检测到项目已有 `cds-compose.yml` → 询问用户：使用现有 / 重新扫描
→ 用户选择"使用现有配置"

**Phase 2**：收集 3 个技能文件 + 1 个配置文件

**Phase 3**：展示清单（5 个文件，约 25KB）→ 用户确认

**Phase 4**：生成 `cds-deployment-skill-20260316-143000.zip`

**Phase 5**：输出结果摘要 + 下一步指引

## 异常处理

| 场景 | 处理 |
|------|------|
| `.claude/skills/cds-project-scan/` 不存在 | 提示用户先安装 CDS 技能，或从模板创建 |
| `cds-compose.yml` 不存在且用户拒绝扫描 | 打包时 config/ 放占位文件 + 提示 |
| zip 命令不可用 | 尝试 `tar -czf` 替代（输出 .tar.gz） |
| 磁盘空间不足 | 报错 + 提示清理空间 |
| 技能文件包含敏感信息 | 扫描 TODO 占位符数量，提醒用户检查 |

## 质量规则

1. zip 内不得包含 `.git/`、`node_modules/`、`.env` 等非必要文件
2. 所有敏感值必须是 `TODO` 占位符
3. README.md 必须包含完整的导入步骤
4. 文件路径使用相对路径，解压后即可使用
5. 压缩包命名包含时间戳，避免覆盖
