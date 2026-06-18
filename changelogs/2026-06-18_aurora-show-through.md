| fix | prd-admin | 修复 aurora 背景被内容区遮挡:<main> 背景由不透明 var(--bg-base) 改 transparent,让外层 .app-aurora 彩色光晕透到内容区,半透卡片/玻璃面板才能折射到淡彩底色而非平底色(aurora 自身以 var(--bg-base) 收底,floor 色不变) |
