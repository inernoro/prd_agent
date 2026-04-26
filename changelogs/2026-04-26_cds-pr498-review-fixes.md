| fix | cds | 子域名 auto-build 错误处理与锁清理: catch 块按 canonicalId 查 entry (而非 bare finalSlug),非 legacy 项目部署失败时 entry 不再卡死在 building; finally 块迭代 lockKeys Set 清理所有注册过的 build lock,杜绝内存泄漏
| fix | cds | legacy-cleanup/cleanup-residual 拒绝在 customEnv['default'] 仍有非空键时执行,避免静默丢失用户密钥
