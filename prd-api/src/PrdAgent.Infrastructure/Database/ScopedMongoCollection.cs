using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 把一个固定条件（如「只看内部租户」）强制叠加到集合的每一次读写上。
/// MAP 读网关库里的请求日志时用它：日志集合是网关全部租户共用的，
/// 判据收在这一处，调用方照常 Find / Aggregate / Update，不可能漏写租户条件。
/// 用不到、又无法安全加条件的操作（BulkWrite / MapReduce / Watch / OfType）直接抛错，不静默放行。
/// </summary>
public sealed class ScopedMongoCollection<TDocument> : IMongoCollection<TDocument>
{
    private readonly IMongoCollection<TDocument> _inner;
    private readonly FilterDefinition<TDocument> _scope;

    public ScopedMongoCollection(IMongoCollection<TDocument> inner, FilterDefinition<TDocument> scope)
    {
        _inner = inner;
        _scope = scope;
    }

    public FilterDefinition<TDocument> Scope => _scope;

    private FilterDefinition<TDocument> F(FilterDefinition<TDocument> filter) =>
        Builders<TDocument>.Filter.And(_scope, filter);

    private PipelineDefinition<TDocument, TResult> P<TResult>(PipelineDefinition<TDocument, TResult> pipeline) =>
        new PrependedStagePipelineDefinition<TDocument, TDocument, TResult>(PipelineStageDefinitionBuilder.Match(_scope), pipeline);

    private static NotSupportedException Unsupported(string operation) =>
        new($"{operation} 无法叠加集合作用域条件，ScopedMongoCollection 不支持；请改用 Find / Aggregate / Update 等带过滤条件的操作。");

    public CollectionNamespace CollectionNamespace => _inner.CollectionNamespace;
    public IMongoDatabase Database => _inner.Database;
    public MongoDB.Bson.Serialization.IBsonSerializer<TDocument> DocumentSerializer => _inner.DocumentSerializer;
    public IMongoIndexManager<TDocument> Indexes => _inner.Indexes;
    public MongoDB.Driver.Search.IMongoSearchIndexManager SearchIndexes => _inner.SearchIndexes;
    public MongoCollectionSettings Settings => _inner.Settings;

    public IAsyncCursor<TResult> Aggregate<TResult>(PipelineDefinition<TDocument, TResult> pipeline, AggregateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.Aggregate(P(pipeline), options, cancellationToken);
    public IAsyncCursor<TResult> Aggregate<TResult>(IClientSessionHandle session, PipelineDefinition<TDocument, TResult> pipeline, AggregateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.Aggregate(session, P(pipeline), options, cancellationToken);
    public Task<IAsyncCursor<TResult>> AggregateAsync<TResult>(PipelineDefinition<TDocument, TResult> pipeline, AggregateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.AggregateAsync(P(pipeline), options, cancellationToken);
    public Task<IAsyncCursor<TResult>> AggregateAsync<TResult>(IClientSessionHandle session, PipelineDefinition<TDocument, TResult> pipeline, AggregateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.AggregateAsync(session, P(pipeline), options, cancellationToken);
    public void AggregateToCollection<TResult>(PipelineDefinition<TDocument, TResult> pipeline, AggregateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.AggregateToCollection(P(pipeline), options, cancellationToken);
    public void AggregateToCollection<TResult>(IClientSessionHandle session, PipelineDefinition<TDocument, TResult> pipeline, AggregateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.AggregateToCollection(session, P(pipeline), options, cancellationToken);
    public Task AggregateToCollectionAsync<TResult>(PipelineDefinition<TDocument, TResult> pipeline, AggregateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.AggregateToCollectionAsync(P(pipeline), options, cancellationToken);
    public Task AggregateToCollectionAsync<TResult>(IClientSessionHandle session, PipelineDefinition<TDocument, TResult> pipeline, AggregateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.AggregateToCollectionAsync(session, P(pipeline), options, cancellationToken);

    public BulkWriteResult<TDocument> BulkWrite(IEnumerable<WriteModel<TDocument>> requests, BulkWriteOptions? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(BulkWrite));
    public BulkWriteResult<TDocument> BulkWrite(IClientSessionHandle session, IEnumerable<WriteModel<TDocument>> requests, BulkWriteOptions? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(BulkWrite));
    public Task<BulkWriteResult<TDocument>> BulkWriteAsync(IEnumerable<WriteModel<TDocument>> requests, BulkWriteOptions? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(BulkWriteAsync));
    public Task<BulkWriteResult<TDocument>> BulkWriteAsync(IClientSessionHandle session, IEnumerable<WriteModel<TDocument>> requests, BulkWriteOptions? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(BulkWriteAsync));

#pragma warning disable CS0618 // Count 已过时，但接口仍要求实现
    public long Count(FilterDefinition<TDocument> filter, CountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.Count(F(filter), options, cancellationToken);
    public long Count(IClientSessionHandle session, FilterDefinition<TDocument> filter, CountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.Count(session, F(filter), options, cancellationToken);
    public Task<long> CountAsync(FilterDefinition<TDocument> filter, CountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.CountAsync(F(filter), options, cancellationToken);
    public Task<long> CountAsync(IClientSessionHandle session, FilterDefinition<TDocument> filter, CountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.CountAsync(session, F(filter), options, cancellationToken);
#pragma warning restore CS0618
    public long CountDocuments(FilterDefinition<TDocument> filter, CountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.CountDocuments(F(filter), options, cancellationToken);
    public long CountDocuments(IClientSessionHandle session, FilterDefinition<TDocument> filter, CountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.CountDocuments(session, F(filter), options, cancellationToken);
    public Task<long> CountDocumentsAsync(FilterDefinition<TDocument> filter, CountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.CountDocumentsAsync(F(filter), options, cancellationToken);
    public Task<long> CountDocumentsAsync(IClientSessionHandle session, FilterDefinition<TDocument> filter, CountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.CountDocumentsAsync(session, F(filter), options, cancellationToken);

    // 估算条数取的是整个集合的元数据，无法按作用域过滤，改为精确计数。
    public long EstimatedDocumentCount(EstimatedDocumentCountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.CountDocuments(_scope, cancellationToken: cancellationToken);
    public Task<long> EstimatedDocumentCountAsync(EstimatedDocumentCountOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.CountDocumentsAsync(_scope, cancellationToken: cancellationToken);

    public DeleteResult DeleteMany(FilterDefinition<TDocument> filter, CancellationToken cancellationToken = default) =>
        _inner.DeleteMany(F(filter), cancellationToken);
    public DeleteResult DeleteMany(FilterDefinition<TDocument> filter, DeleteOptions options, CancellationToken cancellationToken = default) =>
        _inner.DeleteMany(F(filter), options, cancellationToken);
    public DeleteResult DeleteMany(IClientSessionHandle session, FilterDefinition<TDocument> filter, DeleteOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DeleteMany(session, F(filter), options, cancellationToken);
    public Task<DeleteResult> DeleteManyAsync(FilterDefinition<TDocument> filter, CancellationToken cancellationToken = default) =>
        _inner.DeleteManyAsync(F(filter), cancellationToken);
    public Task<DeleteResult> DeleteManyAsync(FilterDefinition<TDocument> filter, DeleteOptions options, CancellationToken cancellationToken = default) =>
        _inner.DeleteManyAsync(F(filter), options, cancellationToken);
    public Task<DeleteResult> DeleteManyAsync(IClientSessionHandle session, FilterDefinition<TDocument> filter, DeleteOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DeleteManyAsync(session, F(filter), options, cancellationToken);
    public DeleteResult DeleteOne(FilterDefinition<TDocument> filter, CancellationToken cancellationToken = default) =>
        _inner.DeleteOne(F(filter), cancellationToken);
    public DeleteResult DeleteOne(FilterDefinition<TDocument> filter, DeleteOptions options, CancellationToken cancellationToken = default) =>
        _inner.DeleteOne(F(filter), options, cancellationToken);
    public DeleteResult DeleteOne(IClientSessionHandle session, FilterDefinition<TDocument> filter, DeleteOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DeleteOne(session, F(filter), options, cancellationToken);
    public Task<DeleteResult> DeleteOneAsync(FilterDefinition<TDocument> filter, CancellationToken cancellationToken = default) =>
        _inner.DeleteOneAsync(F(filter), cancellationToken);
    public Task<DeleteResult> DeleteOneAsync(FilterDefinition<TDocument> filter, DeleteOptions options, CancellationToken cancellationToken = default) =>
        _inner.DeleteOneAsync(F(filter), options, cancellationToken);
    public Task<DeleteResult> DeleteOneAsync(IClientSessionHandle session, FilterDefinition<TDocument> filter, DeleteOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DeleteOneAsync(session, F(filter), options, cancellationToken);

    public IAsyncCursor<TField> Distinct<TField>(FieldDefinition<TDocument, TField> field, FilterDefinition<TDocument> filter, DistinctOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.Distinct(field, F(filter), options, cancellationToken);
    public IAsyncCursor<TField> Distinct<TField>(IClientSessionHandle session, FieldDefinition<TDocument, TField> field, FilterDefinition<TDocument> filter, DistinctOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.Distinct(session, field, F(filter), options, cancellationToken);
    public Task<IAsyncCursor<TField>> DistinctAsync<TField>(FieldDefinition<TDocument, TField> field, FilterDefinition<TDocument> filter, DistinctOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DistinctAsync(field, F(filter), options, cancellationToken);
    public Task<IAsyncCursor<TField>> DistinctAsync<TField>(IClientSessionHandle session, FieldDefinition<TDocument, TField> field, FilterDefinition<TDocument> filter, DistinctOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DistinctAsync(session, field, F(filter), options, cancellationToken);
    public IAsyncCursor<TItem> DistinctMany<TItem>(FieldDefinition<TDocument, IEnumerable<TItem>> field, FilterDefinition<TDocument> filter, DistinctOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DistinctMany(field, F(filter), options, cancellationToken);
    public IAsyncCursor<TItem> DistinctMany<TItem>(IClientSessionHandle session, FieldDefinition<TDocument, IEnumerable<TItem>> field, FilterDefinition<TDocument> filter, DistinctOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DistinctMany(session, field, F(filter), options, cancellationToken);
    public Task<IAsyncCursor<TItem>> DistinctManyAsync<TItem>(FieldDefinition<TDocument, IEnumerable<TItem>> field, FilterDefinition<TDocument> filter, DistinctOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DistinctManyAsync(field, F(filter), options, cancellationToken);
    public Task<IAsyncCursor<TItem>> DistinctManyAsync<TItem>(IClientSessionHandle session, FieldDefinition<TDocument, IEnumerable<TItem>> field, FilterDefinition<TDocument> filter, DistinctOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.DistinctManyAsync(session, field, F(filter), options, cancellationToken);

    public IAsyncCursor<TProjection> FindSync<TProjection>(FilterDefinition<TDocument> filter, FindOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindSync(F(filter), options, cancellationToken);
    public IAsyncCursor<TProjection> FindSync<TProjection>(IClientSessionHandle session, FilterDefinition<TDocument> filter, FindOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindSync(session, F(filter), options, cancellationToken);
    public Task<IAsyncCursor<TProjection>> FindAsync<TProjection>(FilterDefinition<TDocument> filter, FindOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindAsync(F(filter), options, cancellationToken);
    public Task<IAsyncCursor<TProjection>> FindAsync<TProjection>(IClientSessionHandle session, FilterDefinition<TDocument> filter, FindOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindAsync(session, F(filter), options, cancellationToken);

    public TProjection FindOneAndDelete<TProjection>(FilterDefinition<TDocument> filter, FindOneAndDeleteOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndDelete(F(filter), options, cancellationToken);
    public TProjection FindOneAndDelete<TProjection>(IClientSessionHandle session, FilterDefinition<TDocument> filter, FindOneAndDeleteOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndDelete(session, F(filter), options, cancellationToken);
    public Task<TProjection> FindOneAndDeleteAsync<TProjection>(FilterDefinition<TDocument> filter, FindOneAndDeleteOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndDeleteAsync(F(filter), options, cancellationToken);
    public Task<TProjection> FindOneAndDeleteAsync<TProjection>(IClientSessionHandle session, FilterDefinition<TDocument> filter, FindOneAndDeleteOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndDeleteAsync(session, F(filter), options, cancellationToken);
    public TProjection FindOneAndReplace<TProjection>(FilterDefinition<TDocument> filter, TDocument replacement, FindOneAndReplaceOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndReplace(F(filter), replacement, options, cancellationToken);
    public TProjection FindOneAndReplace<TProjection>(IClientSessionHandle session, FilterDefinition<TDocument> filter, TDocument replacement, FindOneAndReplaceOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndReplace(session, F(filter), replacement, options, cancellationToken);
    public Task<TProjection> FindOneAndReplaceAsync<TProjection>(FilterDefinition<TDocument> filter, TDocument replacement, FindOneAndReplaceOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndReplaceAsync(F(filter), replacement, options, cancellationToken);
    public Task<TProjection> FindOneAndReplaceAsync<TProjection>(IClientSessionHandle session, FilterDefinition<TDocument> filter, TDocument replacement, FindOneAndReplaceOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndReplaceAsync(session, F(filter), replacement, options, cancellationToken);
    public TProjection FindOneAndUpdate<TProjection>(FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, FindOneAndUpdateOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndUpdate(F(filter), update, options, cancellationToken);
    public TProjection FindOneAndUpdate<TProjection>(IClientSessionHandle session, FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, FindOneAndUpdateOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndUpdate(session, F(filter), update, options, cancellationToken);
    public Task<TProjection> FindOneAndUpdateAsync<TProjection>(FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, FindOneAndUpdateOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndUpdateAsync(F(filter), update, options, cancellationToken);
    public Task<TProjection> FindOneAndUpdateAsync<TProjection>(IClientSessionHandle session, FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, FindOneAndUpdateOptions<TDocument, TProjection>? options = null, CancellationToken cancellationToken = default) =>
        _inner.FindOneAndUpdateAsync(session, F(filter), update, options, cancellationToken);

    // 写入直接透传：写入方自己决定文档的作用域字段（MAP 的日志写入器只写内部租户）。
    public void InsertOne(TDocument document, InsertOneOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.InsertOne(document, options, cancellationToken);
    public void InsertOne(IClientSessionHandle session, TDocument document, InsertOneOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.InsertOne(session, document, options, cancellationToken);
    [Obsolete("Use the new overload of InsertOneAsync with an InsertOneOptions parameter instead.")]
    public Task InsertOneAsync(TDocument document, CancellationToken _cancellationToken) =>
        _inner.InsertOneAsync(document, options: null, cancellationToken: _cancellationToken);
    public Task InsertOneAsync(TDocument document, InsertOneOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.InsertOneAsync(document, options, cancellationToken);
    public Task InsertOneAsync(IClientSessionHandle session, TDocument document, InsertOneOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.InsertOneAsync(session, document, options, cancellationToken);
    public void InsertMany(IEnumerable<TDocument> documents, InsertManyOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.InsertMany(documents, options, cancellationToken);
    public void InsertMany(IClientSessionHandle session, IEnumerable<TDocument> documents, InsertManyOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.InsertMany(session, documents, options, cancellationToken);
    public Task InsertManyAsync(IEnumerable<TDocument> documents, InsertManyOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.InsertManyAsync(documents, options, cancellationToken);
    public Task InsertManyAsync(IClientSessionHandle session, IEnumerable<TDocument> documents, InsertManyOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.InsertManyAsync(session, documents, options, cancellationToken);

#pragma warning disable CS0618 // MapReduce 已过时，但接口仍要求实现
    public IAsyncCursor<TResult> MapReduce<TResult>(BsonJavaScript map, BsonJavaScript reduce, MapReduceOptions<TDocument, TResult>? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(MapReduce));
    public IAsyncCursor<TResult> MapReduce<TResult>(IClientSessionHandle session, BsonJavaScript map, BsonJavaScript reduce, MapReduceOptions<TDocument, TResult>? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(MapReduce));
    public Task<IAsyncCursor<TResult>> MapReduceAsync<TResult>(BsonJavaScript map, BsonJavaScript reduce, MapReduceOptions<TDocument, TResult>? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(MapReduceAsync));
    public Task<IAsyncCursor<TResult>> MapReduceAsync<TResult>(IClientSessionHandle session, BsonJavaScript map, BsonJavaScript reduce, MapReduceOptions<TDocument, TResult>? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(MapReduceAsync));
#pragma warning restore CS0618

    public IFilteredMongoCollection<TDerivedDocument> OfType<TDerivedDocument>() where TDerivedDocument : TDocument => throw Unsupported(nameof(OfType));

    public ReplaceOneResult ReplaceOne(FilterDefinition<TDocument> filter, TDocument replacement, ReplaceOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.ReplaceOne(F(filter), replacement, options, cancellationToken);
    [Obsolete("Use the overload that takes a ReplaceOptions instead of an UpdateOptions.")]
    public ReplaceOneResult ReplaceOne(FilterDefinition<TDocument> filter, TDocument replacement, UpdateOptions options, CancellationToken cancellationToken = default) =>
        _inner.ReplaceOne(F(filter), replacement, options, cancellationToken);
    public ReplaceOneResult ReplaceOne(IClientSessionHandle session, FilterDefinition<TDocument> filter, TDocument replacement, ReplaceOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.ReplaceOne(session, F(filter), replacement, options, cancellationToken);
    [Obsolete("Use the overload that takes a ReplaceOptions instead of an UpdateOptions.")]
    public ReplaceOneResult ReplaceOne(IClientSessionHandle session, FilterDefinition<TDocument> filter, TDocument replacement, UpdateOptions options, CancellationToken cancellationToken = default) =>
        _inner.ReplaceOne(session, F(filter), replacement, options, cancellationToken);
    public Task<ReplaceOneResult> ReplaceOneAsync(FilterDefinition<TDocument> filter, TDocument replacement, ReplaceOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.ReplaceOneAsync(F(filter), replacement, options, cancellationToken);
    [Obsolete("Use the overload that takes a ReplaceOptions instead of an UpdateOptions.")]
    public Task<ReplaceOneResult> ReplaceOneAsync(FilterDefinition<TDocument> filter, TDocument replacement, UpdateOptions options, CancellationToken cancellationToken = default) =>
        _inner.ReplaceOneAsync(F(filter), replacement, options, cancellationToken);
    public Task<ReplaceOneResult> ReplaceOneAsync(IClientSessionHandle session, FilterDefinition<TDocument> filter, TDocument replacement, ReplaceOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.ReplaceOneAsync(session, F(filter), replacement, options, cancellationToken);
    [Obsolete("Use the overload that takes a ReplaceOptions instead of an UpdateOptions.")]
    public Task<ReplaceOneResult> ReplaceOneAsync(IClientSessionHandle session, FilterDefinition<TDocument> filter, TDocument replacement, UpdateOptions options, CancellationToken cancellationToken = default) =>
        _inner.ReplaceOneAsync(session, F(filter), replacement, options, cancellationToken);

    public UpdateResult UpdateMany(FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, UpdateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.UpdateMany(F(filter), update, options, cancellationToken);
    public UpdateResult UpdateMany(IClientSessionHandle session, FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, UpdateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.UpdateMany(session, F(filter), update, options, cancellationToken);
    public Task<UpdateResult> UpdateManyAsync(FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, UpdateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.UpdateManyAsync(F(filter), update, options, cancellationToken);
    public Task<UpdateResult> UpdateManyAsync(IClientSessionHandle session, FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, UpdateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.UpdateManyAsync(session, F(filter), update, options, cancellationToken);
    public UpdateResult UpdateOne(FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, UpdateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.UpdateOne(F(filter), update, options, cancellationToken);
    public UpdateResult UpdateOne(IClientSessionHandle session, FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, UpdateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.UpdateOne(session, F(filter), update, options, cancellationToken);
    public Task<UpdateResult> UpdateOneAsync(FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, UpdateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.UpdateOneAsync(F(filter), update, options, cancellationToken);
    public Task<UpdateResult> UpdateOneAsync(IClientSessionHandle session, FilterDefinition<TDocument> filter, UpdateDefinition<TDocument> update, UpdateOptions? options = null, CancellationToken cancellationToken = default) =>
        _inner.UpdateOneAsync(session, F(filter), update, options, cancellationToken);

    public IChangeStreamCursor<TResult> Watch<TResult>(PipelineDefinition<ChangeStreamDocument<TDocument>, TResult> pipeline, ChangeStreamOptions? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(Watch));
    public IChangeStreamCursor<TResult> Watch<TResult>(IClientSessionHandle session, PipelineDefinition<ChangeStreamDocument<TDocument>, TResult> pipeline, ChangeStreamOptions? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(Watch));
    public Task<IChangeStreamCursor<TResult>> WatchAsync<TResult>(PipelineDefinition<ChangeStreamDocument<TDocument>, TResult> pipeline, ChangeStreamOptions? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(WatchAsync));
    public Task<IChangeStreamCursor<TResult>> WatchAsync<TResult>(IClientSessionHandle session, PipelineDefinition<ChangeStreamDocument<TDocument>, TResult> pipeline, ChangeStreamOptions? options = null, CancellationToken cancellationToken = default) => throw Unsupported(nameof(WatchAsync));

    public IMongoCollection<TDocument> WithReadConcern(ReadConcern readConcern) =>
        new ScopedMongoCollection<TDocument>(_inner.WithReadConcern(readConcern), _scope);
    public IMongoCollection<TDocument> WithReadPreference(ReadPreference readPreference) =>
        new ScopedMongoCollection<TDocument>(_inner.WithReadPreference(readPreference), _scope);
    public IMongoCollection<TDocument> WithWriteConcern(WriteConcern writeConcern) =>
        new ScopedMongoCollection<TDocument>(_inner.WithWriteConcern(writeConcern), _scope);
}
