export type AgentLifecycleDirective = "start" | "keep-running" | "settle" | "ignore";

/** Map Pi lifecycle events to the WebUI prompt-level running state. */
export function getAgentLifecycleDirective(
  eventType: string,
  promptHadAgentLifecycle: boolean,
): AgentLifecycleDirective {
  if (eventType === "agent_start") return "start";
  if (eventType === "agent_end") return "keep-running";
  if (eventType === "agent_settled" || eventType === "prompt_error") return "settle";
  if (eventType === "prompt_settled") return promptHadAgentLifecycle ? "ignore" : "settle";
  return "ignore";
}
