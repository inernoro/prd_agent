| fix | prd-api | 修复非团队成员可在团队管理页看到所有团队的权限漏洞：ListTeams 改用 ReportAgentTeamManage 判断全量可见性，而非 ReportAgentViewAll |
| fix | prd-api | 修复 GetTeam 详情端点缺少访问控制的安全漏洞，补充成员/负责人/管理员权限校验 |
