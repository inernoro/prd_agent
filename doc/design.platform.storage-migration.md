# 跨存储迁移与资源分离 · 设计

## 管理摘要

本系统的文件存储（图片、文档、音频、视频、字体等）支持多 Provider 切换（腾讯云 COS / Cloudflare R2），通过 `ASSETS_PROVIDER` 环境变量选择。本文档描述：

1. **资产登记簿（Asset Registry）** — 每次存储操作自动登记，为未来迁移铺轨道
2. **资源归属分类（Scope）** — 区分系统资源 vs 用户资源 vs AI 生成 vs 日志
3. **跨存储迁移方案** — 基于 registry 的一键式数据迁移路径
4. **系统/用户资源分离路线图** — 渐进式架构演进

## 当前架构

```
ASSETS_PROVIDER=tencentCos / cloudflareR2
       ↓
IAssetStorage (接口)
       ↓
┌──────────────────────┐
│ RegistryAssetStorage │ ← 装饰器：自动登记到 asset_registry
│  ├─ TencentCosStorage│
│  └─ CloudflareR2Storage│
└──────────────────────┘
```

### 核心集合

- `asset_registry` — 每次写入/删除自动登记（append-only）
- 80 个调用点全部通过 `IAssetStorage` 接口，无直接 SDK 调用

### Provider 环境变量

| Provider | 必填变量 | 公开 URL |
|----------|---------|---------|
| tencentCos | `TENCENT_COS_BUCKET`, `REGION`, `SECRET_ID`, `SECRET_KEY` | `TENCENT_COS_PUBLIC_BASE_URL` (如 `https://i.miduo.org`) |
| cloudflareR2 | `R2_ACCOUNT_ID`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `R2_BUCKET` | `R2_PUBLIC_BASE_URL` (如 `https://cfi.miduo.org`) |

切换只需修改 `ASSETS_PROVIDER` + 对应密钥，重启即可。

## 资产登记簿（Asset Registry）

### 数据结构

```javascript
// asset_registry 集合
{
  _id: "a1b2c3...",
  operation: "write",                  // write / delete
  provider: "cloudflareR2",            // 存储 Provider
  key: "data/visual-agent/img/xxx.png",// 对象 key
  sha256: "abc123...",                 // content hash
  url: "https://cfi.miduo.org/data/visual-agent/img/xxx.png",
  domain: "visual-agent",             // 业务领域
  type: "img",                        // 资源类型
  mime: "image/png",
  sizeBytes: 1024,
  scope: "user",                      // 归属范围
  createdAt: ISODate("2026-04-12...")
}
```

### Scope 分类规则

| Scope | 含义 | 自动推断规则 | 显式标记 |
|-------|------|-------------|---------|
| `system` | 系统级资源（默认头像、桌面皮肤） | key 含 `icon/desktop/` 或 `icon/backups/head/` | — |
| `user` | 用户上传内容（图片/文档/附件/字体） | 默认值（兜底） | — |
| `generated` | AI 生成内容（生图/生视频/TTS） | — | `RegistryAssetStorage.ScopeAs("generated")` |
| `log` | 日志/审计（LLM 日志、错误日志） | domain=="logs" 或 type=="log" | — |

### 已标记 scope="generated" 的代码位置

| 文件 | 方式 | 覆盖范围 |
|------|------|---------|
| `OpenAIImageClient.GenerateUnifiedAsync` | `ScopeAs("generated")` | 所有生图输出（11 个 SaveAsync） |
| `ImageGenRunWorker` | `OverrideNextScope("generated")` | AI 生成图片入库 |
| `VideoGenRunWorker` | `OverrideNextScope("generated")` × 4 | TTS 音频、分镜视频、HTML 播放器、完整视频 |

## 跨存储迁移方案

### 前提条件

1. `asset_registry` 集合已积累足够数据
2. 源和目标 Provider 的环境变量同时可用

### 迁移步骤（未来实施时参考）

```
Step 1: DRY RUN — 统计待迁移对象
  db.asset_registry.aggregate([
    { $match: { operation: "write", provider: "tencentCos" } },
    { $group: { _id: "$scope", count: { $sum: 1 }, totalBytes: { $sum: "$sizeBytes" } } }
  ])

Step 2: 创建迁移脚本（伪代码）
  var source = new TencentCosStorage(...);   // 配置源 Provider
  var target = new CloudflareR2Storage(...); // 配置目标 Provider

  var cursor = db.asset_registry.find({ operation: "write", provider: "tencentCos" });
  foreach (var record in cursor)
  {
      // 下载
      var bytes = await source.TryDownloadBytesAsync(record.Key, ct);
      if (bytes == null) { log("SKIP: not found"); continue; }

      // 上传（key 路径完全一致）
      await target.UploadToKeyAsync(record.Key, bytes, record.Mime, ct);

      // 验证
      var newUrl = target.BuildUrlForKey(record.Key);
      var ok = await HttpHead(newUrl);  // HTTP 200?

      // 更新 registry
      await db.asset_registry.updateOne(
        { _id: record.Id },
        { $set: { provider: "cloudflareR2", url: newUrl } }
      );
  }

Step 3: 全库 URL 域名替换
  // 因为 key 路径两边完全一致，迁移后只是域名变了
  var collections = ["image_assets", "attachments", "messages", ...];
  foreach (var col in collections)
  {
      // 对每个包含 URL 的 string 字段做域名替换
      // https://i.miduo.org → https://cfi.miduo.org
  }

Step 4: 切换 ASSETS_PROVIDER 并重启

Step 5: 验证 — 随机采样旧数据页面，确认图片/文件可访问
```

### 需要扫描 URL 的集合（MECE）

| 集合 | URL 字段 | scope |
|------|---------|-------|
| `image_assets` | `CosUrl` | generated/user |
| `attachments` | `Url` | user |
| `messages` | `Body` 内嵌 URL | mixed |
| `watermark_configs` | `IconRef`, `PreviewBackgroundImageRef` | user |
| `watermark_font_assets` | `Url` | user |
| `hosted_sites` | `SiteUrl` | user |
| `desktop_assets` | `Url` | system |
| `desktop_asset_skins` | 皮肤资源 URL | system |
| `image_gen_run_items` | `OutputUrl`, `InputUrl` | generated |
| `defect_reports` | 附件 URL | user |
| `literary_prompts` | `ImageUrl` | user |
| `reference_image_configs` | `ImageUrl` | user |
| `video_gen_runs` | 场景 URL | generated |
| `document_entries` | `FileUrl` | user |
| `llmrequestlogs` | `ArtifactSha256` | log |

### 安全机制

- **DRY RUN 模式**：先统计不执行
- **断点续传**：记录已迁移的 `_id` 到 `migration_progress` 集合
- **回滚日志**：每次 URL 替换记录 before/after
- **并发限制**：同时最多 5 个下载+上传
- **SHA256 校验**：下载后比对 hash 确保完整性

## 系统/用户资源分离路线图

### 当前状态（Phase 0 — 已完成）

- `asset_registry` 自动登记 + scope 标签
- 不改存储路径，不改 URL 格式
- 可随时通过 `db.asset_registry.aggregate` 按 scope 统计

### Phase 1 — 系统资源克隆（按需实施）

场景：新建系统实例，需要拷贝系统资源但不拷贝用户数据。

```javascript
// 导出系统资源清单
db.asset_registry.find({ scope: "system", operation: "write" })

// 批量拷贝到目标 bucket
foreach (var asset in systemAssets)
{
    download from source → upload to target
}
```

### Phase 2 — 物理路径分离（远期，按需实施）

```
当前: data/{domain}/{type}/{sha}.{ext}
未来: data/sys/{domain}/{type}/{sha}.{ext}   ← 系统
      data/usr/{domain}/{type}/{sha}.{ext}   ← 用户
      data/gen/{domain}/{type}/{sha}.{ext}   ← AI 生成
      data/log/{domain}/{type}/{sha}.{ext}   ← 日志
```

改造成本：
- 修改 `AppDomainPaths` + `BuildObjectKey` 逻辑
- 全量 URL 迁移（基于 registry 批量执行）
- 前端零改动（全地址 URL 存储在 DB）

### 用户数据保护原则

> **宁可误分为 user，也不把 user 误分为 system。**

- scope 默认值是 `user`（最保守的分类）
- system scope 只通过 key 路径精确匹配（`icon/desktop/`, `icon/backups/head/`）
- 删除操作受安全策略保护（`_it/` 测试目录 + 白名单机制）
- 迁移前必须 DRY RUN 验证

## 系统资产同步（System Asset Sync）

### 问题

系统图标（Agent 封面、默认头像、桌面启动动画等）是手动上传到对象存储的，不经过 `SaveAsync`，因此：
- MongoDB 中没有任何记录
- `asset_registry` 也不会自动登记
- 切换 Provider 后这些文件在新 bucket 中不存在 → UI 图标全部 404

### 解法

`SystemAssetManifest` 维护一份声明式清单（24 个文件），`StorageSyncController` 提供一键同步 API。

### 清单内容（24 个文件）

| 类别 | 数量 | 路径示例 |
|------|------|---------|
| 默认头像 | 4 | `icon/backups/head/nohead.png`, `bot_pm.gif` |
| Agent 封面图 | 9 | `icon/backups/agent/visual-agent.png` |
| Agent 视频 | 9 | `icon/backups/agent/visual-agent.mp4` |
| 桌面启动动画 | 2 | `icon/desktop/load.gif` |

### 同步命令

```bash
# 1. 先预览（DRY RUN）
curl -X POST https://preview.miduo.org/api/storage/sync-system-assets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sourceBaseUrl":"https://i.miduo.org","dryRun":true}'

# 2. 执行同步
curl -X POST https://preview.miduo.org/api/storage/sync-system-assets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sourceBaseUrl":"https://i.miduo.org","dryRun":false}'

# 3. 验证
curl https://preview.miduo.org/api/storage/system-assets \
  -H "Authorization: Bearer $TOKEN"
```

### 切换 Provider 完整步骤（更新版）

```
1. 配置新 Provider 环境变量（R2_* 等）
2. 设置 ASSETS_PROVIDER=cloudflareR2
3. 重启服务
4. POST /api/storage/sync-system-assets（从旧域名拉取系统资产到新 Provider）
5. 验证 GET /api/storage/system-assets（确认 24 个文件都 present）
6. 新上传的文件自动走新 Provider
7. 旧用户数据仍通过旧域名访问（全地址 URL 存在 DB 中）
```

### 新增系统资产时的维护规则

在 `SystemAssetManifest.cs` 中追加路径。只要加了新的系统图标（Agent 封面、桌面皮肤等），必须同步更新清单。

## 关联文档

- `IAssetStorage.cs` — 存储接口定义
- `RegistryAssetStorage.cs` — 装饰器实现
- `AssetRegistryEntry.cs` — 登记簿 Model
- `CloudflareR2Storage.cs` — R2 实现
- `TencentCosStorage.cs` — 腾讯 COS 实现
