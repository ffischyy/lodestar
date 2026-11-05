import clsx from "clsx";
import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errMsg } from "../api/client";
import { toast } from "./toast";
import { Modal, Toggle, Tooltip } from "./ui";

/** Play-money mode. On: deposit any amount. Off: you can only use the cash already in the account. */
export function SandboxSwitch({ on, big }: { on: boolean; big?: boolean }) {
  const [open, setOpen] = useState(false);
  const [simData, setSimData] = useState(false);
  const qc = useQueryClient();
  const apply = async (enabled: boolean) => {
    try {
      await api.post("/paper/sandbox", { enabled, simulated_data: enabled && simData ? true : null });
      toast("success", enabled ? "Sandbox mode on" : "Sandbox mode off",
        enabled ? "You can deposit any amount of play money on the Trade desk." : "Deposits are locked. You can only trade the cash already in the account.");
      qc.invalidateQueries();
      setOpen(false);
    } catch (e) {
      toast("error", "Could not change Sandbox mode", errMsg(e));
    }
  };
  return (
    <>
      <Tooltip text={on ? "Sandbox mode: play money, deposit any amount. Click to change." : "Sandbox mode is off: you can only use the cash you have. Click to change."}>
        <button className={clsx("status-item sandbox-chip", on && "on", big && "big")} onClick={() => setOpen(true)} aria-pressed={on}>
          <FlaskConical size={16} /><span className="secondary">Sandbox</span><b>{on ? "On" : "Off"}</b>
        </button>
      </Tooltip>
      {open && (
        <Modal title={on ? "Turn Sandbox mode off?" : "Turn Sandbox mode on?"} onClose={() => setOpen(false)}
          foot={<><button className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn primary" onClick={() => apply(!on)}>{on ? "Turn Sandbox off" : "Turn Sandbox on"}</button></>}>
          <div className="stack lg small">
            {on ? (
              <>
                <p>With Sandbox off, the account behaves like a funded brokerage account: you can only buy with the cash you have, and you cannot deposit more.</p>
                <p className="muted">Your balance, positions and history stay exactly as they are. Withdrawals are still allowed up to your available cash.</p>
              </>
            ) : (
              <>
                <p>Sandbox mode is a no-stakes playground. You can deposit any amount of play money and try anything: manual trades, the AI autopilot, big positions.</p>
                <p className="muted">Everything stays in the paper account. Lodestar never connects to a real broker or touches real money in either mode.</p>
                <Toggle checked={simData} onChange={setSimData} label="Also switch to simulated market prices (works offline, at any time of day)" />
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
