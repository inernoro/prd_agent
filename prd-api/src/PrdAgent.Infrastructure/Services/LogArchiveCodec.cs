using System.IO.Compression;
using System.Security.Cryptography;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;

namespace PrdAgent.Infrastructure.Services;

/// <summary>Versioned BSON + gzip + authenticated encryption. No plaintext object URLs.</summary>
public static class LogArchiveCodec
{
    public const int MaxPlainBytes = 32 * 1024 * 1024;
    private static readonly byte[] Magic = "MAPLOG01"u8.ToArray();
    public static byte[] Pack(BsonDocument document, byte[] key)
    {
        var raw = document.ToBson();
        if (raw.Length > MaxPlainBytes) throw new InvalidDataException("Archive block too large");
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest, true)) gzip.Write(raw);
        var compressed = output.ToArray();
        var nonce = RandomNumberGenerator.GetBytes(12);
        var tag = new byte[16];
        var ciphertext = new byte[compressed.Length];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(nonce, compressed, ciphertext, tag, Magic);
        return [.. Magic, .. nonce, .. tag, .. ciphertext];
    }
    public static BsonDocument Unpack(byte[] bytes, byte[] key)
    {
        if (bytes.Length < 36 || bytes.Length > MaxPlainBytes + 65536 || !bytes.AsSpan(0, 8).SequenceEqual(Magic))
            throw new InvalidDataException("Invalid archive envelope");
        var plain = new byte[bytes.Length - 36];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(bytes.AsSpan(8, 12), bytes.AsSpan(36), bytes.AsSpan(20, 16), plain, Magic);
        using var gzip = new GZipStream(new MemoryStream(plain), CompressionMode.Decompress);
        using var output = new MemoryStream();
        var buffer = new byte[65536];
        int n;
        while ((n = gzip.Read(buffer)) > 0)
        {
            if (output.Length + n > MaxPlainBytes) throw new InvalidDataException("Expanded archive too large");
            output.Write(buffer, 0, n);
        }
        return BsonSerializer.Deserialize<BsonDocument>(output.ToArray());
    }
    public static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    public static BsonDocument ExactVersion(BsonDocument original) => new()
    {
        { "_id", original["_id"] },
        { "$expr", new BsonDocument("$eq", new BsonArray { "$$ROOT", new BsonDocument("$literal", original) }) }
    };
}
