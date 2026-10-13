import assert from "node:assert/strict";

import type { StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";

/**
 * Assertions for pi-durable's storage conformance suite under `node --test`.
 *
 * `partialDeepEqual` is the one that needs care: the suite's name matches what it actually checks —
 * every key in `expected` must match, and extra keys on `actual` are allowed, because storage may
 * return a record carrying more than the assertion bothers to name. Mapping it to
 * `assert.deepStrictEqual` produces three false failures in the document suite, so it is implemented
 * properly here.
 */
export function partialDeepEqual(actual: unknown, expected: unknown, path = "$"): void {
  if (expected === null || typeof expected !== "object") {
    assert.ok(
      Object.is(actual, expected),
      `partialDeepEqual at ${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
    return;
  }

  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `partialDeepEqual at ${path}: expected an array`);
    assert.equal(
      (actual as unknown[]).length,
      expected.length,
      `partialDeepEqual at ${path}: length differs`,
    );
    expected.forEach((value, index) =>
      partialDeepEqual((actual as unknown[])[index], value, `${path}[${index}]`),
    );
    return;
  }

  assert.ok(
    actual !== null && typeof actual === "object",
    `partialDeepEqual at ${path}: expected an object, got ${JSON.stringify(actual)}`,
  );
  const record = actual as Record<string, unknown>;
  for (const key of Object.keys(expected)) {
    assert.ok(key in record, `partialDeepEqual at ${path}: missing key ${key}`);
    partialDeepEqual(record[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

/**
 * `rejects` receives a promise and a substring of the expected message. `assert.rejects` with a
 * predicate is the faithful translation.
 */
export const conformanceAssertions: StorageConformanceAssertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
  deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
  partialDeepEqual: (actual, expected) => partialDeepEqual(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: async (operation, messageIncludes) => {
    await assert.rejects(operation, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(
        message.includes(messageIncludes),
        `expected rejection mentioning ${JSON.stringify(messageIncludes)}, got ${JSON.stringify(message)}`,
      );
      return true;
    });
  },
};
