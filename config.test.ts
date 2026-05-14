import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, getProtectedConfigPaths, getRequiredWritablePaths, resolveEnabled } from "./config.ts";
import { isPathAllowed } from "./guard.ts";

describe("resolveEnabled", () => {
  it("defaults to enabled", () => {
    assert.equal(resolveEnabled(undefined), true);
  });

  it("accepts explicit booleans", () => {
    assert.equal(resolveEnabled(true), true);
    assert.equal(resolveEnabled(false), false);
  });
});

describe("loadConfig", () => {
  it("always includes required Pi support paths in writable roots", () => {
    const { config, pathResolver } = loadConfig("/workspace");
    const requiredPaths = getRequiredWritablePaths(pathResolver);

    for (const path of requiredPaths) {
      assert.equal(
        config.writable.includes(path),
        true,
        `expected required writable path ${path} to be present`,
      );
    }
  });

  it("always protects Pi sandbox config paths", () => {
    const { config } = loadConfig("/workspace");
    assert.equal(config.enabled, true);
    const protectedPaths = getProtectedConfigPaths();

    for (const path of protectedPaths) {
      assert.equal(
        config.denyWithin.includes(path),
        true,
        `expected protected config path ${path} to be denied`,
      );
    }
  });

  it("keeps protected config paths denied even if parent directories are writable", () => {
    const { config } = loadConfig("/workspace");
    const protectedPaths = getProtectedConfigPaths();

    for (const path of protectedPaths) {
      assert.equal(config.denyWithin.includes(path), true);
      assert.equal(isPathAllowed(path, config), false);
    }
  });
});
