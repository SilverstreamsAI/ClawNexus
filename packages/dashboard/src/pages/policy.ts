import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { api } from "../api.js";
import type { PolicyConfig } from "../api.js";

const html = htm.bind(h);

export function PolicyPage({ showToast }: { showToast: (msg: string, type: "ok" | "err") => void }) {
  const [policy, setPolicy] = useState<PolicyConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const p = await api.getPolicy();
      setPolicy(p);
      setEditText(JSON.stringify(p, null, 2));
    } catch (err) {
      showToast(`Failed to load policy: ${err}`, "err");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    try {
      const parsed = JSON.parse(editText) as PolicyConfig;
      const res = await api.updatePolicy(parsed);
      setPolicy(res.policy);
      setEditText(JSON.stringify(res.policy, null, 2));
      setEditing(false);
      showToast("Policy updated");
    } catch (err) {
      showToast(`Invalid policy: ${err}`, "err");
    }
  };

  const handleReset = async () => {
    try {
      const res = await api.resetPolicy();
      setPolicy(res.policy);
      setEditText(JSON.stringify(res.policy, null, 2));
      setEditing(false);
      showToast("Policy reset to defaults");
    } catch (err) {
      showToast(`Reset failed: ${err}`, "err");
    }
  };

  if (loading) return html`<div class="loading">Loading policy...</div>`;

  return html`
    <div class="card-header" style="margin-bottom: 20px;">
      <h1>Policy</h1>
      <div style="display: flex; gap: 8px;">
        ${!editing && html`<button onClick=${() => setEditing(true)}>Edit</button>`}
        ${editing && html`<button class="primary" onClick=${handleSave}>Save</button>`}
        ${editing && html`<button onClick=${() => { setEditing(false); setEditText(JSON.stringify(policy, null, 2)); }}>Cancel</button>`}
        <button onClick=${handleReset} style="color: var(--red);">Reset</button>
      </div>
    </div>

    <div class="card">
      ${editing
        ? html`
          <textarea
            style="width: 100%; min-height: 400px; font-family: var(--mono); font-size: 12px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; resize: vertical;"
            value=${editText}
            onInput=${(e: Event) => setEditText((e.target as HTMLTextAreaElement).value)}
          />`
        : html`<pre class="code-block">${JSON.stringify(policy, null, 2)}</pre>`
      }
    </div>
  `;
}
