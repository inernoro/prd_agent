namespace PrdAgent.Infrastructure.Services.Channels;

/// <summary>
/// Server-owned mailbox binding, supplied only after validating the Parse signature and envelope.
/// From is untrusted mail content and must never select the owner of a verified ingress task.
/// </summary>
public sealed record VerifiedEmailIngress(string Recipient, string OwnerUserId, string DeliveryKey);
