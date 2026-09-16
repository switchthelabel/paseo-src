import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readConfig, type PluginConfig } from "./config.ts";
import { latestOutputText, latestUserText } from "./inspect.ts";
import { writeNote, type NoteDraft } from "./mcp-client.ts";
import { redact } from "./redact.ts";

const execFileAsync = promisify(execFile);

export interface CheckpointDraft {
  agentId: string;
  agentTitle: string | null;
  provider: string;
  workspaceId: string | null;
  cwd: string;
  projectKey: string;
  outcome: "completed" | "failed";
  userText: string;
  outputText: string;
  at: string;
}

export interface CheckpointState {
  lastCheckpointAt: string | null;
  lastError: string | null;
}

const state: CheckpointState = { lastCheckpointAt: null, lastError: null };

export function checkpointState(): CheckpointState {
  return state;
}

export function clamp(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "(empty)";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}\n(truncated)`;
}

export function composeNote(draft: CheckpointDraft, config: PluginConfig): NoteDraft {
  const title = draft.agentTitle ?? draft.agentId;
  return {
    title: `Checkpoint — ${title} — ${draft.at.slice(0, 10)} ${draft.at.slice(11, 16)}`,
    directory: config.folder,
    tags: ["checkpoint", draft.provider, draft.projectKey],
    content: [
      `- Agent: ${draft.agentId} (${title})`,
      `- Provider: ${draft.provider}`,
      `- Workspace: ${draft.workspaceId ?? "none"}`,
      `- Directory: ${draft.cwd}`,
      `- Turn outcome: ${draft.outcome}`,
      `- Recorded: ${draft.at}`,
      "",
      "## Last request",
      "",
      clamp(redact(draft.userText), config.maxUserChars),
      "",
      "## Result",
      "",
      clamp(redact(draft.outputText), config.maxOutputChars),
      "",
      "## Next",
      "",
      "Not recorded. Ask the agent, or read its timeline.",
    ].join("\n"),
  };
}

export interface TurnCoalescer {
  schedule(draft: CheckpointDraft): void;
  stop(): void;
}

// One note per burst of turn ends per agent: each new turn within quietMs
// replaces the pending draft and restarts the timer.
export function createTurnCoalescer(
  quietMs: number,
  onFire: (draft: CheckpointDraft) => void,
): TurnCoalescer {
  const pending = new Map<
    string,
    { draft: CheckpointDraft; timer: ReturnType<typeof setTimeout> }
  >();
  return {
    schedule(draft: CheckpointDraft): void {
      const existing = pending.get(draft.agentId);
      if (existing !== undefined) {
        clearTimeout(existing.timer);
      }
      const timer = setTimeout(() => {
        pending.delete(draft.agentId);
        onFire(draft);
      }, quietMs);
      pending.set(draft.agentId, { draft, timer });
    },
    stop(): void {
      for (const { timer } of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    },
  };
}

export function registerCheckpoint(server: PluginServerContext): () => void {
  const projectKeys = new Map<string, Promise<string>>();
  let active: { quietMs: number; coalescer: TurnCoalescer } | null = null;

  function coalescerFor(quietMs: number): TurnCoalescer {
    if (active === null || active.quietMs !== quietMs) {
      active?.coalescer.stop();
      const coalescer = createTurnCoalescer(quietMs, (draft) => void flush(draft));
      active = { quietMs, coalescer };
    }
    return active.coalescer;
  }

  async function flush(draft: CheckpointDraft): Promise<void> {
    const config = readConfig();
    const result = await writeNote(composeNote(draft, config), config);
    if (result.ok) {
      state.lastCheckpointAt = new Date().toISOString();
      state.lastError = null;
      console.log(`[basic-memory] checkpoint ${result.permalink ?? ""} for ${draft.agentId}`);
      return;
    }
    state.lastError = result.error;
    console.error(
      `[basic-memory] checkpoint failed for ${draft.agentId}: ${result.error ?? "unknown error"}`,
    );
  }

  async function computeProjectKey(cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd });
      const gitDir = resolve(cwd, stdout.trim());
      return basename(dirname(gitDir));
    } catch {
      // Not a git repository; the directory name is the key.
      return basename(cwd) || "unknown";
    }
  }

  function projectKeyFor(cwd: string): Promise<string> {
    let key = projectKeys.get(cwd);
    if (key === undefined) {
      key = computeProjectKey(cwd);
      projectKeys.set(cwd, key);
    }
    return key;
  }

  const remove = server.on("agent.turn_ended", (event) => {
    if (event.outcome.kind === "canceled") {
      return;
    }
    const config = readConfig();
    if (!config.checkpoints) {
      return;
    }
    if (config.skipSubagents && event.agent.parentAgentId !== null) {
      return;
    }
    const userText = latestUserText(event.timeline);
    const outputText = latestOutputText(event.timeline);
    if (userText === "" && outputText === "") {
      return;
    }
    const agent = event.agent;
    void (async () => {
      coalescerFor(config.quietMs).schedule({
        agentId: agent.id,
        agentTitle: agent.title,
        provider: agent.provider,
        workspaceId: agent.workspaceId,
        cwd: agent.cwd,
        projectKey: await projectKeyFor(agent.cwd),
        outcome: event.outcome.kind === "failed" ? "failed" : "completed",
        userText,
        outputText,
        at: new Date().toISOString(),
      });
    })();
  });

  return () => {
    active?.coalescer.stop();
    remove();
  };
}
