# 安装去牛皮癣技能

版本1.0.2使用账本schema v2，增加默认双图对照渲染与一次打开原图的浏览器行为检查；旧v1不会自动通过。升级后先迁移证据，不以改版本号代替补证。

此包只有技能正文、辅助脚本与可执行契约测试，没有服务、凭据、截图或浏览器会话。Python 3.9+ 可打包、校验与执行测试；浏览器操作与构建工具使用目标项目已批准的能力，不由此技能自动安装或启动。

在目标项目根目录执行，先确认 ZIP 内容根目录为 `dechrome/`：

```sh
unzip -l /path/to/dechrome.zip
SKILLS_DIRS=""
for h in .claude .agents; do
  [ -d "$h" ] && SKILLS_DIRS="$SKILLS_DIRS $h/skills"
done
[ -n "$SKILLS_DIRS" ] || SKILLS_DIRS=".agents/skills"
for d in $SKILLS_DIRS; do mkdir -p "$d" && unzip -n /path/to/dechrome.zip -d "$d"; done
```

存在几个宿主就装几个；没有宿主时兜底 `.agents/skills`。不写用户主目录，不新增第三套宿主。`unzip -n` 不覆盖已有技能；升级时先比较现有版本并按目标仓库维护约定替换，避免留下旧版文件。

重启或刷新宿主的技能发现，输入：“去牛皮癣，先逐页实测再修复。”前端宿主识别 `SKILL.md` 的 `name` 与 `description`；无需修改 CLAUDE.md 或建立额外技能索引。

在本仓库修改时只维护 `.claude/skills/dechrome/`，其他宿主副本由项目约定生成或本地镜像，避免两份正文手工漂移。ZIP 是可复现分发产物，不是第二份编辑源。

## 重新生成与验证

在已安装技能目录中运行：

```bash
python3 scripts/package_skill.py --output /tmp/dechrome.zip
python3 -m unittest discover -s tests -p 'test_*.py'
```

脚本只打包显式清单；输出 ZIP 与同目录 `dechrome.zip.sha256`。版本来自 SKILL.md；生成过程不上传、注册市场或发布生产。发布前自行比对 SHA-256，并使用团队允许的下载工件入口分享。不能把本机路径写成他人可下载链接。
