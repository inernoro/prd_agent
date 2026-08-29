| fix | ops | cds-compose 的 Mongo / Redis 连接串补上凭据：mongo 跑 `--auth`、redis 跑 `--aclfile` 之后，只给地址的连接串会让容器启动即崩（Unauthorized / NOAUTH）。线上 CDS 的 build profile 早已改成带凭据并跑通，仓库里这份导入源还停在旧写法——谁重新导一次 compose 就把每条分支重新打回连不上库的状态 |
| fix | ops | mongo 用 `${CDS_MONGODB_URL}` 而不是手拼 `user:pass@host`：CDS 派生这个值时 userinfo 段已做百分号编码，口令里一个 `@` 就能把主机名解析歪。redis 反过来用原始 `_USER` / `_PASSWORD` 自己拼——StackExchange.Redis 不吃 `redis://` URI，只认 `host:port,user=,password=` |
| chore | ops | `.gitignore` 的 `node_modules/` 补一条不带尾斜杠的：尾斜杠只匹配目录，匹配不到同名**软链**（软链在 git 眼里是文件），临时 worktree 里软链依赖目录跑测试时 `git add -A` 会把它们提交进去 |
| docs | cds | `debt.knowledge-base.md` 把「报告只读要不要扩大老授权」那条待定改成已定：单开 `report:read`、不扩大存量凭据，代价是重新授权一次，这是有意付的；并记下两条分支同一件事各写一遍、合并 main 时怎么收敛的 |
