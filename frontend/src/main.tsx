import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "./styles/global.css";
import { keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootEngine } from "./api/client";
import App from "./App";

const qc = new QueryClient({
  defaultOptions: {
    // keepPreviousData: switching symbol or timeframe swaps content in place instead of flashing a skeleton
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000, placeholderData: keepPreviousData },
  },
});

bootEngine().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
});

if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
