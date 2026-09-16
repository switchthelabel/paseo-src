import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PluginConfig {
  binaryPath: string;
  vaultPath: string;
  project: string;
  serverName: string;
  injectMcp: boolean;
  excludeProviders: string[];
  preapproveTools: boolean;
  preapproveProviders: string[];
  checkpoints: boolean;
  skipSubagents: boolean;
  quietMs: number;
  maxUserChars: number;
  maxOutputChars: number;
  folder: string;
}

const CONFIG_PATH = join(homedir(), ".paseo", "basic-memory-plugin.json");

const DEFAULTS: PluginConfig = {
  binaryPath: join(homedir(), ".local", "bin", "basic-memory"),
  vaultPath: join(homedir(), "paseo-memory"),
  project: "paseo-shared",
  serverName: "basic-memory",
  injectMcp: true,
  excludeProviders: [],
  preapproveTools: true,
  // The daemon rejects a toolPolicy on providers whose contract cannot honor
  // exact MCP tool preapproval — only these three can (custom providers that
  // `extends` one of them inherit it; add their ids here to cover them).
  preapproveProviders: ["claude", "codex", "opencode"],
  checkpoints: true,
  skipSubagents: false,
  quietMs: 60_000,
  maxUserChars: 1_000,
  maxOutputChars: 4_000,
  folder: "checkpoints",
};

export function readConfig(): PluginConfig {
  if (!existsSync(CONFIG_PATH)) {
    writeAtomic(`${JSON.stringify(DEFAULTS, null, 2)}\n`);
    return DEFAULTS;
  }
  const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<PluginConfig>;
  return { ...DEFAULTS, ...stored };
}

function writeAtomic(text: string): void {
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, CONFIG_PATH);
}
