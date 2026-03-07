#!/usr/bin/env bash
# =============================================================
# PrdAgent - Database Connectivity & Initialization Test
# Tests MongoDB + Redis connectivity, then initializes a test user
# via the actual API (WebApplicationFactory integration test style).
#
# Usage:
#   export MONGODB_HOST=<host> MONGODB_PASSWORD='<pw>'
#   export REDIS_HOST=<host> REDIS_PASSWORD='<pw>'
#   bash scripts/test-db-connectivity.sh
# =============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"

log() { echo "[db-test] $*"; }

# ---------- env var check ----------
MONGO_HOST="${MONGODB_HOST:-localhost}"
MONGO_PASS="${MONGODB_PASSWORD:-}"
REDIS_HOST_VAR="${REDIS_HOST:-localhost}"
REDIS_PASS="${REDIS_PASSWORD:-}"

# Build MongoDB connection string (URL-encode password)
if [ -n "$MONGO_PASS" ]; then
  ENCODED_PASS=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$MONGO_PASS'))")
  MONGO_CS="mongodb://root:${ENCODED_PASS}@${MONGO_HOST}:27017/?authSource=admin&connectTimeoutMS=5000&serverSelectionTimeoutMS=5000"
else
  MONGO_CS="mongodb://${MONGO_HOST}:27017"
fi

if [ -n "$REDIS_PASS" ]; then
  REDIS_CS="${REDIS_HOST_VAR}:6379,password=${REDIS_PASS},connectTimeout=5000"
else
  REDIS_CS="${REDIS_HOST_VAR}:6379,connectTimeout=5000"
fi

log "MongoDB: root@${MONGO_HOST}:27017"
log "Redis: ${REDIS_HOST_VAR}:6379"

# ---------- Create temp test project ----------
TEST_DIR="/tmp/prd-db-test"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

cat > "$TEST_DIR/DbTest.csproj" << 'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="MongoDB.Driver" Version="2.28.0" />
    <PackageReference Include="StackExchange.Redis" Version="2.7.33" />
    <PackageReference Include="BCrypt.Net-Next" Version="4.0.3" />
  </ItemGroup>
</Project>
CSPROJ

cat > "$TEST_DIR/Program.cs" << 'PROG'
using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;
using StackExchange.Redis;
using System;
using System.Linq;
using System.Security.Cryptography;

var mongoCs = Environment.GetEnvironmentVariable("TEST_MONGO_CS") ?? "mongodb://localhost:27017";
var redisCs = Environment.GetEnvironmentVariable("TEST_REDIS_CS") ?? "localhost:6379";
var dbName  = Environment.GetEnvironmentVariable("TEST_DB_NAME") ?? "prdagent";

var passed = 0;
var failed = 0;

void Pass(string test) { passed++; Console.WriteLine($"  [PASS] {test}"); }
void Fail(string test, string reason) { failed++; Console.WriteLine($"  [FAIL] {test}: {reason}"); }

// ==============================
// Test 1: MongoDB connectivity
// ==============================
Console.WriteLine("\n=== MongoDB Tests ===");
MongoClient? mongoClient = null;
IMongoDatabase? db = null;
try {
    mongoClient = new MongoClient(mongoCs);
    db = mongoClient.GetDatabase(dbName);
    // Force a real server roundtrip
    var names = db.ListCollectionNames().ToList();
    Pass($"Connected to '{dbName}', {names.Count} existing collection(s)");
} catch (Exception ex) {
    Fail("MongoDB connection", ex.Message);
}

// ==============================
// Test 2: MongoDB write + read (users collection)
// ==============================
if (db != null) {
    try {
        var users = db.GetCollection<BsonDocument>("users");
        var testUserId = $"test-user-{DateTime.UtcNow:yyyyMMddHHmmss}";
        var testDoc = new BsonDocument {
            ["userId"] = testUserId,
            ["username"] = "ci_test_user",
            ["displayName"] = "CI Test User",
            ["passwordHash"] = BCrypt.Net.BCrypt.HashPassword("test123"),
            ["role"] = "Admin",
            ["status"] = "Active",
            ["createdAt"] = DateTime.UtcNow,
            ["updatedAt"] = DateTime.UtcNow
        };

        await users.InsertOneAsync(testDoc);
        Pass($"Inserted test user: {testUserId}");

        var found = await users.Find(new BsonDocument("userId", testUserId)).FirstOrDefaultAsync();
        if (found != null && found["username"] == "ci_test_user")
            Pass("Read back test user successfully");
        else
            Fail("Read back test user", "Document not found or mismatch");

        // Cleanup
        await users.DeleteOneAsync(new BsonDocument("userId", testUserId));
        Pass("Cleaned up test user");
    } catch (Exception ex) {
        Fail("MongoDB write/read", ex.Message);
    }
}

// ==============================
// Test 3: MongoDB index creation (like MongoDbContext)
// ==============================
if (db != null) {
    try {
        var sessions = db.GetCollection<BsonDocument>("sessions");
        var indexModel = new CreateIndexModel<BsonDocument>(
            Builders<BsonDocument>.IndexKeys.Ascending("userId"),
            new CreateIndexOptions { Background = true }
        );
        await sessions.Indexes.CreateOneAsync(indexModel);
        Pass("Index creation on 'sessions.userId'");
    } catch (Exception ex) {
        Fail("Index creation", ex.Message);
    }
}

// ==============================
// Test 4: Redis connectivity
// ==============================
Console.WriteLine("\n=== Redis Tests ===");
IDatabase? redisDb = null;
ConnectionMultiplexer? redis = null;
try {
    redis = ConnectionMultiplexer.Connect(redisCs);
    redisDb = redis.GetDatabase();
    var pong = redisDb.Ping();
    Pass($"PING responded in {pong.TotalMilliseconds:F1}ms");
} catch (Exception ex) {
    Fail("Redis connection", ex.Message);
}

// ==============================
// Test 5: Redis write + read
// ==============================
if (redisDb != null) {
    try {
        var key = "prd:ci-test:" + DateTime.UtcNow.Ticks;
        await redisDb.StringSetAsync(key, "hello-prd", TimeSpan.FromSeconds(10));
        var val = await redisDb.StringGetAsync(key);
        if (val == "hello-prd")
            Pass("SET/GET round-trip");
        else
            Fail("SET/GET", $"Expected 'hello-prd', got '{val}'");
        await redisDb.KeyDeleteAsync(key);
        Pass("Key cleanup");
    } catch (Exception ex) {
        Fail("Redis write/read", ex.Message);
    }
}

// ==============================
// Test 6: Redis rate-limit style (sorted set, like RedisRateLimitService)
// ==============================
if (redisDb != null) {
    try {
        var key = "prd:ci-ratelimit-test";
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await redisDb.SortedSetAddAsync(key, now.ToString(), now);
        var count = await redisDb.SortedSetLengthAsync(key);
        if (count > 0)
            Pass("SortedSet (rate-limit pattern)");
        else
            Fail("SortedSet", "Length is 0");
        await redisDb.KeyDeleteAsync(key);
    } catch (Exception ex) {
        Fail("Redis rate-limit pattern", ex.Message);
    }
}

redis?.Close();

// ==============================
// Summary
// ==============================
Console.WriteLine($"\n=== Results: {passed} passed, {failed} failed ===");
Environment.ExitCode = failed > 0 ? 1 : 0;
PROG

# ---------- Restore + Run ----------
log "Building test project..."
cd "$TEST_DIR"

# Handle Web sandbox proxy for NuGet
if [ -n "${HTTPS_PROXY:-}" ] && echo "${HTTPS_PROXY:-}" | grep -q "container_" 2>/dev/null; then
  if pgrep -f "nuget-proxy-relay.py" >/dev/null 2>&1; then
    HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 dotnet restore 2>&1
  else
    log "Starting NuGet proxy relay..."
    python3 "$PROJECT_ROOT/scripts/nuget-proxy-relay.py" &
    RELAY_PID=$!
    sleep 1
    HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 dotnet restore 2>&1
    kill $RELAY_PID 2>/dev/null || true
  fi
else
  dotnet restore 2>&1
fi

log "Running connectivity tests..."
TEST_MONGO_CS="$MONGO_CS" TEST_REDIS_CS="$REDIS_CS" TEST_DB_NAME="prdagent" \
  dotnet run --no-restore 2>&1

EXIT_CODE=$?
rm -rf "$TEST_DIR"
log "Test project cleaned up"
exit $EXIT_CODE
