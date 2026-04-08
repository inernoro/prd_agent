# 一次性数据迁移脚本

> 这里放一次性的 mongosh 数据修正脚本。每个脚本都应在文件头注明背景、用法、是否幂等。

## replace-cdn-domain.js — CDN 旧域名清理

替换所有集合里残留的旧 CDN 域名 `i.pa.759800.com` 为新域名 `i.miduo.org`。

### 为什么需要

`TencentCosStorage.BuildPublicUrl` 把 `${TENCENT_COS_PUBLIC_BASE_URL}/{key}` 拼成完整 URL 后写入了大量 Model 的 `*Url` 字段(如 `image_assets.Url`、`hosted_sites.SiteUrl`、`submissions.GenerationSnapshot.InitImageUrl` 等)。改 `TENCENT_COS_PUBLIC_BASE_URL` 环境变量只影响**新写入**的数据,**历史数据需要这个脚本批量修复**。

### 用法

```bash
# 1) 备份(强烈建议)
mongodump --uri "mongodb://user:pwd@host:port/prd_agent" --out backup-$(date +%F)

# 2) Dry-run, 看看会改多少
mongosh "mongodb://user:pwd@host:port/prd_agent" scripts/migrations/replace-cdn-domain.js

# 3) 确认无误后, 真正执行
mongosh "mongodb://user:pwd@host:port/prd_agent" \
  --eval "var DRY_RUN=false" \
  scripts/migrations/replace-cdn-domain.js

# 4) 验证残留(只读)
mongosh "mongodb://user:pwd@host:port/prd_agent" scripts/migrations/verify-cdn-domain.js
```

### 特性

- **递归扫描** 每个文档的所有字符串字段(任意层级嵌套数组/对象), 不依赖字段白名单
- **幂等**: 重复执行无害, 已经是新域名的字段不会再被改
- **DRY_RUN 默认开启**, 不会意外写入
- 跳过 `system.*` 集合
- 大集合可通过 `SKIP_COLLECTIONS` 临时排除

### 可调参数

通过 `--eval` 覆盖:

```bash
mongosh "..." --eval "var DRY_RUN=false; var OLD_DOMAIN='old.example.com'; var NEW_DOMAIN='new.example.com'" \
  scripts/migrations/replace-cdn-domain.js
```

### 注意事项

1. **先重启后端**, 让新的 `TENCENT_COS_PUBLIC_BASE_URL` 环境变量生效, 避免一边迁移一边又写入旧数据
2. **大集合(`llmrequestlogs` / `apirequestlogs`)** 耗时较长, 建议在低峰执行
3. 这是**字符串子串替换**, 不是正则; `i.pa.759800.com` 出现在哪里都会被替换(包括子文档/数组里)
4. 涉及到的主要集合: `image_assets`, `attachments`, `hosted_sites`, `web_page_share_links`, `submissions`(含 `GenerationSnapshot.*Url` 嵌套字段), `desktop_assets`, `desktop_update_caches`, `watermark_font_assets`, `watermark_configs`, `image_master_workspaces`, `workspaces`, `upload_artifacts`, `defect_reports`, `image_gen_run_items`, `video_gen_runs`, `tutorial_email_assets`, `transcript_items`, `llmrequestlogs` 等

## verify-cdn-domain.js — 残留扫描(只读)

只扫描不写入,列出所有仍包含旧域名的集合、字段路径、样例 `_id`。迁移前后可以各跑一次对比。
