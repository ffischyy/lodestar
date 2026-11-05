import { useState } from "react";
import { engineMode, probeEngine, saveTarget, savedTarget } from "../api/client";
import { toast } from "./toast";
import { Field, Panel, Spinner } from "./ui";

/** Points this site at a Lodestar engine. An empty URL means the engine that served the page, or the browser engine. */
export function EngineConnect() {
  const [t, setT] = useState(savedTarget);
  const [busy, setBusy] = useState(false);
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const target = { url: t.url.trim().replace(/\/$/, ""), token: t.token.trim() };
    const ok = await probeEngine(target, 5000);
    setBusy(false);
    if (!ok) return toast("error", "No engine answered", "Check the address, the token, and LODESTAR_CORS_ORIGINS on the engine.");
    saveTarget(target);
    location.reload();
  };
  const disconnect = () => {
    saveTarget({ url: "", token: "" });
    location.reload();
  };
  return (
    <Panel title="Your own Python engine (optional)" hint={engineMode() === "server" ? "Connected" : "Running in this browser"}>
      <form className="stack lg" onSubmit={connect}>
        <div className="form-grid">
          <Field label="Engine address"><input className="input" placeholder="https://engine.example.com" value={t.url} onChange={(e) => setT({ ...t, url: e.target.value })} /></Field>
          <Field label="Access token"><input className="input" type="password" autoComplete="off" value={t.token} onChange={(e) => setT({ ...t, token: e.target.value })} /></Field>
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy || !t.url.trim()}>{busy && <Spinner />} Connect</button>
          {savedTarget().url && <button type="button" className="btn" onClick={disconnect}>Disconnect</button>}
        </div>
      </form>
    </Panel>
  );
}
