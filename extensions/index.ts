import type { ExtensionAPI, ExtensionContext, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { inspect } from "node:util";

import { loadMacosCuaConfig, summarizeMacosCuaConfig } from "../src/config.js";
import { ExecReplError, PersistentExecRepl } from "../src/exec-repl.js";
import { MacosCuaDriver, type InvokeOptions, type PiDriverToolResult } from "../src/driver.js";

const SEQUENTIAL: ToolExecutionMode = "sequential";
const GET_WINDOW_STATE_OMIT_FIELDS = ["tree_markdown", "screenshot_png_b64", "screenshot_mime_type"];

let piRef: ExtensionAPI;
let macosCua: MacosCuaDriver;
let macosCuaExec = new PersistentExecRepl();

type ExecTraceEntry = {
  helper: string;
  args: Record<string, unknown>;
  result: PiDriverToolResult;
};

function assertLaunchTarget(params: { bundle_id?: string; name?: string }): void {
  if (!params.bundle_id && !params.name) {
    throw new Error("macos_cua_launch_app requires either bundle_id or name.");
  }
}

function assertElementWindowPair(params: { element_index?: number; window_id?: number }, toolName: string): void {
  if (params.element_index !== undefined && params.window_id === undefined) {
    throw new Error(`${toolName} requires window_id whenever element_index is provided.`);
  }
}

function assertClickTarget(params: {
  element_index?: number;
  window_id?: number;
  x?: number;
  y?: number;
}): void {
  const hasElement = params.element_index !== undefined;
  const hasX = params.x !== undefined;
  const hasY = params.y !== undefined;

  if (hasElement) {
    if (params.window_id === undefined) {
      throw new Error("macos_cua_click requires window_id when element_index is used.");
    }
    if (hasX || hasY) {
      throw new Error("macos_cua_click must use either element_index+window_id OR x+y, not both.");
    }
    return;
  }

  if (hasX !== hasY) {
    throw new Error("macos_cua_click requires both x and y together.");
  }
  if (!hasX || !hasY) {
    throw new Error("macos_cua_click requires either element_index+window_id or x+y coordinates.");
  }
}

async function callDriverTool(
  ctx: ExtensionContext,
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  options: InvokeOptions = {},
): Promise<PiDriverToolResult> {
  const config = await loadMacosCuaConfig(ctx.cwd);
  await macosCua.assertInstalled(config);
  const result = await macosCua.invokeTool(config, toolName, params, options, signal);
  await setStatus(ctx);
  return result;
}

async function requireCuaDriverInstalled(ctx: ExtensionContext): Promise<void> {
  const config = await loadMacosCuaConfig(ctx.cwd);
  await macosCua.assertInstalled(config);
}

function createExecHelpers(ctx: ExtensionContext, signal: AbortSignal | undefined, trace: ExecTraceEntry[]) {
  const record = async (
    helper: string,
    toolName: string,
    args: Record<string, unknown>,
    options: InvokeOptions = {},
  ): Promise<PiDriverToolResult> => {
    assertExecStillActive(signal);
    const argsSnapshot = cloneForTrace(args);
    const result = await callDriverTool(ctx, toolName, args, signal, options);
    trace.push({ helper, args: argsSnapshot, result });
    assertExecStillActive(signal);
    return result;
  };

  return {
    invoke: async (toolName: string, args: Record<string, unknown> = {}) => record(`invoke:${toolName}`, toolName, args),
    checkPermissions: async (params: { prompt?: boolean } = {}) =>
      record("checkPermissions", "check_permissions", { prompt: params.prompt ?? false }, { ensureDaemon: false }),
    listApps: async () => record("listApps", "list_apps", {}, { ensureDaemon: false }),
    launchApp: async (params: { bundle_id?: string; name?: string; urls?: string[] }) => {
      assertLaunchTarget(params);
      return record("launchApp", "launch_app", params, { ensureDaemon: true });
    },
    listWindows: async (params: { pid?: number; on_screen_only?: boolean } = {}) =>
      record("listWindows", "list_windows", params, { ensureDaemon: true }),
    getWindowState: async (params: { pid: number; window_id: number; query?: string }) =>
      record("getWindowState", "get_window_state", params, {
        ensureDaemon: true,
        omitStructuredFields: GET_WINDOW_STATE_OMIT_FIELDS,
      }),
    click: async (params: {
      pid: number;
      window_id?: number;
      element_index?: number;
      x?: number;
      y?: number;
      action?: "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open";
      modifier?: string[];
      count?: number;
      from_zoom?: boolean;
    }) => {
      assertClickTarget(params);
      return record("click", "click", params, { ensureDaemon: true });
    },
    typeText: async (params: { pid: number; text: string; element_index?: number; window_id?: number }) => {
      assertElementWindowPair(params, "macos_cua_type_text");
      return record("typeText", "type_text", params, { ensureDaemon: true });
    },
    setValue: async (params: { pid: number; window_id: number; element_index: number; value: string }) =>
      record("setValue", "set_value", params, { ensureDaemon: true }),
    pressKey: async (params: {
      pid: number;
      key: string;
      modifiers?: string[];
      element_index?: number;
      window_id?: number;
    }) => {
      assertElementWindowPair(params, "macos_cua_press_key");
      return record("pressKey", "press_key", params, { ensureDaemon: true });
    },
    hotkey: async (params: { pid: number; keys: string[] }) => record("hotkey", "hotkey", params, { ensureDaemon: true }),
    scroll: async (params: {
      pid: number;
      direction: "up" | "down" | "left" | "right";
      amount?: number;
      by?: "line" | "page";
      element_index?: number;
      window_id?: number;
    }) => {
      assertElementWindowPair(params, "macos_cua_scroll");
      return record("scroll", "scroll", params, { ensureDaemon: true });
    },
    sleep: async (ms: number) => {
      assertExecStillActive(signal);
      await sleepWithSignal(ms, signal);
      assertExecStillActive(signal);
      return { ok: true, sleptMs: ms };
    },
  };
}

function cloneForTrace(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    return { ...value };
  }
}

function assertExecStillActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new Error(typeof reason === "string" ? reason : "Cancelled");
}

function createExecutionSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeoutError = new Error(`macos_cua_exec timed out after ${timeoutMs}ms.`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  const onParentAbort = () => {
    const reason = parentSignal?.reason;
    controller.abort(reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Cancelled"));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Cancelled"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function buildExecToolResult(
  trace: ExecTraceEntry[],
  logs: string[],
  returnedValue: unknown,
  stateKeys: string[],
): PiDriverToolResult {
  const textSections: string[] = [];

  if (trace.length > 0) {
    textSections.push(
      trace
        .map((entry, index) => {
          const parts = [`Step ${index + 1}: ${entry.helper} ${formatExecValue(entry.args)}`];
          const text = extractText(entry.result);
          if (text) {
            parts.push(text);
          }
          return parts.join("\n");
        })
        .join("\n\n"),
    );
  }

  if (logs.length > 0) {
    textSections.push(`Console output:\n${logs.join("\n")}`);
  }

  const returnText = formatReturnedValue(returnedValue);
  if (returnText) {
    textSections.push(`Return value:\n${returnText}`);
  }

  if (stateKeys.length > 0) {
    textSections.push(`Persistent state keys: ${stateKeys.join(", ")}`);
  }

  const content: PiDriverToolResult["content"] = [];
  if (textSections.length > 0) {
    content.push({ type: "text", text: textSections.join("\n\n") });
  }

  for (const entry of trace) {
    for (const item of entry.result.content) {
      if (item.type === "image") {
        content.push(item);
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "macos_cua_exec completed with no output." });
  }

  return {
    content,
    details: {
      driverTool: "exec",
      logs,
      returnValueText: returnText ?? null,
      stateKeys,
      steps: trace.map((entry) => ({
        helper: entry.helper,
        args: entry.args,
        text: extractText(entry.result),
        imageCount: entry.result.content.filter((item) => item.type === "image").length,
        structuredContent: entry.result.details.structuredContent ?? null,
      })),
    },
  };
}

function summarizeExecError(error: unknown, trace: ExecTraceEntry[], logs: string[]): string {
  const parts = [error instanceof Error ? error.message : String(error)];

  if (trace.length > 0) {
    parts.push(
      `Completed steps before failure:\n${trace
        .map((entry, index) => {
          const text = extractText(entry.result);
          return text ? `${index + 1}. ${entry.helper}\n${text}` : `${index + 1}. ${entry.helper}`;
        })
        .join("\n\n")}`,
    );
  }

  if (logs.length > 0) {
    parts.push(`Console output:\n${logs.join("\n")}`);
  }

  return parts.join("\n\n");
}

function extractText(result: PiDriverToolResult): string {
  return result.content
    .filter((item): item is Extract<PiDriverToolResult["content"][number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

function formatReturnedValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (isPiDriverToolResult(value)) {
    const text = extractText(value);
    if (text) return text;
    if (value.details.structuredContent !== undefined) {
      return formatExecValue(value.details.structuredContent);
    }
    return "[Pi driver tool result]";
  }
  return formatExecValue(value);
}

function formatExecValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return inspect(value, { depth: 5, colors: false, breakLength: 100 });
  }
}

function isPiDriverToolResult(value: unknown): value is PiDriverToolResult {
  return typeof value === "object" && value !== null && Array.isArray((value as PiDriverToolResult).content)
    && typeof (value as PiDriverToolResult).details === "object";
}

async function setStatus(ctx: ExtensionContext): Promise<void> {
  try {
    const config = await loadMacosCuaConfig(ctx.cwd);
    if (!(await macosCua.isInstalled(config))) {
      ctx.ui.setStatus("pi-macos-cua", "macos-cua: run /install-cua-driver");
      return;
    }
    const status = await macosCua.getStatus(config);
    const binary = status.binaryPath ? status.binaryPath.split("/").pop() : "missing";
    ctx.ui.setStatus(
      "pi-macos-cua",
      `macos-cua: ${status.daemonRunning ? "daemon:on" : "daemon:off"} binary:${binary}`,
    );
  } catch {
    ctx.ui.setStatus("pi-macos-cua", "macos-cua: unavailable");
  }
}

export default function (pi: ExtensionAPI) {
  piRef = pi;
  macosCua = new MacosCuaDriver((command, args, options) =>
    piRef.exec(command, args, options),
  );

  pi.on("session_start", async (_event, ctx) => {
    macosCuaExec = new PersistentExecRepl();
    await setStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt
      + "\n\nWhen doing local macOS computer use: if CuaDriver.app is missing, ask the user to run /install-cua-driver first. Use the macos_cua_exec tool for all macOS CUA actions. Inside macos_cua_exec, use helpers like launchApp(), listWindows(), getWindowState(), click(), typeText(), setValue(), pressKey(), hotkey(), scroll(), and checkPermissions(). Prefer launchApp() instead of `open -a` or `osascript activate`; call getWindowState() before element-indexed GUI actions; prefer element_index interactions over raw pixel clicks when the AX tree exposes the target; after UI-changing actions, re-snapshot with getWindowState() before taking the next action. Persist cross-call values in state.* when needed.",
  }));

  pi.registerCommand("install-cua-driver", {
    description: "Download and install CuaDriver.app plus the cua-driver CLI",
    handler: async (_args, ctx) => {
      const config = await loadMacosCuaConfig(ctx.cwd);
      if (await macosCua.isInstalled(config)) {
        ctx.ui.notify(`CuaDriver.app is already installed at ${config.appPath}.`, "info");
        await setStatus(ctx);
        return;
      }

      const installCmd = `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"`;
      ctx.ui.notify(
        `CuaDriver.app is not installed. Run this command in your terminal (it needs sudo access):\n\n${installCmd}\n\nAfterwards, grant Accessibility and Screen Recording to CuaDriver.app in System Settings, then try /macos-cua-diagnose.`,
        "info",
      );
    },
  });

  pi.registerCommand("macos-cua-status", {
    description: "Show pi-macos-cua config, resolved binary, and daemon status",
    handler: async (_args, ctx) => {
      try {
        await requireCuaDriverInstalled(ctx);
        const config = await loadMacosCuaConfig(ctx.cwd);
        const status = await macosCua.getStatus(config);
        await setStatus(ctx);
        ctx.ui.notify(
          `${summarizeMacosCuaConfig(config)} binary=${status.binaryPath ?? "(missing)"} daemon=${status.daemonRunning}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("macos-cua-stop", {
    description: "Stop the background cua-driver daemon",
    handler: async (_args, ctx) => {
      try {
        await requireCuaDriverInstalled(ctx);
        const config = await loadMacosCuaConfig(ctx.cwd);
        const text = await macosCua.stopDaemon(config);
        await setStatus(ctx);
        ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("macos-cua-diagnose", {
    description: "Paste `cua-driver diagnose` output into the editor",
    handler: async (_args, ctx) => {
      try {
        await requireCuaDriverInstalled(ctx);
        const config = await loadMacosCuaConfig(ctx.cwd);
        const output = await macosCua.diagnose(config);
        if (ctx.hasUI) {
          const current = ctx.ui.getEditorText();
          ctx.ui.setEditorText(current.trim() ? `${current}\n\n--- cua-driver diagnose ---\n${output}` : output);
          ctx.ui.notify("Inserted cua-driver diagnose output into the editor.", "info");
        } else {
          console.log(output);
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "macos_cua_exec",
    label: "Exec",
    description:
      "Execute a short JavaScript snippet inside a persistent Node REPL with helper functions like launchApp(), getWindowState(), click(), and typeText(). Use state.* to persist values across calls.",
    promptSnippet: "Run a short deterministic JavaScript sequence that chains macOS CUA helper calls",
    promptGuidelines: [
      "Use macos_cua_exec for all macOS CUA actions in this extension.",
      "The code runs as the body of an async function, so use await and return your final value explicitly.",
      "Available helpers: invoke, checkPermissions, listApps, launchApp, listWindows, getWindowState, click, typeText, setValue, pressKey, hotkey, scroll, sleep, state, clearState, console.",
      "If your code uses element_index, call getWindowState() first and usually again after UI-changing actions.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description:
          "JavaScript statements executed inside an async function body. Example: const app = await launchApp({ name: 'Safari' }); return app;",
      }),
      reset_state: Type.Optional(Type.Boolean({ description: "If true, clear the persistent state object before running this code" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Best-effort timeout for the overall execution in milliseconds" })),
    }),
    executionMode: SEQUENTIAL,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await requireCuaDriverInstalled(ctx);
      const trace: ExecTraceEntry[] = [];
      const timeoutMs = params.timeout_ms ?? 30_000;
      const { signal: execSignal, cleanup } = createExecutionSignal(signal, timeoutMs);
      const helpers = createExecHelpers(ctx, execSignal, trace);

      try {
        const { value, logs, stateKeys } = await macosCuaExec.evaluateBody(params.code, {
          signal: execSignal,
          timeoutMs,
          resetState: params.reset_state ?? false,
          context: helpers,
          filename: "macos-cua-exec",
        });

        await setStatus(ctx);
        return buildExecToolResult(trace, logs, value, stateKeys);
      } catch (error) {
        if (error instanceof ExecReplError && (error.message.includes("timed out") || error.message.includes("Cancelled"))) {
          macosCuaExec = new PersistentExecRepl();
        }
        const logs = error instanceof ExecReplError ? error.logs : [];
        throw new Error(summarizeExecError(error, trace, logs));
      } finally {
        cleanup();
      }
    },
  });
}
