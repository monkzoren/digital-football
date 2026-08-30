// Mint a SpacetimeDB identity token, signed with the server's own JWT key.
//
// SpacetimeDB derives an identity purely from the token's `iss`/`sub` claims
// (Identity::from_claims), and accepts any token whose signature verifies
// against the server's local key. Signing a token with FIXED claims therefore
// yields the SAME identity on every run — which makes database ownership
// deterministic instead of depending on credentials saved from the first
// publish. The publisher re-mints on each deploy, so even a server re-key
// only invalidates old signatures, never the identity itself.
//
// Usage: node mint-token.mjs <private-key.pem> <issuer> <subject>
import { createPrivateKey, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [privKeyPath, issuer, subject] = process.argv.slice(2);
if (!privKeyPath || !issuer || !subject) {
  console.error('usage: mint-token.mjs <private-key.pem> <issuer> <subject>');
  process.exit(2);
}

const key = createPrivateKey(readFileSync(privKeyPath));
if (key.asymmetricKeyType !== 'ec') {
  console.error(`expected an EC (ES256) private key, got ${key.asymmetricKeyType}`);
  process.exit(1);
}

const b64url = (data) => Buffer.from(data).toString('base64url');
// Same claim shape the server itself issues: no exp — publish tokens are
// re-minted per run, and the identity endpoint's own tokens carry none either.
const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
const payload = b64url(
  JSON.stringify({ iss: issuer, sub: subject, aud: ['spacetimedb'], iat: Math.floor(Date.now() / 1000) })
);
const signingInput = `${header}.${payload}`;
// ieee-p1363 yields the raw 64-byte r||s signature JWS requires (not DER).
const signature = createSign('SHA256')
  .update(signingInput)
  .end()
  .sign({ key, dsaEncoding: 'ieee-p1363' });
process.stdout.write(`${signingInput}.${b64url(signature)}\n`);
