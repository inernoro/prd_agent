using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 缺陷管理 Agent 单元测试
/// </summary>
public class DefectAgentTests
{
    #region DefectReport Tests

    [Fact]
    public void DefectReport_DefaultValues_ShouldBeCorrect()
    {
        // Arrange & Act
        var report = new DefectReport();

        // Assert
        Assert.NotNull(report.Id);
        Assert.Equal(32, report.Id.Length); // GUID without dashes
        Assert.Equal(DefectStatus.Draft, report.Status);
        Assert.Empty(report.RawContent);
        Assert.Empty(report.StructuredData);
        Assert.Empty(report.Attachments);
        Assert.Empty(report.MissingFields);
        Assert.Null(report.Title);
        Assert.Null(report.Severity);
        Assert.Null(report.AssigneeId);
        Assert.True(report.CreatedAt <= DateTime.UtcNow);
    }

    [Fact]
    public void DefectReport_SetProperties_ShouldWork()
    {
        // Arrange
        var report = new DefectReport
        {
            DefectNo = "DEF-2025-0001",
            Title = "登录页面空白",
            RawContent = "登录后页面显示空白",
            Status = DefectStatus.Submitted,
            Severity = DefectSeverity.Critical,
            ReporterId = "user123",
            ReporterName = "张三"
        };

        // Assert
        Assert.Equal("DEF-2025-0001", report.DefectNo);
        Assert.Equal("登录页面空白", report.Title);
        Assert.Equal(DefectStatus.Submitted, report.Status);
        Assert.Equal(DefectSeverity.Critical, report.Severity);
        Assert.Equal("user123", report.ReporterId);
        Assert.Equal("张三", report.ReporterName);
    }

    [Fact]
    public void DefectStatus_All_ShouldContainAllStatuses()
    {
        // Assert
        Assert.Contains(DefectStatus.Draft, DefectStatus.All);
        Assert.Contains(DefectStatus.Reviewing, DefectStatus.All);
        Assert.Contains(DefectStatus.Awaiting, DefectStatus.All);
        Assert.Contains(DefectStatus.Submitted, DefectStatus.All);
        Assert.Contains(DefectStatus.Assigned, DefectStatus.All);
        Assert.Contains(DefectStatus.Processing, DefectStatus.All);
        Assert.Contains(DefectStatus.Resolved, DefectStatus.All);
        Assert.Contains(DefectStatus.Rejected, DefectStatus.All);
        Assert.Contains(DefectStatus.Closed, DefectStatus.All);
        Assert.Equal(9, DefectStatus.All.Length);
    }

    [Fact]
    public void DefectSeverity_All_ShouldContainAllSeverities()
    {
        // Assert
        Assert.Contains(DefectSeverity.Blocker, DefectSeverity.All);
        Assert.Contains(DefectSeverity.Critical, DefectSeverity.All);
        Assert.Contains(DefectSeverity.Major, DefectSeverity.All);
        Assert.Contains(DefectSeverity.Minor, DefectSeverity.All);
        Assert.Contains(DefectSeverity.Suggestion, DefectSeverity.All);
        Assert.Equal(5, DefectSeverity.All.Length);
    }

    #endregion

    #region DefectTemplate Tests

    [Fact]
    public void DefectTemplate_DefaultValues_ShouldBeCorrect()
    {
        // Arrange & Act
        var template = new DefectTemplate();

        // Assert
        Assert.NotNull(template.Id);
        Assert.Equal(32, template.Id.Length);
        Assert.Empty(template.Name);
        Assert.Empty(template.RequiredFields);
        Assert.False(template.IsDefault);
        Assert.Null(template.AiSystemPrompt);
    }

    [Fact]
    public void DefectTemplate_WithFields_ShouldWork()
    {
        // Arrange
        var template = new DefectTemplate
        {
            Name = "默认模板",
            Description = "系统默认的缺陷提交模板",
            IsDefault = true,
            RequiredFields = new List<DefectTemplateField>
            {
                new() { Key = "title", Label = "问题标题", Type = "text", Required = true },
                new() { Key = "severity", Label = "严重程度", Type = "select", Required = true,
                    Options = new List<string> { "blocker", "critical", "major", "minor", "suggestion" } }
            }
        };

        // Assert
        Assert.Equal("默认模板", template.Name);
        Assert.True(template.IsDefault);
        Assert.Equal(2, template.RequiredFields.Count);
        Assert.Equal("title", template.RequiredFields[0].Key);
        Assert.Equal("select", template.RequiredFields[1].Type);
        Assert.Equal(5, template.RequiredFields[1].Options?.Count);
    }

    [Fact]
    public void DefectTemplateField_DefaultValues_ShouldBeCorrect()
    {
        // Arrange & Act
        var field = new DefectTemplateField();

        // Assert
        Assert.Empty(field.Key);
        Assert.Empty(field.Label);
        Assert.Equal("text", field.Type);
        Assert.True(field.Required);
        Assert.Null(field.Options);
        Assert.Null(field.Placeholder);
        Assert.Null(field.AiPrompt);
    }

    #endregion

    #region DefectMessage Tests

    [Fact]
    public void DefectMessage_DefaultValues_ShouldBeCorrect()
    {
        // Arrange & Act
        var message = new DefectMessage();

        // Assert
        Assert.NotNull(message.Id);
        Assert.Equal(32, message.Id.Length);
        Assert.Empty(message.DefectId);
        Assert.Equal(0, message.Seq);
        Assert.Equal(DefectMessageRole.User, message.Role);
        Assert.Empty(message.Content);
        Assert.Null(message.AttachmentIds);
        Assert.Null(message.ExtractedFields);
    }

    [Fact]
    public void DefectMessage_SetProperties_ShouldWork()
    {
        // Arrange
        var message = new DefectMessage
        {
            DefectId = "defect123",
            Seq = 1,
            Role = DefectMessageRole.Assistant,
            Content = "请补充复现步骤",
            ExtractedFields = new Dictionary<string, string> { { "title", "登录问题" } }
        };

        // Assert
        Assert.Equal("defect123", message.DefectId);
        Assert.Equal(1, message.Seq);
        Assert.Equal(DefectMessageRole.Assistant, message.Role);
        Assert.Equal("请补充复现步骤", message.Content);
        Assert.Single(message.ExtractedFields);
        Assert.Equal("登录问题", message.ExtractedFields["title"]);
    }

    [Fact]
    public void DefectMessageRole_Constants_ShouldBeCorrect()
    {
        // Assert
        Assert.Equal("user", DefectMessageRole.User);
        Assert.Equal("assistant", DefectMessageRole.Assistant);
    }

    #endregion

    #region DefectAttachment Tests

    [Fact]
    public void DefectAttachment_DefaultValues_ShouldBeCorrect()
    {
        // Arrange & Act
        var attachment = new DefectAttachment();

        // Assert
        Assert.NotNull(attachment.Id);
        Assert.Equal(32, attachment.Id.Length);
        Assert.Empty(attachment.FileName);
        Assert.Equal(0, attachment.FileSize);
        Assert.Empty(attachment.MimeType);
        Assert.Empty(attachment.CosUrl);
        Assert.Null(attachment.ThumbnailUrl);
    }

    [Fact]
    public void DefectAttachment_SetProperties_ShouldWork()
    {
        // Arrange
        var attachment = new DefectAttachment
        {
            FileName = "screenshot.png",
            FileSize = 1024 * 100, // 100KB
            MimeType = "image/png",
            CosUrl = "https://cos.example.com/defect-agent/attachments/2025/01/xxx/screenshot.png",
            ThumbnailUrl = "https://cos.example.com/defect-agent/attachments/2025/01/xxx/screenshot_thumb.png"
        };

        // Assert
        Assert.Equal("screenshot.png", attachment.FileName);
        Assert.Equal(102400, attachment.FileSize);
        Assert.Equal("image/png", attachment.MimeType);
        Assert.Contains("cos.example.com", attachment.CosUrl);
        Assert.Contains("thumb", attachment.ThumbnailUrl);
    }

    #endregion

    #region Workflow Tests

    [Fact]
    public void DefectWorkflow_StatusTransition_DraftToSubmitted()
    {
        // Arrange
        var defect = new DefectReport
        {
            Status = DefectStatus.Draft,
            RawContent = "问题描述"
        };

        // Act - 模拟提交流程
        defect.Status = DefectStatus.Submitted;
        defect.SubmittedAt = DateTime.UtcNow;

        // Assert
        Assert.Equal(DefectStatus.Submitted, defect.Status);
        Assert.NotNull(defect.SubmittedAt);
    }

    [Fact]
    public void DefectWorkflow_StatusTransition_SubmittedToAssigned()
    {
        // Arrange
        var defect = new DefectReport
        {
            Status = DefectStatus.Submitted,
            SubmittedAt = DateTime.UtcNow
        };

        // Act - 模拟指派流程
        defect.AssigneeId = "dev123";
        defect.AssigneeName = "李四";
        defect.Status = DefectStatus.Assigned;
        defect.AssignedAt = DateTime.UtcNow;

        // Assert
        Assert.Equal(DefectStatus.Assigned, defect.Status);
        Assert.Equal("dev123", defect.AssigneeId);
        Assert.Equal("李四", defect.AssigneeName);
        Assert.NotNull(defect.AssignedAt);
    }

    [Fact]
    public void DefectWorkflow_StatusTransition_AssignedToResolved()
    {
        // Arrange
        var defect = new DefectReport
        {
            Status = DefectStatus.Assigned,
            AssigneeId = "dev123"
        };

        // Act - 模拟处理和解决流程
        defect.Status = DefectStatus.Processing;
        defect.Status = DefectStatus.Resolved;
        defect.Resolution = "已修复登录逻辑";
        defect.ResolvedAt = DateTime.UtcNow;

        // Assert
        Assert.Equal(DefectStatus.Resolved, defect.Status);
        Assert.Equal("已修复登录逻辑", defect.Resolution);
        Assert.NotNull(defect.ResolvedAt);
    }

    [Fact]
    public void DefectWorkflow_StatusTransition_AssignedToRejected()
    {
        // Arrange
        var defect = new DefectReport
        {
            Status = DefectStatus.Assigned,
            AssigneeId = "dev123"
        };

        // Act - 模拟拒绝流程
        defect.Status = DefectStatus.Rejected;
        defect.RejectReason = "无法复现";

        // Assert
        Assert.Equal(DefectStatus.Rejected, defect.Status);
        Assert.Equal("无法复现", defect.RejectReason);
    }

    [Fact]
    public void DefectWorkflow_StatusTransition_ResolvedToClosed()
    {
        // Arrange
        var defect = new DefectReport
        {
            Status = DefectStatus.Resolved,
            ResolvedAt = DateTime.UtcNow
        };

        // Act - 模拟关闭流程
        defect.Status = DefectStatus.Closed;
        defect.ClosedAt = DateTime.UtcNow;

        // Assert
        Assert.Equal(DefectStatus.Closed, defect.Status);
        Assert.NotNull(defect.ClosedAt);
    }

    [Fact]
    public void DefectWorkflow_Reopen_ShouldClearResolutionFields()
    {
        // Arrange
        var defect = new DefectReport
        {
            Status = DefectStatus.Closed,
            Resolution = "已修复",
            ResolvedAt = DateTime.UtcNow,
            ClosedAt = DateTime.UtcNow,
            AssigneeId = "dev123"
        };

        // Act - 模拟重新打开
        defect.Status = DefectStatus.Assigned; // 有指派人，回到已指派状态
        defect.Resolution = null;
        defect.RejectReason = null;
        defect.ResolvedAt = null;
        defect.ClosedAt = null;

        // Assert
        Assert.Equal(DefectStatus.Assigned, defect.Status);
        Assert.Null(defect.Resolution);
        Assert.Null(defect.ResolvedAt);
        Assert.Null(defect.ClosedAt);
        Assert.Equal("dev123", defect.AssigneeId); // 保留指派人
    }

    #endregion

    #region DefectNo Generation Tests

    [Fact]
    public void DefectNo_Format_ShouldBeCorrect()
    {
        // Arrange
        var year = DateTime.UtcNow.Year;
        var expectedPrefix = $"DEF-{year}-";

        // Act
        var defectNo1 = $"DEF-{year}-0001";
        var defectNo2 = $"DEF-{year}-0099";
        var defectNo3 = $"DEF-{year}-1234";

        // Assert
        Assert.StartsWith(expectedPrefix, defectNo1);
        Assert.StartsWith(expectedPrefix, defectNo2);
        Assert.StartsWith(expectedPrefix, defectNo3);
        Assert.Equal(14, defectNo1.Length); // DEF-2025-0001
    }

    [Theory]
    [InlineData("DEF-2025-0001", true)]
    [InlineData("DEF-2025-9999", true)]
    [InlineData("DEF-2024-0001", true)]
    [InlineData("DEFECT-2025-0001", false)]
    [InlineData("DEF-25-0001", false)]
    [InlineData("DEF-2025-1", false)]
    public void DefectNo_Validation_ShouldMatchPattern(string defectNo, bool shouldMatch)
    {
        // Arrange
        var pattern = new System.Text.RegularExpressions.Regex(@"^DEF-\d{4}-\d{4}$");

        // Act
        var matches = pattern.IsMatch(defectNo);

        // Assert
        Assert.Equal(shouldMatch, matches);
    }

    #endregion

    #region Attachment Tests

    [Fact]
    public void DefectReport_AddAttachment_ShouldWork()
    {
        // Arrange
        var report = new DefectReport();
        var attachment = new DefectAttachment
        {
            FileName = "error.log",
            FileSize = 5000,
            MimeType = "text/plain",
            CosUrl = "https://cos.example.com/logs/error.log"
        };

        // Act
        report.Attachments.Add(attachment);

        // Assert
        Assert.Single(report.Attachments);
        Assert.Equal("error.log", report.Attachments[0].FileName);
    }

    [Fact]
    public void DefectReport_MultipleAttachments_ShouldWork()
    {
        // Arrange
        var report = new DefectReport();

        // Act
        report.Attachments.Add(new DefectAttachment { FileName = "screenshot1.png", MimeType = "image/png" });
        report.Attachments.Add(new DefectAttachment { FileName = "screenshot2.png", MimeType = "image/png" });
        report.Attachments.Add(new DefectAttachment { FileName = "console.log", MimeType = "text/plain" });

        // Assert
        Assert.Equal(3, report.Attachments.Count);
        Assert.Equal(2, report.Attachments.Count(a => a.MimeType == "image/png"));
        Assert.Single(report.Attachments.Where(a => a.MimeType == "text/plain"));
    }

    [Fact]
    public void DefectReport_RemoveAttachment_ShouldWork()
    {
        // Arrange
        var report = new DefectReport();
        var attachment = new DefectAttachment { FileName = "test.png" };
        report.Attachments.Add(attachment);

        // Act
        var removed = report.Attachments.Remove(attachment);

        // Assert
        Assert.True(removed);
        Assert.Empty(report.Attachments);
    }

    #endregion

    #region StructuredData Tests

    [Fact]
    public void DefectReport_StructuredData_ShouldStoreExtractedFields()
    {
        // Arrange
        var report = new DefectReport();

        // Act
        report.StructuredData["title"] = "登录失败";
        report.StructuredData["description"] = "点击登录按钮后无响应";
        report.StructuredData["steps"] = "1. 打开登录页 2. 输入账号密码 3. 点击登录";
        report.StructuredData["expected"] = "跳转到首页";
        report.StructuredData["actual"] = "页面无响应";
        report.StructuredData["severity"] = "critical";

        // Assert
        Assert.Equal(6, report.StructuredData.Count);
        Assert.Equal("登录失败", report.StructuredData["title"]);
        Assert.Equal("critical", report.StructuredData["severity"]);
    }

    [Fact]
    public void DefectReport_MissingFields_ShouldTrackIncompleteData()
    {
        // Arrange
        var report = new DefectReport();

        // Act - 模拟 AI 检测到缺失字段
        report.MissingFields.Add("steps");
        report.MissingFields.Add("expected");
        report.Status = DefectStatus.Awaiting;

        // Assert
        Assert.Equal(2, report.MissingFields.Count);
        Assert.Contains("steps", report.MissingFields);
        Assert.Contains("expected", report.MissingFields);
        Assert.Equal(DefectStatus.Awaiting, report.Status);
    }

    #endregion
}
