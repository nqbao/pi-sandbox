import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, getProtectedConfigPaths, getRequiredWritablePaths, resolveEnabled, resolveReadOnly, computeEffectiveDenyRead, mergeWritable, createPathResolver } from "./config.ts";
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

  it("defaults denyRead to the resolved DEFAULT_DENY_READ paths", () => {
    const { config } = loadConfig("/workspace");
    assert.equal(config.denyRead.length > 0, true);
    assert.equal(config.allowRead.length, 0);
  });

  it("defaults readOnly to false", () => {
    const { config } = loadConfig("/workspace");
    assert.equal(config.readOnly, false);
  });
});

describe("mergeWritable", () => {
  const resolver = createPathResolver("/workspace");

  it("includes DEFAULT_WRITABLE even when user specifies custom writable paths", () => {
    const result = mergeWritable(["/custom/path"], resolver);
    assert.equal(result.includes(resolveRealPath("/workspace")), true);
    assert.equal(result.includes("/custom/path"), true);
  });

  it("user paths are additive, not a replacement for defaults", () => {
    const withCustom = mergeWritable(["/extra"], resolver);
    const withoutCustom = mergeWritable(undefined, resolver);
    for (const p of withoutCustom) {
      assert.equal(withCustom.includes(p), true, `expected default path ${p} to be present`);
    }
    assert.equal(withCustom.includes("/extra"), true);
  });
});

describe("computeEffectiveDenyRead", () => {
  const defaults = ["/home/user/.ssh", "/home/user/.aws", "/etc/shadow"];

  it("returns all defaults when no allowRead or denyRead", () => {
    const { effectiveDenyRead, effectiveAllowRead, conflicts, inconsistentAllow } = computeEffectiveDenyRead([], [], defaults);
    assert.deepEqual(effectiveDenyRead, defaults);
    assert.deepEqual(effectiveAllowRead, []);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(inconsistentAllow, []);
  });

  it("removes exact default path when covered by allowRead", () => {
    const { effectiveDenyRead, effectiveAllowRead, inconsistentAllow } = computeEffectiveDenyRead([], ["/home/user/.ssh"], defaults);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh"), false);
    assert.equal(effectiveDenyRead.includes("/home/user/.aws"), true);
    assert.equal(effectiveDenyRead.includes("/etc/shadow"), true);
    assert.deepEqual(effectiveAllowRead, ["/home/user/.ssh"]);
    assert.deepEqual(inconsistentAllow, []);
  });

  it("removes default child paths when parent is in allowRead", () => {
    const defaultsWithChild = ["/home/user/.ssh", "/home/user/.ssh/id_rsa"];
    const { effectiveDenyRead, effectiveAllowRead, inconsistentAllow } = computeEffectiveDenyRead([], ["/home/user/.ssh"], defaultsWithChild);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh"), false);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh/id_rsa"), false);
    assert.deepEqual(effectiveAllowRead, ["/home/user/.ssh"]);
    assert.deepEqual(inconsistentAllow, []);
  });

  it("merges user denyRead with filtered defaults", () => {
    const { effectiveDenyRead } = computeEffectiveDenyRead(["/home/user/.config"], [], defaults);
    assert.equal(effectiveDenyRead.includes("/home/user/.config"), true);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh"), true);
  });

  it("detects conflict when same path is in allowRead and denyRead", () => {
    const { effectiveDenyRead, effectiveAllowRead, conflicts } = computeEffectiveDenyRead(
      ["/home/user/.ssh"],
      ["/home/user/.ssh"],
      defaults,
    );
    assert.deepEqual(conflicts, ["/home/user/.ssh"]);
    assert.equal(effectiveDenyRead.includes("/home/user/.ssh"), true);
    assert.equal(effectiveAllowRead.includes("/home/user/.ssh"), false);
  });

  it("no conflict when allowRead and denyRead have different paths", () => {
    const { conflicts } = computeEffectiveDenyRead(["/home/user/.aws"], ["/home/user/.ssh"], defaults);
    assert.deepEqual(conflicts, []);
  });

  it("child-of-denyRead allowRead is caught by inconsistentAllow, not conflicts", () => {
    const { effectiveDenyRead, effectiveAllowRead, conflicts, inconsistentAllow } = computeEffectiveDenyRead(
      ["/home/user"],
      ["/home/user/.ssh"],
      [],
    );
    assert.deepEqual(conflicts, []);
    assert.deepEqual(inconsistentAllow, ["/home/user/.ssh"]);
    assert.equal(effectiveDenyRead.includes("/home/user"), true);
    assert.equal(effectiveAllowRead.includes("/home/user/.ssh"), false);
  });

  it("no conflict when allowRead is a parent of denyRead (intentional: allow broad, deny specific)", () => {
    const { effectiveAllowRead, conflicts, inconsistentAllow } = computeEffectiveDenyRead(["/home/user/.ssh"], ["/home/user"], []);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(inconsistentAllow, []);
    assert.deepEqual(effectiveAllowRead, ["/home/user"]);
  });

  it("detects and removes allowRead entry that is a child of effectiveDenyRead", () => {
    const { effectiveAllowRead, inconsistentAllow } = computeEffectiveDenyRead(
      [],
      ["/home/user/.ssh/config"],
      ["/home/user/.ssh"],
    );
    assert.deepEqual(inconsistentAllow, ["/home/user/.ssh/config"]);
    assert.deepEqual(effectiveAllowRead, []);
  });
});
