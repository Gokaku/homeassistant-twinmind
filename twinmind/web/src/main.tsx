import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/app/error-boundary";
import "./index.css";
import { installClipboardFallback } from "./lib/clipboard";
import { connect } from "./lib/store";
import { trackColorScheme, trackVisualViewport } from "./lib/viewport";

installClipboardFallback();
trackColorScheme();
trackVisualViewport();
connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
