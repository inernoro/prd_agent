# 边界情况处理

> 被 SKILL.md 引用。处理特殊场景时按需读取。

## 浅克隆边界

本仓库为浅克隆（`.git/shallow` 含多个边界提交）。当 `git diff --shortstat FIRST^..LAST` 失败时自动回退：

```bash
if ! git diff --shortstat "$FIRST_COMMIT^..$LAST_COMMIT" 2>/dev/null; then
  git diff --shortstat "$FIRST_COMMIT..$LAST_COMMIT"
fi
```

## 无提交的周

如果目标周没有提交，生成一份简短报告：

```markdown
# 周报 {YEAR}-W{NUM} ({MON} ~ {SUN})

> **本周无提交活动**
```

## 跨年周 (W52/W53 → W01)

使用 ISO 8601 周计算，`date +%G` 和 `date +%V` 自动处理。

## 报告已存在

如果 `$REPORT_FILE` 已存在，提示用户选择：
1. 覆盖现有报告
2. 取消生成
3. 生成到新文件（添加 `-v2` 后缀）
