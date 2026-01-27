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
        Assert.Empty(attachment.Url);
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
            Url = "https://cos.example.com/defect-agent/attachments/2025/01/xxx/screenshot.png",
            ThumbnailUrl = "https://cos.example.com/defect-agent/attachments/2025/01/xxx/screenshot_thumb.png"
        };

        // Assert
        Assert.Equal("screenshot.png", attachment.FileName);
        Assert.Equal(102400, attachment.FileSize);
        Assert.Equal("image/png", attachment.MimeType);
        Assert.Contains("cos.example.com", attachment.Url);
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
        Assert.Equal(13, defectNo1.Length); // DEF-2026-0001 (13 characters)
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
            Url = "https://cos.example.com/logs/error.log"
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
        Assert.Single(report.Attachments, a => a.MimeType == "text/plain");
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

    #region Template Ownership Tests

    [Fact]
    public void DefectTemplate_CreatedBy_ShouldTrackOwner()
    {
        // Arrange & Act
        var template = new DefectTemplate
        {
            Name = "我的模板",
            CreatedBy = "user123"
        };

        // Assert
        Assert.Equal("user123", template.CreatedBy);
    }

    [Fact]
    public void DefectTemplate_SharedWith_ShouldBeNullByDefault()
    {
        // Arrange & Act
        var template = new DefectTemplate();

        // Assert
        Assert.Null(template.SharedWith);
    }

    [Fact]
    public void DefectTemplate_ShareToUsers_ShouldWork()
    {
        // Arrange
        var template = new DefectTemplate
        {
            Name = "共享模板",
            CreatedBy = "owner123",
            SharedWith = new List<string>()
        };

        // Act
        template.SharedWith.Add("user456");
        template.SharedWith.Add("user789");

        // Assert
        Assert.Equal(2, template.SharedWith.Count);
        Assert.Contains("user456", template.SharedWith);
        Assert.Contains("user789", template.SharedWith);
    }

    [Fact]
    public void DefectTemplate_CheckOwnership_ShouldMatchCreatedBy()
    {
        // Arrange
        var template = new DefectTemplate
        {
            Name = "测试模板",
            CreatedBy = "owner123"
        };

        // Act & Assert
        Assert.True(template.CreatedBy == "owner123");
        Assert.False(template.CreatedBy == "other_user");
    }

    [Fact]
    public void DefectTemplate_CheckSharedAccess_ShouldWork()
    {
        // Arrange
        var template = new DefectTemplate
        {
            CreatedBy = "owner123",
            SharedWith = new List<string> { "user456", "user789" }
        };

        // Act & Assert
        // Owner has access
        Assert.True(template.CreatedBy == "owner123");

        // Shared users have access
        Assert.Contains("user456", template.SharedWith);
        Assert.Contains("user789", template.SharedWith);

        // Non-shared user doesn't have access
        Assert.DoesNotContain("user999", template.SharedWith);
    }

    #endregion

    #region Defect Assignment Tests

    [Fact]
    public void DefectReport_AssignToUser_ShouldWork()
    {
        // Arrange
        var defect = new DefectReport
        {
            ReporterId = "reporter123",
            ReporterName = "提交人"
        };

        // Act
        defect.AssigneeId = "assignee456";
        defect.AssigneeName = "处理人";

        // Assert
        Assert.Equal("reporter123", defect.ReporterId);
        Assert.Equal("assignee456", defect.AssigneeId);
        Assert.NotEqual(defect.ReporterId, defect.AssigneeId);
    }

    [Fact]
    public void DefectReport_SelfAssign_ShouldBeAllowed()
    {
        // Arrange & Act
        var defect = new DefectReport
        {
            ReporterId = "user123",
            ReporterName = "张三",
            AssigneeId = "user123",
            AssigneeName = "张三"
        };

        // Assert - 可以提交给自己
        Assert.Equal(defect.ReporterId, defect.AssigneeId);
    }

    [Fact]
    public void DefectReport_ChangeAssignee_ShouldWork()
    {
        // Arrange
        var defect = new DefectReport
        {
            AssigneeId = "user1",
            AssigneeName = "用户1",
            Status = DefectStatus.Assigned
        };

        // Act - 重新指派
        defect.AssigneeId = "user2";
        defect.AssigneeName = "用户2";

        // Assert
        Assert.Equal("user2", defect.AssigneeId);
        Assert.Equal("用户2", defect.AssigneeName);
    }

    #endregion

    #region Priority Tests

    [Fact]
    public void DefectPriority_All_ShouldContainAllPriorities()
    {
        // Assert
        Assert.Contains(DefectPriority.High, DefectPriority.All);
        Assert.Contains(DefectPriority.Medium, DefectPriority.All);
        Assert.Contains(DefectPriority.Low, DefectPriority.All);
        Assert.Equal(3, DefectPriority.All.Length);
    }

    [Fact]
    public void DefectReport_SetPriority_ShouldWork()
    {
        // Arrange
        var defect = new DefectReport();

        // Act
        defect.Priority = DefectPriority.High;

        // Assert
        Assert.Equal(DefectPriority.High, defect.Priority);
    }

    #endregion

    #region Space Isolation Tests (防止空间泄漏)

    [Fact]
    public void DefectFolder_DefaultValues_ShouldBeCorrect()
    {
        // Arrange & Act
        var folder = new DefectFolder();

        // Assert
        Assert.NotNull(folder.Id);
        Assert.Equal(32, folder.Id.Length);
        Assert.Empty(folder.Name);
        Assert.Null(folder.Description);
        Assert.Null(folder.Color);
        Assert.Null(folder.Icon);
        Assert.Equal(0, folder.SortOrder);
        Assert.Null(folder.SpaceId); // 默认共享空间
        Assert.Empty(folder.CreatedBy);
    }

    [Fact]
    public void DefectFolder_SetProperties_ShouldWork()
    {
        // Arrange & Act
        var folder = new DefectFolder
        {
            Name = "紧急缺陷",
            Description = "需要紧急处理的缺陷",
            Color = "#FF5500",
            Icon = "alert-triangle",
            SortOrder = 100,
            SpaceId = "team-a",
            CreatedBy = "user123"
        };

        // Assert
        Assert.Equal("紧急缺陷", folder.Name);
        Assert.Equal("#FF5500", folder.Color);
        Assert.Equal("team-a", folder.SpaceId);
        Assert.Equal("user123", folder.CreatedBy);
    }

    [Fact]
    public void SpaceIsolation_FoldersWithDifferentSpaces_ShouldNotBeMixed()
    {
        // Arrange - 创建不同空间的文件夹
        var folderA = new DefectFolder { Name = "A团队文件夹", SpaceId = "space-a" };
        var folderB = new DefectFolder { Name = "B团队文件夹", SpaceId = "space-b" };
        var folderDefault = new DefectFolder { Name = "共享文件夹", SpaceId = null }; // 默认共享空间

        var allFolders = new List<DefectFolder> { folderA, folderB, folderDefault };

        // Act - 模拟查询特定空间的文件夹
        var spaceAFolders = allFolders.Where(f => f.SpaceId == "space-a").ToList();
        var spaceBFolders = allFolders.Where(f => f.SpaceId == "space-b").ToList();
        var defaultFolders = allFolders.Where(f => f.SpaceId == null || f.SpaceId == "default").ToList();

        // Assert - 确保空间隔离
        Assert.Single(spaceAFolders);
        Assert.Equal("A团队文件夹", spaceAFolders[0].Name);

        Assert.Single(spaceBFolders);
        Assert.Equal("B团队文件夹", spaceBFolders[0].Name);

        Assert.Single(defaultFolders);
        Assert.Equal("共享文件夹", defaultFolders[0].Name);

        // 确保 space-a 用户看不到 space-b 的文件夹
        Assert.DoesNotContain(allFolders.Where(f => f.SpaceId == "space-a"), f => f.SpaceId == "space-b");
    }

    [Fact]
    public void SpaceIsolation_DefectsWithFolderId_ShouldBeIsolated()
    {
        // Arrange - 创建不同空间的文件夹和缺陷
        var folderA = new DefectFolder { Id = "folder-a", SpaceId = "space-a" };
        var folderB = new DefectFolder { Id = "folder-b", SpaceId = "space-b" };

        var defectInFolderA = new DefectReport
        {
            DefectNo = "DEF-2025-0001",
            FolderId = "folder-a",
            ReporterId = "user-a"
        };

        var defectInFolderB = new DefectReport
        {
            DefectNo = "DEF-2025-0002",
            FolderId = "folder-b",
            ReporterId = "user-b"
        };

        var allDefects = new List<DefectReport> { defectInFolderA, defectInFolderB };
        var folders = new Dictionary<string, DefectFolder>
        {
            { "folder-a", folderA },
            { "folder-b", folderB }
        };

        // Act - 模拟根据空间筛选缺陷
        Func<DefectReport, string, bool> belongsToSpace = (defect, spaceId) =>
        {
            if (defect.FolderId == null) return spaceId == null || spaceId == "default";
            return folders.TryGetValue(defect.FolderId, out var folder) && folder.SpaceId == spaceId;
        };

        var spaceADefects = allDefects.Where(d => belongsToSpace(d, "space-a")).ToList();
        var spaceBDefects = allDefects.Where(d => belongsToSpace(d, "space-b")).ToList();

        // Assert - 确保缺陷在空间间隔离
        Assert.Single(spaceADefects);
        Assert.Equal("DEF-2025-0001", spaceADefects[0].DefectNo);

        Assert.Single(spaceBDefects);
        Assert.Equal("DEF-2025-0002", spaceBDefects[0].DefectNo);
    }

    [Fact]
    public void SpaceIsolation_UserCannotAccessOtherSpace_ShouldReturnEmpty()
    {
        // Arrange
        var folders = new List<DefectFolder>
        {
            new() { Id = "f1", Name = "私有文件夹", SpaceId = "space-owner-only", CreatedBy = "owner" }
        };

        // Act - 模拟其他用户尝试访问
        var otherUserAccessibleFolders = folders
            .Where(f => f.SpaceId == "space-attacker-space") // 攻击者尝试用自己的 spaceId 查询
            .ToList();

        var ownerAccessibleFolders = folders
            .Where(f => f.SpaceId == "space-owner-only")
            .ToList();

        // Assert
        Assert.Empty(otherUserAccessibleFolders); // 攻击者看不到任何内容
        Assert.Single(ownerAccessibleFolders); // 所有者可以看到
    }

    [Fact]
    public void SpaceIsolation_MoveDefectAcrossSpaces_ShouldRequireValidation()
    {
        // Arrange
        var sourceFolder = new DefectFolder { Id = "source", SpaceId = "space-a" };
        var targetFolder = new DefectFolder { Id = "target", SpaceId = "space-b" }; // 不同空间

        var defect = new DefectReport
        {
            FolderId = "source",
            ReporterId = "user-a"
        };

        // Act - 模拟跨空间移动验证逻辑
        bool isCrossSpaceMove = sourceFolder.SpaceId != targetFolder.SpaceId;

        // Assert - 跨空间移动应该被检测到
        Assert.True(isCrossSpaceMove);

        // 实际控制器应该拒绝这种操作或进行额外的权限检查
    }

    [Fact]
    public void SpaceIsolation_DefaultSpaceIsShared_ShouldBeAccessibleToAll()
    {
        // Arrange
        var sharedFolder = new DefectFolder
        {
            Name = "共享文件夹",
            SpaceId = null // 或 "default"
        };

        // Act - 模拟不同用户查询共享空间
        Func<DefectFolder, bool> isAccessibleInDefaultSpace = folder =>
            folder.SpaceId == null || folder.SpaceId == "default";

        // Assert
        Assert.True(isAccessibleInDefaultSpace(sharedFolder));
    }

    [Theory]
    [InlineData("space-a", "space-a", true)]  // 同空间，允许访问
    [InlineData("space-a", "space-b", false)] // 不同空间，拒绝访问
    [InlineData(null, null, true)]            // 默认空间，允许访问
    [InlineData("default", "default", true)]  // 明确的默认空间，允许访问
    [InlineData(null, "default", true)]       // null 和 "default" 等效
    public void SpaceIsolation_AccessCheck_ShouldRespectBoundaries(
        string? userSpaceId,
        string? resourceSpaceId,
        bool expectedAccess)
    {
        // Arrange
        var folder = new DefectFolder { SpaceId = resourceSpaceId };

        // Act - 模拟访问检查逻辑
        bool hasAccess = (userSpaceId == resourceSpaceId) ||
                         (userSpaceId == null && (resourceSpaceId == null || resourceSpaceId == "default")) ||
                         (resourceSpaceId == null && (userSpaceId == null || userSpaceId == "default")) ||
                         ((userSpaceId == null || userSpaceId == "default") && (resourceSpaceId == null || resourceSpaceId == "default"));

        // Assert
        Assert.Equal(expectedAccess, hasAccess);
    }

    [Fact]
    public void DefectReport_FolderId_ShouldBeNullByDefault()
    {
        // Arrange & Act
        var defect = new DefectReport();

        // Assert
        Assert.Null(defect.FolderId);
    }

    [Fact]
    public void DefectReport_SetFolderId_ShouldWork()
    {
        // Arrange
        var defect = new DefectReport();

        // Act
        defect.FolderId = "folder123";

        // Assert
        Assert.Equal("folder123", defect.FolderId);
    }

    [Fact]
    public void DefectReport_SoftDelete_ShouldWork()
    {
        // Arrange
        var defect = new DefectReport
        {
            DefectNo = "DEF-2025-0001",
            Status = DefectStatus.Draft
        };

        // Act - 软删除
        defect.IsDeleted = true;
        defect.DeletedAt = DateTime.UtcNow;
        defect.DeletedBy = "user123";

        // Assert
        Assert.True(defect.IsDeleted);
        Assert.NotNull(defect.DeletedAt);
        Assert.Equal("user123", defect.DeletedBy);
        // 状态保持不变
        Assert.Equal(DefectStatus.Draft, defect.Status);
    }

    [Fact]
    public void DefectReport_SoftDelete_DefaultValues()
    {
        // Arrange & Act
        var defect = new DefectReport();

        // Assert - 默认未删除
        Assert.False(defect.IsDeleted);
        Assert.Null(defect.DeletedAt);
        Assert.Null(defect.DeletedBy);
    }

    [Fact]
    public void DefectReport_RestoreFromTrash_ShouldClearDeleteFields()
    {
        // Arrange
        var defect = new DefectReport
        {
            IsDeleted = true,
            DeletedAt = DateTime.UtcNow.AddDays(-1),
            DeletedBy = "user123"
        };

        // Act - 恢复
        defect.IsDeleted = false;
        defect.DeletedAt = null;
        defect.DeletedBy = null;

        // Assert
        Assert.False(defect.IsDeleted);
        Assert.Null(defect.DeletedAt);
        Assert.Null(defect.DeletedBy);
    }

    #endregion
}
