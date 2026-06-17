// ============================================================================
// Stateless cryptographic identity. A captain's player id is SHA-256 of a secret
// the CLIENT holds; the client proves ownership by presenting the secret, and the
// server derives the id from it. You cannot claim another captain's id without their
// secret (finding one would mean inverting SHA-256), so a wallet can't be stolen by
// merely asserting its id — the gap the old localStorage-playerId left open.
//
// (Sybil — minting fresh secrets for fresh ids — is inherent to anonymous play and a
// separate concern; this closes IMPERSONATION, not anonymity.)
//
// Uses Web Crypto (globalThis.crypto.subtle), which is present in Node 20+ AND browsers,
// so the server and client derive identical ids from the same secret. Runnable under
// `node --test`.
// ============================================================================

export async function playerIdFromSecret(secret) {
  const bytes = new TextEncoder().encode(`salt-and-flags:${String(secret)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `p_${hex.slice(0, 24)}`;
}
