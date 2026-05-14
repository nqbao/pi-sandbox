import {
  type ExtensionAPI,
  createBashTool,
  createLocalBashOperations,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { resolve, dirname, basename, join } from "node:path";
import { realpathSync, readFileSync } from "node:fs";
import { loadConfig, isPathAllowed } from "./config.ts";
import { selectProvider } from "./providers.ts";
import { resolveToolPath } from "./guard.ts";

let _version = "unknown";
try {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
  _version = pkg.version ?? "unknown";
} catch {
  // package.json not accessible (e.g., bundled deployment)
}

export default function (pi: ExtensionAPI) {
  const workspaceDir = process.cwd();
  let runtimeEnabledOverride: boolean | undefined;

  function getState() {
    const { config } = loadConfig(workspaceDir);
    const provider = selectProvider(config.provider);

    if (config.provider && config.provider !== "auto" && !provider.available()) {
      console.warn(
        `[pi-sandbox] Forced provider "${config.provider}" is not available on this system. ` +
          `Falling back to automatic detection. Set provider to "auto" to suppress this warning.`,
      );
    }

    const activeProvider = provider.available() ? provider : selectProvider("auto");
    const enabled = runtimeEnabledOverride ?? config.enabled;

    return { config, activeProvider, enabled };
  }

  // ── Bash tool override ──────────────────────────────────────────────────

  const localOps = createLocalBashOperations();
  const dynamicOps = {
    exec(command: string, cwd: string, options: Parameters<typeof localOps.exec>[2]) {
      const state = getState();
      if (!state.enabled) {
        return localOps.exec(command, cwd, options);
      }
      return state.activeProvider.wrap(localOps, workspaceDir, state.config).exec(command, cwd, options);
    },
  };

  const bashTool = createBashTool(workspaceDir, {
    operations: dynamicOps,
  });
  pi.registerTool(bashTool);

  // ── Path guard for in-process file tools (write, edit) ──────────────────

  function resolveRealPath(targetPath: string): string {
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
            reason: `pi-sandbox: write to "${targetPath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
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
            reason: `pi-sandbox: edit of "${targetPath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
          };
        }
      }
    }

    if (isToolCallEventType("delete", event)) {
      const targetPath = event.input?.path ?? event.input?.filePath;
      if (targetPath) {
        const absolute = resolveRealPath(resolveToolPath(cwd, targetPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: `pi-sandbox: delete of "${targetPath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
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
            reason: `pi-sandbox: move from "${sourcePath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
          };
        }
      }
      if (destPath) {
        const absolute = resolveRealPath(resolveToolPath(cwd, destPath));
        if (!isPathAllowed(absolute, config)) {
          return {
            block: true,
            reason: `pi-sandbox: move to "${destPath}" blocked (outside writable paths: ${config.writable.join(", ")})`,
          };
        }
      }
    }
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
        `Provider:     ${activeProvider.name}`,
        `Network:      ${config.network ? "allowed" : "blocked"}`,
        `Writable:`,
        ...config.writable.map((p) => `  - ${p}`),
      ];
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
      ctx.ui.notify("pi-sandbox override cleared; using config again", "info");
    },
  });
}
