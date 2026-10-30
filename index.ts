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
  };
}

export function assertSandboxProviderAvailable(enabled: boolean, providerName: string): void {
  if (enabled && providerName === "none") {
    throw new Error("pi-sandbox: sandbox enabled but no supported OS sandbox provider is available");
  }
}

export function describeBackgroundProcesses(providerName: string, allowBackgroundProcesses: boolean | undefined): string {
  if (providerName === "bubblewrap") {
    return allowBackgroundProcesses ? "kept running (no PID namespace)" : "killed when the command exits";
  }
  if (providerName === "sandbox-exec") {
    return "kept running (allowBackgroundProcesses only applies on Linux)";
  }
  return "kept running";
}

export function describeGpu(providerName: string, allowGpu: boolean | undefined): string {
  if (providerName === "sandbox-exec") {
    return allowGpu ? "allowed (Metal)" : "blocked";
  }
  return allowGpu ? "unchanged (allowGpu only applies on macOS)" : "unchanged";
}

// pi.getSettings() was added in Pi 0.99.0; on older Pi, shellPath can't be read.
export function readShellPath(pi: Pick<ExtensionAPI, "getSettings">, warn: (message: string) => void): string | undefined {
  if (typeof pi.getSettings !== "function") {
    warn("[pi-sandbox] This Pi version has no pi.getSettings() (added in 0.99.0), so the shellPath setting is ignored and bash commands use the default shell");
    return undefined;
  }
  try {
    return pi.getSettings().shellPath;
  } catch {
    // Not available until the extension runtime is initialized.
    return undefined;
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
  // sandbox.json is read once and only re-read on /sandbox-reload, so a change to it from
  // inside the sandbox can't take effect between commands.
  let loaded: ReturnType<typeof loadConfig> | undefined;

  function reloadConfig() {
    loaded = loadConfig(workspaceDir);
    return loaded;
  }

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
    const loadedConfig = loaded ?? reloadConfig();
    const config = applyReadOnlyOverride(loadedConfig.config, runtimeReadOnlyOverride);
    const provider = selectProvider(config.provider);

    if (config.provider && config.provider !== "auto" && !provider.available()) {
      const warningKey = `${config.provider}:${workspaceDir}`;
      if (!warnedUnavailableProviders.has(warningKey)) {
        warnedUnavailableProviders.add(warningKey);
        console.warn(
          `[pi-sandbox] Forced provider "${config.provider}" is not available on this system. ` +
            `Falling back to automatic detection. Set provider to "auto" to suppress this warning.`,
        );
      }
    }

    const activeProvider = provider.available() ? provider : selectProvider("auto");
    const enabled = runtimeEnabledOverride ?? config.enabled;

    return { config, activeProvider, enabled, sources: loadedConfig.sources, warnings: loadedConfig.warnings };
  }

  function writeBlockReason(action: string, targetPath: string, config: ReturnType<typeof getState>["config"]): string {
    if (config.readOnly) {
      return `pi-sandbox: ${action} of "${targetPath}" blocked (sandbox is read-only)`;
    }
    return `pi-sandbox: ${action} of "${targetPath}" blocked (outside writable paths: ${config.writable.join(", ")})`;
  }

  // ── Bash tool override ──────────────────────────────────────────────────

  // Settings aren't available while the extension loads, so read shellPath per command.
  let warnedNoSettings = false;
  const warnOnce = (message: string) => {
    if (!warnedNoSettings) {
      warnedNoSettings = true;
      console.warn(message);
    }
  };
  const getShellPath = () => readShellPath(pi, warnOnce);
  type ExecOptions = Parameters<ReturnType<typeof createLocalBashOperations>["exec"]>[2];
  const dynamicOps = {
    exec(command: string, cwd: string, options: ExecOptions) {
      const state = getState();
      const shellPath = getShellPath();
      const localOps = createLocalBashOperations({ shellPath });
      if (!state.enabled) {
        return localOps.exec(command, cwd, options);
      }
      assertSandboxProviderAvailable(state.enabled, state.activeProvider.name);
      return state.activeProvider.wrap(localOps, workspaceDir, state.config, shellPath).exec(command, cwd, options);
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
    reloadConfig();
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
      const { config, activeProvider, enabled, sources, warnings } = getState();
      const lines = [
        `pi-sandbox v${_version}`,
        `Enabled:      ${enabled ? "yes" : "no"}`,
        `Override:     ${runtimeEnabledOverride === undefined ? "config" : runtimeEnabledOverride ? "enabled" : "disabled"}`,
        `RO Override:  ${runtimeReadOnlyOverride === undefined ? "config" : runtimeReadOnlyOverride ? "enabled" : "disabled"}`,
        `Provider:     ${activeProvider.name}${enabled && activeProvider.name === "none" ? " (unavailable)" : ""}`,
        `Config:       ${sources.length > 0 ? sources.join(", ") : "none (defaults only)"}`,
        `Read-only:    ${config.readOnly ? "yes" : "no"}`,
        `Network:      ${config.network ? "allowed" : "blocked"}`,
        `Background:   ${describeBackgroundProcesses(activeProvider.name, config.allowBackgroundProcesses)}`,
        `GPU:          ${describeGpu(activeProvider.name, config.allowGpu)}`,
        `Writable:`,
        ...(config.writable.length > 0 ? config.writable.map((p) => `  - ${p}`) : ["  - none"]),
      ];
      if (config.allowRead.length > 0) {
        lines.push("Allow-read:");
        for (const p of config.allowRead) {
          lines.push(`  - ${p}`);
        }
      }
      if (config.denyRead.length > 0) {
        lines.push("Deny-read (effective):");
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
      for (const warning of warnings) {
        ctx.ui.notify(warning, "warning");
      }
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

  pi.registerCommand("sandbox-reload", {
    description: "Re-read sandbox.json and apply it to the current Pi process",
    handler: async (_args, ctx) => {
      const { sources } = reloadConfig();
      const { activeProvider, enabled } = getState();
      const configList = sources.length > 0 ? sources.join(", ") : "defaults";
      ctx.ui.notify(
        `pi-sandbox: reloaded ${configList} (${enabled ? `enabled, ${activeProvider.name}` : "disabled"})`,
        "info",
      );
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
