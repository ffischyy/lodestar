import { GO_KEYS } from "../nav";
import { Modal } from "./ui";

const GENERAL: [string, string][] = [["Ctrl K or /", "Search symbols and screens"], ["?", "Show these shortcuts"], ["Esc", "Close a dialog"]];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="kv small">
        {GENERAL.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt><span className="kbd">{k}</span></dt><dd>{v}</dd></div>)}
        {Object.entries(GO_KEYS).map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt><span className="kbd">g</span> <span className="kbd">{k}</span></dt><dd>{v.label}</dd></div>)}
      </dl>
    </Modal>
  );
}
