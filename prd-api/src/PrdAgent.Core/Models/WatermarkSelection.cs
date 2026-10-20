namespace PrdAgent.Core.Models;

/// <summary>单次生图对水印的显式选择。</summary>
public static class WatermarkSelection
{
    /// <summary>明确不打水印的哨兵值（区别于 null = 沿用账号默认绑定）。</summary>
    public const string None = "none";
}
