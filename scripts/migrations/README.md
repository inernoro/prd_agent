# 一次性数据迁移脚本

## replace-cdn-domain.js — CDN 域名字符串替换

把 MongoDB 所有集合里的 `pa.759800.com` 替换成 `map.ebcone.net`。

历史数据里的 `*Url` 字段是由 `TencentCosStorage.BuildPublicUrl` 把 `${TENCENT_COS_PUBLIC_BASE_URL}/{key}` 拼好后写入的完整 URL,所以改环境变量只影响新写入,存量需要这个脚本批量修复。

```bash
# 0) 备份
mongodump --uri "mongodb://..." --out backup-$(date +%F)

# 1) Dry-run (默认, 不写入)
mongosh "mongodb://..." scripts/migrations/replace-cdn-domain.js

# 2) 真正执行
mongosh "mongodb://..." --eval "var DRY_RUN=false" scripts/migrations/replace-cdn-domain.js

# 3) 验证残留
mongosh "mongodb://..." scripts/migrations/verify-cdn-domain.js
```

### 想换其它域名

```bash
mongosh "..." --eval "var OLD='a.com'; var NEW='b.com'; var DRY_RUN=false" \
  scripts/migrations/replace-cdn-domain.js
```

### 说明

- 递归扫所有集合的所有字符串字段,含嵌套数组/子文档
- 子串替换,不是正则; `pa.759800.com` 出现在哪里都会被替换(包括 `i.pa.759800.com`、`cdn.pa.759800.com` 等任何子域名)
- **幂等**: 重复执行无害
- 跳过 `system.*` 集合

## verify-cdn-domain.js — 残留扫描(只读)

只扫不写,列出所有仍含旧域名的集合、字段路径、样例 `_id`。
