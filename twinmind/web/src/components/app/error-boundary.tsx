import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { TriangleAlertIcon } from "lucide-react";
import { Component, type ReactNode } from "react";

/** Last line of defence: show a reload button instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[twinmind] UI crashed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription className="break-words">{this.state.error.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => location.reload()}>Reload</Button>
        </EmptyContent>
      </Empty>
    );
  }
}
