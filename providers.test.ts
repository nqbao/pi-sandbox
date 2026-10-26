import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapSetup, buildSandboxExecProfile, buildSandboxedArgv } from "./providers.ts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
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

  it("emits allowRead rules after denyRead rules", () => {
    const config: SandboxConfig = {
      enabled: true,
      readOnly: false,
      allowRead: ["/Users/test/.ssh"],
      denyRead: ["/Users/test/.ssh"],
      writable: ["/workspace"],
      denyWithin: [],
      network: true,
    };

    const profile = buildSandboxExecProfile(config);
    const denyIndex = profile.indexOf('(deny file-read* (subpath "/Users/test/.ssh"))');
    const allowIndex = profile.indexOf('(allow file-read* (subpath "/Users/test/.ssh"))');
    assert.notEqual(denyIndex, -1);
    assert.notEqual(allowIndex, -1);
    assert.ok(allowIndex > denyIndex, "allowRead rules must appear after denyRead rules");
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
        // The overlays hide the secrets by being empty; mode 000 also makes them unreadable
        // for non-root users. Root ignores file permissions, so only emptiness applies there.
        if (process.getuid?.() === 0) {
          assert.equal(readFileSync(fileOverlaySource, "utf8"), "");
          assert.deepEqual(readdirSync(dirOverlaySource), []);
        } else {
          assert.throws(() => readFileSync(fileOverlaySource, "utf8"));
          assert.throws(() => readdirSync(dirOverlaySource));
        }
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

  it("mounts read-only paths unless a writable root already covers them", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-romount-"));
    const workspace = join(root, "ws");
    const agentDir = join(root, "agent");
    mkdirSync(workspace);
    mkdirSync(agentDir);
    try {
      const base: SandboxConfig = {
        enabled: true,
        readOnly: false,
        denyRead: [],
        writable: [workspace],
        denyWithin: [],
        readOnlyMounts: [agentDir],
        network: true,
      };
      const mounts = (config: SandboxConfig) => {
        const setup = buildBwrapSetup(workspace, config, workspace);
        setup.cleanup();
        return setup.args.flatMap((a, i) => (a.startsWith("--") && setup.args[i + 1] === agentDir && setup.args[i + 2] === agentDir ? [`${a} ${agentDir}`] : []));
      };

      assert.deepEqual(mounts(base), [`--ro-bind ${agentDir}`]);
      assert.deepEqual(mounts({ ...base, writable: [workspace, agentDir] }), [`--bind ${agentDir}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins directories between a writable root and a protected path", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-pin-"));
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const workspace = join(home, "ws");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    try {
      const config: SandboxConfig = {
        enabled: true,
        readOnly: false,
        denyRead: [],
        writable: [workspace, home],
        denyWithin: [join(workspace, ".git", "hooks"), join(agentDir, "sandbox.json")],
        protectedFiles: [join(agentDir, "sandbox.json")],
        network: true,
      };

      const setup = buildBwrapSetup(workspace, config, workspace);
      try {
        const index = (flag: string, p: string) =>
          setup.args.findIndex((_a, i) => setup.args[i] === flag && setup.args[i + 1] === p && setup.args[i + 2] === p);

        // Writable roots themselves are already mount points.
        assert.equal(setup.args.filter((a, i) => a === "--bind" && setup.args[i + 1] === home).length, 1);
        // .git can't be renamed away to rebuild .git/hooks.
        assert.ok(index("--bind", join(workspace, ".git")) > index("--bind", workspace));
        assert.ok(index("--ro-bind", join(workspace, ".git", "hooks")) > index("--bind", join(workspace, ".git")));
        // ~/.pi is pinned before the agent dir is locked for the missing sandbox.json.
        const pin = index("--bind", join(home, ".pi"));
        assert.ok(pin > index("--bind", home));
        assert.ok(index("--ro-bind", agentDir) > pin);
      } finally {
        setup.cleanup();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("protects missing Pi paths so bash cannot create them", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-protect-"));
    const workspace = join(root, "ws");
    const agentDir = join(root, "agent");
    mkdirSync(workspace);
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    try {
      const config: SandboxConfig = {
        enabled: true,
        readOnly: false,
        denyRead: [],
        writable: [workspace, agentDir],
        denyWithin: [join(workspace, ".pi"), join(agentDir, "extensions"), join(agentDir, "settings.json")],
        protectedFiles: [join(agentDir, "settings.json")],
        protectedDirs: [join(workspace, ".pi"), join(agentDir, "extensions")],
        network: true,
      };

      const setup = buildBwrapSetup(workspace, config, workspace);
      try {
        const roBound = (p: string) =>
          setup.args.findIndex((_a, i) => setup.args[i] === "--ro-bind" && setup.args[i + 1] === p && setup.args[i + 2] === p);
        const bound = (p: string) =>
          setup.args.findIndex((_a, i) => setup.args[i] === "--bind" && setup.args[i + 2] === p);

        // Missing directories are created and mounted read-only.
        assert.equal(statSync(join(workspace, ".pi")).isDirectory(), true);
        assert.notEqual(roBound(join(workspace, ".pi")), -1);
        assert.notEqual(roBound(join(agentDir, "extensions")), -1);

        // A missing file locks its parent, re-binding existing children writable afterwards.
        assert.equal(existsSync(join(agentDir, "settings.json")), false);
        const lockIndex = roBound(agentDir);
        assert.ok(lockIndex > bound(agentDir), "parent lock must come after the writable bind");
        assert.ok(bound(join(agentDir, "sessions")) > lockIndex, "existing children stay writable");
        // The created extensions dir is a child too, but its ro-bind must win.
        assert.ok(roBound(join(agentDir, "extensions")) > bound(join(agentDir, "extensions")));
      } finally {
        setup.cleanup();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create protected paths in read-only mode", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-protect-ro-"));
    try {
      const config: SandboxConfig = {
        enabled: true,
        readOnly: true,
        denyRead: [],
        writable: [root],
        denyWithin: [join(root, ".pi")],
        protectedDirs: [join(root, ".pi")],
        network: true,
      };
      const setup = buildBwrapSetup(root, config, root);
      setup.cleanup();
      assert.equal(existsSync(join(root, ".pi")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildSandboxedArgv", () => {
  it("runs the command with the same shell as Pi's bash tool, not /bin/sh", () => {
    const { shell, args } = getShellConfig();
    const argv = buildSandboxedArgv(["--ro-bind", "/usr", "/usr"], "[[ 1 == 1 ]] && echo ok");
    assert.deepEqual(argv, ["--ro-bind", "/usr", "/usr", "--", shell, ...args, "[[ 1 == 1 ]] && echo ok"]);
    if (existsSync("/bin/bash")) {
      assert.equal(shell, "/bin/bash");
    }
  });
});
