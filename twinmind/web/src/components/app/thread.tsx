import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { uploadUrl } from "@/lib/api";
import type { ChatMessage, Part, ProviderId } from "@/lib/protocol";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleIcon,
  CopyIcon,
  FileIcon,
  InfoIcon,
  ListTodoIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { Logo, PROVIDER_STYLE, ProviderAvatar } from "./brand";
import { ToolCard } from "./tool-card";

const SUGGESTIONS = [
  "What errors are in my logs today?",
  "Rename my Hue lights to match their rooms",
  "Which automations use the kitchen lights?",
  "Check my configuration for errors",
  "Write an automation: hallway light at sunset",
];

export function Thread({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  const current = useStore((s) => (s.currentId ? s.details[s.currentId] : null));
  const loadingId = useStore((s) => (s.currentId && !s.details[s.currentId] ? s.currentId : null));

  if (!current) {
    return loadingId ? (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    ) : (
      <EmptyState onSuggestion={onSuggestion} />
    );
  }

  return (
    <Conversation className="flex-1">
      <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-4 pb-6">
        {current.messages.map((m, i) => (
          <MessageView key={m.id} message={m} previous={current.messages[i - 1]} />
        ))}
      </ConversationContent>
      <ConversationScrollButton className="bottom-3 shadow-md" />
    </Conversation>
  );
}

function EmptyState({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  const user = useStore((s) => s.user);
  const provider = useStore((s) => s.provider);
  const first = user?.name?.split(" ")[0];
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 pb-6">
      <div className="twin-glow pointer-events-none absolute inset-0 opacity-90" />
      <div className="relative flex flex-col items-center text-center">
        <Logo className="size-16 drop-shadow-xl" />
        <h1 className="mt-5 font-semibold text-2xl tracking-tight">{first ? `Hi ${first}` : "Twinmind"}</h1>
        <p className="mt-1.5 max-w-xs text-balance text-muted-foreground text-sm">
          Ask <span className={cn("font-medium", PROVIDER_STYLE[provider].text)}>{PROVIDER_STYLE[provider].name}</span> about your
          home. Switch minds any time; the other one picks up the conversation.
        </p>
      </div>
      <div className="relative mt-8 w-full max-w-xl">
        <Suggestions className="justify-center px-4 md:w-full md:flex-wrap md:px-0">
          {SUGGESTIONS.map((s) => (
            <Suggestion key={s} suggestion={s} onClick={onSuggestion} className="bg-background/70 backdrop-blur" />
          ))}
        </Suggestions>
      </div>
    </div>
  );
}

const MessageView = memo(function MessageView({ message: m, previous }: { message: ChatMessage; previous?: ChatMessage }) {
  if (m.role === "user") {
    const files = m.parts.filter((p) => p.type === "file");
    const texts = m.parts.filter((p) => p.type === "text");
    const switched = previous && previous.provider !== m.provider;
    return (
      <>
        {switched && <Handoff to={m.provider} />}
        <Message from="user">
          {files.length > 0 && (
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              {files.map((f) => (f.type === "file" ? <FileChip key={f.id} part={f} /> : null))}
            </div>
          )}
          {texts.length > 0 && (
            <MessageContent className="rounded-2xl rounded-br-md bg-primary! px-4 py-2.5 text-primary-foreground! shadow-sm">
              {texts.map((t) => (t.type === "text" ? <p key={t.id} className="whitespace-pre-wrap break-words">{t.text}</p> : null))}
            </MessageContent>
          )}
        </Message>
      </>
    );
  }
  const streaming = m.status === "streaming";
  const style = PROVIDER_STYLE[m.provider];
  const empty = m.parts.length === 0;
  return (
    <Message from="assistant" className="max-w-full">
      <div className="flex items-center gap-2">
        <ProviderAvatar provider={m.provider} pulse={streaming} />
        <span className={cn("font-semibold text-sm", style.text)}>{style.name}</span>
        {m.model && <span className="text-muted-foreground text-xs">{m.model}</span>}
        {m.status === "interrupted" && <span className="text-muted-foreground text-xs">· stopped</span>}
      </div>
      <MessageContent className="w-full gap-3 pl-8">
        {empty && streaming && <Shimmer className="text-sm">Thinking…</Shimmer>}
        {m.parts.map((p, i) => (
          <PartView key={p.id} part={p} provider={m.provider} streaming={streaming && i === m.parts.length - 1} />
        ))}
        {!streaming && m.parts.some((p) => p.type === "text") && (
          <MessageActions className="-ml-2 opacity-70 hover:opacity-100">
            <CopyAction text={m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n")} />
          </MessageActions>
        )}
      </MessageContent>
    </Message>
  );
});

function PartView({ part, provider, streaming }: { part: Part; provider: ProviderId; streaming: boolean }) {
  switch (part.type) {
    case "text":
      return (
        <MessageResponse className="prose-twinmind" isAnimating={streaming}>
          {part.text}
        </MessageResponse>
      );
    case "reasoning":
      return (
        <Reasoning isStreaming={streaming && !part.done} defaultOpen={false}>
          <ReasoningTrigger getThinkingMessage={thinkingLabel} />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "tool":
      return <ToolCard part={part} provider={provider} />;
    case "todo": {
      const done = part.items.filter((i) => i.status === "completed").length;
      return (
        <Task defaultOpen className="rounded-xl border bg-card/60 p-3">
          <TaskTrigger title="Plan">
            <button type="button" className="flex w-full items-center gap-2 text-muted-foreground text-sm hover:text-foreground">
              <ListTodoIcon className="size-4" />
              <span>
                Plan · {done}/{part.items.length} done
              </span>
              <ChevronDownIcon className="ml-auto size-4 transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </TaskTrigger>
          <TaskContent>
            {part.items.map((it, i) => (
              <TaskItem key={i} className="flex items-start gap-2">
                {it.status === "completed" ? (
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-safe" />
                ) : it.status === "in_progress" ? (
                  <CircleDashedIcon className="mt-0.5 size-4 shrink-0 animate-spin text-codex [animation-duration:3s]" />
                ) : (
                  <CircleIcon className="mt-0.5 size-4 shrink-0" />
                )}
                <span className={cn(it.status === "completed" && "line-through opacity-60")}>{it.text}</span>
              </TaskItem>
            ))}
          </TaskContent>
        </Task>
      );
    }
    case "notice":
      return (
        <Alert variant={part.level === "error" ? "destructive" : "default"} className={cn("rounded-xl", part.level === "warning" && "border-warn/40 text-warn")}>
          {part.level === "info" ? <InfoIcon /> : <AlertTriangleIcon />}
          <AlertDescription className={cn("break-words", part.level === "warning" && "text-warn")}>{part.text}</AlertDescription>
        </Alert>
      );
    case "file":
      return <FileChip part={part} />;
  }
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <MessageAction
      label="Copy answer"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon className="size-4 text-safe" /> : <CopyIcon className="size-4" />}
    </MessageAction>
  );
}

function thinkingLabel(isStreaming: boolean, duration?: number) {
  if (isStreaming || duration === 0) return <Shimmer duration={1}>Thinking…</Shimmer>;
  if (!duration) return <p>Thought for a moment</p>;
  return <p>Thought for {duration === 1 ? "1 second" : `${duration} seconds`}</p>;
}

function FileChip({ part }: { part: Extract<Part, { type: "file" }> }) {
  const isImage = part.mediaType.startsWith("image/");
  if (isImage) {
    return (
      <a href={uploadUrl(part.uploadId)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl ring-1 ring-border">
        <img src={uploadUrl(part.uploadId)} alt={part.name} className="max-h-48 max-w-56 object-cover" loading="lazy" />
      </a>
    );
  }
  return (
    <a
      href={uploadUrl(part.uploadId)}
      className="flex max-w-64 items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm"
      target="_blank"
      rel="noreferrer"
    >
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{part.name}</span>
    </a>
  );
}

function Handoff({ to }: { to: ProviderId }) {
  const s = PROVIDER_STYLE[to];
  return (
    <div className="flex items-center gap-3 text-muted-foreground text-xs">
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        Handed over to <span className={cn("font-medium", s.text)}>{s.name}</span>
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
