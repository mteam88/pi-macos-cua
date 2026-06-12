# pi-macos-cua

> Attribution: this repository is a local copy of the original `pi-macos-cua@0.1.1` npm package (`https://npmx.dev/package-code/pi-macos-cua/v/0.1.1`). The package is published under the MIT license and is maintained on npm by `tanishqkancharla <tanishqkancharla3@gmail.com>`. Original authorship and rights remain with the original rightsholders.

Pi extension package for **local macOS computer-use** with
[`cua-driver`](https://github.com/trycua/cua/tree/main/libs/cua-driver).

This version is intentionally **local-first**:

- no CUA cloud API key
- no container name
- no remote sandbox requirement

Instead, Pi talks to the locally installed `cua-driver` CLI and lets the
driver manage backgrounded macOS automation through `CuaDriver.app`.

## How it works

`cua-driver` already exposes a practical CLI surface for local macOS use:

- `cua-driver serve`
- `cua-driver status`
- `cua-driver stop`
- `cua-driver call <tool> <json>`
- shorthand tool calls like `cua-driver list_apps`, `launch_app`, `click`, etc.

This package wraps that CLI in one Pi-native exec tool with built-in helper functions.

## Registered Pi tools

- `macos_cua_exec`

Inside `macos_cua_exec`, use the built-in helpers around the driver's own workflow:

1. launch or find an app
2. list/select a window
3. snapshot with `get_window_state`
4. act via `element_index` or pixel coordinates
5. snapshot again

## Why this backend

For Pi on macOS, `cua-driver` is the best fit because it is:

- local
- background-first
- built specifically for native macOS apps
- already usable from plain CLI commands

That means the extension does **not** need to build a full MCP client just to get started.

## Prerequisites

Install `CuaDriver.app` and the CLI:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"
```

Then grant **Accessibility** and **Screen Recording** to `CuaDriver.app` in macOS System Settings.

Inside Pi, you can also run:

```text
/install-cua-driver
```

If CuaDriver.app is missing, the macOS CUA commands/tool will tell you to run that command first.

## Install this Pi package

```bash
cd pi-macos-cua
npm install
```

Try directly:

```bash
pi -e ./extensions/index.ts
```

Or install as a Pi package:

```bash
pi install /absolute/path/to/pi-macos-cua
```

## Optional configuration

Environment variables:

```bash
export PI_MACOS_CUA_BINARY=/usr/local/bin/cua-driver
export PI_MACOS_CUA_APP=/Applications/CuaDriver.app
export PI_MACOS_CUA_AUTOSTART=1
export PI_MACOS_CUA_START_TIMEOUT_MS=10000
export PI_MACOS_CUA_AGENT_CURSOR_OVERLAY=0
```

Optional config file:

- `~/.pi/agent/macos-cua.json`
- `<project>/.pi/macos-cua.json`

```json
{
  "binaryPath": "/usr/local/bin/cua-driver",
  "appPath": "/Applications/CuaDriver.app",
  "autoStartDaemon": true,
  "startTimeoutMs": 10000,
  "agentCursorOverlay": false
}
```

The agent cursor overlay is disabled by default to avoid idle AppKit/WindowServer CPU usage. Set `agentCursorOverlay` or `PI_MACOS_CUA_AGENT_CURSOR_OVERLAY=1` if you want the visible agent cursor.

This extension relies on `cua-driver call --raw`. It accepts both MCP-style raw results (`content` / `structuredContent`) and direct JSON results from newer driver builds; successful plain-text output is treated as a successful text result.

## Commands

- `/install-cua-driver` — print the install command for `CuaDriver.app` (requires sudo, so you run it yourself)
- `/macos-cua-status` — show resolved binary/app + daemon status
- `/macos-cua-stop` — stop the background `cua-driver` daemon
- `/macos-cua-diagnose` — paste `cua-driver diagnose` output into the editor

## Usage notes

Important driver rules this extension follows:

- prefer `launchApp()` instead of `open -a`
- prefer `element_index` clicks over pixel clicks when AX elements exist
- call `getWindowState()` before element-indexed actions
- re-snapshot after UI-changing actions

`macos_cua_exec` is an escape hatch for short deterministic JavaScript sequences.
The code runs inside a persistent Node REPL as the body of an async function, so:

- use `await`
- `return` a final value explicitly if you want one shown
- use `state.foo = ...` to persist values across calls
- keep `state` plain structured-cloneable data only (objects, arrays, strings, numbers, booleans, null)

Available helpers inside `macos_cua_exec` (all async except `unwrap`, `state`, `clearState`, and `console`):

- `invoke(toolName: string, args?: Record<string, unknown>) -> PiDriverToolResult` — raw wrapper for advanced use.
- `unwrap(result: PiDriverToolResult) -> structuredContent | text | null`.
- `checkPermissions(params?: { prompt?: boolean }) -> structured permission status/text`.
- `listApps() -> { apps: AppInfo[] }`.
- `launchApp(params: { bundle_id?: string; name?: string; urls?: string[] }) -> structured launch result/text`.
- `listWindows(params?: { pid?: number; on_screen_only?: boolean }) -> { windows: WindowInfo[] }`.
- `getWindowState(params: { pid: number; window_id: number; query?: string })` -> window snapshot with `tree_markdown`; screenshot base64 is omitted by default.
- `click(params: { pid: number; window_id?: number; element_index?: number; x?: number; y?: number; action?: string; modifier?: string[]; count?: number; from_zoom?: boolean }) -> structured result/text`.
- `typeText(params: { pid: number; text: string; element_index?: number; window_id?: number }) -> structured result/text`.
- `setValue(params: { pid: number; window_id: number; element_index: number; value: string }) -> structured result/text`.
- `pressKey(params: { pid: number; key: string; modifiers?: string[]; element_index?: number; window_id?: number }) -> structured result/text`.
- `hotkey(params: { pid: number; keys: string[] }) -> structured result/text`, e.g. `await hotkey({ pid, keys: ["cmd", "shift", "a"] })`.
- `scroll(params: { pid: number; direction: "up" | "down" | "left" | "right"; amount?: number; by?: "line" | "page"; element_index?: number; window_id?: number }) -> structured result/text`.
- `sleep(ms: number) -> { ok: true; sleptMs: number }`.
- `state` — persistent structured-cloneable object.
- `clearState()`.
- `console.log(...)` — captured in the tool output.

Driver stdout/stderr are not stored verbatim in tool details. Details include bounded `stdoutPreview` / `stderrPreview` metadata instead, while parsed JSON is exposed as `structuredContent` and returned directly from the convenience helpers.

Example:

```js
const launched = await launchApp({ name: "Safari" });
const windows = await listWindows();
console.log("window count", windows.windows?.length ?? 0);
state.lastWindows = windows;
return { launched, windows: windows.windows?.slice(0, 3) };
```

Because this executes arbitrary JavaScript in the extension process, keep sequences short
and deterministic. Timeouts are best-effort for cooperative async code; avoid tight infinite loops.

## Future improvements

- add richer rendering for AX trees and screenshots
- add optional zoom / double-click wrappers
- add safer confirmation flows for destructive GUI actions
- add specialized browser-oriented helpers on top of the raw driver primitives
