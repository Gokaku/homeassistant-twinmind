import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "@/components/ai-elements/terminal";
import { Plan, PlanContent, PlanDescription, PlanFooter, PlanHeader, PlanTitle, PlanTrigger } from "@/components/ai-elements/plan";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ProviderId, ToolKind, ToolPart } from "@/lib/protocol";
import { approve } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import { useEffect, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { PROVIDER_NAME } from "./brand";

const VERB: Record<ToolKind, string> = {
  command: "run a command",
  file: "change files",
  read: "read a file",
  search: "search files",
  web: "go online",
  mcp: "use a tool",
  ha: "change Home Assistant",
  agent: "start a helper agent",
  other: "use a tool",
};

/** Our tool states mapped onto the AI SDK states that AI Elements understands. */
export function uiState(p: ToolPart): ToolUIPart["state"] {
  switch (p.state) {
    case "awaiting-approval":
      return "approval-requested";
    case "completed":
      return "output-available";
    case "error":
      return "output-error";
    case "denied":
      return "output-denied";
    default:
      // Approved and now running.
      return p.approval?.decision ? "approval-responded" : "input-available";
  }
}

/** "mcp__homeassistant__ha_update_entity" / "homeassistant.ha_update_entity" -> "Home Assistant". */
function displayName(p: ToolPart): string {
  if (p.kind === "ha") return "Home Assistant";
  return p.name.replace(/^mcp__([^_]+)__/, "$1 · ");
}

export function ToolCard({ part, provider }: { part: ToolPart; provider: ProviderId }) {
  const state = uiState(part);
  const awaiting = part.state === "awaiting-approval" && !!part.approval && !part.approval.decision;
  const plan = part.name === "ExitPlanMode" && typeof (part.input as any)?.plan === "string" ? ((part.input as any).plan as string) : null;
  // Opens by itself when an approval is needed, otherwise the user decides.
  const [open, setOpen] = useState(awaiting);
  useEffect(() => {
    if (awaiting) setOpen(true);
  }, [awaiting]);
  if (plan) return <PlanCard part={part} provider={provider} plan={plan} />;

  const isDiff = part.kind === "file" && !!part.output?.includes("@@");
  const output = !part.output ? undefined : isDiff ? (
    <CodeBlock code={part.output} language="diff" />
  ) : part.kind === "command" ? (
    // Composed like the upstream example so the icon-only copy button gets a name.
    <Terminal output={part.output} isStreaming={part.state === "running"}>
      <TerminalHeader>
        <TerminalTitle />
        <div className="flex items-center gap-1">
          <TerminalStatus />
          <TerminalActions>
            <TerminalCopyButton aria-label="Copy output" />
          </TerminalActions>
        </div>
      </TerminalHeader>
      <TerminalContent />
    </Terminal>
  ) : (
    part.output
  );

  return (
    <Tool open={open} onOpenChange={setOpen}>
      {/* Long commands wrap and the status badge moves below on phones instead of overflowing the card. */}
      <ToolHeader
        type="dynamic-tool"
        toolName={displayName(part)}
        title={`${displayName(part)}: ${part.title}`}
        state={state}
        className="text-left [&>div]:min-w-0 [&>div>span:first-of-type]:min-w-0 [&>div>span:first-of-type]:[overflow-wrap:anywhere] [&_svg]:shrink-0 max-sm:[&>div]:flex-wrap max-sm:[&>div>span:first-of-type]:basis-[calc(100%-1.5rem)]"
      />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={output} errorText={part.state === "error" ? (part.error ?? "The tool failed.") : undefined} />
      </ToolContent>
      <ApprovalBlock part={part} provider={provider} />
    </Tool>
  );
}

/** Approval request and outcome, shared by tool cards and plan cards. */
function ApprovalBlock({ part, provider, className }: { part: ToolPart; provider: ProviderId; className?: string }) {
  if (!part.approval) return null;
  const awaiting = part.state === "awaiting-approval" && !part.approval.decision;
  const decided = part.approval.decision;
  return (
    <Confirmation
      approval={decided ? { id: part.approval.id, approved: decided !== "deny" } : { id: part.approval.id }}
      state={awaiting ? "approval-requested" : "approval-responded"}
      className={className}
    >
      <ConfirmationTitle>
        <ConfirmationRequest>
          {PROVIDER_NAME[provider]} wants to{" "}
          {part.name === "ExitPlanMode" ? "leave plan mode and carry out this plan" : (VERB[part.kind] ?? "use a tool")}
          {part.approval.reason ? ` (${part.approval.reason})` : ""}. Do you approve?
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <CheckIcon className="size-4 text-green-600 dark:text-green-400" />
          <span>{decided === "allow-session" ? "You allowed this for the rest of the conversation" : "You approved this"}</span>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <XIcon className="size-4 text-destructive" />
          <span>You rejected this</span>
        </ConfirmationRejected>
      </ConfirmationTitle>
      <ConfirmationActions>
        <ConfirmationAction onClick={() => approve(part.approval!.id, "deny")} variant="outline">
          Reject
        </ConfirmationAction>
        <ConfirmationAction onClick={() => approve(part.approval!.id, "allow-session")} variant="secondary">
          Always
        </ConfirmationAction>
        <ConfirmationAction onClick={() => approve(part.approval!.id, "allow")} variant="default">
          Approve
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}

/** Claude's ExitPlanMode: the plan in an AI Elements Plan card with the approval below. */
function PlanCard({ part, provider, plan }: { part: ToolPart; provider: ProviderId; plan: string }) {
  const awaiting = part.state === "awaiting-approval" && !part.approval?.decision;
  // The first heading becomes the card title (and is not repeated in the body).
  const heading = plan.match(/^#+\s*(.+)$/m);
  const title = heading?.[1] ?? "Plan";
  const body = heading ? plan.replace(heading[0], "").trim() : plan;
  return (
    <Plan defaultOpen>
      <PlanHeader>
        <div>
          <PlanTitle>{title}</PlanTitle>
          <PlanDescription>{`${PROVIDER_NAME[provider]} ${awaiting ? "proposes this plan" : "proposed this plan"}`}</PlanDescription>
        </div>
        <PlanTrigger />
      </PlanHeader>
      <PlanContent>
        <MessageResponse className="text-sm">{body}</MessageResponse>
      </PlanContent>
      {part.approval && (
        <PlanFooter className="block p-0">
          <ApprovalBlock part={part} provider={provider} />
        </PlanFooter>
      )}
    </Plan>
  );
}
