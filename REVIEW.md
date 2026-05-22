# Code Review: @nqbao/pi-sandbox — current branch

---

## Issues

### 1. Staged and working-tree versions of `config.ts` and `config.test.ts` are out of sync

`MM` status on both files means staged != working tree. The working-tree versions are more complete and correct:

- **`config.ts` (working tree)**: imports `resolveRealPath` from `guard.ts`; adds `resolveReadOnly` + `readOnly` field in `loadConfig`; simplifies `mergeDenyRead` to drop the redundant `resolver.resolve()` re-call on already-resolved paths.
- **`config.ts` (staged)**: defines its own private `resolveRealPath` (no parent-dir fallback); missing `resolveReadOnly`; missing `readOnly` in `loadConfig`.
- **`config.test.ts` (working tree)**: imports `resolveRealPath` from `guard.ts`; includes `resolveReadOnly` test suite.
- **`config.test.ts` (staged)**: defines its own local `resolveRealPath`; missing `resolveReadOnly` tests.

**Fix**: `git add config.ts config.test.ts` to promote the working-tree versions, or discard the staged hunks.

### 2. Profile cache key can collide on comma-containing paths

`providers.ts` — `SandboxExecProvider._profileCache`:

```ts
const key = `${config.readOnly}|${config.network}|${config.writable.join(",")}|${config.denyRead.join(",")}|${config.denyWithin.join(",")}`;
```

A path containing `,` produces an ambiguous key. Use `\0` as separator or `JSON.stringify([...])`.

### 3. Removed SBPL `denyWithin` lines may be load-bearing on older macOS

```ts
// removed:
lines.push(`(deny file-write-unlink (subpath "${ep}"))`);
lines.push(`(deny file-write-create (subpath "${ep}"))`);
```

`file-write*` is documented to subsume these on recent macOS, but this isn't guaranteed on older policy versions. Fine to remove if there's a known minimum macOS version; otherwise worth keeping as defense-in-depth.

### 4. `createDenyReadOverlay` null-guard removal — confirm TOCTOU is acceptable

The caller guards with `existsSync(p)` before calling, and the null guard is removed. This is safe unless the path disappears between the `existsSync` check and `statSync` inside the function (TOCTOU). In a sandbox context that window is narrow, but if `statSync` does throw, `buildBwrapSetup` crashes rather than skipping gracefully. Consider a try/catch around the call site.

---

## Resolved Since Last Review

- **`/var` removal** — working-tree `providers.ts` now has a four-line comment explaining why: bind-mounting `/var` causes startup delay and memory pressure, and `/var/run`/`/var/lock` are already covered via the `/run` symlink. Good.
- **`sandbox-enable` provider check** — implemented correctly.
- **`sandbox-reset` + `syncStartupOverrides()`** — implemented correctly.

---

## Positive Changes

- **`stripTrailingSep("/")` fix** — `p.length > 1` guard correctly preserves root; the old `""` return was a latent path-comparison bug.
- **`settled` flag in `spawnSandboxedCommand`** — prevents `killChild` after promise settles on abort. Correct race fix.
- **`isPathAllowed` short-circuit** — `if (config.readOnly) return false` is the right chokepoint.
- **`resolveRealPath` in `guard.ts`** — extracted from `index.ts` with two-level fallback (parent-dir, then `resolve`). Shared via export; `index.ts` and `config.ts` (working tree) both reuse it.
- **Test coverage** — `readOnly` tested across both providers and the guard. `stripTrailingSep` root-path behavior updated. bwrap assertion improved from `args[0] !== "bwrap"` to checking `--unshare-all` presence.

---

## Minor

- **`resolveReadOnly` tests** — add a case for an invalid string (e.g., `"yes"`) to confirm the `console.warn` path fires.
- **`package.json` error handling** — only `SyntaxError` is warned; `ENOENT` and permission errors are swallowed silently. A brief comment clarifying the intent (bundled deployment) would prevent confusion in dev.

---

---

# Code Review: @nqbao/pi-sandbox v0.1.2 (round 3)

> After applying fixes for rounds 1 and 2.

---

## 🔴 High Severity

*None identified.*

---

## 🟡 Medium Severity

### 1. `/sandbox-enable` doesn't check provider availability

**File**: `index.ts`, `sandbox-enable` command handler

```ts
pi.registerCommand("sandbox-enable", {
    handler: async (_args, ctx) => {
      runtimeEnabledOverride = true;
      ctx.ui.notify("pi-sandbox enabled for this Pi process", "info");
    },
});
```

On a system with no sandbox provider (e.g., a minimal Linux without bwrap, or an unsupported OS), this command succeeds silently. The user sees "enabled" in the notification, but the next bash command will fail with:

```
Error: pi-sandbox: sandbox enabled but no supported OS sandbox provider is available
```

**Recommendation**: Check provider availability before accepting the enable:

```ts
const { activeProvider } = getState();
if (activeProvider.name === "none") {
  ctx.ui.notify("pi-sandbox: no sandbox provider available on this system", "error");
  return;
}
runtimeEnabledOverride = true;
```

---

## 🟢 Low Severity

### 2. Messy import ordering in `guard.ts` (cosmetic regression from round 2 edit)

**File**: `guard.ts`, lines 1–5

```ts
import { homedir } from "node:os";
import type { SandboxConfig } from "./types.ts";

import { realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
```

The `resolveRealPath` extraction in round 2 left imports split across blank lines instead of grouped together. Node module, type, and local imports should be contiguous blocks.

**Fix**: Collapse into a single import block:

```ts
import { realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import type { SandboxConfig } from "./types.ts";
```

### 3. Guard functions re-resolve already-resolved paths

**File**: `guard.ts`, `isPathWithinRoots`, `isPathDenied`, `isPathSearchable`

Config paths are already fully resolved via `resolveRealPath` at load time. But the guard functions call `resolve(path)` on every comparator:

```ts
const d = stripTrailingSep(resolve(denied));   // denied is already absolute+resolved
```

`resolve()` on an absolute path is cheap (just normalization), so this is harmless. But it's wasted work — `stripTrailingSep` alone would suffice since paths are already absolute and normalized.

---

## Observations (non-bugs)

- **`buildBwrapSetup` denyWithin silently skips non-existent paths**: If a denyWithin path doesn't exist on the host at setup time, the ro-bind is skipped. The SBPL (sandbox-exec) path handles this correctly with permanent deny rules regardless of existence. This is a known asymmetry between the two providers — not exploitable because the sandbox namespace is already constructed.
- **`SandboxExecProvider._profileCache` never evicts entries**: The Map grows unbounded if config changes frequently (e.g., per-session tmpdirs with different random suffixes). In practice, config rarely changes within a session, so this is fine.
- **`BubblewrapProvider.wrap()` cannot cache like `SandboxExecProvider`**: bwrap setup creates temp overlay dirs per-exec for denyRead paths, so caching is impossible without a more complex invalidation scheme. The current per-exec setup is correct.
- **Temp overlay dirs leak if Pi crashes mid-command**: `mkdtempSync` dirs under `/tmp` are cleaned by the OS on reboot. No process-level cleanup is needed.
- **Pi agent dir and `~/.pi` are writable by default**: Combined with `denyWithin` protection on the sandbox config files themselves, this provides defense-in-depth — the agent can write to its config dir but the sandbox config is write-protected via overlay even within writable parents.
