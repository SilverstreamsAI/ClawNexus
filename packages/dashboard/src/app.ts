import { h, render } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { api } from "./api.js";
import type { HealthResponse } from "./api.js";
import { InstancesPage } from "./pages/instances.js";
import { DiagnosticsPage } from "./pages/diagnostics.js";
import { TasksPage } from "./pages/tasks.js";
import { PolicyPage } from "./pages/policy.js";

const html = htm.bind(h);

type Page = "instances" | "diagnostics" | "tasks" | "policy";

function getPage(): Page {
  const hash = location.hash.replace("#", "") || "instances";
  if (["instances", "diagnostics", "tasks", "policy"].includes(hash)) return hash as Page;
  return "instances";
}

function Nav({ page, version }: { page: Page; version: string }) {
  return html`
    <nav>
      <div class="logo">
        ClawNexus
        <span>Dashboard${version ? ` v${version}` : ""}</span>
      </div>
      <a href="#instances" class=${page === "instances" ? "active" : ""}>Instances</a>
      <a href="#diagnostics" class=${page === "diagnostics" ? "active" : ""}>Diagnostics</a>
      <a href="#tasks" class=${page === "tasks" ? "active" : ""}>Tasks</a>
      <a href="#policy" class=${page === "policy" ? "active" : ""}>Policy</a>
    </nav>
  `;
}

function Toast({
  message,
  type,
  onDone,
}: {
  message: string;
  type: "ok" | "err";
  onDone: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, []);
  return html`<div class="toast toast-${type}">${message}</div>`;
}

function App() {
  const [page, setPage] = useState<Page>(getPage());
  const [version, setVersion] = useState("");
  const [toast, setToast] = useState<{ message: string; type: "ok" | "err" } | null>(null);

  const showToast = useCallback((message: string, type: "ok" | "err" = "ok") => {
    setToast({ message, type });
  }, []);

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api
      .getHealth()
      .then((h: HealthResponse) => setVersion(h.version))
      .catch(() => {});
  }, []);

  const pageComponent = {
    instances: html`<${InstancesPage} showToast=${showToast} />`,
    diagnostics: html`<${DiagnosticsPage} />`,
    tasks: html`<${TasksPage} />`,
    policy: html`<${PolicyPage} showToast=${showToast} />`,
  }[page];

  return html`
    <${Nav} page=${page} version=${version} />
    <main>${pageComponent}</main>
    ${toast &&
    html`<${Toast} message=${toast.message} type=${toast.type} onDone=${() => setToast(null)} />`}
  `;
}

render(html`<${App} />`, document.getElementById("app")!);
