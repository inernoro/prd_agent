namespace PrdAgent.Api.Services;

/// <summary>一次要写进 run 的进度与阶段文案。</summary>
public sealed record OpenDesignProgressUpdate(int Progress, string Phase);

/// <summary>
/// 把 CDS 转来的 OpenDesign 阶段事件（status 事件的 reason / elapsedSeconds / attempt）
/// 翻译成 run 的进度与阶段文案（2026-09-23）。
///
/// 为什么有这个类：CDS 在 OpenDesign 运行期间约每 3 秒发一次阶段事件，MAP 也都收到了，
/// 但执行器只认文字 / 思考 / 出错 / 完成四种事件，阶段事件被丢掉；worker 于是只在开头写 18%、
/// 结尾写 100%，中间 9–12 分钟用户看到的一直是「正在规划页面结构与视觉层级 18%」。
///
/// 规矩：
/// - 进度只增不减（生命周期服务拒收倒退的进度；修复回路会回到「运行中」，不能让它把进度拉回去）。
/// - 进度上限 86：之后的「校验并保存」（88）与完成（100）仍由 worker 自己写。
/// - 阶段切换立刻出一条；同一阶段内按已运行时长每 15 秒出一条，文案里带上用时，
///   用户能看到「还在动」。一次 15 分钟的运行约 60–70 条，远低于生命周期的 1000 条上限。
/// - 认不出的 reason 不出更新（不编造阶段），交给下一条认得的事件。
/// </summary>
public sealed class OpenDesignStageProgress
{
    internal const int ElapsedStepSeconds = 15;
    internal const int MaxProgress = 86;

    private enum Macro
    {
        None,
        Preparing,
        Importing,
        Starting,
        Designing,
        Reviewing,
        Repairing,
        Collecting,
        Committing,
    }

    private readonly bool _editing;
    private Macro _macro = Macro.None;
    private int _repairAttempt;
    private int _progress;
    private int _lastElapsedBucket = -1;

    public OpenDesignStageProgress(bool editing, int startProgress)
    {
        _editing = editing;
        _progress = Math.Clamp(startProgress, 0, MaxProgress);
    }

    /// <summary>当前已写出的进度（只增不减）。</summary>
    public int Progress => _progress;

    /// <summary>
    /// 观察一条阶段事件；需要写进 run 时返回更新，否则返回 null。
    /// </summary>
    public OpenDesignProgressUpdate? Observe(string? reason, int? elapsedSeconds, int? attempt)
    {
        var next = MacroOf(reason);
        if (next == null)
            return null;

        var stageChanged = next.Value != Macro.Designing && next.Value != _macro;
        if (next.Value == Macro.Designing)
        {
            // 「运行中」事件属于它前面那个大阶段：首轮设计、终审或修复。
            // 只有还没进入任何设计相关阶段时，才把它算作首轮设计开始。
            if (_macro is Macro.None or Macro.Preparing or Macro.Importing or Macro.Starting)
            {
                stageChanged = _macro != Macro.Designing;
                _macro = Macro.Designing;
            }
        }
        else
        {
            if (next.Value == Macro.Repairing && attempt is > 0)
            {
                stageChanged = stageChanged || attempt.Value != _repairAttempt;
                _repairAttempt = attempt.Value;
            }
            _macro = next.Value;
        }

        var elapsed = Math.Max(0, elapsedSeconds ?? 0);
        var bucket = elapsed / ElapsedStepSeconds;
        var runningTick = next.Value == Macro.Designing && elapsedSeconds.HasValue;
        if (!stageChanged && !(runningTick && bucket != _lastElapsedBucket))
            return null;
        if (stageChanged)
            _lastElapsedBucket = runningTick ? bucket : -1;
        else
            _lastElapsedBucket = bucket;

        var target = TargetProgress(_macro, runningTick ? elapsed : 0);
        _progress = Math.Min(MaxProgress, Math.Max(_progress, target));
        return new OpenDesignProgressUpdate(_progress, PhaseText(_macro, runningTick ? elapsed : null));
    }

    private static Macro? MacroOf(string? reason) => reason switch
    {
        // task_accepted 只有直连设计执行服务时才有（服务接单的第一条事件）；container_* 只有经 CDS 会话时才有。
        "task_accepted" or "workspace_downloading" or "workspace_materialized" or "container_starting" or "container_ready"
            => Macro.Preparing,
        "open_design_importing" => Macro.Importing,
        "open_design_run_starting" => Macro.Starting,
        "open_design_running" => Macro.Designing,
        "open_design_reviewing" => Macro.Reviewing,
        "open_design_quality_repairing" => Macro.Repairing,
        "workspace_collecting" or "deliverable_entry_resolved" => Macro.Collecting,
        "workspace_committing" => Macro.Committing,
        _ => null,
    };

    /// <summary>
    /// 各阶段的进度区间。首轮设计实测占全程六成以上（2026-09-23 两次样本：32–34 轮模型调用，
    /// 写页面那一轮之前还有 8 轮左右的读取与规划），按已运行时长在区间里缓慢推进，
    /// 约 8 分钟走满；终审与修复各占一段小区间。
    /// </summary>
    private int TargetProgress(Macro macro, int elapsed) => macro switch
    {
        Macro.Preparing => 20,
        Macro.Importing => 22,
        Macro.Starting => 25,
        Macro.Designing => 25 + Math.Min(37, elapsed / 13),
        Macro.Reviewing => Math.Max(64, Math.Min(74, 64 + elapsed / 20)),
        Macro.Repairing => Math.Min(80, 75 + _repairAttempt),
        Macro.Collecting => 82,
        Macro.Committing => 85,
        _ => _progress,
    };

    private string PhaseText(Macro macro, int? elapsed)
    {
        var suffix = elapsed is > 0 ? $" · 已运行 {FormatElapsed(elapsed.Value)}" : string.Empty;
        return macro switch
        {
            Macro.Preparing => "正在准备隔离工作区",
            Macro.Importing => _editing ? "OpenDesign 正在读取当前页面与修改要求" : "OpenDesign 正在读取素材与任务书",
            Macro.Starting => _editing ? "OpenDesign 开始修改页面" : "OpenDesign 开始设计页面",
            Macro.Designing => (_editing ? "OpenDesign 正在修改页面" : "OpenDesign 正在设计并写出页面") + suffix,
            Macro.Reviewing => "OpenDesign 正在逐项自查" + suffix,
            Macro.Repairing => (_repairAttempt > 0
                ? $"正在修复自查发现的问题（第 {_repairAttempt} 次）"
                : "正在修复自查发现的问题") + suffix,
            Macro.Collecting => "正在收集并校验产物",
            Macro.Committing => "正在提交产物",
            _ => "OpenDesign 设计中",
        };
    }

    internal static string FormatElapsed(int seconds)
        => seconds < 60 ? $"{seconds} 秒" : $"{seconds / 60} 分 {seconds % 60:D2} 秒";
}
