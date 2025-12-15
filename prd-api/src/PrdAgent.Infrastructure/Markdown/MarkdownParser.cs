using System.Text.RegularExpressions;
using Markdig;
using Markdig.Syntax;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Markdown;

/// <summary>
/// Markdown解析器
/// </summary>
public class MarkdownParser : IMarkdownParser
{
    private readonly MarkdownPipeline _pipeline;

    public MarkdownParser()
    {
        _pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .Build();
    }

    /// <summary>解析Markdown文档</summary>
    public ParsedPrd Parse(string content)
    {
        var document = Markdig.Markdown.Parse(content, _pipeline);
        // 统一处理 Windows(\r\n) 和 Unix(\n) 换行符
        var lines = content.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n');
        
        var title = ExtractTitle(document, lines);
        var sections = ExtractSections(lines);
        var charCount = content.Length;
        var tokenEstimate = EstimateTokens(content);

        return new ParsedPrd
        {
            Title = title,
            RawContent = content,
            CharCount = charCount,
            TokenEstimate = tokenEstimate,
            Sections = sections
        };
    }

    private string ExtractTitle(MarkdownDocument document, string[] lines)
    {
        // 查找第一个H1标题
        foreach (var block in document)
        {
            if (block is HeadingBlock heading && heading.Level == 1)
            {
                var line = heading.Line;
                if (line >= 0 && line < lines.Length)
                {
                    return lines[line].TrimStart('#', ' ');
                }
            }
        }
        
        // 如果没有H1，尝试从第一行提取
        if (lines.Length > 0)
        {
            var firstLine = lines[0].Trim();
            if (firstLine.StartsWith("#"))
            {
                return firstLine.TrimStart('#', ' ');
            }
        }
        
        return "未命名文档";
    }

    private List<Section> ExtractSections(string[] lines)
    {
        var sections = new List<Section>();
        var headingPattern = new Regex(@"^(#{1,6})\s+(.+)$");
        var currentSection = new Stack<Section>();
        
        for (int i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var match = headingPattern.Match(line);
            
            if (match.Success)
            {
                var level = match.Groups[1].Value.Length;
                var title = match.Groups[2].Value.Trim();
                
                var section = new Section
                {
                    Level = level,
                    Title = title,
                    StartLine = i + 1, // 1-based
                    EndLine = i + 1
                };
                
                // 更新之前章节的结束行
                if (sections.Count > 0)
                {
                    UpdateEndLines(sections, i);
                }
                
                // 根据层级添加到合适的位置
                if (level == 1 || currentSection.Count == 0)
                {
                    sections.Add(section);
                    currentSection.Clear();
                    currentSection.Push(section);
                }
                else
                {
                    // 找到合适的父章节
                    while (currentSection.Count > 0 && currentSection.Peek().Level >= level)
                    {
                        currentSection.Pop();
                    }
                    
                    if (currentSection.Count > 0)
                    {
                        currentSection.Peek().Children.Add(section);
                    }
                    else
                    {
                        sections.Add(section);
                    }
                    currentSection.Push(section);
                }
            }
        }
        
        // 更新最后章节的结束行
        if (sections.Count > 0)
        {
            UpdateEndLines(sections, lines.Length);
        }
        
        return sections;
    }

    private void UpdateEndLines(List<Section> sections, int endLine)
    {
        foreach (var section in sections)
        {
            if (section.EndLine == section.StartLine)
            {
                section.EndLine = endLine;
            }
            UpdateEndLines(section.Children, endLine);
        }
    }

    /// <summary>估算Token数量</summary>
    public int EstimateTokens(string content)
    {
        // 简化估算：中文约0.7个Token/字符，英文约0.25个Token/字符
        var chineseCount = Regex.Matches(content, @"[\u4e00-\u9fff]").Count;
        var otherCount = content.Length - chineseCount;
        
        return (int)(chineseCount * 1.5 + otherCount * 0.25);
    }
}
