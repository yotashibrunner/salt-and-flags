// Client identity: a long random SECRET kept in localStorage. We send the secret on
// every join; the server derives the public player id as SHA-256(secret) (see the
// server's identity.mjs — same algorithm, same id). The secret is the proof of wallet
// ownership, so it never leaves this device except to the authoritative server.

export async function playerIdFromSecret(secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(`salt-and-flags:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `p_${hex.slice(0, 24)}`;
}

let cached: { secret: string; playerId: string } | null = null;

// The captain's identity for this browser (created + persisted on first use). Migrates a
// legacy `salt.playerId` by adopting it as the secret, so an existing player keeps a
// stable (if newly-derived) id rather than silently splitting wallets.
export async function getIdentity(): Promise<{ secret: string; playerId: string }> {
  if (cached) return cached;
  let secret = localStorage.getItem("salt.secret");
  if (!secret) {
    secret = localStorage.getItem("salt.playerId") ?? (crypto.randomUUID() + "." + crypto.randomUUID());
    localStorage.setItem("salt.secret", secret);
  }
  cached = { secret, playerId: await playerIdFromSecret(secret) };
  return cached;
}
