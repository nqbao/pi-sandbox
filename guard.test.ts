import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
  expandHomePath,
  isPathAllowed,
  isPathDenied,
  isPathReadable,
  isPathSearchable,
  resolveToolPath,
  stripTrailingSep,
} from "./guard.ts";
import type { SandboxConfig } from "./types.ts";

describe("stripTrailingSep", () => {
  it("removes a single trailing slash", () => {
    assert.equal(stripTrailingSep("/foo/bar/"), "/foo/bar");
  });

  it("removes multiple trailing slashes", () => {
    assert.equal(stripTrailingSep("/foo/bar///"), "/foo/bar");
  });

  it("leaves paths without trailing slash unchanged", () => {
    assert.equal(stripTrailingSep("/foo/bar"), "/foo/bar");
  });

  it("preserves root path as single slash", () => {
    assert.equal(stripTrailingSep("/"), "/");
  });

  it("normalizes multiple root slashes to single slash", () => {
    assert.equal(stripTrailingSep("///"), "/");
  });

  it("handles empty string", () => {
    assert.equal(stripTrailingSep(""), "");
  });
});

describe("expandHomePath", () => {
  it("expands bare tilde to the home directory", () => {
    assert.equal(expandHomePath("~"), homedir());
  });

  it("expands home-relative paths", () => {
    assert.equal(expandHomePath("~/file.txt"), `${homedir()}/file.txt`);
  });

  it("leaves non-home paths unchanged", () => {
    assert.equal(expandHomePath("src/file.txt"), "src/file.txt");
  });
});

describe("resolveToolPath", () => {
  it("resolves tilde paths against the home directory", () => {
    assert.equal(resolveToolPath("/workspace", "~/file.txt"), `${homedir()}/file.txt`);
  });

  it("resolves relative paths against cwd", () => {
    assert.equal(resolveToolPath("/workspace", "src/file.txt"), "/workspace/src/file.txt");
  });
});

describe("isPathAllowed", () => {
  const config: SandboxConfig = {
    enabled: true,
    readOnly: false,
    denyRead: [],
    writable: ["/workspace", "/tmp"],
    denyWithin: ["/workspace/.git/hooks"],
    network: true,
  };

  it("allows writes within writable directories", () => {
    assert.equal(isPathAllowed("/workspace/src/file.ts", config), true);
    assert.equal(isPathAllowed("/workspace/package.json", config), true);
    assert.equal(isPathAllowed("/tmp/build/output", config), true);
  });

  it("allows the writable directory path itself", () => {
    assert.equal(isPathAllowed("/workspace", config), true);
    assert.equal(isPathAllowed("/tmp", config), true);
  });

  it("blocks writes outside writable directories", () => {
    assert.equal(isPathAllowed("/etc/hosts", config), false);
    assert.equal(isPathAllowed("/home/user/file", config), false);
  });

  it("blocks writes within denyWithin paths", () => {
    assert.equal(isPathAllowed("/workspace/.git/hooks", config), false);
  });

  it("blocks denyWithin children via startsWith", () => {
    assert.equal(isPathAllowed("/workspace/.git/hooks/pre-commit", config), false);
    assert.equal(isPathAllowed("/workspace/.git/hooks/post-checkout", config), false);
  });

  it("denyWithin takes precedence over writable", () => {
    assert.equal(isPathAllowed("/workspace/.git/hooks", config), false);
  });

  it("handles trailing slashes in config paths", () => {
    const configWithSlashes: SandboxConfig = {
      enabled: true,
      readOnly: false,
      denyRead: [],
      writable: ["/workspace/", "/tmp/"],
      denyWithin: ["/workspace/.git/hooks/"],
      network: true,
    };
    assert.equal(isPathAllowed("/workspace/src/file.ts", configWithSlashes), true);
    assert.equal(isPathAllowed("/workspace/.git/hooks/pre-commit", configWithSlashes), false);
    assert.equal(isPathAllowed("/tmp/build", configWithSlashes), true);
  });

  it("handles trailing slashes in the checked path", () => {
    assert.equal(isPathAllowed("/workspace/src/", config), true);
    assert.equal(isPathAllowed("/tmp/", config), true);
  });

  it("does not allow sibling paths that look like prefixes", () => {
    const c: SandboxConfig = {
      enabled: true,
      readOnly: false,
      denyRead: [],
      writable: ["/workspace"],
      denyWithin: [],
      network: true,
    };
    assert.equal(isPathAllowed("/workspace", c), true);
    assert.equal(isPathAllowed("/workspace-other", c), false);
  });

  it("resolves .. traversal before checking", () => {
    assert.equal(isPathAllowed("/workspace/../etc/hosts", config), false);
    assert.equal(isPathAllowed("/workspace/sub/../file.ts", config), true);
  });

  it("normalizes .. in config writable paths", () => {
    const c: SandboxConfig = {
      enabled: true,
      readOnly: false,
      denyRead: [],
      writable: ["/workspace/../shared"],
      denyWithin: [],
      network: true,
    };
    assert.equal(isPathAllowed("/shared/file.ts", c), true);
    assert.equal(isPathAllowed("/workspace/file.ts", c), false);
  });

  it("normalizes internal double slashes in config paths", () => {
    const c: SandboxConfig = {
      enabled: true,
      readOnly: false,
      denyRead: [],
      writable: ["/workspace//src"],
      denyWithin: ["/workspace//src/.git"],
      network: true,
    };
    assert.equal(isPathAllowed("/workspace/src/file.ts", c), true);
    assert.equal(isPathAllowed("/workspace/src/.git/config", c), false);
  });

  it("denies everything when writable is empty", () => {
    const c: SandboxConfig = { enabled: true, readOnly: false, denyRead: [], writable: [], denyWithin: [], network: true };
    assert.equal(isPathAllowed("/anything", c), false);
  });

  it("does not deny when denyWithin is empty", () => {
    const c: SandboxConfig = {
      enabled: true,
      readOnly: false,
      denyRead: [],
      writable: ["/workspace"],
      denyWithin: [],
      network: true,
    };
    assert.equal(isPathAllowed("/workspace/src", c), true);
  });

  it("applies denyRead separately from write policy", () => {
    const c: SandboxConfig = {
      enabled: true,
      readOnly: false,
      denyRead: ["/workspace/secrets", "/tmp/private.log"],
      writable: ["/workspace"],
      denyWithin: ["/workspace/.git/hooks"],
      network: true,
    };
    assert.equal(isPathReadable("/tmp/log.txt", c), true);
    assert.equal(isPathAllowed("/tmp/log.txt", c), false);
    assert.equal(isPathReadable("/workspace/secrets/api-key.txt", c), false);
    assert.equal(isPathDenied("/tmp/private.log", c.denyRead), true);
  });

  it("blocks grep/find roots that contain denied descendants", () => {
    const c: SandboxConfig = {
      enabled: true,
      readOnly: false,
      denyRead: [`${homedir()}/.ssh`, "/etc/passwd"],
      writable: ["/workspace"],
      denyWithin: [],
      network: true,
    };
    assert.equal(isPathSearchable(homedir(), c), false);
    assert.equal(isPathSearchable("/etc", c), false);
    assert.equal(isPathSearchable("/workspace", c), true);
  });

  it("blocks writes everywhere in read-only mode", () => {
    const c: SandboxConfig = {
      enabled: true,
      readOnly: true,
      denyRead: [],
      writable: [],
      denyWithin: [],
      network: true,
    };
    assert.equal(isPathAllowed("/workspace/file.ts", c), false);
    assert.equal(isPathAllowed("/tmp/output", c), false);
  });

  it("readOnly overrides writable roots (config-level readOnly)", () => {
    const c: SandboxConfig = {
      enabled: true,
      readOnly: true,
      denyRead: [],
      writable: ["/workspace", "/tmp"],
      denyWithin: [],
      network: true,
    };
    assert.equal(isPathAllowed("/workspace/file.ts", c), false);
    assert.equal(isPathAllowed("/tmp/output", c), false);
  });
});
