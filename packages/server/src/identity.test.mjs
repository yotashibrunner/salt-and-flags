import { test } from "node:test";
import assert from "node:assert/strict";
import { playerIdFromSecret } from "./identity.mjs";

test("a player id is a deterministic SHA-256 derivation of the secret", async () => {
  const a = await playerIdFromSecret("correct-horse-battery-staple");
  const b = await playerIdFromSecret("correct-horse-battery-staple");
  assert.equal(a, b, "same secret -> same id (stable across reconnects)");
  assert.match(a, /^p_[0-9a-f]{24}$/, "well-formed id");
});

test("different secrets yield different ids (no trivial collisions)", async () => {
  const ids = await Promise.all(["a", "b", "c", "alice", "bob", ""].map(playerIdFromSecret));
  assert.equal(new Set(ids).size, ids.length, "all distinct");
});

test("you cannot derive a target id without its secret", async () => {
  // The id reveals nothing usable: knowing victim's id doesn't let you present a secret
  // that derives to it (that would require inverting SHA-256). Sanity: the id is not the
  // secret, and a guessed secret derives somewhere else.
  const victim = await playerIdFromSecret("victim-secret-xyz");
  assert.notEqual(victim, "victim-secret-xyz");
  assert.notEqual(await playerIdFromSecret(victim), victim, "presenting the id as a secret doesn't reproduce it");
});
