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

export function isPathReadable(absolutePath: string, config: SandboxConfig): boolean {
  return !isPathDenied(absolutePath, config.denyRead);
}

export function isPathSearchable(absolutePath: string, config: SandboxConfig): boolean {
  const normPath = stripTrailingSep(resolve(absolutePath));

  for (const denied of config.denyRead) {
    const d = stripTrailingSep(resolve(denied));
    if (normPath === d || normPath.startsWith(d + "/")) {
      return false;
    }
    if (d.startsWith(normPath + "/")) {
      return false;
    }
  }

  return true;
}

export function isPathAllowed(absolutePath: string, config: SandboxConfig): boolean {
  if (config.readOnly) return false;
  return isPathWithinRoots(absolutePath, config.writable, config.denyWithin);
}
