import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PluginConfig } from "./config.ts";

export interface McpCallResult {
  ok: boolean;
  permalink: string | null;
  error: string | null;
}

export interface NoteDraft {
  title: string;
  content: string;
  directory: string;
  tags: string[];
}

interface ToolCall {
  ok: boolean;
  permalink: string | null;
  filePath: string | null;
  error: string | null;
}

const CALL_TIMEOUT_MS = 30_000;
const FILE_WAIT_TIMEOUT_MS = 8_000;
const FILE_POLL_MS = 250;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

// One process per call. `basic-memory mcp` starts in about a second and
// checkpoint writes are minutes apart, so a persistent connection costs more
// than it saves.
export async function writeNote(note: NoteDraft, config: PluginConfig): Promise<McpCallResult> {
  const call = await callTool(
    "write_note",
    {
      title: note.title,
      content: note.content,
      directory: note.directory,
      tags: note.tags,
      output_format: "json",
    },
    config,
  );
  if (call.ok && call.filePath !== null) {
    await waitForFile(join(config.vaultPath, call.filePath));
  }
  return { ok: call.ok, permalink: call.permalink, error: call.error };
}

export function permalinkFromToolText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) {
    return null;
  }
  return textOrNull(record.permalink);
}

function callTool(
  name: string,
  args: Record<string, unknown>,
  config: PluginConfig,
): Promise<ToolCall> {
  const child = spawn(config.binaryPath, ["mcp", "--project", config.project], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let lineBuffer = "";
  let stdoutBytes = 0;
  let stderrTail = "";
  let settled = false;
  let resolveCall: (call: ToolCall) => void;
  const promise = new Promise<ToolCall>((resolve) => {
    resolveCall = resolve;
  });

  const timer = setTimeout(() => {
    finish({
      ok: false,
      permalink: null,
      filePath: null,
      error: `basic-memory mcp did not answer within ${CALL_TIMEOUT_MS / 1000}s`,
    });
  }, CALL_TIMEOUT_MS);

  function finish(call: ToolCall): void {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    child.kill();
    resolveCall(call);
  }

  function send(message: unknown): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function handleMessage(message: unknown): void {
    const record = asRecord(message);
    if (record === null) {
      return;
    }
    if (record.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
      return;
    }
    if (record.id === 2) {
      finish(readToolResult(record, stderrTail));
    }
  }

  // The child can exit between our write and its read; the close handler
  // below reports that, so an EPIPE here carries no new information.
  child.stdin.on("error", () => undefined);

  child.on("error", (err) => {
    finish({ ok: false, permalink: null, filePath: null, error: `spawn failed: ${err.message}` });
  });

  child.on("close", () => {
    finish({
      ok: false,
      permalink: null,
      filePath: null,
      error: `basic-memory mcp exited early: ${stderrTail.slice(0, 500) || "no stderr"}`,
    });
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      finish({
        ok: false,
        permalink: null,
        filePath: null,
        error: "basic-memory mcp stdout exceeded 4 MiB",
      });
      return;
    }
    lineBuffer += chunk.toString("utf8");
    let newline = lineBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line.length > 0) {
        handleMessage(parseLine(line));
      }
      newline = lineBuffer.indexOf("\n");
    }
  });

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "paseo-plugin-basic-memory", version: "0.1.0" },
    },
  });

  return promise;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    // Banner or log line, not JSON-RPC.
    return null;
  }
}

interface NoteOutcome {
  permalink: string | null;
  filePath: string | null;
  isError: boolean;
  text: string;
}

function readToolResult(response: Record<string, unknown>, stderrTail: string): ToolCall {
  const failure = asRecord(response.error);
  if (failure !== null) {
    const message = textOrNull(failure.message) ?? "write_note failed";
    return { ok: false, permalink: null, filePath: null, error: message };
  }
  const result = asRecord(response.result);
  const outcome = result === null ? null : noteOutcome(result);
  if (outcome === null) {
    return {
      ok: false,
      permalink: null,
      filePath: null,
      error: stderrTail.slice(0, 500) || "write_note returned no readable result",
    };
  }
  if (outcome.isError) {
    return {
      ok: false,
      permalink: null,
      filePath: null,
      error: outcome.text.slice(0, 500) || stderrTail.slice(0, 500) || "write_note failed",
    };
  }
  return { ok: true, permalink: outcome.permalink, filePath: outcome.filePath, error: null };
}

function noteOutcome(result: Record<string, unknown>): NoteOutcome | null {
  const structured = asRecord(result.structuredContent);
  const note = structured === null ? null : asRecord(structured.result);
  if (note !== null) {
    return {
      permalink: textOrNull(note.permalink),
      filePath: textOrNull(note.file_path),
      isError: result.isError === true,
      text: contentText(result),
    };
  }
  const text = contentText(result);
  const parsed = permalinkRecord(text);
  if (parsed !== null) {
    return {
      permalink: textOrNull(parsed.permalink),
      filePath: textOrNull(parsed.file_path),
      isError: result.isError === true,
      text,
    };
  }
  return null;
}

function permalinkRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return asRecord(parsed);
}

function contentText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      const record = asRecord(part);
      if (record !== null && record.type === "text" && typeof record.text === "string") {
        parts.push(record.text);
      }
    }
  }
  return parts.join("\n");
}

// basic-memory 0.23 answers after the index update, not after the markdown
// file lands. Killing the process at the answer leaves the file to the next
// session's reconciliation, so poll for it before shutting down. A timeout is
// not an error: the next session flushes the pending note.
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + FILE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await delay(FILE_POLL_MS);
  }
  console.error(
    `[basic-memory] note file did not appear within ${FILE_WAIT_TIMEOUT_MS / 1000}s: ${path}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
