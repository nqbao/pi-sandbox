# @nqbao/pi-sandbox

OS-level sandbox extension for Pi.

This package overrides Pi's bash tool and applies an OS sandbox:
- macOS: `sandbox-exec`
- Linux: `bubblewrap`

It also blocks in-process file mutations outside configured writable paths.

## Install

Install from npm through Pi:

```bash
pi install npm:@nqbao/pi-sandbox
```

Or load it locally during development:

```bash
pi -e ./index.ts
```

## What It Does

`pi-sandbox` adds two layers of protection:

- It overrides Pi's `bash` tool and runs shell commands inside an OS sandbox.
- It intercepts file mutation tools such as `write`, `edit`, `delete`, and `move`, and blocks paths outside the configured writable roots.

Behavior depends on the platform:

- macOS: uses `sandbox-exec`
- Linux: uses `bubblewrap`
- if no supported provider is available: Pi falls back to normal unsandboxed execution and prints a warning

## Configuration

The extension reads `sandbox.json` from:

- `$(pi agent dir)/sandbox.json`
- `~/.pi/agent/sandbox.json`

Supported fields:

- `writable`: directories Pi is allowed to modify
- `denyWithin`: subpaths that stay blocked even if they are inside a writable directory
- `network`: whether outbound network access is allowed
- `provider`: `auto`, `sandbox-exec`, `bubblewrap`, or `none`

Example:

```json
{
  "writable": ["${WORKSPACE}", "${TMP}"],
  "denyWithin": ["${WORKSPACE}/.git/hooks"],
  "network": true,
  "provider": "auto"
}
```

Available path variables:

- `${WORKSPACE}`: the current project directory
- `${HOME}`: your home directory
- `${TMP}` and `${TMPDIR}`: the system temporary directory

By default, the extension allows writes to:

- `${WORKSPACE}`
- `${TMP}`

And blocks:

- `${WORKSPACE}/.git/hooks`

## Status Command

The extension registers a Pi command:

```text
/sandbox-status
```

It shows the active provider, network mode, writable paths, and deny rules.

## Package

This is a Pi package and exposes its extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
