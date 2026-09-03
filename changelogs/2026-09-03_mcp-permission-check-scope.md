| fix | prd-api | 修复签发密钥时把海鲜市场 scope 也拿去做权限交集校验的问题：权限目录里没有 marketplace.skills.* 权限位，那条校验会让所有人（含 root）都签不出市场密钥 |
| test | prd-api | 权限映射守卫改为只覆盖真正参与校验的四个 scope，并补两条断言钉住「为什么排除市场与知识库」 |
