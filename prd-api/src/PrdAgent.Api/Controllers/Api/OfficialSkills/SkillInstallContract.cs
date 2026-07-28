namespace PrdAgent.Api.Controllers.Api.OfficialSkills;

/// <summary>
/// 技能安装约定的单一事实源。
///
/// 为什么需要这个类：安装目录这件事此前散在四处各写各的 ——
/// findmapskills 的 SKILL.md 写 `~/.claude/skills/`（用户级且写死 .claude）、
/// 套装的 installCommand 写 `~/.claude/skills/`、套装 INSTALL.md 又写一遍、
/// CDS 的引导脚本写项目级三宿主探测。结果是同一个客户项目里会分裂出两处技能库：
/// 一处跟着 git 走、一处跟着这台机器走，队友 clone 下来少一半。
///
/// 约定本身：**项目级优先，不写用户主目录**。技能跟着项目的版本库走，
/// 团队每个人都有；装到 `~` 的话，人一走团队什么都不剩。
///
/// 宿主目录：`.claude` / `.cursor` / `.agents`，**存在几个就装几个**，一个都没有时
/// 建 `.agents/skills` 兜底。早期版本按 `.claude` → `.cursor` → `.agents` 取第一个
/// 命中的，在同时装了多个 Agent 的仓库里会装到「不是当前 Agent 读的那个目录」——
/// 本仓库同时有 `.claude` 和 `.agents`，从 Codex 跑引导脚本会装进 `.claude/skills`，
/// 而 Codex 只读 `.agents/skills`，结果是「装完了但一个技能都看不见」。
/// 装到多处的代价是几百 KB 重复文件，比装了看不见小得多。
///
/// 同一份约定的另外两处实现（跨语言无法共享代码，靠本文档注释与守卫测试对齐）：
/// - `cds/src/routes/bootstrap.ts` 的引导脚本
/// - `.claude/skills/findmapskills/SKILL.md` 的「下载」一节
/// 三处任意一处改了探测顺序或默认层级，另外两处必须同步。
/// </summary>
public static class SkillInstallContract
{
    /// <summary>
    /// 宿主探测片段（POSIX sh）。执行后 <c>$SKILLS_DIRS</c> 是空格分隔的目标目录列表
    /// （存在几个宿主就有几个），并已全部 mkdir。
    /// </summary>
    public const string DetectSnippet =
        """
        SKILLS_DIRS=""
        for h in .claude .cursor .agents; do
          [ -d "$h" ] && SKILLS_DIRS="$SKILLS_DIRS $h/skills"
        done
        [ -n "$SKILLS_DIRS" ] || SKILLS_DIRS=".agents/skills"
        for d in $SKILLS_DIRS; do mkdir -p "$d"; done
        """;

    /// <summary>
    /// 宿主探测的单行等价式。
    /// 不能把 <see cref="DetectSnippet"/> 用 <c>&amp;&amp;</c> 拼成一行 ——
    /// <c>if ... &amp;&amp; elif ...</c> 不是合法 shell，粘贴过去直接语法错。
    /// </summary>
    public const string DetectOneLiner =
        "SKILLS_DIRS=$(for h in .claude .cursor .agents; do [ -d \"$h\" ] && "
        + "printf '%s/skills ' \"$h\"; done); [ -n \"$SKILLS_DIRS\" ] || SKILLS_DIRS=.agents/skills";

    /// <summary>拼一条「下载并装到项目级技能目录」的完整命令（可直接粘贴执行）。</summary>
    public static string BuildInstallCommand(string downloadUrl, string fileName) =>
        $"{DetectOneLiner} && curl -sSLo /tmp/{fileName} \"{downloadUrl}\" && "
        + $"for d in $SKILLS_DIRS; do mkdir -p \"$d\" && unzip -o /tmp/{fileName} -d \"$d\"; done";
}
