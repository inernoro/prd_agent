using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Controllers.Api;

public partial class DocumentStoreController
{
    [HttpGet("stores/{storeId}/writing-collection")]
    public async Task<IActionResult> ReadWritingCollection(string storeId)
    {
        var (store, error) = await LoadReadableStoreAsync(storeId, GetUserId());
        if (error != null) return error;
        var entries = await _db.DocumentEntries.Find(e => e.StoreId == storeId && !e.IsFolder).SortBy(e => e.SortOrder).ThenBy(e => e.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { store, templates = WritingTemplateRegistry.All,
            entries = entries.Where(e => e.Writing == null || e.Writing.Published != null),
            canEdit = await CanWriteStoreAsync(store!, GetUserId(), await _teams.GetMyTeamIdsAsync(GetUserId())) }));
    }
    [HttpGet("writing-templates")]
    public IActionResult ListWritingTemplates() => Ok(ApiResponse<object>.Ok(new { items = WritingTemplateRegistry.All }));

    [HttpGet("stores/{storeId}/writing-context")]
    public async Task<IActionResult> WritingContext(string storeId)
    {
        var (store, error) = await LoadWritableStoreAsync(storeId, GetUserId());
        if (error != null) return error;
        var (actorId, actorName) = await GetActorInfoAsync();
        var owner = await FindUserByAnyIdAsync(store!.OwnerId);
        var entries = await _db.DocumentEntries.Find(e => e.StoreId == storeId && !e.IsFolder).SortBy(e => e.SortOrder).ToListAsync();
        var myTeams = await _teams.GetMyTeamIdsAsync(GetUserId());
        var teamNames = await _db.Teams.Find(t => store.SharedTeamIds.Contains(t.Id) && myTeams.Contains(t.Id)).Project(t => t.Name).ToListAsync();
        var projectName = await IsPmProjectMemberAsync(store, GetUserId(), false)
            ? (await _db.PmProjects.Find(p => p.Id == store.PmProjectId && !p.IsDeleted).FirstOrDefaultAsync())?.Title : null;
        var creators = entries.Select(e => e.CreatedBy).Distinct().ToList();
        var names = (await _db.Users.Find(u => creators.Contains(u.UserId)).Project(u => new { u.UserId, u.DisplayName, u.Username }).ToListAsync())
            .ToDictionary(u => u.UserId, u => string.IsNullOrWhiteSpace(u.DisplayName) ? u.Username : u.DisplayName);
        return Ok(ApiResponse<object>.Ok(new {
            store, teamNames, projectName, actorId, actorName, reviewerId = store.OwnerId,
            reviewerName = owner?.DisplayName ?? owner?.Username ?? store.OwnerId,
            templates = WritingTemplateRegistry.All,
            sources = entries.Select(e => new { e.Id, e.Title, e.Summary, e.ContentType, e.UpdatedAt, e.CreatedBy, authorName = names.GetValueOrDefault(e.CreatedBy) ?? e.CreatedBy, e.FileSize,
                e.SortOrder, e.Metadata, published = e.Writing?.Published != null })
        }));
    }

    [HttpPost("stores/{storeId}/writing")]
    public async Task<IActionResult> CreateWritingDocument(string storeId, [FromBody] WritingCreateRequest request)
    {
        var (store, error) = await LoadWritableStoreAsync(storeId, GetUserId());
        if (error != null) return error;
        var template = WritingTemplateRegistry.Find(request.TemplateId ?? "prd");
        if (template == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未知写作模版"));
        var (actorId, actorName) = await GetActorInfoAsync();
        var owner = await FindUserByAnyIdAsync(store!.OwnerId);
        var state = new WritingDocumentState { TemplateId = template.Id, AuthorId = actorId, AuthorName = actorName,
            ReviewerId = store.OwnerId, ReviewerName = owner?.DisplayName ?? owner?.Username ?? store.OwnerId };
        var entry = new DocumentEntry { StoreId = storeId, Title = "未命名文档", CreatedBy = actorId,
            ContentType = "text/markdown", SourceType = DocumentSourceType.Upload, Writing = state,
            Metadata = new() { ["writing_template"] = template.Id, ["writing_stage"] = "select", ["writing_version"] = template.Version } };
        await _db.DocumentEntries.InsertOneAsync(entry);
        return Ok(ApiResponse<object>.Ok(new { entryId = entry.Id, state }));
    }

    [HttpGet("entries/{entryId}/writing")]
    public async Task<IActionResult> GetWritingDocument(string entryId)
    {
        var (entry, store, error) = await LoadWritableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var state = entry!.Writing;
        if (state == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "写作草稿不存在"));
        DocumentStoreAgentRun? run = null;
        if ((state.Stage is "generating" or "publishing") && state.UpdatedAt < DateTime.UtcNow.AddMinutes(-5)) {
            var running = state.ActiveRunId == null ? null : await _db.DocumentStoreAgentRuns.Find(r => r.Id == state.ActiveRunId).FirstOrDefaultAsync();
            if (state.Stage == "publishing" || running == null) {
                var prior = state.Revision;
                state.Stage = state.Stage == "publishing" ? "pending-review" : "failed";
                state.Failure = "上一次操作未完整结束，草稿已恢复，可重新操作";
                await SaveWritingState(entry, state, prior);
            }
        }
        if (state.ActiveRunId != null) {
            run = await _db.DocumentStoreAgentRuns.Find(r => r.Id == state.ActiveRunId).FirstOrDefaultAsync();
            if (state.Stage == "generating" && run?.Status is DocumentStoreRunStatus.Failed or DocumentStoreRunStatus.Cancelled) {
                var revision = state.Revision; state.Stage = "failed"; state.Failure = run.ErrorMessage ?? "生成已中断，可以重试";
                await SaveWritingState(entry, state, revision);
            }
        }
        return Ok(ApiResponse<object>.Ok(new { entryId, store, state, run = run == null ? null : new {
            run.Id, run.Status, run.Phase, run.Progress, run.CreatedAt, run.StartedAt, run.GeneratedText, run.ErrorMessage
        }, canApprove = state.ReviewerId == GetUserId() }));
    }

    [HttpPut("entries/{entryId}/writing")]
    public async Task<IActionResult> SaveWritingDocument(string entryId, [FromBody] WritingSaveRequest request)
    {
        var (entry, _, error) = await LoadWritableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var state = entry!.Writing;
        if (state == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "草稿不存在"));
        if (state.Revision != request.Revision || state.Stage is "generating" or "pending-review" or "publishing") return WritingConflict();
        var template = WritingTemplateRegistry.Find(request.TemplateId ?? state.TemplateId);
        if (template == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未知写作模版"));
        if ((request.ManualInput?.Length ?? 0) > 100000) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "输入超过10万字，请拆分资料"));
        state.TemplateId = template.Id; state.Title = request.Title ?? state.Title; state.Summary = request.Summary ?? state.Summary;
        state.ManualInput = request.ManualInput ?? state.ManualInput;
        if (request.SourceEntryIds != null) {
            if (request.SourceEntryIds.Count > 20 || request.SourceEntryIds.Contains(entryId)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "最多关联20份资料，不能引用自身"));
            var ids = request.SourceEntryIds.Distinct().ToList();
            var sources = await _db.DocumentEntries.Find(e => ids.Contains(e.Id) && e.StoreId == entry.StoreId && !e.IsFolder).ToListAsync();
            if (sources.Count != ids.Count) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "关联资料不存在或不属于当前知识库"));
            var nextSourceNumber = state.Sources.Select(s => int.TryParse(s.Id.TrimStart('S'), out var n) ? n : 0).DefaultIfEmpty().Max() + 1;
            var selected = ids.Select(id => state.Sources.FirstOrDefault(s => s.EntryId == id)
                ?? new WritingSource { Id = $"S{nextSourceNumber++}", EntryId = id, Title = sources.First(e => e.Id == id).Title, Status = "pending" }).ToList();
            var removed = state.Sources.Select(s => s.Id).Except(selected.Select(s => s.Id)).ToHashSet();
            foreach (var p in state.Sections.SelectMany(s => s.Paragraphs).Where(p => p.Citations.Any(removed.Contains))) {
                p.Citations.RemoveAll(removed.Contains); p.Status = "auth"; p.Confirmed = false;
                foreach (var id in removed) p.Quotes.Remove(id);
            }
            foreach (var q in state.Questions) q.Citations.RemoveAll(removed.Contains);
            state.Sources = selected;
        }
        if (request.Sections != null) {
            if (request.Sections.Count > 30 || request.Sections.Sum(s => s.Paragraphs.Count) > 300) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "正文超过小节或段落上限"));
            if (request.Sections.SelectMany(s => s.Paragraphs).Select(p => p.Id).Distinct().Count() != request.Sections.Sum(s => s.Paragraphs.Count))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "段落编号不能重复"));
            if (request.Sections.Any(s => (s.Condition?.Length ?? 0) > 4000 || s.Detail?.Rows.Count > 100
                || s.Detail?.Rows.Any(row => row.Count > 6 || row.Any(cell => cell.Length > 2000)) == true))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "小节条件或细节超过可编辑上限"));
            var oldSections = state.Sections.ToDictionary(s => s.Id);
            foreach (var section in request.Sections) {
                section.MetadataConfirmed = oldSections.TryGetValue(section.Id, out var old)
                    && old.Condition == section.Condition && System.Text.Json.JsonSerializer.Serialize(old.Detail) == System.Text.Json.JsonSerializer.Serialize(section.Detail)
                    && old.MetadataConfirmed;
            }
            var previous = state.Sections.SelectMany(s => s.Paragraphs).ToDictionary(p => p.Id);
            foreach (var p in request.Sections.SelectMany(s => s.Paragraphs)) {
                if (!previous.TryGetValue(p.Id, out var before) || before.Text != p.Text) { p.Status = "auth"; p.Confirmed = false; p.Citations.Clear(); p.Quotes.Clear(); }
                else { p.Status = before.Status; p.Citations = before.Citations; p.Quotes = before.Quotes; p.Confirmed = before.Confirmed; }
            }
            state.Sections = request.Sections;
            var paragraphIds = state.Sections.SelectMany(s => s.Paragraphs).Select(p => p.Id).ToHashSet();
            state.Questions.RemoveAll(q => !paragraphIds.Contains(q.ParagraphId));
            if (state.Stage == "published") state.Stage = "confirm";
        }
        if (request.IntentPoints != null) state.IntentPoints = request.IntentPoints.Where(x => !string.IsNullOrWhiteSpace(x)).Take(20).ToList();
        if (request.Conclusions != null) state.Conclusions = request.Conclusions.Take(20).ToList();
        if (request.ScopeIn != null) state.ScopeIn = request.ScopeIn;
        if (request.ScopeOut != null) state.ScopeOut = request.ScopeOut;
        if (request.Roles != null) state.Roles = request.Roles.Take(20).ToList();
        if (request.Chapters != null) {
            if (request.Chapters.Count > 40 || request.Chapters.Any(c => c.Start < 0 || c.Steps.Any(s => s.At < c.Start)))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "章节和步骤时间必须非负，步骤不能早于章节"));
            state.Chapters = request.Chapters.OrderBy(c => c.Start).ToList();
        }
        if (request.Captions != null) {
            if (request.Captions.Count > 2000 || request.Captions.Any(c => !double.IsFinite(c.At) || c.At < 0 || string.IsNullOrWhiteSpace(c.Id) || string.IsNullOrWhiteSpace(c.Text))
                || request.Captions.Select(c => c.Id).Distinct().Count() != request.Captions.Count)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "字幕需有唯一标识、正文和非负时间，最多2000条"));
            state.Captions = request.Captions.OrderBy(c => c.At).ToList();
        }
        if (request.VideoEntryId != null) {
            var media = string.IsNullOrEmpty(request.VideoEntryId) ? null : await _db.DocumentEntries.Find(e => e.Id == request.VideoEntryId && e.StoreId == entry.StoreId && !e.IsFolder).FirstOrDefaultAsync();
            if (!string.IsNullOrEmpty(request.VideoEntryId) && (media == null || !media.ContentType.StartsWith("video/"))) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择当前知识库中的视频"));
            state.VideoEntryId = string.IsNullOrEmpty(request.VideoEntryId) ? null : request.VideoEntryId;
        }
        if (request.MobileVideoEntryId != null) {
            var media = string.IsNullOrEmpty(request.MobileVideoEntryId) ? null : await _db.DocumentEntries.Find(e => e.Id == request.MobileVideoEntryId && e.StoreId == entry.StoreId && !e.IsFolder).FirstOrDefaultAsync();
            if (!string.IsNullOrEmpty(request.MobileVideoEntryId) && (media == null || !media.ContentType.StartsWith("video/"))) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择当前知识库中的手机视频"));
            state.MobileVideoEntryId = string.IsNullOrEmpty(request.MobileVideoEntryId) ? null : request.MobileVideoEntryId;
        }
        if (!await SaveWritingState(entry, state, request.Revision)) return WritingConflict();
        return Ok(ApiResponse<object>.Ok(new { state }));
    }

    [HttpPost("entries/{entryId}/writing/generate")]
    public async Task<IActionResult> GenerateWritingDraft(string entryId, [FromBody] WritingCommandRequest request)
    {
        var (entry, _, error) = await LoadWritableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var state = entry!.Writing;
        if (state == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "草稿不存在"));
        if (state.Revision != request.Revision || state.Stage is "generating" or "pending-review" or "publishing") return WritingConflict();
        if (state.Sources.All(s => s.Status == "skipped") && string.IsNullOrWhiteSpace(state.ManualInput)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请关联资料或输入内容，也可以用空白模版开始"));
        var run = new DocumentStoreAgentRun { Kind = WritingDocumentPolicy.RunKind, SourceEntryId = entryId, StoreId = entry.StoreId,
            UserId = GetUserId(), OwnerInstanceId = InstanceIdentity.Get(_config), TaskPermitId = PrdAgent.Core.Security.TaskExecutionContext.Current?.PermitId,
            Status = DocumentStoreRunStatus.Queued, Phase = "等待读取资料" };
        state.ActiveRunId = run.Id; state.ActiveExecutionId = ""; state.Stage = "generating"; state.Failure = null;
        if (!await SaveWritingState(entry, state, request.Revision)) return WritingConflict();
        run.CustomPrompt = state.Revision.ToString(System.Globalization.CultureInfo.InvariantCulture);
        try { await _db.DocumentStoreAgentRuns.InsertOneAsync(run); }
        catch { state.Stage = "failed"; state.Failure = "生成任务未能排队，请重试"; await SaveWritingState(entry, state, state.Revision); throw; }
        return Ok(ApiResponse<object>.Ok(new { state, runId = run.Id }));
    }

    [HttpPost("entries/{entryId}/writing/commands")]
    public async Task<IActionResult> CommandWritingDocument(string entryId, [FromBody] WritingCommandRequest request)
    {
        var (entry, store, error) = await LoadWritableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var state = entry!.Writing;
        if (state == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "草稿不存在"));
        if (state.Revision != request.Revision || state.Stage == "publishing") return WritingConflict();
        if (state.Stage == "generating") {
            if (request.Action != "skip-source" || !state.Sources.Any(s => s.Id == request.SourceId)) return WritingConflict();
            // 只有确实会续跑的跳过操作才领取写作许可；确认、审核等普通命令没有付费执行权。
            var resume = state.Sources.Any(s => s.Id != request.SourceId && s.Status != "skipped") || !string.IsNullOrWhiteSpace(state.ManualInput);
            var authority = resume ? await HttpContext.RequestServices
                .GetRequiredService<PrdAgent.Api.Services.BackgroundTasks.TaskAdmissionService>()
                .AdmitAuthenticatedPaidBranchAsync(HttpContext, HttpContext.RequestAborted) : null;
            using var continuation = authority == null ? null : PrdAgent.Core.Security.TaskExecutionContext.Enter(authority);
            var cancelled = await _db.DocumentStoreAgentRuns.UpdateOneAsync(r => r.Id == state.ActiveRunId
                && (r.Status == DocumentStoreRunStatus.Running || r.Status == DocumentStoreRunStatus.Queued),
                Builders<DocumentStoreAgentRun>.Update.Set(r => r.Status, DocumentStoreRunStatus.Cancelled).Set(r => r.EndedAt, DateTime.UtcNow));
            if (cancelled.ModifiedCount != 1) return WritingConflict();
            var skipped = state.Sources.Single(s => s.Id == request.SourceId);
            skipped.Status = "skipped"; skipped.Content = ""; skipped.Hash = "";
            state.Stage = "failed"; state.Failure = "已跳过该资料，原文与目录位置保留。";
            if (!await SaveWritingState(entry, state, request.Revision)) return WritingConflict();
            if (resume)
                return await GenerateWritingDraft(entryId, new WritingCommandRequest { Revision = state.Revision });
            return Ok(ApiResponse<object>.Ok(new { state }));
        }
        try {
            var editable = state.Stage is not ("pending-review" or "published");
            if (request.Action == "blank" && state.Stage == "select") {
                var template = WritingTemplateRegistry.Find(state.TemplateId)!;
                state.Sections = template.Headings.Select((h, i) => new WritingSection { Id = $"s{i + 1}", Title = h.Title,
                    Paragraphs = new() { new() { Id = $"p{i + 1}", Status = "auth" } } }).ToList(); state.Stage = "confirm";
            }
            else if (request.Action == "confirm-section" && editable) {
                var section = state.Sections.SingleOrDefault(s => s.Id == request.SectionId) ?? throw new InvalidOperationException("小节不存在");
                section.MetadataConfirmed = request.Confirmed;
            }
            else if (request.Action == "answer" && editable) WritingDocumentPolicy.Answer(state, request.QuestionId ?? "", request.Text ?? "", request.Open);
            else if (request.Action == "confirm" && editable) {
                var paragraph = state.Sections.SelectMany(s => s.Paragraphs).Single(p => p.Id == request.ParagraphId);
                paragraph.Confirmed = request.Confirmed;
            }
            else if (request.Action is "keep-source" or "update-source" && editable) {
                var source = state.Sources.Single(s => s.Id == request.SourceId);
                var current = await _db.DocumentEntries.Find(e => e.Id == source.EntryId && e.StoreId == entry.StoreId).FirstOrDefaultAsync();
                if (current == null) throw new InvalidOperationException("原始资料已删除，请移除引用并重新审核正文");
                var (_, content) = await LoadEntryMarkdownAsync(current);
                source.ReviewedHash = WritingHash(content ?? "");
                if (request.Action == "update-source") {
                    source.Content = content ?? ""; source.Hash = source.ReviewedHash; source.UpdatedAt = current.UpdatedAt; source.Status = "read";
                    foreach (var p in state.Sections.SelectMany(s => s.Paragraphs).Where(p => p.Citations.Contains(source.Id))) {
                        p.Status = "auth"; p.Confirmed = false; p.Quotes.Remove(source.Id); p.Citations.Remove(source.Id);
                    }
                }
            }
            else if (request.Action == "review" && editable) {
                var problems = WritingDocumentPolicy.SubmissionProblems(state);
                if (problems.Count > 0) return UnprocessableEntity(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, string.Join("；", problems)));
                state.Stage = "pending-review";
            }
            else if (request.Action == "withdraw" && state.Stage == "pending-review" && (state.AuthorId == GetUserId() || state.ReviewerId == GetUserId())) state.Stage = "review";
            else if (request.Action == "edit" && state.Stage == "published") state.Stage = "confirm";
            else if (request.Action == "approve" && state.Stage == "pending-review" && state.ReviewerId == GetUserId()) {
                var problems = WritingDocumentPolicy.SubmissionProblems(state);
                if (problems.Count > 0) return UnprocessableEntity(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, string.Join("；", problems)));
                foreach (var source in state.Sources.Where(s => s.Status == "read")) {
                    var original = await _db.DocumentEntries.Find(e => e.Id == source.EntryId && e.StoreId == entry.StoreId).FirstOrDefaultAsync();
                    if (original == null) return UnprocessableEntity(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "引用资料已删除，请先复核"));
                    var (_, currentContent) = await LoadEntryMarkdownAsync(original);
                    if (WritingHash(currentContent ?? "") != (source.ReviewedHash ?? source.Hash))
                        return UnprocessableEntity(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"资料《{source.Title}》有更新，请撤回审核并逐项复核"));
                }
                // 仅归档上一次已经提交的发布版。新发布快照在最终CAS成功前不进入归档读取路径。
                var previousPublication = state.Published;
                if (previousPublication != null) {
                    var archive = _db.Database.GetCollection<WritingPublicationRecord>("document_writing_publications");
                    var record = new WritingPublicationRecord { Id = $"{entryId}:v{previousPublication.Version}", EntryId = entryId, StoreId = entry.StoreId, Publication = previousPublication };
                    try { await archive.InsertOneAsync(record); }
                    catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) { /* 已归档的发布版不可覆盖 */ }
                }
                state.Stage = "publishing";
                if (!await SaveWritingState(entry, state, request.Revision)) return WritingConflict();
                var publishingRevision = state.Revision;
                var (_, actorName) = await GetActorInfoAsync();
                var nextPublication = WritingDocumentPolicy.Snapshot(state, GetUserId(), actorName);
                try {
                    state.Published = nextPublication; state.Stage = "published";
                    state.Revision = publishingRevision + 1;
                    var bodyExcerpt = string.Concat(state.Sections.SelectMany(s => s.Paragraphs).Select(p => p.Text));
                    var publishedUpdate = Builders<DocumentEntry>.Update.Set(e => e.Writing, state)
                        .Set(e => e.Title, nextPublication.Title).Set("Metadata.writing_stage", "published")
                        .Set(e => e.Summary, string.IsNullOrWhiteSpace(state.Summary)
                            ? bodyExcerpt[..Math.Min(60, bodyExcerpt.Length)] : state.Summary)
                        .Set("Metadata.writing_summary_origin", string.IsNullOrWhiteSpace(state.Summary) ? "body" : "author");
                    var guard = Builders<DocumentEntry>.Filter.Where(e => e.Writing!.Revision == publishingRevision && e.Writing.Stage == "publishing");
                    var result = await _entryContentWriter.WriteAsync(entry, store!, WritingDocumentPolicy.Markdown(state), GetUserId(), actorName,
                        DocumentVersionSource.Edit, expectedUpdatedAt: state.UpdatedAt, derivedStateMetadataKey: "writing_derived_state",
                        extraGuard: guard, atomicEntryUpdate: publishedUpdate);
                    if (result.Conflicted) return WritingConflict();
                } catch {
                    var current = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
                    if (current?.Writing?.Published?.Version == nextPublication.Version && current.Writing.Stage == "published")
                        return Ok(ApiResponse<object>.Ok(new { state = current.Writing }));
                    state.Published = previousPublication;
                    state.Stage = "pending-review"; state.Failure = "发布写入未完成，请重试";
                    await SaveWritingState(entry, state, publishingRevision); throw;
                }
                return Ok(ApiResponse<object>.Ok(new { state }));
            }
            else return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "当前阶段或身份不允许此操作"));
        } catch (InvalidOperationException ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
        if (!await SaveWritingState(entry, state, request.Revision)) return WritingConflict();
        return Ok(ApiResponse<object>.Ok(new { state }));
    }

    [HttpGet("entries/{entryId}/writing/published")]
    public async Task<IActionResult> ReadWritingPublication(string entryId, [FromQuery] int? version = null, [FromQuery] bool overview = false)
    {
        var (entry, store, error) = await LoadReadableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var published = entry!.Writing?.Published;
        if (version.HasValue && (published == null || version.Value > published.Version))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "该发布版本不存在"));
        if (version.HasValue && version != published?.Version) published = (await _db.Database.GetCollection<WritingPublicationRecord>("document_writing_publications")
            .Find(r => r.EntryId == entryId && r.StoreId == entry.StoreId && r.Publication.Version == version.Value).FirstOrDefaultAsync())?.Publication;
        if (published == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "此文档尚未发布"));
        var affected = new List<string>();
        if (!overview) foreach (var s in published.Sources) {
            var current = await _db.DocumentEntries.Find(e => e.Id == s.EntryId && e.StoreId == entry.StoreId).FirstOrDefaultAsync();
            if (current == null) { affected.Add(s.Id); continue; }
            var (_, content) = await LoadEntryMarkdownAsync(current);
            if (WritingHash(content ?? "") != (s.ReviewedHash ?? s.Hash)) affected.Add(s.Id);
        }
        var peers = await _db.DocumentEntries.Find(e => e.StoreId == entry.StoreId && !e.IsFolder).SortBy(e => e.SortOrder).ToListAsync();
        var entries = peers.Where(e => e.Writing?.Published != null).Select(e => new { e.Id, e.Title });
        var canEdit = await CanWriteStoreAsync(store!, GetUserId(), await _teams.GetMyTeamIdsAsync(GetUserId()));
        if (overview) return Ok(ApiResponse<object>.Ok(new { entryId, store, publication = WritingPublicationOverview(published),
            template = WritingTemplateRegistry.Find(published.TemplateId), affectedSources = affected, bodyPending = true, entries, canEdit }));
        return Ok(ApiResponse<object>.Ok(new { entryId, store, publication = published, template = WritingTemplateRegistry.Find(published.TemplateId), affectedSources = affected,
            entries, canEdit }));
    }

    private static WritingPublication WritingPublicationOverview(WritingPublication published) => new() {
        Version = published.Version, Title = published.Title, Summary = published.Summary,
        TemplateId = published.TemplateId, TemplateVersion = published.TemplateVersion,
        AuthorName = published.AuthorName, ReviewerId = published.ReviewerId, ReviewerName = published.ReviewerName, PublishedAt = published.PublishedAt,
        Conclusions = published.Conclusions, ScopeIn = published.ScopeIn, ScopeOut = published.ScopeOut, Roles = published.Roles,
        Sections = published.Sections.Select(section => new WritingSection { Id = section.Id, Title = section.Title }).ToList(),
        Sources = published.Sources.Select(source => new WritingSource { Id = source.Id, EntryId = source.EntryId, Title = source.Title,
            UpdatedAt = source.UpdatedAt, Status = source.Status, Hash = source.Hash, ReviewedHash = source.ReviewedHash, Content = "" }).ToList(),
        VideoEntryId = published.VideoEntryId, MobileVideoEntryId = published.MobileVideoEntryId,
    };

    private async Task<bool> SaveWritingState(DocumentEntry entry, WritingDocumentState state, long expected)
    {
        state.Revision = expected + 1; state.UpdatedAt = DateTime.UtcNow;
        var update = Builders<DocumentEntry>.Update.Set(e => e.Writing, state)
            .Set(e => e.Title, state.Published?.Title ?? (string.IsNullOrWhiteSpace(state.Title) ? "未命名文档" : state.Title))
            .Set(e => e.UpdatedAt, state.UpdatedAt)
            .Set("Metadata.writing_stage", state.Stage).Set("Metadata.writing_template", state.TemplateId);
        var result = await _db.DocumentEntries.UpdateOneAsync(e => e.Id == entry.Id && e.Writing!.Revision == expected, update);
        return result.ModifiedCount == 1;
    }
    private IActionResult WritingConflict() => Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "草稿已在另一窗口更新或正在处理，请刷新后继续"));
    internal static string WritingHash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

public class WritingCreateRequest { public string? TemplateId { get; set; } }
public class WritingSaveRequest
{
    public long Revision { get; set; }
    public string? TemplateId { get; set; }
    public string? Title { get; set; }
    public string? Summary { get; set; }
    public string? ManualInput { get; set; }
    public string? ScopeIn { get; set; }
    public string? ScopeOut { get; set; }
    public string? VideoEntryId { get; set; }
    public string? MobileVideoEntryId { get; set; }
    public List<string>? SourceEntryIds { get; set; }
    public List<string>? IntentPoints { get; set; }
    public List<string>? Conclusions { get; set; }
    public List<WritingSection>? Sections { get; set; }
    public List<WritingChapter>? Chapters { get; set; }
    public List<WritingCaption>? Captions { get; set; }
    public List<WritingRole>? Roles { get; set; }
}
public class WritingCommandRequest
{
    public long Revision { get; set; }
    public string Action { get; set; } = "";
    public string? QuestionId { get; set; }
    public string? ParagraphId { get; set; }
    public string? SectionId { get; set; }
    public string? SourceId { get; set; }
    public string? Text { get; set; }
    public bool Open { get; set; }
    public bool Confirmed { get; set; }
}
