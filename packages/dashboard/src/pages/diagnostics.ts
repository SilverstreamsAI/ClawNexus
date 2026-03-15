import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { api } from "../api.js";
import type { DiagnosticsResponse } from "../api.js";

const html = htm.bind(h);

function DiagItem({ label, value, status }: { label: string; value: string; status?: "ok" | "warn" | "err" }) {
  const cls = status ? `diag-${status}` : "";
  return html`
    <div class="diag-item">
      <span class="diag-label">${label}</span>
      <span class="diag-value ${cls}">${value}</span>
    </div>
  `;
}

export function DiagnosticsPage() {
  const [diag, setDiag] = useState<DiagnosticsResponse | null>(null);
  const [identity, setIdentity] = useState<{ pubkey?: string; claw_name?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const [d, id] = await Promise.all([api.getDiagnostics(), api.getWhoami()]);
      setDiag(d);
      setIdentity(id);
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) return html`<div class="loading">Loading diagnostics...</div>`;
  if (error) return html`<div style="color: var(--red)">Error: ${error}</div>`;
  if (!diag) return null;

  return html`
    <div class="card-header" style="margin-bottom: 20px;">
      <h1>Diagnostics</h1>
      <button onClick=${load}>Refresh</button>
    </div>

    <div class="card">
      <div class="card-title">Identity</div>
      <${DiagItem} label="Public Key" value=${identity?.pubkey ?? "Not initialized"} status=${identity?.pubkey ? "ok" : "warn"} />
      <${DiagItem} label="Claw Name" value=${identity?.claw_name ?? "Not registered"} status=${identity?.claw_name ? "ok" : "warn"} />
    </div>

    <div class="card">
      <div class="card-title">Local Instance</div>
      <${DiagItem}
        label="OpenClaw (127.0.0.1:18789)"
        value=${diag.local_instance.agent_id ? `Detected (${diag.local_instance.agent_id})` : "Not detected"}
        status=${diag.local_instance.agent_id ? "ok" : "warn"}
      />
    </div>

    <div class="card">
      <div class="card-title">LAN Discovery</div>
      <${DiagItem} label="mDNS" value=${diag.lan_discovery.mdns} status="ok" />
      <${DiagItem}
        label="Unreachable"
        value=${diag.lan_discovery.unreachable_count === 0 ? "None" : `${diag.lan_discovery.unreachable_count} instance(s)`}
        status=${diag.lan_discovery.unreachable_count === 0 ? "ok" : "warn"}
      />
      ${diag.lan_discovery.unreachable.map((u) => html`
        <${DiagItem} label=${`  ${u.address}`} value=${u.reason} status="err" />
      `)}
    </div>

    <div class="card">
      <div class="card-title">Registry</div>
      <${DiagItem}
        label="Status"
        value=${diag.registry.status}
        status=${diag.registry.status === "registered" ? "ok" : "warn"}
      />
      ${diag.registry.claw_name ? html`<${DiagItem} label="Claw Name" value=${diag.registry.claw_name} />` : ""}
    </div>

    <div class="card">
      <div class="card-title">Relay</div>
      <${DiagItem}
        label="Status"
        value=${diag.relay.status}
        status=${diag.relay.status === "connected" ? "ok" : "warn"}
      />
    </div>

    <div class="card">
      <div class="card-title">Summary</div>
      <${DiagItem} label="Total Instances" value=${String(diag.summary.total_instances)} />
      <${DiagItem} label="LAN" value=${String(diag.summary.lan_instances)} />
      <${DiagItem} label="Relay" value=${String(diag.summary.relay_instances)} />
    </div>
  `;
}
