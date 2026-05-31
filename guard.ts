import { realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import type { SandboxConfig } from "./types.ts";

export function resolveRealPath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    try {
      const parent = realpathSync(dirname(targetPath));
      return join(parent, basename(targetPath));
    } catch {
      return resolve(targetPath);
    }
  }
}

export function stripTrailingSep(p: string): string {
  while (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
}

export function expandHomePath(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

export function resolveToolPath(cwd: string, targetPath: string): string {
  return resolve(cwd, expandHomePath(targetPath));
}

function isPathWithinRoots(absolutePath: string, allowedRoots: string[], deniedRoots: string[]): boolean {
  const normPath = stripTrailingSep(resolve(absolutePath));
  for (const denied of deniedRoots) {
    const d = stripTrailingSep(resolve(denied));
    if (normPath === d || normPath.startsWith(d + "/")) {
      return false;
    }
  }
  for (const allowed of allowedRoots) {
    const a = stripTrailingSep(resolve(allowed));
    if (normPath === a || normPath.startsWith(a + "/")) {
      return true;
    }
  }
  return false;
}

export function isPathDenied(absolutePath: string, deniedRoots: string[]): boolean {
  const normPath = stripTrailingSep(resolve(absolutePath));
  for (const denied of deniedRoots) {
    const d = stripTrailingSep(resolve(denied));
    if (normPath === d || normPath.startsWith(d + "/")) {
      return true;
    }
  }
  return false;
}

function longestMatchingPrefix(absolutePath: string, roots: string[]): number {
  const normPath = stripTrailingSep(resolve(absolutePath));
  let best = -1;
  for (const root of roots) {
    const nr = stripTrailingSep(resolve(root));
    if ((normPath === nr || normPath.startsWith(nr + "/")) && nr.length > best) {
      best = nr.length;
    }
  }
  return best;
}

export function isPathReadable(absolutePath: string, config: SandboxConfig): boolean {
  const allowLen = longestMatchingPrefix(absolutePath, config.allowRead ?? []);
  const denyLen = longestMatchingPrefix(absolutePath, config.denyRead);
  if (allowLen >= 0 && denyLen >= 0) return allowLen > denyLen;
  if (allowLen >= 0) return true;
  if (denyLen >= 0) return false;
  return true;
}

export function isPathSearchable(absolutePath: string, config: SandboxConfig): boolean {
  const normPath = stripTrailingSep(resolve(absolutePath));
  const allowRead = config.allowRead ?? [];

  const allowLen = longestMatchingPrefix(absolutePath, allowRead);
  const denyLen = longestMatchingPrefix(absolutePath, config.denyRead);

  // If the path itself is denied and allow doesn't win, block immediately.
  if (denyLen >= 0 && (allowLen < 0 || denyLen >= allowLen)) return false;

  // Even when the path itself is allowed, block if it would traverse a denied
  // descendant that isn't covered by a more-specific allowRead.
  for (const denied of config.denyRead) {
    const d = stripTrailingSep(resolve(denied));
    if (d.startsWith(normPath + "/")) {
      const dAllowLen = longestMatchingPrefix(d, allowRead);
      const dDenyLen = longestMatchingPrefix(d, config.denyRead);
      const effectivelyAllowed = dAllowLen >= 0 && (dDenyLen < 0 || dAllowLen > dDenyLen);
      if (!effectivelyAllowed) return false;
    }
  }

  return true;
}

export function isPathAllowed(absolutePath: string, config: SandboxConfig): boolean {
  if (config.readOnly) return false;
  return isPathWithinRoots(absolutePath, config.writable, config.denyWithin);
}
