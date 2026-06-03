import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type RawConfig = Partial<{
  binaryPath: string;
  appPath: string;
  autoStartDaemon: boolean;
  startTimeoutMs: number;
}>;

export interface MacosCuaConfig {
  binaryPath?: string;
  appPath: string;
  autoStartDaemon: boolean;
  startTimeoutMs: number;
}

const DEFAULTS = {
  appPath: "/Applications/CuaDriver.app",
  autoStartDaemon: true,
  startTimeoutMs: 10000,
} satisfies Pick<MacosCuaConfig, "appPath" | "autoStartDaemon" | "startTimeoutMs">;

async function readJsonIfPresent(path: string): Promise<RawConfig> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as RawConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return {};
    }
    throw new Error(`Failed to read config at ${path}: ${message}`);
  }
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${name}: ${value}`);
  }
  return parsed;
}

export async function loadMacosCuaConfig(cwd: string): Promise<MacosCuaConfig> {
  const userConfig = await readJsonIfPresent(join(homedir(), ".pi/agent/macos-cua.json"));
  const projectConfig = await readJsonIfPresent(join(cwd, ".pi/macos-cua.json"));
  const fileConfig = { ...userConfig, ...projectConfig };

  return {
    binaryPath: process.env.PI_MACOS_CUA_BINARY ?? fileConfig.binaryPath,
    appPath: process.env.PI_MACOS_CUA_APP ?? fileConfig.appPath ?? DEFAULTS.appPath,
    autoStartDaemon:
      parseBoolean(process.env.PI_MACOS_CUA_AUTOSTART) ??
      fileConfig.autoStartDaemon ??
      DEFAULTS.autoStartDaemon,
    startTimeoutMs:
      parseNumber(process.env.PI_MACOS_CUA_START_TIMEOUT_MS, "PI_MACOS_CUA_START_TIMEOUT_MS") ??
      fileConfig.startTimeoutMs ??
      DEFAULTS.startTimeoutMs,
  };
}

export function summarizeMacosCuaConfig(config: MacosCuaConfig): string {
  return [
    `binary=${config.binaryPath ?? "(auto)"}`,
    `app=${config.appPath}`,
    `autoStartDaemon=${config.autoStartDaemon}`,
    `startTimeoutMs=${config.startTimeoutMs}`,
  ].join(" ");
}
