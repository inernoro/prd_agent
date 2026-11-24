namespace PrdAgent.Core.Models;

/// <summary>MAP 持有的 CDS 委托会话，兑换一次后仍用于核对原始授权。</summary>
public sealed class CdsSsoSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Ciphertext { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public DateTime RedeemBy { get; set; }
    public bool Redeemed { get; set; }
}
