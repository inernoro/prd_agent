namespace PrdAgent.Core.Models;

/// <summary>A user-confirmed prompt located at a placeholder in the original article.</summary>
public sealed record ArticleAnchorPrompt(int Offset, int SourceOffset, string Prompt);
