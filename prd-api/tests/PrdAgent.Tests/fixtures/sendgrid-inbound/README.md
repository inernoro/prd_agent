# Inbound Parse raw-byte fixture

Synthetic mail, generated independently with Python cryptography, using the official SendGrid Inbound Parse security-policy protocol: base64 SPKI P-256 public key, base64 DER ECDSA signature over SHA-256(timestamp ASCII + exact raw multipart bytes). This is not a captured live SendGrid delivery and contains no production credential. No private key is retained.

Official contract: https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks

`multipart.bin` includes CRLF, Chinese UTF-8 and a binary attachment with 00/ff/80 bytes. `multipart.json` fixes the public key, timestamp and signature. Regeneration with `python3 generate.py` intentionally produces a new test-only key and signature. Tests pass the fixture time explicitly; the real controller uses wall clock time.

Persistence tests require an explicitly supplied disposable loopback MongoDB through `EMAIL_WEBHOOK_TEST_MONGO`. Run only the named `EmailInboundPersistenceTests` integration class; each case creates and removes its own uniquely named database. No model, worker, mail-sending or external provider is started.
