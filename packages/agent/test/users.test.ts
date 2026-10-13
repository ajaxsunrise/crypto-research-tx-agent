import assert from "node:assert/strict";
import test from "node:test";

import { parseTenantId } from "@crypto/domain/internal";

import { memoryUsers } from "../src/http/users.js";

test("registration mints a valid tenant id and login verifies the password", async () => {
  const users = memoryUsers();
  try {
    const outcome = await users.register("User@Example.com", "correct horse battery");
    assert.deepEqual(outcome.kind, "registered");
    if (outcome.kind !== "registered") {
      return;
    }
    assert.match(outcome.tenantId, /^u_[0-9a-f]{24}$/);
    assert.notEqual(parseTenantId(outcome.tenantId), undefined);
    assert.equal(await users.login("user@example.com", "correct horse battery"), outcome.tenantId);
  } finally {
    await users.close();
  }
});

test("a duplicate email is rejected and wrong or unknown credentials never log in", async () => {
  const users = memoryUsers();
  try {
    const first = await users.register("user@example.com", "correct horse battery");
    assert.deepEqual(first.kind, "registered");
    assert.deepEqual(await users.register("user@example.com", "another password"), {
      kind: "email-taken",
    });
    assert.equal(await users.login("user@example.com", "wrong password"), undefined);
    assert.equal(await users.login("nobody@example.com", "correct horse battery"), undefined);
  } finally {
    await users.close();
  }
});

test("two registrations mint distinct tenant ids", async () => {
  const users = memoryUsers();
  try {
    const first = await users.register("one@example.com", "password one");
    const second = await users.register("two@example.com", "password two");
    assert.equal(first.kind, "registered");
    assert.equal(second.kind, "registered");
    if (first.kind !== "registered" || second.kind !== "registered") {
      return;
    }
    assert.notEqual(first.tenantId, second.tenantId);
  } finally {
    await users.close();
  }
});
