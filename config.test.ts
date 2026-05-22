import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, getProtectedConfigPaths, getRequiredWritablePaths, resolveEnabled, resolveReadOnly } from "./config.ts";
import { isPathAllowed, resolveRealPath } from "./guard.ts";

describe("resolveEnabled", () => {
  it("defaults to enabled", () => {
    assert.equal(resolveEnabled(undefined), true);
  });

  it("accepts explicit booleans", () => {
    assert.equal(resolveEnabled(true), true);
    assert.equal(resolveEnabled(false), false);
  });
});

describe("resolveReadOnly", () => {
  it("defaults to false", () => {
    assert.equal(resolveReadOnly(undefined), false);
  });

  it("accepts explicit booleans", () => {
    assert.equal(resolveReadOnly(true), true);
    assert.equal(resolveReadOnly(false), false);
  });
});

describe("loadConfig", () => {
  it("always includes required Pi support paths in writable roots", () => {
    const { config, pathResolver } = loadConfig("/workspace");
    const requiredPaths = getRequiredWritablePaths(pathResolver);

    for (const path of requiredPaths) {
      const realPath = resolveRealPath(path);
      assert.equal(
        config.writable.includes(realPath),
        true,
        `expected required writable path ${realPath} to be present`,
      );
    }
  });

  it("always protects Pi sandbox config paths", () => {
    const { config } = loadConfig("/workspace");
    assert.equal(config.enabled, true);
    const protectedPaths = getProtectedConfigPaths();

    for (const path of protectedPaths) {
      const realPath = resolveRealPath(path);
      assert.equal(
        config.denyWithin.includes(realPath),
        true,
        `expected protected config path ${realPath} to be denied`,
      );
    }
  });

  it("keeps protected config paths denied even if parent directories are writable", () => {
    const { config } = loadConfig("/workspace");
    const protectedPaths = getProtectedConfigPaths();

    for (const path of protectedPaths) {
      const realPath = resolveRealPath(path);
      assert.equal(config.denyWithin.includes(realPath), true);
      assert.equal(isPathAllowed(realPath, config), false);
    }
  });

  it("defaults denyRead to an empty list", () => {
    const { config } = loadConfig("/workspace");
    assert.deepEqual(config.denyRead, []);
  });

  it("defaults readOnly to false", () => {
    const { config } = loadConfig("/workspace");
    assert.equal(config.readOnly, false);
  });
});
