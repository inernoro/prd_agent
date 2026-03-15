# 各维度扫描命令

> 被 SKILL.md Phase 2 引用。Claude 执行扫描时按需读取。

## 维度一：导航与入口变更

```bash
# 管理后台路由/页面变更
git diff main...HEAD -- "prd-admin/src/App.tsx" "prd-admin/src/pages/**" --name-only

# API 端点变更
git diff main...HEAD -- "prd-api/src/PrdAgent.Api/Controllers/**" --name-only

# 菜单变更
grep -rn "sidebar\|menu\|nav" prd-admin/src/ --include="*.tsx" | head -20

# 桌面端入口变更
git diff main...HEAD -- "prd-desktop/src/pages/**" "prd-desktop/src/components/**" --name-only
```

## 维度二：文档沉淀

```bash
# 文档变更
git diff main...HEAD -- "doc/**" --name-only

# 新 MongoDB 集合（需更新数据字典）
git diff main...HEAD -- "prd-api/src/PrdAgent.Infrastructure/Data/MongoDbContext.cs"

# 新 Controller（需更新 SRS）
git diff main...HEAD -- "prd-api/src/PrdAgent.Api/Controllers/**" --name-only | grep -i "controller"
```

## 维度三：规则与约定

```bash
# 新 appKey
git diff main...HEAD | grep -i "appkey\|AppKey\|app-key"

# 新 AppCallerCode
git diff main...HEAD | grep -i "appcallercode\|AppCallerCode"

# 新权限
git diff main...HEAD | grep -i "AdminPermission\|PermissionCatalog"

# 新 MongoDB 集合
git diff main...HEAD | grep -i "GetCollection\|IMongoCollection"
```

## 维度四：流程变更

```bash
# DTO/Model 变更
git diff main...HEAD -- "prd-api/src/PrdAgent.Core/Models/**" --name-only

# 接口定义变更
git diff main...HEAD -- "prd-api/src/PrdAgent.Core/Interfaces/**" --name-only

# 前端 API 服务变更
git diff main...HEAD -- "prd-admin/src/services/**" --name-only
```

## 维度五：测试

```bash
# 测试文件变更
git diff main...HEAD -- "**/*Test*" "**/*test*" "**/*spec*" --name-only
```

## 维度七：代码质量

```bash
# 后端编译
cd prd-api && dotnet build --no-restore 2>&1 | tail -5

# 前端类型检查
cd prd-admin && pnpm tsc --noEmit 2>&1 | tail -10

# 桌面端检查
cd prd-desktop/src-tauri && cargo check 2>&1 | tail -5
```
