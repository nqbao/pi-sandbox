import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve as pathResolve, dirname, join } from "node:path";
import { platform, tmpdir } from "node:os";
import { getShellConfig, type BashOperations } from "@earendil-works/pi-coding-agent";
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

  wrap(inner: BashOperations, _cwd: string, config: SandboxConfig, shellPath?: string): BashOperations {
    const key = JSON.stringify([config.readOnly, config.network, config.writable, config.denyRead, config.denyWithin, config.allowRead]);
    let profile = this._profileCache.get(key);
    if (!profile) {
      profile = buildSandboxExecProfile(config);
      this._profileCache.set(key, profile);
    }

    return {
      ...inner,
      exec(command, cwd, options) {
        return execSandboxed(inner, "sandbox-exec", ["-p", profile], command, cwd, options, undefined, shellPath);
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

  wrap(inner: BashOperations, workspaceDir: string, config: SandboxConfig, shellPath?: string): BashOperations {
    return {
      ...inner,
      exec(command, cwd, options) {
        const setup = buildBwrapSetup(cwd, config, workspaceDir);
        return execSandboxed(inner, "bwrap", setup.args, command, cwd, options, setup.cleanup, shellPath);
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

  for (const p of config.readOnlyMounts ?? []) {
    const np = stripTrailingSep(p);
    if (existsSync(p) && !isUnderBindRoot(np, bindMounted)) {
      args.push("--ro-bind", p, p);
      bindMounted.add(np);
    }
  }

  if (!config.readOnly) {
    protectPaths(args, config, bindMounted);
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

// bwrap can only overlay paths that exist, so a protected Pi path that doesn't exist yet
// could be created from bash. Missing directories are created empty on the host so the
// denyWithin pass can mount them read-only. For a missing file, its parent is mounted
// read-only with the parent's existing children re-bound writable, which blocks creating
// new entries there without touching the host.
//
// A read-only mount doesn't stop renaming a directory above it, though: `mv .git .git-old`
// would let bash rebuild .git/hooks from scratch. So every directory between a writable root
// and a protected path is bind-mounted onto itself first, since a mount point can't be
// renamed or removed.
function protectPaths(args: string[], config: SandboxConfig, bindMounted: Set<string>): void {
  const isMissing = (p: string) => !existsSync(p) && isUnderExistingRoot(p, config.writable);
  const lockParentOf = (config.protectedFiles ?? []).filter(isMissing);

  for (const dir of (config.protectedDirs ?? []).filter(isMissing)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // can't create it on the host; lock its parent instead
      lockParentOf.push(dir);
    }
  }

  const lockedParents: string[] = [];
  for (const path of lockParentOf) {
    const parent = dirname(path);
    if (lockedParents.includes(parent)) {
      continue;
    }
    try {
      mkdirSync(parent, { recursive: true });
    } catch {
      // parent can't be created on the host; then it can't be created in the sandbox either
      continue;
    }
    lockedParents.push(parent);
  }

  pinAncestors(args, [...config.denyWithin.filter((p) => existsSync(p)), ...lockedParents], config.writable, bindMounted);

  for (const parent of lockedParents) {
    args.push("--ro-bind", parent, parent);
    for (const child of readdirSync(parent)) {
      const childPath = join(parent, child);
      args.push("--bind", childPath, childPath);
    }
  }
}

function pinAncestors(args: string[], targets: string[], writable: string[], bindMounted: Set<string>): void {
  const pins = new Set<string>();
  for (const target of targets) {
    for (let dir = dirname(stripTrailingSep(target)); dir !== dirname(dir); dir = dirname(dir)) {
      if (!isStrictlyUnderExistingRoot(dir, writable)) {
        break;
      }
      if (!bindMounted.has(dir)) {
        pins.add(dir);
      }
    }
  }
  // Parents before children, so a later bind doesn't hide an earlier one.
  const depth = (p: string) => p.split("/").length;
  for (const dir of [...pins].sort((a, b) => depth(a) - depth(b))) {
    args.push("--bind", dir, dir);
  }
}

function isStrictlyUnderExistingRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const r = stripTrailingSep(root);
    return target.startsWith(r + "/") && existsSync(r);
  });
}

function isUnderExistingRoot(target: string, roots: string[]): boolean {
  const t = stripTrailingSep(target);
  return roots.some((root) => {
    const r = stripTrailingSep(root);
    return (t === r || t.startsWith(r + "/")) && existsSync(r);
  });
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

// Use the same shell as Pi's own bash tool (the shellPath setting, else /bin/bash, then
// bash on PATH, then sh) rather than /bin/sh, which is dash on Debian/Ubuntu and rejects bash syntax.
export function buildSandboxedArgv(sandboxArgs: string[], command: string, shellPath?: string): string[] {
  const { shell, args: shellArgs } = getShellConfig(shellPath);
  return [...sandboxArgs, "--", shell, ...shellArgs, command];
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// The shell command that replaces itself with the sandbox binary running the user's command.
export function buildSandboxedCommand(binary: string, sandboxArgs: string[], command: string, shellPath?: string): string {
  return ["exec", ...[binary, ...buildSandboxedArgv(sandboxArgs, command, shellPath)].map(shellQuote)].join(" ");
}

// Run through Pi's own exec rather than spawning directly, so the sandboxed command gets
// Pi's process handling: it returns when the process exits instead of waiting for
// background jobs to close stdio, kills the whole process tree on abort or timeout,
// and is tracked so Pi kills it on shutdown.
export async function execSandboxed(
  inner: BashOperations,
  binary: string,
  args: string[],
  command: string,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
  cleanup?: () => void,
  shellPath?: string,
): Promise<{ exitCode: number | null }> {
  try {
    return await inner.exec(buildSandboxedCommand(binary, args, command, shellPath), cwd, options);
  } finally {
    cleanup?.();
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
