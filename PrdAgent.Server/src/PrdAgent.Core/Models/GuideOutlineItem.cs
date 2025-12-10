namespace PrdAgent.Core.Models;

/// <summary>
/// 引导大纲项
/// </summary>
public class GuideOutlineItem
{
    public int Step { get; set; }
    public string Title { get; set; } = string.Empty;
    public string PromptTemplate { get; set; } = string.Empty;
}



