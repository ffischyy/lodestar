import clsx from "clsx";
import { Check, CheckCircle2, Copy, Download, Paintbrush, Pencil, Plus, RotateCcw, Save, Trash2, Upload, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { checkTheme } from "../theme/contrast";
import { baseThemeFor, DEFAULT_PREFS, FONT_OPTIONS, prefsFromTokens, prefsToTokens, resolveTokens, useTheme, type CustomTheme, type Prefs } from "../theme/store";
import { THEMES, TOKEN_GROUPS, TOKEN_LABELS, type TokenKey, type Tokens } from "../theme/themes";
import { Sparkline } from "../components/charts/svg";
import { toast } from "../components/toast";
import { Confirm, Delta, Field, Modal, Notice, PageHead, Panel, Seg, StatusPill, Toggle } from "../components/ui";

interface Draft { id: number | null; name: string; base: string; tokens: Partial<Tokens>; prefsBefore: Prefs }

function Swatches({ t }: { t: Tokens }) {
  return (
    <div className="row" style={{ gap: 0, height: 34, borderRadius: "var(--radius-sm)", overflow: "hidden", border: "var(--line)" }} aria-hidden>
      {(["bg", "surface", "text", "accent", "up", "down"] as TokenKey[]).map((k) => <i key={k} style={{ flex: 1, height: "100%", background: t[k] }} />)}
    </div>
  );
}

const colorKeys = (t: Record<string, unknown>) => Object.fromEntries(Object.entries(t).filter(([k, v]) => !k.startsWith("pref-") && v != null && v !== "")) as Partial<Tokens>;

export default function ThemeStudioPage() {
  const st = useTheme();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [del, setDel] = useState<CustomTheme | null>(null);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const resolved = resolveTokens(st);
  const checks = useMemo(() => checkTheme(resolved.tokens), [resolved.tokens]);
  const activeCustom = st.custom.find((c) => `custom:${c.id}` === st.active);

  // live preview of colour edits across the whole app
  useEffect(() => {
    st.setPreview(draft ? draft.tokens : null);
    return () => st.setPreview(null);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadCustom = async () => {
    const c = await api.get<CustomTheme[]>("/themes");
    st.setCustom(c);
    qc.invalidateQueries({ queryKey: ["themes"] });
    return c;
  };

  /** Switch to a theme. Saved themes also bring back their text size, density, corners, font and motion. */
  const apply = (id: string, list: CustomTheme[] = st.custom) => {
    setDraft(null);
    st.setActive(id);
    const c = list.find((x) => `custom:${x.id}` === id);
    const p = prefsFromTokens(c?.tokens as Record<string, unknown> | undefined);
    if (p) st.setPrefs(p);
  };

  const startEdit = (from: string, asNew = false, name?: string) => {
    const { def, custom } = baseThemeFor(from, st.custom);
    setDraft({ id: asNew ? null : custom?.id ?? null, name: name ?? (custom && !asNew ? custom.name : `My ${def.name}`), base: def.id,
      tokens: { ...colorKeys((custom?.tokens ?? {}) as Record<string, unknown>) }, prefsBefore: { ...st.prefs } });
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const persist = async (name: string, id: number | null) => {
    if (!draft) return;
    const tokens = { ...colorKeys(draft.tokens as Record<string, unknown>), ...prefsToTokens(useTheme.getState().prefs) };
    try {
      const body = { name: name.trim(), base: draft.base, tokens };
      const r = id ? await api.put<CustomTheme>(`/themes/${id}`, body) : await api.post<CustomTheme>("/themes", body);
      const list = await reloadCustom();
      setDraft(null);
      setSaveAs(null);
      apply(`custom:${r.id}`, list);
      toast("success", `Saved theme "${r.name}"`, "It is now active. Find it any time under Your themes.");
    } catch (e) { toast("error", "Theme not saved", errMsg(e)); }
  };

  const discard = () => {
    if (draft) st.setPrefs(draft.prefsBefore);
    setDraft(null);
  };

  const exportTheme = async (c: CustomTheme) => {
    const json = JSON.stringify({ lodestar_theme: 1, name: c.name, base: c.base, tokens: c.tokens }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${c.name.replace(/[^\w-]+/g, "_")}.lodestar-theme.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const duplicate = async (c: CustomTheme) => {
    try {
      const r = await api.post<CustomTheme>("/themes", { name: `${c.name} copy`.slice(0, 80), base: c.base, tokens: c.tokens });
      await reloadCustom();
      toast("success", `Created "${r.name}"`);
    } catch (e) { toast("error", "Could not duplicate", errMsg(e)); }
  };

  const base = draft ? THEMES.find((t) => t.id === draft.base)!.tokens : null;
  const editingName = draft ? (draft.id ? `Editing "${draft.name}"` : "New theme (not saved yet)") : "";

  return (
    <div className="page">
      <PageHead title="Theme studio"
        sub="Colours, font, size, density, corners and animation, saved as your own theme"
        actions={<>
          <button className="btn" onClick={() => setImportOpen(true)}><Upload size={16} /> Import</button>
          <button className="btn" onClick={() => startEdit(st.active, !activeCustom)}><Paintbrush size={16} /> Customise current theme</button>
          <button className="btn primary" onClick={() => setNewOpen(true)}><Plus size={16} /> Create new theme</button>
        </>} />
      <div className="grid g-12">
        <div className="span-8 stack lg">
          <Panel title="Your themes" hint={st.custom.length ? `${st.custom.length} saved` : "None saved yet"}>
            {st.custom.length === 0 ? (
              <div className="row wrap" style={{ gap: 12, justifyContent: "space-between" }}>
                <p className="small muted" style={{ margin: 0 }}>Start from any built-in theme, change what you like, then save it with your own name. It appears here, ready to switch to.</p>
                <button className="btn primary" onClick={() => setNewOpen(true)}><Plus size={16} /> Create new theme</button>
              </div>
            ) : (
              <div className="grid cols-3">
                {st.custom.map((c) => {
                  const r = resolveTokens({ active: `custom:${c.id}`, prefs: st.prefs, custom: st.custom, preview: null });
                  const on = st.active === `custom:${c.id}`;
                  return (
                    <div key={c.id} className={clsx("theme-card", on && "on")}>
                      <button className="theme-card-main" onClick={() => apply(`custom:${c.id}`)} aria-pressed={on} title={`Use ${c.name}`}>
                        <Swatches t={r.tokens} />
                        <span className="row" style={{ gap: 8 }}><b className="grow truncate">{c.name}</b>{on && <Check size={16} className="up" aria-label="active" />}</span>
                        <span className="xs faint">Based on {THEMES.find((t) => t.id === c.base)?.name ?? c.base}</span>
                      </button>
                      <span className="row" style={{ gap: 2 }}>
                        <button className="btn ghost sm icon" aria-label={`Edit ${c.name}`} title="Edit" onClick={() => { apply(`custom:${c.id}`); startEdit(`custom:${c.id}`); }}><Pencil size={16} /></button>
                        <button className="btn ghost sm icon" aria-label={`Duplicate ${c.name}`} title="Duplicate" onClick={() => duplicate(c)}><Copy size={16} /></button>
                        <button className="btn ghost sm icon" aria-label={`Export ${c.name}`} title="Export to a file" onClick={() => exportTheme(c)}><Download size={16} /></button>
                        <span className="grow" />
                        <button className="btn ghost sm icon" aria-label={`Delete ${c.name}`} title="Delete" onClick={() => setDel(c)}><Trash2 size={16} /></button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="Built-in themes" hint="Pick one to use, or as a starting point for your own">
            <div className="grid cols-3">
              {THEMES.map((t) => (
                <div key={t.id} className={clsx("theme-card", st.active === t.id && "on")}>
                  <button className="theme-card-main" onClick={() => apply(t.id)} aria-pressed={st.active === t.id}>
                    <Swatches t={t.tokens} />
                    <span className="row" style={{ gap: 8 }}><b className="grow">{t.name}</b>{st.active === t.id && <Check size={16} className="up" aria-label="active" />}</span>
                    <span className="xs faint" style={{ whiteSpace: "normal" }}>{t.description}</span>
                  </button>
                  <button className="btn ghost sm" onClick={() => { apply(t.id); startEdit(t.id, true); }}><Paintbrush size={16} /> Make my own from this</button>
                </div>
              ))}
            </div>
          </Panel>

          {draft && base && (
            <div ref={editorRef}>
              <Panel title={editingName} hint="Every change previews live across the whole app"
                actions={<>
                  <button className="btn ghost sm" onClick={() => { setDraft({ ...draft, tokens: {} }); st.setPrefs(DEFAULT_PREFS); }}><RotateCcw size={16} /> Reset to {THEMES.find((t) => t.id === draft.base)?.name}</button>
                  <button className="btn sm" onClick={discard}>Discard</button>
                  {draft.id && <button className="btn sm" onClick={() => setSaveAs(`${draft.name} copy`)}>Save as new…</button>}
                  <button className="btn primary sm" disabled={!draft.name.trim()} onClick={() => (draft.id ? persist(draft.name, draft.id) : setSaveAs(draft.name))}>
                    <Save size={16} /> {draft.id ? "Save changes" : "Save theme…"}
                  </button>
                </>}>
                <div className="stack lg">
                  <div className="form-grid" style={{ gridTemplateColumns: "2fr 1fr" }}>
                    <Field label="Theme name"><input className="input" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                    <Field label="Starting point">
                      <select className="select" value={draft.base} onChange={(e) => setDraft({ ...draft, base: e.target.value })}>
                        {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </Field>
                  </div>
                  <LookControls />
                  {TOKEN_GROUPS.map((g) => (
                    <div key={g.label}>
                      <div className="section-title">{g.label}</div>
                      <div className="grid auto-fill" style={{ gap: 8 }}>
                        {g.keys.map((k) => {
                          const v = (draft.tokens[k] ?? base[k]) as string;
                          return (
                            <label key={k} className="row small" style={{ gap: 8 }}>
                              <input type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : "#000000"} onChange={(e) => setDraft({ ...draft, tokens: { ...draft.tokens, [k]: e.target.value } })} aria-label={TOKEN_LABELS[k] ?? k} />
                              <span className="grow">{TOKEN_LABELS[k] ?? k}</span>
                              <span className="num faint xs">{v}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                    <button className="btn" onClick={discard}>Discard</button>
                    <button className="btn primary" disabled={!draft.name.trim()} onClick={() => (draft.id ? persist(draft.name, draft.id) : setSaveAs(draft.name))}>
                      <Save size={16} /> {draft.id ? "Save changes" : "Save theme…"}
                    </button>
                  </div>
                </div>
              </Panel>
            </div>
          )}

          {!draft && (
            <Panel title="Text, layout and motion" hint="Changes the current look"
              actions={<button className="btn primary sm" onClick={() => startEdit(st.active, !activeCustom)}><Save size={16} /> Save this look as a theme…</button>}>
              <LookControls />
            </Panel>
          )}
        </div>

        <div className="span-4 stack lg">
          <Panel title="Now using" hint={draft ? "Previewing changes" : undefined}>
            <div className="stack">
              <b>{draft ? draft.name || "Unnamed" : resolved.name}</b>
              <Swatches t={resolved.tokens} />
            </div>
          </Panel>
          <Panel title="Readability check" hint={resolved.name}>
            <div className="stack" style={{ gap: 8 }}>
              {checks.map((c) => (
                <div key={c.label} className="row small" style={{ gap: 8 }}>
                  {c.pass ? <CheckCircle2 size={16} className="up" aria-label="passes" /> : <XCircle size={16} className="down" aria-label="fails" />}
                  <span className="grow">{c.label}</span>
                  <span className={`num ${c.pass ? "" : "down"}`}>{c.ratio ? c.ratio.toFixed(1) : "—"}:1</span>
                </div>
              ))}
            </div>
            {checks.some((c) => !c.pass) && <div style={{ marginTop: 12 }}><Notice kind="warn">Some pairs fall below WCAG minimums (4.5:1 for text, 3:1 for marks). Numbers may be hard to read.</Notice></div>}
          </Panel>
          <Panel title="Preview">
            <div className="stack lg">
              <div className="row between"><span className="sym">NVDA</span><StatusPill status="live" /></div>
              <div className="row between"><span className="num" style={{ fontSize: "var(--fs-xl)", fontWeight: 500 }}>912.44</span><Delta value={2.31} /></div>
              <div className="row between"><span className="muted">Losers</span><Delta value={-1.18} /></div>
              <Sparkline values={[3, 4, 3.6, 5, 4.4, 6, 5.8, 7.1]} width={240} height={36} />
              <div className="row wrap"><button className="btn primary sm">Primary</button><button className="btn sm">Secondary</button><button className="btn buy sm">Buy</button><button className="btn sell sm">Sell</button></div>
              <div className="row wrap"><span className="badge up">▲ Long</span><span className="badge down">▼ Short</span><span className="badge warn">warning</span><StatusPill status="simulated" /><StatusPill status="delayed" /></div>
              <input className="input" placeholder="Input field" />
            </div>
          </Panel>
        </div>
      </div>

      {newOpen && <NewThemeDialog onClose={() => setNewOpen(false)} onStart={(baseId, name) => { setNewOpen(false); apply(baseId); startEdit(baseId, true, name); }} />}
      {saveAs !== null && (
        <Modal title="Save theme" onClose={() => setSaveAs(null)}
          foot={<><button className="btn" onClick={() => setSaveAs(null)}>Cancel</button>
            <button className="btn primary" disabled={!saveAs.trim()}
              onClick={() => persist(saveAs, null)}><Save size={16} /> Save</button></>}>
          <div className="stack">
            <Field label="Name your theme" help="Colours, font, text size, density, corners and animation save together">
              <input className="input" value={saveAs} autoFocus maxLength={80} onChange={(e) => setSaveAs(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && saveAs.trim()) persist(saveAs, null); }} />
            </Field>
            {st.custom.some((c) => c.name.toLowerCase() === saveAs.trim().toLowerCase()) && <span className="xs warn">You already have a theme called this. Saving creates a second one.</span>}
          </div>
        </Modal>
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onDone={async (id) => { setImportOpen(false); const list = await reloadCustom(); apply(`custom:${id}`, list); }} />}
      {del && <Confirm title={`Delete "${del.name}"?`} danger confirmLabel="Delete theme" body="Switches back to Meridian if this theme is active. This can't be undone (export it first to keep a copy)."
        onCancel={() => setDel(null)} onConfirm={async () => { await api.del(`/themes/${del.id}`); if (st.active === `custom:${del.id}`) apply("meridian"); setDel(null); await reloadCustom(); }} />}
    </div>
  );
}

/** Font, text size, density, corners, borders, shadows and animation (saved with the theme). */
function LookControls() {
  const st = useTheme();
  return (
    <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
      <Field label="Font">
        <select className="select" value={st.prefs.font ?? ""} onChange={(e) => st.setPrefs({ font: e.target.value || null })}>
          <option value="">Theme default</option>
          {FONT_OPTIONS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
        </select>
      </Field>
      <Field label={`Text size ${Math.round(st.prefs.fontScale * 100)}%`}>
        <input type="range" min={0.85} max={1.25} step={0.05} value={st.prefs.fontScale} onChange={(e) => st.setPrefs({ fontScale: +e.target.value })} />
      </Field>
      <Field label={`Corner roundness ${Math.round(st.prefs.radiusScale * 100)}%`}>
        <input type="range" min={0} max={2} step={0.25} value={st.prefs.radiusScale} onChange={(e) => st.setPrefs({ radiusScale: +e.target.value })} />
      </Field>
      <Field label="Spacing">
        <Seg label="Density" value={st.prefs.density} onChange={(v) => st.setPrefs({ density: v })}
          options={[{ value: "theme", label: "Theme" }, { value: "compact", label: "Compact" }, { value: "comfortable", label: "Roomy" }]} />
      </Field>
      <Field label="Animation">
        <Seg label="Animation" value={st.prefs.motion} onChange={(v) => st.setPrefs({ motion: v })}
          options={[{ value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }, { value: "off", label: "Off" }]} />
      </Field>
      <Field label="Borders">
        <Seg label="Borders" value={st.prefs.borders} onChange={(v) => st.setPrefs({ borders: v })}
          options={[{ value: "theme", label: "Theme" }, { value: "strong", label: "Strong" }]} />
      </Field>
      <Field label="Shadows"><Toggle checked={st.prefs.shadows} onChange={(v) => st.setPrefs({ shadows: v })} label={st.prefs.shadows ? "On" : "Off"} /></Field>
    </div>
  );
}

function NewThemeDialog({ onClose, onStart }: { onClose: () => void; onStart: (base: string, name: string) => void }) {
  const [name, setName] = useState("");
  const [base, setBase] = useState(THEMES[0].id);
  return (
    <Modal title="Create a new theme" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim()} onClick={() => onStart(base, name.trim())}><Paintbrush size={16} /> Start editing</button></>}>
      <div className="stack lg">
        <Field label="Name"><input className="input" autoFocus value={name} maxLength={80} placeholder="e.g. Night shift" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onStart(base, name.trim()); }} /></Field>
        <div className="stack" style={{ gap: 8 }}>
          <span className="field-label">Start from</span>
          <div className="grid cols-2">
            {THEMES.map((t) => (
              <button key={t.id} type="button" className={clsx("theme-card-main pick", base === t.id && "on")} onClick={() => setBase(t.id)} aria-pressed={base === t.id}>
                <Swatches t={t.tokens} /><b>{t.name}</b>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    try {
      const v = JSON.parse(text);
      if (!v || typeof v.name !== "string" || typeof v.tokens !== "object") throw new Error("This doesn't look like a Lodestar theme file.");
      const r = await api.post<CustomTheme>("/themes", { name: v.name.slice(0, 80), base: THEMES.some((t) => t.id === v.base) ? v.base : "meridian", tokens: v.tokens });
      toast("success", `Imported "${r.name}"`);
      onDone(r.id);
    } catch (e) { setErr(e instanceof SyntaxError ? "That isn't valid theme text." : errMsg(e)); }
  };
  const onFile = async (f: File | undefined) => { if (f) setText(await f.text()); };
  return (
    <Modal title="Import a theme" onClose={onClose}
      foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!text.trim()} onClick={go}><Upload size={16} /> Import</button></>}>
      <div className="stack">
        <input type="file" accept=".json,application/json" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Theme file" />
        <textarea className="input" style={{ height: 160, fontFamily: "var(--font-num)", padding: 8 }} placeholder="…or paste the theme text here" value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} />
        {err && <span className="xs down">{err}</span>}
      </div>
    </Modal>
  );
}
