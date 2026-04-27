| refactor | prd-admin | 解决 NavSection 类型同名冲突：navRegistry.tsx 的 NavSection（4 段：agent/toolbox/utility/infra）重命名为 RegistrySection；unifiedNavCatalog.ts 的 NavSection（7 段：含 home/shortcut/menu）保留。launcherCatalog 跟随更新 import |
| chore | prd-admin | 删除 getHardcodedDefaultNavOrder dead code（@deprecated 标记的兼容壳，实际无任何调用方） |
