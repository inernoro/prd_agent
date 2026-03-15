# prd-api — .NET 8 后端 (C# 12)

## 构建命令

```bash
dotnet restore
dotnet build
dotnet watch run --project src/PrdAgent.Api  # Dev server (port 5000)
dotnet test PrdAgent.sln                     # Run all tests (xunit)
dotnet test PrdAgent.sln --filter "Category!=Integration"  # Unit tests only
dotnet test --filter "FullyQualifiedName~ClassName.MethodName"  # Single test
```

Docker build: `../scripts/build-server-docker.sh`

## C# 静态分析

任何 `.cs` 改动完成后必须执行：

```bash
dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

- `error CS*`：必须修复
- `warning CS*`：评估是否为本次改动引入，如是则修复
