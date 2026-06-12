import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { MacosCuaConfig } from "./config.js";
import {
  DETAILS_PREVIEW_MAX_BYTES,
  DETAILS_PREVIEW_MAX_LINES,
  truncateText,
} from "./truncate.js";

const INSTALL_COMMAND_HINT = "Run /install-cua-driver for the install command.";

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
};

export type ExecFunction = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

type DriverRawContent =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string; mime_type?: string }
  | Record<string, unknown>;

type DriverRawResult = {
  content?: DriverRawContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

type NormalizedDriverRawResult = DriverRawResult & {
  rawKind: "mcp" | "json" | "text" | "empty";
};

type PiTextBlock = { type: "text"; text: string };
type PiImageBlock = { type: "image"; data: string; mimeType: string };

export interface PiDriverToolResult {
  content: Array<PiTextBlock | PiImageBlock>;
  details: Record<string, unknown>;
}

export interface DriverStatus {
  binaryPath: string | null;
  appPath: string;
  daemonRunning: boolean;
  statusText: string;
}

export interface InvokeOptions {
  ensureDaemon?: boolean;
  timeoutMs?: number;
  omitStructuredFields?: string[];
}

export class MacosCuaDriver {
  constructor(private readonly exec: ExecFunction) {}

  async isInstalled(config: MacosCuaConfig): Promise<boolean> {
    return isExecutable(join(config.appPath, "Contents/MacOS/cua-driver"));
  }

  async assertInstalled(config: MacosCuaConfig): Promise<void> {
    if (await this.isInstalled(config)) return;
    throw new Error(this.getInstallRequiredMessage(config));
  }

  async getStatus(config: MacosCuaConfig): Promise<DriverStatus> {
    const binaryPath = await this.resolveBinary(config);
    if (!binaryPath) {
      return {
        binaryPath: null,
        appPath: config.appPath,
        daemonRunning: false,
        statusText: "cua-driver binary not found",
      };
    }

    const status = await this.exec(binaryPath, ["status"], { timeout: 2000 });
    return {
      binaryPath,
      appPath: config.appPath,
      daemonRunning: status.code === 0,
      statusText: (status.stdout || status.stderr).trim() || `exit ${status.code}`,
    };
  }

  async stopDaemon(config: MacosCuaConfig): Promise<string> {
    await this.assertInstalled(config);
    const binaryPath = await this.requireBinary(config);
    const result = await this.exec(binaryPath, ["stop"], { timeout: 5000 });
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout || "Failed to stop cua-driver daemon.").trim());
    }
    return (result.stdout || "Stopped cua-driver daemon.").trim();
  }

  async diagnose(config: MacosCuaConfig): Promise<string> {
    await this.assertInstalled(config);
    const binaryPath = await this.requireBinary(config);
    const result = await this.exec(binaryPath, ["diagnose"], { timeout: 10000 });
    if (result.code !== 0) {
      throw new Error((result.stderr || result.stdout || "cua-driver diagnose failed.").trim());
    }
    return result.stdout.trim();
  }

  async invokeTool(
    config: MacosCuaConfig,
    toolName: string,
    args: Record<string, unknown>,
    options: InvokeOptions = {},
    signal?: AbortSignal,
  ): Promise<PiDriverToolResult> {
    await this.assertInstalled(config);

    if (options.ensureDaemon !== false) {
      await this.ensureDaemonRunning(config, signal);
    }

    const binaryPath = await this.requireBinary(config);
    const execResult = await this.exec(
      binaryPath,
      ["call", "--raw", "--compact", toolName, JSON.stringify(args)],
      { timeout: options.timeoutMs ?? 30000, signal },
    );

    const parsed = this.normalizeRawResult(execResult.stdout);
    const omitStructuredFields = options.omitStructuredFields ?? [];
    const content = this.buildPiContent(parsed, omitStructuredFields);
    if (parsed.isError || execResult.code !== 0) {
      const contentText = this.contentToText(content);
      const message = (contentText && contentText !== "cua-driver returned no content." ? contentText : "")
        || execResult.stderr.trim()
        || execResult.stdout.trim()
        || `${toolName} failed.`;
      throw new Error(message);
    }

    const stdoutPreview = buildPreview(execResult.stdout);
    const stderrPreview = buildPreview(execResult.stderr);

    return {
      content,
      details: {
        driverTool: toolName,
        binaryPath,
        rawKind: parsed.rawKind,
        structuredContent: sanitizeStructuredContent(parsed.structuredContent, omitStructuredFields) ?? null,
        stdoutPreview: stdoutPreview.text,
        stdoutBytes: stdoutPreview.totalBytes,
        stdoutLines: stdoutPreview.totalLines,
        stdoutTruncated: stdoutPreview.truncated,
        stderrPreview: stderrPreview.text,
        stderrBytes: stderrPreview.totalBytes,
        stderrLines: stderrPreview.totalLines,
        stderrTruncated: stderrPreview.truncated,
        exitCode: execResult.code,
      },
    };
  }

  getInstallRequiredMessage(config: MacosCuaConfig): string {
    return [
      `CuaDriver.app was not found at ${config.appPath}.`,
      INSTALL_COMMAND_HINT,
      config.appPath === "/Applications/CuaDriver.app"
        ? undefined
        : "If you installed it elsewhere, update PI_MACOS_CUA_APP or .pi/macos-cua.json.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async ensureDaemonRunning(config: MacosCuaConfig, signal?: AbortSignal): Promise<void> {
    await this.assertInstalled(config);
    const status = await this.getStatus(config);
    if (status.daemonRunning) return;

    if (!config.autoStartDaemon) {
      throw new Error(
        `cua-driver daemon is not running. Start it with \`${this.formatManualStartCommand(config)}\` or enable autoStartDaemon.`,
      );
    }

    const appExists = await isExecutable(join(config.appPath, "Contents/MacOS/cua-driver"));
    if (!appExists) {
      throw new Error(this.getInstallRequiredMessage(config));
    }

    const serveArgs = ["serve", ...(config.agentCursorOverlay ? [] : ["--no-overlay"])] as string[];
    const openResult = await this.exec(
      "/usr/bin/open",
      ["-n", "-g", config.appPath, "--args", ...serveArgs],
      { timeout: 3000, signal },
    );
    if (openResult.code !== 0) {
      throw new Error((openResult.stderr || openResult.stdout || "Failed to launch CuaDriver.app.").trim());
    }

    const deadline = Date.now() + config.startTimeoutMs;
    while (Date.now() < deadline) {
      const next = await this.getStatus(config);
      if (next.daemonRunning) return;
      await sleep(250, signal);
    }

    throw new Error(
      "Timed out waiting for cua-driver daemon. Run `cua-driver check_permissions` or `cua-driver diagnose` and make sure CuaDriver.app has Accessibility + Screen Recording access.",
    );
  }

  private formatManualStartCommand(config: MacosCuaConfig): string {
    const overlayArg = config.agentCursorOverlay ? "" : " --no-overlay";
    return `open -n -g ${JSON.stringify(config.appPath)} --args serve${overlayArg}`;
  }

  private async requireBinary(config: MacosCuaConfig): Promise<string> {
    const binaryPath = await this.resolveBinary(config);
    if (!binaryPath) {
      throw new Error(
        `${this.getInstallRequiredMessage(config)} If the app is already installed, set PI_MACOS_CUA_BINARY if the CLI lives outside the app bundle.`,
      );
    }
    return binaryPath;
  }

  private async resolveBinary(config: MacosCuaConfig): Promise<string | null> {
    const candidates = [
      config.binaryPath,
      ...pathsFromEnv("cua-driver"),
      "/usr/local/bin/cua-driver",
      "/opt/homebrew/bin/cua-driver",
      join(config.appPath, "Contents/MacOS/cua-driver"),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      if (await isExecutable(candidate)) return candidate;
    }
    return null;
  }

  private normalizeRawResult(stdout: string): NormalizedDriverRawResult {
    const trimmed = stdout.trim();
    if (!trimmed) return { rawKind: "empty", content: [] };

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isDriverRawResult(parsed)) {
        return { ...parsed, rawKind: "mcp" };
      }
      return { rawKind: "json", content: [], structuredContent: parsed };
    } catch {
      return {
        rawKind: "text",
        content: [{ type: "text", text: trimmed }],
      };
    }
  }

  private buildPiContent(parsed: NormalizedDriverRawResult, omitStructuredFields: string[]): Array<PiTextBlock | PiImageBlock> {
    const textParts = (parsed.content ?? [])
      .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [truncateText(item.text.trim()).text] : []))
      .filter(Boolean);

    const omitSet = new Set(omitStructuredFields);
    const structured = parsed.structuredContent;
    const treeMarkdown = isRecord(structured) && typeof structured.tree_markdown === "string"
      ? structured.tree_markdown
      : undefined;
    if (treeMarkdown && !omitSet.has("tree_markdown")) {
      textParts.push(`UI tree:\n${truncateText(treeMarkdown).text}`);
    }

    const sanitizedStructured = sanitizeStructuredContent(
      structured,
      uniqueStrings([...omitStructuredFields, "screenshot_png_b64", "tree_markdown"]),
    );
    if (sanitizedStructured !== undefined) {
      const structuredText = safeStringify(sanitizedStructured);
      if (structuredText && structuredText !== "{}") {
        textParts.push(`Structured data:\n${truncateText(structuredText).text}`);
      }
    }

    const content: Array<PiTextBlock | PiImageBlock> = [];
    if (textParts.length > 0) {
      content.push({ type: "text", text: truncateText(textParts.join("\n\n")).text });
    }

    for (const item of parsed.content ?? []) {
      if (item.type !== "image") continue;
      if (typeof item.data !== "string") continue;
      const mimeType = typeof item.mimeType === "string"
        ? item.mimeType
        : typeof item.mime_type === "string"
          ? item.mime_type
          : "image/png";
      content.push({ type: "image", data: item.data, mimeType });
    }

    if (!content.some((item) => item.type === "image") && !omitSet.has("screenshot_png_b64")) {
      const structuredRecord = isRecord(parsed.structuredContent) ? parsed.structuredContent : undefined;
      const base64 = typeof structuredRecord?.screenshot_png_b64 === "string" ? structuredRecord.screenshot_png_b64 : undefined;
      if (base64 && structuredRecord) {
        const mimeType = typeof structuredRecord.screenshot_mime_type === "string"
          ? structuredRecord.screenshot_mime_type
          : "image/png";
        content.push({ type: "image", data: base64, mimeType });
      }
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "cua-driver returned no content." });
    }
    return content;
  }

  private contentToText(content: Array<PiTextBlock | PiImageBlock>): string {
    return content
      .filter((item): item is PiTextBlock => item.type === "text")
      .map((item) => item.text)
      .join("\n\n")
      .trim();
  }
}

function isDriverRawResult(value: unknown): value is DriverRawResult {
  if (!isRecord(value)) return false;
  if ("structuredContent" in value || typeof value.isError === "boolean") return true;
  if (!Array.isArray(value.content)) return false;
  return value.content.every((item) => isRecord(item) && typeof item.type === "string");
}

function buildPreview(value: string) {
  return truncateText(value, {
    maxBytes: DETAILS_PREVIEW_MAX_BYTES,
    maxLines: DETAILS_PREVIEW_MAX_LINES,
  });
}

function sanitizeStructuredContent(value: unknown, omitFields: string[]): unknown {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = { ...value };
  for (const field of omitFields) {
    delete copy[field];
  }
  return copy;
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2) ?? null;
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathsFromEnv(binaryName: string): string[] {
  const pathValue = process.env.PATH;
  if (!pathValue) return [];
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry, binaryName));
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
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
