import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { api } from "../api.js";
import type { ClawInstance } from "../api.js";

const html = htm.bind(h);

function StatusDot({ status }: { status: string }) {
  const cls = status === "online" ? "dot-online" : status === "offline" ? "dot-offline" : "dot-unknown";
  return html`<span class="dot ${cls}"></span>`;
}

function SourceBadge({ source, isSelf }: { source: string; isSelf?: boolean }) {
  if (isSelf) return html`<span class="badge badge-self">self</span>`;
  const cls = `badge-${source}`;
  return html`<span class="badge ${cls}">${source}</span>`;
}

function AliasCell({
  instance,
  onSave,
}: {
  instance: ClawInstance;
  onSave: (id: string, alias: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(instance.alias ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return html`
      <span>
        ${instance.alias ?? html`<span style="color: var(--text-dim)">—</span>`}
        ${" "}
        <button style="padding: 1px 6px; font-size: 11px;" onClick=${() => { setValue(instance.alias ?? ""); setEditing(true); }}>
          ${instance.alias ? "edit" : "set"}
        </button>
      </span>
    `;
  }

  const save = () => {
    if (value.trim()) {
      onSave(instance.auto_name, value.trim());
    }
    setEditing(false);
  };

  return html`
    <span class="inline-edit">
      <input ref=${inputRef} type="text" value=${value} maxlength="32"
        onInput=${(e: Event) => setValue((e.target as HTMLInputElement).value)}
        onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
      />
      <button onClick=${save}>ok</button>
      <button onClick=${() => setEditing(false)}>x</button>
    </span>
  `;
}

export function InstancesPage({ showToast }: { showToast: (msg: string, type: "ok" | "err") => void }) {
  const [instances, setInstances] = useState<ClawInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const load = async () => {
    try {
      const res = await api.getInstances();
      setInstances(res.instances);
    } catch (err) {
      showToast(`Failed to load instances: ${err}`, "err");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, []);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await api.triggerScan();
      showToast(`Scan complete: ${res.discovered} instance(s) found`);
      await load();
    } catch (err) {
      showToast(`Scan failed: ${err}`, "err");
    } finally {
      setScanning(false);
    }
  };

  const handleAlias = async (id: string, alias: string) => {
    try {
      await api.setAlias(id, alias);
      showToast(`Alias "${alias}" set`);
      await load();
    } catch (err) {
      showToast(`Failed: ${err}`, "err");
    }
  };

  const online = instances.filter((i) => i.status === "online").length;

  if (loading) return html`<div class="loading">Loading instances...</div>`;

  return html`
    <div class="card-header" style="margin-bottom: 20px;">
      <h1>Instances</h1>
      <button class="primary" onClick=${handleScan} disabled=${scanning}>
        ${scanning ? "Scanning..." : "Scan Now"}
      </button>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${instances.length}</div>
        <div class="stat-label">Total Instances</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color: var(--green)">${online}</div>
        <div class="stat-label">Online</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color: var(--red)">${instances.length - online}</div>
        <div class="stat-label">Offline</div>
      </div>
    </div>

    <div class="card">
      ${instances.length === 0
        ? html`<p style="color: var(--text-dim); padding: 12px 0;">No instances discovered yet. Try scanning your network.</p>`
        : html`
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Alias</th>
                <th>Address</th>
                <th>Status</th>
                <th>Source</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              ${instances.map((inst) => html`
                <tr key=${inst.auto_name}>
                  <td>
                    <strong>${inst.auto_name}</strong>
                    ${inst.claw_name ? html` <span style="color: var(--text-dim); font-size: 11px;">(${inst.claw_name})</span>` : ""}
                  </td>
                  <td><${AliasCell} instance=${inst} onSave=${handleAlias} /></td>
                  <td style="font-family: var(--mono); font-size: 12px;">${inst.address}:${inst.gateway_port}</td>
                  <td><${StatusDot} status=${inst.status} />${inst.status}</td>
                  <td><${SourceBadge} source=${inst.discovery_source} isSelf=${inst.is_self} /></td>
                  <td style="color: var(--text-dim); font-size: 12px;">
                    ${inst.last_seen ? new Date(inst.last_seen).toLocaleString() : "—"}
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `
      }
    </div>
  `;
}
