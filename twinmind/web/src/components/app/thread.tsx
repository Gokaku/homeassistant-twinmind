import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from "@/components/ai-elements/attachments";
import { Checkpoint, CheckpointIcon } from "@/components/ai-elements/checkpoint";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { uploadUrl } from "@/lib/api";
import type { ChatMessage, Part, ProviderId } from "@/lib/protocol";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  AlertTriangleIcon,
  ArrowLeftRightIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  ListTodoIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { Logo, PROVIDER_STYLE, ProviderAvatar } from "./brand";
import { QuestionCard } from "./question-card";
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
    <ConversationEmptyState className="relative flex-1 justify-center overflow-hidden px-6 pt-0 pb-6">
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
    </ConversationEmptyState>
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
      // AskUserQuestion is shown as a question card instead.
      if (part.name === "AskUserQuestion") return null;
      return <ToolCard part={part} provider={provider} />;
    case "question":
      return <QuestionCard part={part} />;
    case "todo": {
      const done = part.items.filter((i) => i.status === "completed").length;
      return (
        <Queue>
          <QueueSection>
            <QueueSectionTrigger>
              <QueueSectionLabel icon={<ListTodoIcon className="size-4" />} count={part.items.length} label="tasks" />
              <span className="text-xs">
                {done}/{part.items.length} done
              </span>
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {part.items.map((it, i) => (
                  <QueueItem key={i}>
                    <div className="flex items-center gap-2">
                      <QueueItemIndicator completed={it.status === "completed"} />
                      <QueueItemContent completed={it.status === "completed"}>{it.text}</QueueItemContent>
                    </div>
                    {it.status === "in_progress" && <QueueItemDescription>In progress</QueueItemDescription>}
                  </QueueItem>
                ))}
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        </Queue>
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
  const url = uploadUrl(part.uploadId);
  const isImage = part.mediaType.startsWith("image/");
  return (
    <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${part.name}`}>
      <Attachments variant={isImage ? "grid" : "inline"}>
        <Attachment data={{ id: part.id, type: "file", url, mediaType: part.mediaType, filename: part.name }} className={isImage ? "size-40" : undefined}>
          <AttachmentPreview />
          {!isImage && <AttachmentInfo />}
        </Attachment>
      </Attachments>
    </a>
  );
}

function Handoff({ to }: { to: ProviderId }) {
  const st = PROVIDER_STYLE[to];
  return (
    <Checkpoint className="gap-2 text-xs">
      <CheckpointIcon>
        <ArrowLeftRightIcon className="size-3.5 shrink-0" />
      </CheckpointIcon>
      <span className="shrink-0">
        Handed over to <span className={cn("font-medium", st.text)}>{st.name}</span>
      </span>
    </Checkpoint>
  );
}
