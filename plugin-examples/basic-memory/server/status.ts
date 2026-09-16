import { existsSync } from "node:fs";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { basicMemoryStatus, basicMemoryWrite } from "../shared/contracts.ts";
import { checkpointState } from "./checkpoint.ts";
import { readConfig } from "./config.ts";
import { writeNote } from "./mcp-client.ts";

export function handleStatus(): RpcOutput<typeof basicMemoryStatus> {
  const config = readConfig();
  return {
    config: { ...config },
    binaryPresent: existsSync(config.binaryPath),
    vaultPresent: existsSync(config.vaultPath),
    lastCheckpointAt: checkpointState().lastCheckpointAt,
    lastError: checkpointState().lastError,
  };
}

export async function handleWrite(
  input: RpcInput<typeof basicMemoryWrite>,
): Promise<RpcOutput<typeof basicMemoryWrite>> {
  const config = readConfig();
  return writeNote(
    {
      title: input.title,
      content: input.content,
      directory: input.folder ?? config.folder,
      tags: input.tags ?? [],
    },
    config,
  );
}
