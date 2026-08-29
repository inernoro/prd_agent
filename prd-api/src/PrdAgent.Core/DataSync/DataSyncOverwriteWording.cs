namespace PrdAgent.Core.DataSync;

/// <summary>
/// 把「覆盖已存在的记录」这个开关翻译成人话。
///
/// 放在 Core 而不是 Controller 里，有两个理由：一是报错文案与界面提示要用同一套说法，
/// 省得一处说「覆盖」另一处说「替换」（形状 3：同一件事的两份表述各自漂移）；
/// 二是测试项目不引用 Api，放在那边就没法直接钉住。
/// </summary>
public static class DataSyncOverwriteWording
{
    public static string Describe(bool overwrite)
        => overwrite ? "覆盖已存在的记录" : "跳过已存在的记录";
}
