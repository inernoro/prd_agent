using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Attributes;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using System.Reflection;
using System.Security.Claims;
using System.Text.Json;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 数据检测与迁移 Agent - 管理 MongoDB 实体与集合的映射关系
/// </summary>
[ApiController]
[Route("api/data-migration")]
[Authorize]
[AdminController("data-migration", AdminPermissionCatalog.DataMigrationAgentUse, WritePermission = AdminPermissionCatalog.DataMigrationAgentWrite)]
public class DataMigrationController : ControllerBase
{
    private const string AppKey = "data-migration-agent";

    private readonly MongoDbContext _db;
    private readonly ILogger<DataMigrationController> _logger;

    public DataMigrationController(
        MongoDbContext db,
        ILogger<DataMigrationController> logger)
    {
        _db = db;
        _logger = logger;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    /// <summary>
    /// 获取实体与集合的完整映射关系
    /// </summary>
    [HttpGet("mappings")]
    public async Task<IActionResult> GetMappings()
    {
        // 1. 扫描所有 MongoDbContext 属性获取已注册的集合
        var registeredMappings = GetRegisteredCollectionMappings();

        // 2. 获取数据库中实际存在的集合
        var dbCollections = await _db.Database.ListCollectionNamesAsync();
        var actualCollections = await dbCollections.ToListAsync();

        // 3. 扫描实体类的 AppOwnership 特性
        var entityAppMappings = GetEntityAppOwnershipMappings();

        // 4. 构建映射结果
        var mappings = new List<CollectionMappingItem>();
        var processedCollections = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // 先处理已注册的映射
        foreach (var reg in registeredMappings)
        {
            var entityName = reg.EntityType.Name;
            var collectionName = reg.CollectionName;
            processedCollections.Add(collectionName);

            var appOwners = entityAppMappings.GetValueOrDefault(entityName) ?? new List<AppOwnerInfo>();
            var existsInDb = actualCollections.Contains(collectionName, StringComparer.OrdinalIgnoreCase);

            // 获取文档数量
            long documentCount = 0;
            if (existsInDb)
            {
                try
                {
                    var collection = _db.Database.GetCollection<BsonDocument>(collectionName);
                    documentCount = await collection.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty);
                }
                catch
                {
                    // 忽略计数错误
                }
            }

            mappings.Add(new CollectionMappingItem
            {
                CollectionName = collectionName,
                EntityName = entityName,
                EntityFullName = reg.EntityType.FullName ?? entityName,
                AppOwners = appOwners,
                ExistsInDatabase = existsInDb,
                HasEntity = true,
                DocumentCount = documentCount
            });
        }

        // 处理数据库中存在但未注册的集合
        foreach (var col in actualCollections)
        {
            if (processedCollections.Contains(col)) continue;

            long documentCount = 0;
            try
            {
                var collection = _db.Database.GetCollection<BsonDocument>(col);
                documentCount = await collection.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty);
            }
            catch
            {
                // 忽略计数错误
            }

            mappings.Add(new CollectionMappingItem
            {
                CollectionName = col,
                EntityName = null,
                EntityFullName = null,
                AppOwners = new List<AppOwnerInfo>(),
                ExistsInDatabase = true,
                HasEntity = false,
                DocumentCount = documentCount
            });
        }

        // 按应用分组统计
        var appStats = mappings
            .Where(m => m.AppOwners.Count > 0)
            .SelectMany(m => m.AppOwners.Select(a => new { AppName = a.AppName, DisplayName = a.DisplayName, Collection = m }))
            .GroupBy(x => x.AppName)
            .Select(g => new AppCollectionStats
            {
                AppName = g.Key,
                DisplayName = g.First().DisplayName,
                CollectionCount = g.Count(),
                TotalDocuments = g.Sum(x => x.Collection.DocumentCount)
            })
            .OrderBy(x => x.DisplayName)
            .ToList();

        // 添加"无应用"分组
        var noAppCount = mappings.Count(m => m.AppOwners.Count == 0);
        if (noAppCount > 0)
        {
            appStats.Insert(0, new AppCollectionStats
            {
                AppName = null,
                DisplayName = "无应用",
                CollectionCount = noAppCount,
                TotalDocuments = mappings.Where(m => m.AppOwners.Count == 0).Sum(x => x.DocumentCount)
            });
        }

        var response = new CollectionMappingsResponse
        {
            Mappings = mappings.OrderBy(m => m.AppOwners.FirstOrDefault()?.DisplayName ?? "ZZZ").ThenBy(m => m.CollectionName).ToList(),
            AppStats = appStats,
            TotalCollections = actualCollections.Count,
            TotalEntities = registeredMappings.Count,
            UnmappedCollections = mappings.Count(m => !m.HasEntity),
            UnmappedEntities = mappings.Count(m => m.HasEntity && !m.ExistsInDatabase)
        };

        return Ok(ApiResponse<CollectionMappingsResponse>.Ok(response));
    }

    /// <summary>
    /// 查看集合数据（分页）
    /// </summary>
    [HttpGet("collections/{collectionName}/data")]
    public async Task<IActionResult> GetCollectionData(
        string collectionName,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        if (string.IsNullOrWhiteSpace(collectionName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "集合名称不能为空"));

        if (page < 1) page = 1;
        if (pageSize < 1) pageSize = 20;
        if (pageSize > 100) pageSize = 100;

        try
        {
            var collection = _db.Database.GetCollection<BsonDocument>(collectionName);
            var totalCount = await collection.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty);

            var documents = await collection
                .Find(FilterDefinition<BsonDocument>.Empty)
                .Skip((page - 1) * pageSize)
                .Limit(pageSize)
                .ToListAsync();

            var data = documents.Select(d => BsonDocumentToJsonElement(d)).ToList();

            // 获取字段列表（从第一个文档）
            var fields = new List<string>();
            if (documents.Count > 0)
            {
                fields = documents[0].Names.ToList();
            }

            var response = new CollectionDataResponse
            {
                CollectionName = collectionName,
                Page = page,
                PageSize = pageSize,
                TotalCount = totalCount,
                TotalPages = (int)Math.Ceiling((double)totalCount / pageSize),
                Fields = fields,
                Data = data
            };

            return Ok(ApiResponse<CollectionDataResponse>.Ok(response));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get collection data: {CollectionName}", collectionName);
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"获取集合数据失败: {ex.Message}"));
        }
    }

    /// <summary>
    /// 检测集合数据与实体字段的匹配情况
    /// </summary>
    [HttpGet("collections/{collectionName}/validation")]
    public async Task<IActionResult> ValidateCollectionData(
        string collectionName,
        [FromQuery] int limit = 100)
    {
        if (string.IsNullOrWhiteSpace(collectionName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "集合名称不能为空"));

        if (limit < 1) limit = 100;
        if (limit > 1000) limit = 1000;

        try
        {
            // 获取对应的实体类型
            var mappings = GetRegisteredCollectionMappings();
            var mapping = mappings.FirstOrDefault(m => string.Equals(m.CollectionName, collectionName, StringComparison.OrdinalIgnoreCase));

            if (mapping == null)
            {
                return Ok(ApiResponse<CollectionValidationResponse>.Ok(new CollectionValidationResponse
                {
                    CollectionName = collectionName,
                    HasEntity = false,
                    EntityName = null,
                    TotalDocuments = 0,
                    ValidDocuments = 0,
                    InvalidDocuments = 0,
                    InvalidItems = new List<InvalidDocumentItem>(),
                    EntityFields = new List<EntityFieldInfo>()
                }));
            }

            var entityType = mapping.EntityType;
            var entityFields = GetEntityFields(entityType);

            var collection = _db.Database.GetCollection<BsonDocument>(collectionName);
            var totalCount = await collection.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty);

            // 获取文档并验证
            var documents = await collection
                .Find(FilterDefinition<BsonDocument>.Empty)
                .Limit(limit)
                .ToListAsync();

            var invalidItems = new List<InvalidDocumentItem>();
            var validCount = 0;

            foreach (var doc in documents)
            {
                var issues = ValidateDocument(doc, entityFields);
                if (issues.Count > 0)
                {
                    var docId = doc.Contains("_id") ? doc["_id"].ToString() ?? "unknown" : "unknown";
                    invalidItems.Add(new InvalidDocumentItem
                    {
                        DocumentId = docId,
                        Document = BsonDocumentToJsonElement(doc),
                        Issues = issues
                    });
                }
                else
                {
                    validCount++;
                }
            }

            var response = new CollectionValidationResponse
            {
                CollectionName = collectionName,
                HasEntity = true,
                EntityName = entityType.Name,
                TotalDocuments = totalCount,
                ScannedDocuments = documents.Count,
                ValidDocuments = validCount,
                InvalidDocuments = invalidItems.Count,
                InvalidItems = invalidItems,
                EntityFields = entityFields
            };

            return Ok(ApiResponse<CollectionValidationResponse>.Ok(response));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to validate collection: {CollectionName}", collectionName);
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"验证集合数据失败: {ex.Message}"));
        }
    }

    /// <summary>
    /// 删除集合
    /// </summary>
    [HttpDelete("collections/{collectionName}")]
    public async Task<IActionResult> DeleteCollection(
        string collectionName,
        [FromQuery] bool confirmed = false)
    {
        if (string.IsNullOrWhiteSpace(collectionName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "集合名称不能为空"));

        if (!confirmed)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "需要确认删除操作（confirmed=true）"));

        // 保护核心集合
        var protectedCollections = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "users", "llmplatforms", "llmmodels", "system_roles"
        };

        if (protectedCollections.Contains(collectionName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, $"集合 {collectionName} 为系统核心集合，不允许删除"));

        try
        {
            // 获取删除前的文档数量
            var collection = _db.Database.GetCollection<BsonDocument>(collectionName);
            var count = await collection.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty);

            await _db.Database.DropCollectionAsync(collectionName);

            _logger.LogWarning("Collection dropped by admin: {CollectionName}, documents: {Count}, adminId: {AdminId}",
                collectionName, count, GetAdminId());

            return Ok(ApiResponse<CollectionDeleteResponse>.Ok(new CollectionDeleteResponse
            {
                CollectionName = collectionName,
                DeletedDocuments = count,
                Success = true
            }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete collection: {CollectionName}", collectionName);
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"删除集合失败: {ex.Message}"));
        }
    }

    /// <summary>
    /// 删除指定文档
    /// </summary>
    [HttpDelete("collections/{collectionName}/documents/{documentId}")]
    public async Task<IActionResult> DeleteDocument(
        string collectionName,
        string documentId,
        [FromQuery] bool confirmed = false)
    {
        if (string.IsNullOrWhiteSpace(collectionName) || string.IsNullOrWhiteSpace(documentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "集合名称和文档ID不能为空"));

        if (!confirmed)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "需要确认删除操作（confirmed=true）"));

        try
        {
            var collection = _db.Database.GetCollection<BsonDocument>(collectionName);

            // 尝试多种 ID 格式匹配
            FilterDefinition<BsonDocument> filter;
            if (ObjectId.TryParse(documentId, out var objectId))
            {
                filter = Builders<BsonDocument>.Filter.Or(
                    Builders<BsonDocument>.Filter.Eq("_id", objectId),
                    Builders<BsonDocument>.Filter.Eq("_id", documentId)
                );
            }
            else
            {
                filter = Builders<BsonDocument>.Filter.Eq("_id", documentId);
            }

            var result = await collection.DeleteOneAsync(filter);

            _logger.LogWarning("Document deleted by admin: {CollectionName}/{DocumentId}, deleted: {Deleted}, adminId: {AdminId}",
                collectionName, documentId, result.DeletedCount, GetAdminId());

            return Ok(ApiResponse<DocumentDeleteResponse>.Ok(new DocumentDeleteResponse
            {
                CollectionName = collectionName,
                DocumentId = documentId,
                Deleted = result.DeletedCount > 0
            }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete document: {CollectionName}/{DocumentId}", collectionName, documentId);
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"删除文档失败: {ex.Message}"));
        }
    }

    /// <summary>
    /// 删除指定应用的所有数据
    /// </summary>
    [HttpDelete("apps/{appName}")]
    public async Task<IActionResult> DeleteAppData(
        string appName,
        [FromQuery] bool confirmed = false)
    {
        if (string.IsNullOrWhiteSpace(appName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "应用名称不能为空"));

        if (!confirmed)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "需要确认删除操作（confirmed=true）"));

        // 保护核心应用
        if (string.Equals(appName, AppNames.System, StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "不允许删除系统核心数据"));

        try
        {
            var mappings = GetRegisteredCollectionMappings();
            var entityAppMappings = GetEntityAppOwnershipMappings();

            var deletedCollections = new List<string>();
            var totalDeleted = 0L;

            foreach (var reg in mappings)
            {
                var entityName = reg.EntityType.Name;
                var appOwners = entityAppMappings.GetValueOrDefault(entityName) ?? new List<AppOwnerInfo>();

                // 检查是否属于指定应用
                var belongsToApp = appOwners.Any(a => string.Equals(a.AppName, appName, StringComparison.OrdinalIgnoreCase));
                if (!belongsToApp) continue;

                // 检查是否共享（有多个应用拥有）
                if (appOwners.Count > 1)
                {
                    // 共享集合，跳过
                    continue;
                }

                // 独享集合，可以删除
                try
                {
                    var collection = _db.Database.GetCollection<BsonDocument>(reg.CollectionName);
                    var count = await collection.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty);
                    await _db.Database.DropCollectionAsync(reg.CollectionName);

                    deletedCollections.Add(reg.CollectionName);
                    totalDeleted += count;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to drop collection: {CollectionName}", reg.CollectionName);
                }
            }

            _logger.LogWarning("App data deleted by admin: appName={AppName}, collections={Collections}, documents={Documents}, adminId={AdminId}",
                appName, deletedCollections.Count, totalDeleted, GetAdminId());

            return Ok(ApiResponse<AppDataDeleteResponse>.Ok(new AppDataDeleteResponse
            {
                AppName = appName,
                DeletedCollections = deletedCollections,
                TotalDeletedDocuments = totalDeleted
            }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete app data: {AppName}", appName);
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"删除应用数据失败: {ex.Message}"));
        }
    }

    #region Private Methods

    private List<CollectionRegistration> GetRegisteredCollectionMappings()
    {
        var result = new List<CollectionRegistration>();
        var dbContextType = typeof(MongoDbContext);

        foreach (var prop in dbContextType.GetProperties())
        {
            var propType = prop.PropertyType;
            if (!propType.IsGenericType) continue;

            var genericDef = propType.GetGenericTypeDefinition();
            if (genericDef != typeof(IMongoCollection<>)) continue;

            var entityType = propType.GetGenericArguments()[0];
            if (entityType == typeof(BsonDocument)) continue;

            // 获取集合名称（通过调用属性）
            try
            {
                var collectionObj = prop.GetValue(_db);
                if (collectionObj == null) continue;

                var collectionNameProp = propType.GetProperty("CollectionNamespace");
                var ns = collectionNameProp?.GetValue(collectionObj);
                var collectionName = ns?.ToString()?.Split('.').LastOrDefault();

                if (!string.IsNullOrWhiteSpace(collectionName))
                {
                    result.Add(new CollectionRegistration
                    {
                        CollectionName = collectionName,
                        EntityType = entityType,
                        PropertyName = prop.Name
                    });
                }
            }
            catch
            {
                // 忽略访问错误
            }
        }

        return result;
    }

    private Dictionary<string, List<AppOwnerInfo>> GetEntityAppOwnershipMappings()
    {
        var result = new Dictionary<string, List<AppOwnerInfo>>();
        var coreAssembly = typeof(AppOwnershipAttribute).Assembly;

        foreach (var type in coreAssembly.GetTypes())
        {
            if (!type.IsClass || type.IsAbstract) continue;

            var attrs = type.GetCustomAttributes<AppOwnershipAttribute>().ToList();
            if (attrs.Count == 0) continue;

            result[type.Name] = attrs.Select(a => new AppOwnerInfo
            {
                AppName = a.AppName,
                DisplayName = a.DisplayName,
                IsPrimary = a.IsPrimary
            }).ToList();
        }

        return result;
    }

    private List<EntityFieldInfo> GetEntityFields(Type entityType)
    {
        var fields = new List<EntityFieldInfo>();

        foreach (var prop in entityType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var propType = prop.PropertyType;
            var isNullable = Nullable.GetUnderlyingType(propType) != null ||
                             (propType.IsClass && propType != typeof(string));

            fields.Add(new EntityFieldInfo
            {
                Name = prop.Name,
                Type = GetFriendlyTypeName(propType),
                IsNullable = isNullable || propType == typeof(string),
                IsRequired = !isNullable && propType != typeof(string)
            });
        }

        return fields;
    }

    private string GetFriendlyTypeName(Type type)
    {
        if (type == typeof(string)) return "string";
        if (type == typeof(int)) return "int";
        if (type == typeof(long)) return "long";
        if (type == typeof(bool)) return "bool";
        if (type == typeof(double)) return "double";
        if (type == typeof(decimal)) return "decimal";
        if (type == typeof(DateTime)) return "DateTime";
        if (type == typeof(Guid)) return "Guid";

        var nullableType = Nullable.GetUnderlyingType(type);
        if (nullableType != null)
            return $"{GetFriendlyTypeName(nullableType)}?";

        if (type.IsGenericType)
        {
            var genericDef = type.GetGenericTypeDefinition();
            if (genericDef == typeof(List<>))
                return $"List<{GetFriendlyTypeName(type.GetGenericArguments()[0])}>";
            if (genericDef == typeof(Dictionary<,>))
                return $"Dictionary<{GetFriendlyTypeName(type.GetGenericArguments()[0])}, {GetFriendlyTypeName(type.GetGenericArguments()[1])}>";
        }

        return type.Name;
    }

    private List<string> ValidateDocument(BsonDocument doc, List<EntityFieldInfo> entityFields)
    {
        var issues = new List<string>();
        var docFields = doc.Names.ToHashSet(StringComparer.OrdinalIgnoreCase);

        // 检查缺失的必填字段
        foreach (var field in entityFields.Where(f => f.IsRequired))
        {
            var fieldNameLower = field.Name.ToLowerInvariant();
            var exists = docFields.Any(d => d.Equals(field.Name, StringComparison.OrdinalIgnoreCase) ||
                                            d.Equals(fieldNameLower, StringComparison.OrdinalIgnoreCase));
            if (!exists)
            {
                issues.Add($"缺失必填字段: {field.Name}");
            }
        }

        // 检查文档中存在但实体中不存在的字段（可能是旧字段或错误字段）
        var entityFieldNames = entityFields.Select(f => f.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var docField in docFields)
        {
            if (docField == "_id") continue; // MongoDB 主键总是存在
            if (!entityFieldNames.Contains(docField))
            {
                issues.Add($"多余字段（实体中不存在）: {docField}");
            }
        }

        return issues;
    }

    private static JsonElement BsonDocumentToJsonElement(BsonDocument doc)
    {
        var json = doc.ToJson(new MongoDB.Bson.IO.JsonWriterSettings
        {
            OutputMode = MongoDB.Bson.IO.JsonOutputMode.RelaxedExtendedJson
        });
        return JsonSerializer.Deserialize<JsonElement>(json);
    }

    #endregion
}

#region DTOs

public class CollectionRegistration
{
    public string CollectionName { get; set; } = string.Empty;
    public Type EntityType { get; set; } = typeof(object);
    public string PropertyName { get; set; } = string.Empty;
}

public class AppOwnerInfo
{
    public string AppName { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public bool IsPrimary { get; set; }
}

public class CollectionMappingItem
{
    public string CollectionName { get; set; } = string.Empty;
    public string? EntityName { get; set; }
    public string? EntityFullName { get; set; }
    public List<AppOwnerInfo> AppOwners { get; set; } = new();
    public bool ExistsInDatabase { get; set; }
    public bool HasEntity { get; set; }
    public long DocumentCount { get; set; }
}

public class AppCollectionStats
{
    public string? AppName { get; set; }
    public string DisplayName { get; set; } = string.Empty;
    public int CollectionCount { get; set; }
    public long TotalDocuments { get; set; }
}

public class CollectionMappingsResponse
{
    public List<CollectionMappingItem> Mappings { get; set; } = new();
    public List<AppCollectionStats> AppStats { get; set; } = new();
    public int TotalCollections { get; set; }
    public int TotalEntities { get; set; }
    public int UnmappedCollections { get; set; }
    public int UnmappedEntities { get; set; }
}

public class CollectionDataResponse
{
    public string CollectionName { get; set; } = string.Empty;
    public int Page { get; set; }
    public int PageSize { get; set; }
    public long TotalCount { get; set; }
    public int TotalPages { get; set; }
    public List<string> Fields { get; set; } = new();
    public List<JsonElement> Data { get; set; } = new();
}

public class EntityFieldInfo
{
    public string Name { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty;
    public bool IsNullable { get; set; }
    public bool IsRequired { get; set; }
}

public class InvalidDocumentItem
{
    public string DocumentId { get; set; } = string.Empty;
    public JsonElement Document { get; set; }
    public List<string> Issues { get; set; } = new();
}

public class CollectionValidationResponse
{
    public string CollectionName { get; set; } = string.Empty;
    public bool HasEntity { get; set; }
    public string? EntityName { get; set; }
    public long TotalDocuments { get; set; }
    public int ScannedDocuments { get; set; }
    public int ValidDocuments { get; set; }
    public int InvalidDocuments { get; set; }
    public List<InvalidDocumentItem> InvalidItems { get; set; } = new();
    public List<EntityFieldInfo> EntityFields { get; set; } = new();
}

public class CollectionDeleteResponse
{
    public string CollectionName { get; set; } = string.Empty;
    public long DeletedDocuments { get; set; }
    public bool Success { get; set; }
}

public class DocumentDeleteResponse
{
    public string CollectionName { get; set; } = string.Empty;
    public string DocumentId { get; set; } = string.Empty;
    public bool Deleted { get; set; }
}

public class AppDataDeleteResponse
{
    public string AppName { get; set; } = string.Empty;
    public List<string> DeletedCollections { get; set; } = new();
    public long TotalDeletedDocuments { get; set; }
}

#endregion
