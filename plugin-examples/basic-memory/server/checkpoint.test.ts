import test from "node:test";
import assert from "node:assert/strict";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { clamp, composeNote, createTurnCoalescer, type CheckpointDraft } from "./checkpoint.ts";
import { latestOutputText, latestUserText } from "./inspect.ts";
import { preapprovalsFor } from "./inject.ts";
import { permalinkFromToolText } from "./mcp-client.ts";
import { redact } from "./redact.ts";

function timeline(...items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items;
}

test("latestUserText returns the last user message", () => {
  const items = timeline(
    { type: "user_message", text: "first request" },
    { type: "assistant_message", text: "first answer" },
    { type: "user_message", text: "second request" },
  );
  assert.equal(latestUserText(items), "second request");
});

test("latestUserText returns empty for a timeline without user messages", () => {
  assert.equal(latestUserText(timeline({ type: "reasoning", text: "hmm" })), "");
});

test("latestOutputText joins assistant messages after the last user message", () => {
  const items = timeline(
    { type: "user_message", text: "request" },
    { type: "assistant_message", text: "part one" },
    { type: "assistant_message", text: "part two" },
  );
  assert.equal(latestOutputText(items), "part one\n\npart two");
});

test("latestOutputText drops assistant messages before the last user message", () => {
  const items = timeline(
    { type: "assistant_message", text: "stale answer" },
    { type: "user_message", text: "request" },
    { type: "assistant_message", text: "fresh answer" },
  );
  assert.equal(latestOutputText(items), "fresh answer");
});

test("latestOutputText includes error items from failed turns", () => {
  const items = timeline(
    { type: "user_message", text: "request" },
    { type: "error", message: "provider exited: quota exceeded" },
  );
  assert.equal(latestOutputText(items), "provider exited: quota exceeded");
});

test("latestOutputText ignores reasoning and tool items", () => {
  const items = timeline(
    { type: "user_message", text: "request" },
    { type: "reasoning", text: "thinking" },
    { type: "assistant_message", text: "answer" },
  );
  assert.equal(latestOutputText(items), "answer");
});

test("redact masks bearer tokens", () => {
  assert.equal(redact("Authorization: Bearer abc123def456ghi789"), "Authorization: [token]");
});

test("redact masks common API key prefixes", () => {
  assert.equal(redact("key is sk-abcdef0123456789abcdef"), "key is [token]");
  assert.equal(redact("ghp_0123456789abcdefghijklmnopqrstuvwxyz"), "[token]");
  assert.equal(redact("AKIAIOSFODNN7EXAMPLE"), "[token]");
});

test("redact masks labeled secrets", () => {
  assert.equal(redact("password: 0123456789abcdef0123456789abcdef"), "password: [token]");
});

test("redact leaves bare hex runs untouched", () => {
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assert.equal(redact(`commit ${sha}`), `commit ${sha}`);
});

test("redact masks emails, SSNs, phones, and long digit runs", () => {
  assert.equal(redact("mail ada@example.com now"), "mail [email] now");
  assert.equal(redact("ssn 123-45-6789"), "ssn [ssn]");
  assert.equal(redact("call 415-555-2671"), "call [phone]");
  assert.equal(redact("order 123456789012"), "order [number]");
});

test("clamp keeps short text, truncates long text with a marker", () => {
  assert.equal(clamp("  short  ", 100), "short");
  const long = "a".repeat(50);
  const clamped = clamp(long, 10);
  assert.ok(clamped.startsWith("a".repeat(10)));
  assert.ok(clamped.endsWith("(truncated)"));
});

test("clamp replaces empty text with a marker", () => {
  assert.equal(clamp("   ", 100), "(empty)");
});

test("composeNote builds the checkpoint note", () => {
  const draft: CheckpointDraft = {
    agentId: "agent-1",
    agentTitle: "Fix login bug",
    provider: "claude",
    workspaceId: "ws-9",
    cwd: "/home/ubuntu/paseo",
    projectKey: "paseo",
    outcome: "completed",
    userText: "Fix the login bug. Token sk-abcdef0123456789abcdef",
    outputText: "Fixed.",
    at: "2026-09-15T12:34:56.000Z",
  };
  const note = composeNote(draft, testConfig());
  assert.equal(note.title, "Checkpoint — Fix login bug — 2026-09-15 12:34");
  assert.equal(note.directory, "checkpoints");
  assert.deepEqual(note.tags, ["checkpoint", "claude", "paseo"]);
  assert.ok(note.content.includes("- Agent: agent-1 (Fix login bug)"));
  assert.ok(note.content.includes("- Provider: claude"));
  assert.ok(note.content.includes("- Workspace: ws-9"));
  assert.ok(note.content.includes("- Directory: /home/ubuntu/paseo"));
  assert.ok(note.content.includes("- Turn outcome: completed"));
  assert.ok(note.content.includes("## Last request"));
  assert.ok(note.content.includes("[token]"));
  assert.ok(note.content.includes("## Result"));
  assert.ok(note.content.includes("Fixed."));
  assert.ok(note.content.includes("## Next"));
});

test("createTurnCoalescer keeps only the newest draft per agent", async () => {
  const fired: CheckpointDraft[] = [];
  const coalescer = createTurnCoalescer(20, (draft) => fired.push(draft));
  coalescer.schedule(makeDraft("agent-1", "first"));
  coalescer.schedule(makeDraft("agent-1", "second"));
  await sleep(80);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].userText, "second");
});

test("createTurnCoalescer fires per agent", async () => {
  const fired: CheckpointDraft[] = [];
  const coalescer = createTurnCoalescer(20, (d) => fired.push(d));
  coalescer.schedule(makeDraft("agent-1", "one"));
  coalescer.schedule(makeDraft("agent-2", "two"));
  await sleep(80);
  assert.equal(fired.length, 2);
});

test("createTurnCoalescer stop clears pending timers", async () => {
  const fired: CheckpointDraft[] = [];
  const coalescer = createTurnCoalescer(20, (d) => fired.push(d));
  coalescer.schedule(makeDraft("agent-1", "one"));
  coalescer.stop();
  await sleep(80);
  assert.equal(fired.length, 0);
});

test("permalinkFromToolText reads the permalink from a JSON tool result", () => {
  const text = JSON.stringify({
    title: "T",
    permalink: "paseo-shared/checkpoints/t",
    file_path: "checkpoints/T.md",
  });
  assert.equal(permalinkFromToolText(text), "paseo-shared/checkpoints/t");
  assert.equal(permalinkFromToolText("not json"), null);
});

test("preapprovalsFor returns grants only for providers that support them", () => {
  const config = testConfig();
  const claudeGrants = preapprovalsFor("claude", config);
  assert.equal(claudeGrants.length, 7);
  assert.deepEqual(claudeGrants[0], { kind: "mcp", server: "basic-memory", tool: "search_notes" });

  // Providers without exact preapproval support must get no toolPolicy:
  // the daemon rejects agent creation for them otherwise.
  assert.deepEqual(preapprovalsFor("glm-acp-agent", config), []);
  assert.deepEqual(preapprovalsFor("gemini", config), []);

  // A listed custom provider extending a supported harness still gets grants.
  const extended = { ...config, preapproveProviders: [...config.preapproveProviders, "zai"] };
  assert.equal(preapprovalsFor("zai", extended).length, 7);

  // The master switch wins over the provider list.
  assert.deepEqual(preapprovalsFor("claude", { ...config, preapproveTools: false }), []);
});

function testConfig() {
  return {
    binaryPath: "/basic-memory",
    vaultPath: "/paseo-memory",
    project: "paseo-shared",
    serverName: "basic-memory",
    injectMcp: true,
    excludeProviders: [],
    preapproveTools: true,
    preapproveProviders: ["claude", "codex", "opencode"],
    checkpoints: true,
    skipSubagents: false,
    quietMs: 60_000,
    maxUserChars: 1_000,
    maxOutputChars: 4_000,
    folder: "checkpoints",
  };
}

function makeDraft(agentId: string, userText: string): CheckpointDraft {
  return {
    agentId,
    agentTitle: null,
    provider: "claude",
    workspaceId: null,
    cwd: "/tmp",
    projectKey: "tmp",
    outcome: "completed",
    userText,
    outputText: "done",
    at: "2026-09-15T12:00:00.000Z",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
