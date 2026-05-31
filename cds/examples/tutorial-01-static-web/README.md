# CDS 教程 01 - 静态网页托管

横向场景①（最简单）：把一个纯前端目录托管成可访问站点。无后端、无数据库。

## 目录

- `site/index.html` — 要托管的静态页面
- `cds-compose.yml` — 单个 `web` service，用 `serve` 托管 `site/`

## 纵向②：用 cds-compose.yml 一键导入

```bash
cd cds/examples/tutorial-01-static-web
python3 ../../../.claude/skills/cds/cli/cdscli.py verify . --min-score 90   # 期望 A 级
python3 ../../../.claude/skills/cds/cli/cdscli.py scan . --apply-to-cds <projectId>
```

## 纵向①：直接配置 CDS（无 cds-compose.yml）

把仓库接入后，在 onboarding 里把 runtime 选成 `静态站点(static)`，CDS 会自动用
`npx serve` 托管构建产物。命令序列见 `doc/guide.cds-tutorial.md` § 场景①。

## 预期结果

- 一个 app service `web`，path 前缀 `/`，端口 `4173`
- 预览域名打开后直接看到「教程 01」页面
