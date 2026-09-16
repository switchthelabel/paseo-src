import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const basicMemoryStatus = defineRpc({
  name: "basicMemory.status",
  input: z.object({}),
  output: z.object({
    config: z.record(z.string(), z.unknown()),
    binaryPresent: z.boolean(),
    vaultPresent: z.boolean(),
    lastCheckpointAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }),
});

export const basicMemoryWrite = defineRpc({
  name: "basicMemory.write",
  input: z.object({
    title: z.string().min(1),
    content: z.string(),
    folder: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    permalink: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
