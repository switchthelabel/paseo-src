import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export function latestUserText(timeline: readonly AgentTimelineItem[]): string {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type === "user_message") {
      return item.text;
    }
  }
  return "";
}

export function latestOutputText(timeline: readonly AgentTimelineItem[]): string {
  const parts: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type === "user_message") {
      break;
    }
    if (item.type === "assistant_message") {
      parts.unshift(item.text);
    } else if (item.type === "error") {
      parts.unshift(item.message);
    }
  }
  return parts.join("\n\n");
}
