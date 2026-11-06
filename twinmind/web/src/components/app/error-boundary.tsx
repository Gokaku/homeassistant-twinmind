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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="font-semibold text-lg">Something went wrong</h1>
        <p className="max-w-sm break-words text-muted-foreground text-sm">{this.state.error.message}</p>
        <button type="button" className="rounded-full bg-primary px-4 py-2 text-primary-foreground text-sm" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
