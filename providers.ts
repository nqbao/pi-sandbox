import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { platform } from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxProvider, SandboxConfig, SandboxProviderType } from "./types";
import { stripTrailingSep } from "./guard";

function shellEscape(s: string): string {
  const sanitized = s.replace(/[\x00\r\n]/g, (ch) => ch === "\n" ? " " : "");
  return `'${sanitized.replace(/'/g, "'\\''")}'`;
}

function findBinary(name: string): boolean {
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const searchDirs = [...pathDirs, "/usr/bin", "/usr/sbin", "/bin", "/sbin"];
  const seen = new Set<string>();
  return searchDirs.some((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return existsSync(`${dir}/${name}`);
  });
}

// ─── macOS sandbox-exec ────────────────────────────────────────────────────

class SandboxExecProvider implements SandboxProvider {
  readonly name = "sandbox-exec";

  available(): boolean {
    return platform() === "darwin" && findBinary("sandbox-exec");
  }

  wrap(inner: BashOperations, _cwd: string, config: SandboxConfig): BashOperations {
    const profile = this.buildProfile(config);

    return {
      ...inner,
      exec(command, cwd, options) {
        const escapedCommand = shellEscape(command);
        const sandboxCmd = `sandbox-exec -p ${shellEscape(profile)} -- /bin/sh -c ${escapedCommand}`;
        return inner.exec(sandboxCmd, cwd, options);
      },
    };
  }

  private buildProfile(config: SandboxConfig): string {
    const lines = [
      "(version 1)",
      "(deny default (with message \"pi-sandbox: operation not permitted\"))",
      "; global read-only filesystem",
      "(allow file-read*)",
      "; child processes inherit this policy",
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow signal (target self))",
      "(allow signal (target children))",
      "; /dev/null writes only",
      "(allow file-write-data",
      "  (require-all",
      '    (path "/dev/null")',
      "    (vnode-type CHARACTER-DEVICE)))",
      "; device access",
      '(allow file-write* (path-prefix "/dev/tty"))',
      '(allow file-ioctl  (path-prefix "/dev/tty"))',
      '(allow file-write* (path "/dev/dtracehelper"))',
      '(allow file-write* (path "/dev/autofs_nowait"))',
    ];

    if (config.writable.length > 0) {
      lines.push("; writable paths");
      lines.push("(allow file-write*");
      for (const p of config.writable) {
        lines.push(`  (subpath "${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`);
      }
      lines.push(")");
    }

    for (const p of config.denyWithin) {
      const ep = p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(`(deny file-write* (subpath "${ep}"))`);
      lines.push(`(deny file-write-unlink (subpath "${ep}"))`);
      lines.push(`(deny file-write-create (subpath "${ep}"))`);
    }

    lines.push(
      "; mach services — missing entries cause hangs",
      "(allow mach-lookup",
      '  (global-name "com.apple.logd")',
      '  (global-name "com.apple.system.logger")',
      '  (global-name "com.apple.system.opendirectoryd.api")',
      '  (global-name "com.apple.system.opendirectoryd.membership")',
      '  (global-name "com.apple.bsd.dirhelper")',
      '  (global-name "com.apple.cfprefsd.daemon")',
      '  (global-name "com.apple.cfprefsd.agent")',
      '  (global-name "com.apple.SecurityServer"))',
      "; hardware + kernel info",
      "(allow sysctl-read)",
    );

    if (config.network) {
      lines.push(
        "; network access",
        "(allow network*)",
        "(allow system-socket)",
        "(allow mach-lookup",
        '  (global-name "com.apple.mDNSResponder")',
        '  (global-name "com.apple.mDNSResponderHelper"))',
      );
    }

    return lines.join("\n");
  }
}

// ─── Linux bubblewrap ──────────────────────────────────────────────────────

const SYSTEM_RO_BINDS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc",
  "/opt",
  "/sbin",
  "/run",
  "/var",
];

class BubblewrapProvider implements SandboxProvider {
  readonly name = "bubblewrap";

  available(): boolean {
    return platform() === "linux" && findBinary("bwrap");
  }

  wrap(inner: BashOperations, workspaceDir: string, config: SandboxConfig): BashOperations {
    return {
      ...inner,
      exec(command, cwd, options) {
        const args = buildBwrapArgs(cwd, config, workspaceDir);
        const escapedCommand = shellEscape(command);
        const bwrapCmd = `${args.join(" ")} /bin/sh -c ${escapedCommand}`;
        return inner.exec(bwrapCmd, cwd, options);
      },
    };
  }
}

function buildBwrapArgs(cwd: string, config: SandboxConfig, workspaceDir: string): string[] {
  const args: string[] = ["bwrap"];

  args.push("--unshare-all");
  args.push("--die-with-parent");
  if (config.network) {
    args.push("--share-net");
  }

  args.push("--dev", "/dev");
  args.push("--proc", "/proc");
  args.push("--tmpfs", "/tmp");

  const bindMounted = new Set<string>();

  for (const dir of SYSTEM_RO_BINDS) {
    if (existsSync(dir)) {
      args.push("--ro-bind", shellEscape(dir), shellEscape(dir));
      bindMounted.add(stripTrailingSep(dir));
    }
  }

  for (const p of config.writable) {
    if (existsSync(p)) {
      args.push("--bind", shellEscape(p), shellEscape(p));
      bindMounted.add(stripTrailingSep(p));
    }
  }

  // always mount workspace as read-only if not already covered
  const ws = stripTrailingSep(pathResolve(workspaceDir));
  if (existsSync(workspaceDir) && !isUnderBindRoot(ws, bindMounted)) {
    args.push("--ro-bind", shellEscape(workspaceDir), shellEscape(workspaceDir));
  }

  // denyWithin: ro-bind overlay on specific subpaths (order matters — later wins)
  for (const p of config.denyWithin) {
    if (existsSync(p)) {
      args.push("--ro-bind", shellEscape(p), shellEscape(p));
    }
  }

  const chdirTarget = resolveChdirTarget(cwd, config.writable, workspaceDir);
  args.push("--chdir", shellEscape(chdirTarget));
  args.push("--");
  return args;
}

function isUnderBindRoot(target: string, roots: Set<string>): boolean {
  if (roots.has(target)) return true;
  for (const r of roots) {
    if (target.startsWith(r + "/")) return true;
  }
  return false;
}

function resolveChdirTarget(cwd: string, writable: string[], workspaceDir: string): string {
  const absCwd = pathResolve(cwd);
  const roots = [...writable, ...SYSTEM_RO_BINDS, "/tmp", "/proc", "/dev", pathResolve(workspaceDir)];
  const normCwd = stripTrailingSep(absCwd);

  for (const root of roots) {
    const r = stripTrailingSep(root);
    if (normCwd === r || normCwd.startsWith(r + "/")) {
      return absCwd;
    }
  }
  console.warn(`[pi-sandbox] bwrap: cwd "${absCwd}" is not bind-mounted, using /tmp instead`);
  return "/tmp";
}

// ─── Noop fallback ─────────────────────────────────────────────────────────

class NoopProvider implements SandboxProvider {
  readonly name = "none";

  available(): boolean {
    return true;
  }

  wrap(inner: BashOperations, _cwd: string, _config: SandboxConfig): BashOperations {
    return inner;
  }
}

// ─── Provider factory ──────────────────────────────────────────────────────

export const providers: Record<Exclude<SandboxProviderType, "auto">, SandboxProvider> = {
  "sandbox-exec": new SandboxExecProvider(),
  bubblewrap: new BubblewrapProvider(),
  none: new NoopProvider(),
};

export function selectProvider(preferred?: SandboxProviderType): SandboxProvider {
  if (preferred && preferred !== "auto") {
    return providers[preferred];
  }

  for (const p of [providers["sandbox-exec"], providers["bubblewrap"]]) {
    if (p.available()) return p;
  }

  return providers["none"];
}
