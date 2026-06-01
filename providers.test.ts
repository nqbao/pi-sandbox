import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapSetup, buildSandboxExecProfile } from "./providers.ts";
import type { SandboxConfig } from "./types.ts";

describe("buildSandboxExecProfile", () => {
  it("adds denyRead rules to the sandbox-exec profile", () => {
    const config: SandboxConfig = {
      enabled: true,
      readOnly: false,
      denyRead: ["/etc/passwd", "/Users/test/.ssh"],
      writable: ["/workspace"],
      denyWithin: ["/workspace/.git/hooks"],
      network: true,
    };

    const profile = buildSandboxExecProfile(config);

    assert.match(profile, /\(deny file-read\* \(literal "\/etc\/passwd"\)\)/);
    assert.match(profile, /\(deny file-read\* \(subpath "\/etc\/passwd"\)\)/);
    assert.match(profile, /\(deny file-read\* \(literal "\/Users\/test\/\.ssh"\)\)/);
  });

  it("emits allowRead rules before denyRead rules so narrower denies win", () => {
    const config: SandboxConfig = {
      enabled: true,
      readOnly: false,
      allowRead: ["/Users/test"],
      denyRead: ["/Users/test/.ssh"],
      writable: ["/workspace"],
      denyWithin: [],
      network: true,
    };

    const profile = buildSandboxExecProfile(config);
    const allowIndex = profile.indexOf('(allow file-read* (subpath "/Users/test"))');
    const denyIndex = profile.indexOf('(deny file-read* (subpath "/Users/test/.ssh"))');
    assert.notEqual(allowIndex, -1);
    assert.notEqual(denyIndex, -1);
    assert.ok(allowIndex < denyIndex, "allowRead rules must appear before denyRead rules so deny wins");
  });

  it("does not emit writable paths when readOnly is true", () => {
    const config: SandboxConfig = {
      enabled: true,
      readOnly: true,
      denyRead: [],
      writable: ["/workspace", "/tmp"],
      denyWithin: [],
      network: true,
    };

    const profile = buildSandboxExecProfile(config);

    // The writable-paths (allow file-write*) block must not appear.
    // Device-access (allow file-write*) lines for /dev/* are still present.
    assert.doesNotMatch(profile, /; writable paths/);
    assert.doesNotMatch(profile, /\(subpath "\/workspace"\)/);
    assert.doesNotMatch(profile, /\(subpath "\/tmp"\)/);
  });
});

describe("buildBwrapSetup", () => {
  it("overlays denyRead files and directories after normal binds", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-workspace-"));
    const secretDir = mkdtempSync(join(tmpdir(), "pi-sandbox-secret-dir-"));
    try {
      const secretFile = join(workspace, "secret.txt");
      writeFileSync(secretFile, "secret");
      mkdirSync(join(secretDir, "nested"));

      const config: SandboxConfig = {
        enabled: true,
        readOnly: false,
        denyRead: [secretFile, secretDir],
        writable: [workspace],
        denyWithin: [],
        network: true,
      };

      const setup = buildBwrapSetup(workspace, config, workspace);
      try {
        assert.ok(setup.args.length > 0, "expected non-empty args");
        assert.ok(setup.args.includes("--unshare-all"), "expected --unshare-all flag");
        const fileOverlayIndex = setup.args.findIndex(
          (_arg, index) =>
            setup.args[index] === "--ro-bind" &&
            setup.args[index + 2] === secretFile,
        );
        const dirOverlayIndex = setup.args.findIndex(
          (_arg, index) =>
            setup.args[index] === "--ro-bind" &&
            setup.args[index + 2] === secretDir,
        );

        assert.notEqual(fileOverlayIndex, -1);
        assert.notEqual(dirOverlayIndex, -1);
        const fileOverlaySource = setup.args[fileOverlayIndex + 1];
        const dirOverlaySource = setup.args[dirOverlayIndex + 1];
        assert.equal(statSync(fileOverlaySource).mode & 0o777, 0);
        assert.equal(statSync(dirOverlaySource).mode & 0o777, 0);
        assert.throws(() => readFileSync(fileOverlaySource, "utf8"));
        assert.throws(() => readdirSync(dirOverlaySource));
        assert.equal(setup.args.includes("--chdir"), true);
        assert.equal(setup.args.includes("--"), false);
      } finally {
        setup.cleanup();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it("does not emit --ro-bind for allowRead paths already covered by a writable root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-workspace-"));
    try {
      const config: SandboxConfig = {
        enabled: true,
        readOnly: false,
        allowRead: [workspace],
        denyRead: [],
        writable: [workspace],
        denyWithin: [],
        network: true,
      };

      const setup = buildBwrapSetup(workspace, config, workspace);
      try {
        const roBindIndex = setup.args.findIndex(
          (_arg, index) => setup.args[index] === "--ro-bind" && setup.args[index + 2] === workspace,
        );
        const bindIndex = setup.args.findIndex(
          (_arg, index) => setup.args[index] === "--bind" && setup.args[index + 2] === workspace,
        );
        assert.notEqual(bindIndex, -1, "expected --bind for writable path");
        assert.equal(roBindIndex, -1, "expected no --ro-bind for allowRead path covered by writable");
      } finally {
        setup.cleanup();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("resolves --chdir correctly when cwd is inside an allowRead directory", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-workspace-"));
    const roDir = mkdtempSync(join(tmpdir(), "pi-sandbox-ro-"));
    const subDir = join(roDir, "sub");
    mkdirSync(subDir);
    try {
      const config: SandboxConfig = {
        enabled: true,
        readOnly: false,
        allowRead: [roDir],
        denyRead: [],
        writable: [workspace],
        denyWithin: [],
        network: true,
      };

      const setup = buildBwrapSetup(subDir, config, workspace);
      try {
        const chdirIndex = setup.args.indexOf("--chdir");
        assert.notEqual(chdirIndex, -1);
        assert.equal(setup.args[chdirIndex + 1], subDir);
      } finally {
        setup.cleanup();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(roDir, { recursive: true, force: true });
    }
  });

  it("bind-mounts allowRead paths before denyRead overlays so deny shadows allow", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-workspace-"));
    const parentDir = mkdtempSync(join(tmpdir(), "pi-sandbox-parent-"));
    const childDir = join(parentDir, "child");
    mkdirSync(childDir);
    try {
      const config: SandboxConfig = {
        enabled: true,
        readOnly: false,
        allowRead: [parentDir],
        denyRead: [childDir],
        writable: [workspace],
        denyWithin: [],
        network: true,
      };

      const setup = buildBwrapSetup(workspace, config, workspace);
      try {
        const allowBindIndex = setup.args.findIndex(
          (_arg, index) => setup.args[index] === "--ro-bind" && setup.args[index + 2] === parentDir,
        );
        const denyOverlayIndex = setup.args.findIndex(
          (_arg, index) => setup.args[index] === "--ro-bind" && setup.args[index + 2] === childDir,
        );
        assert.notEqual(allowBindIndex, -1, "expected allowRead bind for parent");
        assert.notEqual(denyOverlayIndex, -1, "expected denyRead overlay for child");
        assert.ok(allowBindIndex < denyOverlayIndex, "allowRead bind must appear before denyRead overlay so deny shadows allow");
        const denyOverlaySource = setup.args[denyOverlayIndex + 1];
        assert.equal(statSync(denyOverlaySource).mode & 0o777, 0);
      } finally {
        setup.cleanup();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it("mounts /tmp read-only in read-only mode", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-workspace-"));
    try {
      const config: SandboxConfig = {
        enabled: true,
        readOnly: true,
        denyRead: [],
        writable: [],
        denyWithin: [],
        network: true,
      };

      const setup = buildBwrapSetup(workspace, config, workspace);
      try {
        const tmpOverlayIndex = setup.args.findIndex(
          (_arg, index) => setup.args[index] === "--ro-bind" && setup.args[index + 2] === "/tmp",
        );

        assert.notEqual(tmpOverlayIndex, -1);
        const tmpOverlaySource = setup.args[tmpOverlayIndex + 1];
        assert.equal(statSync(tmpOverlaySource).mode & 0o777, 0o555);
      } finally {
        setup.cleanup();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("mounts writable paths as --ro-bind when readOnly is true", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-workspace-"));
    const writableDir = mkdtempSync(join(tmpdir(), "pi-sandbox-writable-"));
    try {
      const config: SandboxConfig = {
        enabled: true,
        readOnly: true,
        denyRead: [],
        writable: [writableDir, workspace],
        denyWithin: [],
        network: true,
      };

      const setup = buildBwrapSetup(workspace, config, workspace);
      try {
        // Should NOT have --bind for writable paths
        for (const p of [writableDir, workspace]) {
          const bindIndex = setup.args.findIndex(
            (_arg, index) => setup.args[index] === "--bind" && setup.args[index + 2] === p,
          );
          assert.equal(bindIndex, -1, `expected no --bind for ${p}`);
        }
        // Should have --ro-bind for writable paths
        for (const p of [writableDir, workspace]) {
          const roBindIndex = setup.args.findIndex(
            (_arg, index) => setup.args[index] === "--ro-bind" && setup.args[index + 2] === p,
          );
          assert.notEqual(roBindIndex, -1, `expected --ro-bind for ${p}`);
        }
      } finally {
        setup.cleanup();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(writableDir, { recursive: true, force: true });
    }
  });
});
