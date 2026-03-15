import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { api } from "../api.js";
import type { TaskRecord, TaskStats } from "../api.js";

const html = htm.bind(h);

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    pending: "var(--yellow)",
    accepted: "var(--accent)",
    executing: "var(--accent)",
    completed: "var(--green)",
    failed: "var(--red)",
    rejected: "var(--red)",
    cancelled: "var(--text-dim)",
  };
  const color = colors[state] ?? "var(--text-dim)";
  return html`<span style="color: ${color}; font-weight: 500;">${state}</span>`;
}

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [t, s] = await Promise.all([api.getTasks(showAll), api.getTaskStats()]);
      setTasks(t.tasks);
      setStats(s);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [showAll]);
  useEffect(() => {
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [showAll]);

  if (loading) return html`<div class="loading">Loading tasks...</div>`;

  return html`
    <div class="card-header" style="margin-bottom: 20px;">
      <h1>Tasks</h1>
      <div style="display: flex; gap: 8px; align-items: center;">
        <label style="font-size: 13px; color: var(--text-dim); cursor: pointer;">
          <input type="checkbox" checked=${showAll} onChange=${() => setShowAll(!showAll)} style="margin-right: 4px;" />
          Show all
        </label>
        <button onClick=${load}>Refresh</button>
      </div>
    </div>

    ${stats && html`
      <div class="stats">
        <div class="stat">
          <div class="stat-value">${stats.total}</div>
          <div class="stat-label">Total</div>
        </div>
        <div class="stat">
          <div class="stat-value" style="color: var(--accent)">${stats.active}</div>
          <div class="stat-label">Active</div>
        </div>
        ${Object.entries(stats.by_state).filter(([, v]) => v > 0).map(([k, v]) => html`
          <div class="stat">
            <div class="stat-value">${v}</div>
            <div class="stat-label">${k}</div>
          </div>
        `)}
      </div>
    `}

    <div class="card">
      ${tasks.length === 0
        ? html`<p style="color: var(--text-dim); padding: 12px 0;">No tasks found.</p>`
        : html`
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Direction</th>
                <th>Peer</th>
                <th>Type</th>
                <th>State</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              ${tasks.map((t) => html`
                <tr key=${t.task_id}>
                  <td style="font-family: var(--mono); font-size: 12px;">${t.task_id.slice(0, 8)}</td>
                  <td>${t.direction}</td>
                  <td style="font-family: var(--mono); font-size: 12px;">${t.peer_claw_id}</td>
                  <td>${t.task.task_type}</td>
                  <td><${StateBadge} state=${t.state} /></td>
                  <td style="color: var(--text-dim); font-size: 12px;">${new Date(t.created_at).toLocaleString()}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `
      }
    </div>
  `;
}
