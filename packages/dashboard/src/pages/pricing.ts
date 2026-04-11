import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { api } from "../api.js";
import type { PricingModel } from "../api.js";

const html = htm.bind(h);

type SortKey = "name" | "provider" | "prompt" | "completion" | "context_length";
type SortDir = "asc" | "desc";

function formatPrice(value: number): string {
  if (value === 0) return "—";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatContext(len: number): string {
  if (len === 0) return "—";
  if (len >= 1_000_000) return `${(len / 1_000_000).toFixed(1)}M`;
  if (len >= 1_000) return `${(len / 1_000).toFixed(0)}K`;
  return String(len);
}

function sortModels(models: PricingModel[], key: SortKey, dir: SortDir): PricingModel[] {
  const sorted = [...models].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "provider":
        cmp = a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name);
        break;
      case "prompt":
        cmp = a.pricing.prompt - b.pricing.prompt;
        break;
      case "completion":
        cmp = a.pricing.completion - b.pricing.completion;
        break;
      case "context_length":
        cmp = a.context_length - b.context_length;
        break;
    }
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = currentKey === sortKey;
  const arrow = active ? (currentDir === "asc" ? " \u25B2" : " \u25BC") : "";
  return html`
    <th class="sortable ${className ?? ""}" onClick=${() => onSort(sortKey)}>
      ${label}${arrow}
    </th>
  `;
}

export function PricingPage() {
  const [models, setModels] = useState<PricingModel[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fetchedAt, setFetchedAt] = useState("");

  const [search, setSearch] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("provider");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const load = async () => {
    try {
      setError("");
      const [pricingRes, provRes] = await Promise.all([
        selectedProvider ? api.getPricing(selectedProvider) : api.getPricing(),
        api.getPricingProviders(),
      ]);
      setModels(pricingRes.models);
      setFetchedAt(pricingRes.fetched_at);
      setProviders(provRes.providers);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("pricing_data_not_available") || msg.includes("503")) {
        setError("Pricing data not available yet. The daemon will fetch it shortly.");
      } else {
        setError(`Failed to load pricing data: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [selectedProvider]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filtered = search
    ? models.filter(
        (m) =>
          m.name.toLowerCase().includes(search.toLowerCase()) ||
          m.id.toLowerCase().includes(search.toLowerCase()),
      )
    : models;

  const sorted = sortModels(filtered, sortKey, sortDir);

  if (loading) return html`<div class="loading">Loading pricing data...</div>`;

  return html`
    <div class="card-header" style="margin-bottom: 20px;">
      <h1>LLM Pricing</h1>
      <button onClick=${() => { setLoading(true); load(); }}>Refresh</button>
    </div>

    ${error
      ? html`<div class="card" style="color: var(--yellow); padding: 16px 20px;">${error}</div>`
      : html`
          <div class="stats">
            <div class="stat">
              <div class="stat-value">${models.length}</div>
              <div class="stat-label">Models</div>
            </div>
            <div class="stat">
              <div class="stat-value">${providers.length}</div>
              <div class="stat-label">Providers</div>
            </div>
            <div class="stat">
              <div class="stat-value" style="font-size: 16px; font-family: var(--mono);">
                ${fetchedAt ? new Date(fetchedAt).toLocaleString() : "—"}
              </div>
              <div class="stat-label">Last Updated</div>
            </div>
          </div>

          <div class="pricing-toolbar">
            <input
              type="text"
              placeholder="Search models..."
              value=${search}
              onInput=${(e: Event) => setSearch((e.target as HTMLInputElement).value)}
            />
            <select
              value=${selectedProvider}
              onChange=${(e: Event) => {
                setSelectedProvider((e.target as HTMLSelectElement).value);
                setLoading(true);
              }}
            >
              <option value="">All providers</option>
              ${providers.map((p) => html`<option value=${p}>${p}</option>`)}
            </select>
            ${search && html`
              <span style="color: var(--text-dim); font-size: 13px;">
                ${filtered.length} of ${models.length} models
              </span>
            `}
          </div>

          <div class="card">
            ${sorted.length === 0
              ? html`<p style="color: var(--text-dim); padding: 12px 0;">No models found.</p>`
              : html`
                  <table>
                    <thead>
                      <tr>
                        <${SortHeader} label="Model" sortKey="name" currentKey=${sortKey} currentDir=${sortDir} onSort=${handleSort} />
                        <${SortHeader} label="Provider" sortKey="provider" currentKey=${sortKey} currentDir=${sortDir} onSort=${handleSort} />
                        <${SortHeader} label="Input $/MTok" sortKey="prompt" currentKey=${sortKey} currentDir=${sortDir} onSort=${handleSort} className="price-col" />
                        <${SortHeader} label="Output $/MTok" sortKey="completion" currentKey=${sortKey} currentDir=${sortDir} onSort=${handleSort} className="price-col" />
                        <${SortHeader} label="Context" sortKey="context_length" currentKey=${sortKey} currentDir=${sortDir} onSort=${handleSort} className="price-col" />
                        <th>Modalities</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${sorted.map(
                        (m) => html`
                          <tr key=${m.id}>
                            <td>
                              <strong>${m.name}</strong>
                              <div style="color: var(--text-dim); font-size: 11px; font-family: var(--mono);">${m.id}</div>
                            </td>
                            <td>${m.provider}</td>
                            <td class="price-cell">${formatPrice(m.pricing.prompt)}</td>
                            <td class="price-cell">${formatPrice(m.pricing.completion)}</td>
                            <td class="price-cell">${formatContext(m.context_length)}</td>
                            <td style="font-size: 12px; color: var(--text-dim);">
                              ${[...m.input_modalities, ...m.output_modalities.filter((o) => !m.input_modalities.includes(o))].join(", ")}
                            </td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                `}
          </div>
        `}
  `;
}
