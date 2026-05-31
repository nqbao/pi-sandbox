import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve as pathResolve, join } from "node:path";
import { platform, tmpdir } from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxProvider, SandboxConfig, SandboxProviderType } from "./types.ts";
import { stripTrailingSep } from "./guard.ts";

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
  private _profileCache = new Map<string, string>();

  available(): boolean {
    return platform() === "darwin" && findBinary("sandbox-exec");
  }

  wrap(inner: BashOperations, _cwd: string, config: SandboxConfig): BashOperations {
    const key = JSON.stringify([config.readOnly, config.network, config.writable, config.denyRead, config.denyWithin, config.allowRead]);
    let profile = this._profileCache.get(key);
    if (!profile) {
      profile = buildSandboxExecProfile(config);
      this._profileCache.set(key, profile);
    }

    return {
      ...inner,
      exec(command, cwd, options) {
        return spawnSandboxedCommand("sandbox-exec", ["-p", profile], command, cwd, options);
      },
    };
  }

}

function escapeSbplPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildSandboxExecProfile(config: SandboxConfig): string {
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

  if (config.denyRead.length > 0) {
    lines.push("; denied read paths");
    for (const p of config.denyRead) {
      const ep = escapeSbplPath(p);
      lines.push(`(deny file-read* (literal "${ep}"))`);
      lines.push(`(deny file-read* (subpath "${ep}"))`);
    }
  }

  if (config.allowRead && config.allowRead.length > 0) {
    lines.push("; allowRead exceptions");
    for (const p of config.allowRead) {
      const ep = escapeSbplPath(p);
      lines.push(`(allow file-read* (literal "${ep}"))`);
      lines.push(`(allow file-read* (subpath "${ep}"))`);
    }
  }

  if (!config.readOnly && config.writable.length > 0) {
    lines.push("; writable paths");
    lines.push("(allow file-write*");
    for (const p of config.writable) {
      lines.push(`  (subpath "${escapeSbplPath(p)}")`);
    }
    lines.push(")");
  }

  for (const p of config.denyWithin) {
    const ep = escapeSbplPath(p);
    lines.push(`(deny file-write* (subpath "${ep}"))`);
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

// ─── Linux bubblewrap ──────────────────────────────────────────────────────

// Intentionally excludes /var — bind-mounting the entire tree (/var/log, /var/cache, /var/lib)
// adds seconds of startup delay and significant memory pressure on many distros.
// /var/run and /var/lock are symlinks to /run (already bound above).
// Add /var or specific subpaths to writable in sandbox.json if needed.
const SYSTEM_RO_BINDS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc",
  "/opt",
  "/sbin",
  "/run",
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
        const setup = buildBwrapSetup(cwd, config, workspaceDir);
        return spawnSandboxedCommand("bwrap", setup.args, command, cwd, options, setup.cleanup);
      },
    };
  }
}

export function buildBwrapSetup(
  cwd: string,
  config: SandboxConfig,
  workspaceDir: string,
): { args: string[]; cleanup: () => void } {
  const args: string[] = [];
  const cleanupDirs: string[] = [];

  args.push("--unshare-all");
  args.push("--die-with-parent");
  if (config.network) {
    args.push("--share-net");
  }

  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  const bindMounted = new Set<string>();

  for (const dir of SYSTEM_RO_BINDS) {
    if (existsSync(dir)) {
      args.push("--ro-bind", dir, dir);
      bindMounted.add(stripTrailingSep(dir));
    }
  }

  for (const p of config.writable) {
    if (existsSync(p)) {
      args.push(config.readOnly ? "--ro-bind" : "--bind", p, p);
      bindMounted.add(stripTrailingSep(p));
    }
  }

  if (config.readOnly) {
    const readOnlyTmp = createReadOnlyDirOverlay();
    cleanupDirs.push(readOnlyTmp.cleanupDir);
    args.push("--ro-bind", readOnlyTmp.source, "/tmp");
  } else {
    args.push("--tmpfs", "/tmp");
  }

  // always mount workspace as read-only if not already covered
  const ws = stripTrailingSep(pathResolve(workspaceDir));
  if (existsSync(workspaceDir) && !isUnderBindRoot(ws, bindMounted)) {
    args.push("--ro-bind", workspaceDir, workspaceDir);
    bindMounted.add(ws);
  }

  // denyWithin: ro-bind overlay on specific subpaths (order matters — later wins)
  for (const p of config.denyWithin) {
    if (existsSync(p)) {
      args.push("--ro-bind", p, p);
    }
  }

  // allowRead binds before denyRead overlays so narrower deny mounts shadow broader allows.
  // Skip paths already covered by a writable root — the existing --bind is sufficient for reads
  // and a later --ro-bind would silently downgrade write access.
  for (const p of (config.allowRead ?? [])) {
    if (!existsSync(p)) continue;
    const np = stripTrailingSep(p);
    const coveredByWritable = config.writable.some((w) => {
      const nw = stripTrailingSep(w);
      return np === nw || np.startsWith(nw + "/");
    });
    if (!coveredByWritable) {
      args.push("--ro-bind", p, p);
      bindMounted.add(np);
    }
  }

  for (const p of config.denyRead) {
    if (!existsSync(p)) {
      continue;
    }
    const overlay = createDenyReadOverlay(p);
    cleanupDirs.push(overlay.cleanupDir);
    args.push("--ro-bind", overlay.source, p);
  }

  const chdirTarget = resolveChdirTarget(cwd, bindMounted, workspaceDir);
  args.push("--chdir", chdirTarget);
  return {
    args,
    cleanup: () => {
      for (const dir of cleanupDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort cleanup
        }
      }
    },
  };
}

function createDenyReadOverlay(targetPath: string): { source: string; cleanupDir: string } {
  const cleanupDir = mkdtempSync(join(tmpdir(), "pi-sandbox-denyread-"));
  const stat = statSync(targetPath);

  if (stat.isDirectory()) {
    const emptyDir = join(cleanupDir, "empty-dir");
    mkdirSync(emptyDir);
    chmodSync(emptyDir, 0o000);
    return { source: emptyDir, cleanupDir };
  }

  const emptyFile = join(cleanupDir, "empty-file");
  writeFileSync(emptyFile, "");
  chmodSync(emptyFile, 0o000);
  return { source: emptyFile, cleanupDir };
}

function createReadOnlyDirOverlay(): { source: string; cleanupDir: string } {
  const cleanupDir = mkdtempSync(join(tmpdir(), "pi-sandbox-readonly-"));
  const dir = join(cleanupDir, "tmp");
  mkdirSync(dir);
  chmodSync(dir, 0o555);
  return { source: dir, cleanupDir };
}

function isUnderBindRoot(target: string, roots: Set<string>): boolean {
  if (roots.has(target)) return true;
  for (const r of roots) {
    if (target.startsWith(r + "/")) return true;
  }
  return false;
}

function resolveChdirTarget(cwd: string, bindMounted: Set<string>, workspaceDir: string): string {
  const absCwd = pathResolve(cwd);
  const roots = new Set([...bindMounted, "/tmp", "/proc", "/dev", stripTrailingSep(pathResolve(workspaceDir))]);
  const normCwd = stripTrailingSep(absCwd);

  if (roots.has(normCwd)) return absCwd;
  for (const root of roots) {
    if (normCwd.startsWith(root + "/")) {
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

function spawnSandboxedCommand(
  binary: string,
  args: string[],
  command: string,
  cwd: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
  cleanup?: () => void,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanedUp = false;
    const runCleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      cleanup?.();
    };

    const child = spawn(binary, [...args, "--", "/bin/sh", "-c", command], {
      cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const killChild = () => {
      if (!child.killed) {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
      }
    };

    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killChild();
      }, options.timeout * 1000);
    }

    const onAbort = () => {
      if (settled) return;
      killChild();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    child.on("error", (err) => {
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      runCleanup();
      reject(err);
    });
    child.on("close", (code) => {
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      runCleanup();
      if (options.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (timedOut) {
        reject(new Error(`timeout:${options.timeout}`));
        return;
      }
      resolve({ exitCode: code });
    });
  });
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
