import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerCheckpoint } from "./server/checkpoint.ts";
import { registerInjection } from "./server/inject.ts";
import { handleStatus, handleWrite } from "./server/status.ts";
import { basicMemoryStatus, basicMemoryWrite } from "./shared/contracts.ts";

export default function contribute(server: PluginServerContext) {
  registerInjection(server);
  const stopCheckpoints = registerCheckpoint(server);
  server.handle(basicMemoryStatus, handleStatus);
  server.handle(basicMemoryWrite, handleWrite);
  console.log("[basic-memory] plugin ready");
  return () => {
    stopCheckpoints();
  };
}
