import {
  type ExtensionAPI,
  createBashTool,
  createLocalBashOperations,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { loadConfig, isPathAllowed } from "./config.ts";
import { selectProvider } from "./providers.ts";
import { isPathReadable, isPathSearchable, resolveToolPath, resolveRealPath } from "./guard.ts";

let _version = "unknown";
try {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
  _version = pkg.version ?? "unknown";
} catch (err) {
  if (err instanceof SyntaxError) {
    console.warn("[pi-sandbox] Failed to parse package.json — version reporting disabled");
  }
}

export function applyReadOnlyOverride(config: ReturnType<typeof loadConfig>["config"], readOnlyOverride: boolean | undefined) {
  if (readOnlyOverride === undefined) {
    return config;
  }
  return {
    ...config,
    readOnly: readOnlyOverride,
    writable: readOnlyOverride ? [] : config.writable,
  };
}

export function assertSandboxProviderAvailable(enabled: boolean, providerName: string): void {
  if (enabled && providerName === "none") {
    throw new Error("pi-sandbox: sandbox enabled but no supported OS sandbox provider is available");
  }
}

export function resolveStartupOverrides(
  forceSandbox: boolean,
  forceNoSandbox: boolean,
  forceReadOnly: boolean,
): {
  runtimeEnabledOverride: boolean | undefined;
  runtimeReadOnlyOverride: boolean | undefined;
  warnings: string[];
} {
  let runtimeEnabledOverride: boolean | undefined;
  let runtimeReadOnlyOverride: boolean | undefined;
  const warnings: string[] = [];

  if (forceSandbox && forceNoSandbox) {
    warnings.push("[pi-sandbox] Both --sandbox and --no-sandbox were provided; --no-sandbox wins.");
    runtimeEnabledOverride = false;
  } else if (forceSandbox) {
    runtimeEnabledOverride = true;
  } else if (forceNoSandbox) {
    runtimeEnabledOverride = false;
  }

  if (forceReadOnly && forceNoSandbox) {
    warnings.push("[pi-sandbox] --sandbox-readonly is ignored when --no-sandbox is set.");
    runtimeReadOnlyOverride = false;
  } else if (forceReadOnly) {
    runtimeReadOnlyOverride = true;
    runtimeEnabledOverride = true;
  }

  return { runtimeEnabledOverride, runtimeReadOnlyOverride, warnings };
}

export default function (pi: ExtensionAPI) {
  const workspaceDir = process.cwd();
  let runtimeEnabledOverride: boolean | undefined;
  let runtimeReadOnlyOverride: boolean | undefined;
  const warnedUnavailableProviders = new Set<string>();

  pi.registerFlag("sandbox", {
    description: "Enable pi-sandbox for this Pi process",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("no-sandbox", {
    description: "Disable pi-sandbox for this Pi process",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("sandbox-readonly", {
    description: "Force pi-sandbox into read-only mode for this Pi process",
    type: "boolean",
    default: false,
  });

  function syncStartupOverrides() {
    const resolved = resolveStartupOverrides(
      pi.getFlag("sandbox") === true,
      pi.getFlag("no-sandbox") === true,
      pi.getFlag("sandbox-readonly") === true,
    );
    runtimeEnabledOverride = resolved.runtimeEnabledOverride;
    runtimeReadOnlyOverride = resolved.runtimeReadOnlyOverride;
    for (const warning of resolved.warnings) {
      console.warn(warning);
    }
  }

  function getState() {
    const { config } = loadConfig(workspaceDir);
    const effectiveConfig = applyReadOnlyOverride(config, runtimeReadOnlyOverride);
    const provider = selectProvider(effectiveConfig.provider);

    if (effectiveConfig.provider && effectiveConfig.provider !== "auto" && !provider.available()) {
      const warningKey = `${effectiveConfig.provider}:${workspaceDir}`;
      if (!warnedUnavailableProviders.has(warningKey)) {
        warnedUnavailableProviders.add(warningKey);
        console.warn(
          `[pi-sandbox] Forced provider "${effectiveConfig.provider}" is not available on this system. ` +
            `Falling back to automatic detection. Set provider to "auto" to suppress this warning.`,
        );
      }
    }

    const activeProvider = provider.available() ? provider : selectProvider("auto");
    const enabled = runtimeEnabledOverride ?? effectiveConfig.enabled;

    return { config: effectiveConfig, activeProvider, enabled };
  }

  function writeBlockReason(action: string, targetPath: string, config: ReturnType<typeof getState>["config"]): string {
    if (config.readOnly) {
      return `pi-sandbox: ${action} of "${targetPath}" blocked (sandbox is read-only)`;
    }
    return `pi-sandbox: ${action} of "${targetPath}" blocked (outside writable paths: ${config.writable.join(", ")})`;
  }

  // ── Bash tool override ──────────────────────────────────────────────────

  const localOps = createLocalBashOperations();
  const dynamicOps = {
    exec(command: string, cwd: string, options: Parameters<typeof localOps.exec>[2]) {
      const state = getState();
      if (!state.enabled) {
        return localOps.exec(command, cwd, options);
      }
      assertSandboxProviderAvailable(state.enabled, state.activeProvider.name);
      return state.activeProvider.wrap(localOps, workspaceDir, state.config).exec(command, cwd, options);
    },
  };

  const bashTool = createBashTool(workspaceDir, {
    operations: dynamicOps,
  });
  pi.registerTool(bashTool);

  // ── Path guard for in-process file tools (write, edit) ──────────────────

  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd ?? workspaceDir;
    const { config, enabled } = getState();

    if (!enabled) {
      return;
    }

    if (isToolCallEventType("write", event)) {
      const targetPath = event.input?.path;
      if (targetPath) {
        const absolute = resolveRealPath(resolveToolPath(cwd, targetPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: writeBlockReason("write", targetPath, config),
          };
        }
      }
    }

    if (isToolCallEventType("edit", event)) {
      const targetPath = event.input?.path;
      if (targetPath) {
        const absolute = resolveRealPath(resolveToolPath(cwd, targetPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: writeBlockReason("edit", targetPath, config),
          };
        }
      }
    }

    // Future-proof guards for tools Pi doesn't ship yet.
    // When Pi adds built-in delete/move tools, these handlers activate automatically.
    if (isToolCallEventType("delete", event)) {
      const targetPath = event.input?.path ?? event.input?.filePath;
      if (targetPath) {
        const absolute = resolveRealPath(resolveToolPath(cwd, targetPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: writeBlockReason("delete", targetPath, config),
          };
        }
      }
    }

    if (isToolCallEventType("move", event)) {
      const sourcePath = event.input?.path ?? event.input?.source;
      const destPath = event.input?.destination ?? event.input?.target;
      if (sourcePath) {
        const absolute = resolveRealPath(resolveToolPath(cwd, sourcePath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: writeBlockReason("move from", sourcePath, config),
          };
        }
      }
      if (destPath) {
        const absolute = resolveRealPath(resolveToolPath(cwd, destPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: writeBlockReason("move to", destPath, config),
          };
        }
      }
    }

    if (isToolCallEventType("read", event)) {
      const targetPath = event.input?.path;
      if (targetPath) {
        const absolute = resolveRealPath(resolveToolPath(cwd, targetPath));
        if (!isPathReadable(absolute, config)) {
          return {
            block: true,
            reason: `pi-sandbox: read of "${targetPath}" blocked (matches denyRead: ${config.denyRead.join(", ")})`,
          };
        }
      }
    }

    if (isToolCallEventType("grep", event)) {
      const targetPath = event.input?.path ?? ".";
      const absolute = resolveRealPath(resolveToolPath(cwd, targetPath));
      if (!isPathSearchable(absolute, config)) {
        return {
          block: true,
          reason: `pi-sandbox: grep in "${targetPath}" blocked (matches denyRead: ${config.denyRead.join(", ")})`,
        };
      }
    }

    if (isToolCallEventType("find", event)) {
      const targetPath = event.input?.path ?? ".";
      const absolute = resolveRealPath(resolveToolPath(cwd, targetPath));
      if (!isPathSearchable(absolute, config)) {
        return {
          block: true,
          reason: `pi-sandbox: find in "${targetPath}" blocked (matches denyRead: ${config.denyRead.join(", ")})`,
        };
      }
    }

    if (isToolCallEventType("ls", event)) {
      const targetPath = event.input?.path ?? ".";
      const absolute = resolveRealPath(resolveToolPath(cwd, targetPath));
      if (!isPathReadable(absolute, config)) {
        return {
          block: true,
          reason: `pi-sandbox: ls of "${targetPath}" blocked (matches denyRead: ${config.denyRead.join(", ")})`,
        };
      }
    }
  });

  pi.on("session_start", async () => {
    syncStartupOverrides();
  });

  // ── User bash guard (user-typed !commands) ──────────────────────────────

  pi.on("user_bash", (_event, _ctx) => {
    return {
      operations: dynamicOps,
    };
  });

  // ── Command: show sandbox status ────────────────────────────────────────

  pi.registerCommand("sandbox-status", {
    description: "Show pi-sandbox status and configuration",
    handler: async (_args, ctx) => {
      const { config, activeProvider, enabled } = getState();
      const lines = [
        `pi-sandbox v${_version}`,
        `Enabled:      ${enabled ? "yes" : "no"}`,
        `Override:     ${runtimeEnabledOverride === undefined ? "config" : runtimeEnabledOverride ? "enabled" : "disabled"}`,
        `RO Override:  ${runtimeReadOnlyOverride === undefined ? "config" : runtimeReadOnlyOverride ? "enabled" : "disabled"}`,
        `Provider:     ${activeProvider.name}${enabled && activeProvider.name === "none" ? " (unavailable)" : ""}`,
        `Read-only:    ${config.readOnly ? "yes" : "no"}`,
        `Network:      ${config.network ? "allowed" : "blocked"}`,
        `Writable:`,
        ...(config.writable.length > 0 ? config.writable.map((p) => `  - ${p}`) : ["  - none"]),
      ];
      if (config.denyRead.length > 0) {
        lines.push("Deny-read:");
        for (const p of config.denyRead) {
          lines.push(`  - ${p}`);
        }
      }
      if (config.denyWithin.length > 0) {
        lines.push("Deny-within:");
        for (const p of config.denyWithin) {
          lines.push(`  - ${p}`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable pi-sandbox for the current Pi process",
    handler: async (_args, ctx) => {
      const { activeProvider } = getState();
      if (activeProvider.name === "none") {
        ctx.ui.notify("pi-sandbox: no sandbox provider available on this system", "error");
        return;
      }
      runtimeEnabledOverride = true;
      ctx.ui.notify("pi-sandbox enabled for this Pi process", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable pi-sandbox for the current Pi process",
    handler: async (_args, ctx) => {
      runtimeEnabledOverride = false;
      ctx.ui.notify("pi-sandbox disabled for this Pi process", "warning");
    },
  });

  pi.registerCommand("sandbox-reset", {
    description: "Reset pi-sandbox runtime override and return to config-driven mode",
    handler: async (_args, ctx) => {
      runtimeEnabledOverride = undefined;
      runtimeReadOnlyOverride = undefined;
      syncStartupOverrides();
      ctx.ui.notify("pi-sandbox overrides cleared; using config again", "info");
    },
  });
}
