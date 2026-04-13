const api = {
  requirements: "/api/requirements",
  conflicts: "/api/conflicts",
  relationships: "/api/relationships",
  traceability: "/api/traceability",
  dashboard: "/api/dashboard",
  graph: "/api/graph",
};

let typeChart;
let priorityChart;
let graphInstance;

function setMessage(id, message, ok = true) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.className = `mt-2 text-sm ${ok ? "text-emerald-700" : "text-rose-700"}`;
}

function formToObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function renderKPIs(dashboard) {
  const cards = [
    ["Total Requirements", dashboard.total_requirements, "bg-cyan-600"],
    ["FR", dashboard.fr, "bg-blue-600"],
    ["NFR", dashboard.nfr, "bg-indigo-600"],
    ["Conflicts", dashboard.conflicts, "bg-rose-600"],
    ["Duplicates", dashboard.duplicates, "bg-amber-600"],
  ];

  const root = document.getElementById("kpi-cards");
  root.innerHTML = cards
    .map(
      ([label, value, color]) => `
      <article class="rounded-2xl ${color} p-4 text-white shadow">
        <p class="text-xs uppercase tracking-wide">${label}</p>
        <p class="mt-1 text-2xl font-bold">${value}</p>
      </article>
    `
    )
    .join("");
}

function renderEmptyTableState(message) {
  document.getElementById("requirementsBody").innerHTML = `
    <tr>
      <td class="px-2 py-8 text-center text-slate-500" colspan="7">${message}</td>
    </tr>
  `;
}

function renderEmptyGraphState(message) {
  const container = document.getElementById("graph");
  if (graphInstance) {
    graphInstance.destroy();
    graphInstance = null;
  }
  container.innerHTML = `<div class="flex h-full items-center justify-center text-sm text-slate-500">${message}</div>`;
}

function renderCharts(dashboard) {
  const typeCtx = document.getElementById("typeChart").getContext("2d");
  const priorityCtx = document.getElementById("priorityChart").getContext("2d");

  if (typeChart) typeChart.destroy();
  if (priorityChart) priorityChart.destroy();

  typeChart = new Chart(typeCtx, {
    type: "pie",
    data: {
      labels: ["FR", "NFR"],
      datasets: [{
        data: [dashboard.fr, dashboard.nfr],
        backgroundColor: ["#0284c7", "#0f766e"],
      }],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });

  priorityChart = new Chart(priorityCtx, {
    type: "bar",
    data: {
      labels: ["low", "medium", "high"],
      datasets: [{
        label: "Requirements",
        data: [
          dashboard.priority.low || 0,
          dashboard.priority.medium || 0,
          dashboard.priority.high || 0,
        ],
        backgroundColor: ["#22c55e", "#f59e0b", "#ef4444"],
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true } },
    },
  });
}

function requirementRow(req) {
  const template = `${req.actor || "?"} - ${req.action || "?"} - ${req.object || "?"} - ${req.constraint || "?"}`;
  return `
    <tr class="border-b">
      <td class="px-2 py-2 font-mono text-xs">${req.id}</td>
      <td class="px-2 py-2">${req.title}</td>
      <td class="px-2 py-2">${req.type}</td>
      <td class="px-2 py-2">${req.priority}</td>
      <td class="px-2 py-2 text-xs">${template}</td>
      <td class="px-2 py-2">${req.conflict_flag ? "Yes" : "No"}</td>
      <td class="px-2 py-2">
        <button class="rounded bg-rose-600 px-2 py-1 text-xs text-white" data-delete="${req.id}">Delete</button>
      </td>
    </tr>
  `;
}

async function loadRequirements() {
  const type = document.getElementById("filterType").value;
  const priority = document.getElementById("filterPriority").value;
  const query = new URLSearchParams();
  if (type) query.set("type", type);
  if (priority) query.set("priority", priority);
  const data = await fetchJSON(`${api.requirements}?${query.toString()}`);

  const body = document.getElementById("requirementsBody");
  if (!data.length) {
    renderEmptyTableState("No requirements found. Demo data will load automatically on first access if the database is empty.");
    return;
  }
  body.innerHTML = data.map(requirementRow).join("");

  body.querySelectorAll("button[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await fetchJSON(`${api.requirements}/${btn.dataset.delete}`, { method: "DELETE" });
        await refreshAll();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

async function loadDashboard() {
  const dashboard = await fetchJSON(api.dashboard);
  renderKPIs(dashboard);
  renderCharts(dashboard);
}

function relationColor(type) {
  if (type === "conflicts_with") return "#dc2626";
  if (type === "duplicates") return "#ca8a04";
  return "#2563eb";
}

async function loadGraph() {
  const data = await fetchJSON(api.graph);
  if (!data.nodes.length) {
    renderEmptyGraphState("No graph data yet");
    return;
  }

  const nodes = new vis.DataSet(
    data.nodes.map((n) => ({
      id: n.id,
      label: `${n.id}\n${n.title}`,
      color: n.conflict_flag ? "#fecaca" : n.type === "FR" ? "#bfdbfe" : "#bbf7d0",
      shape: "box",
      margin: 8,
    }))
  );

  const edges = new vis.DataSet(
    data.edges.map((e, idx) => ({
      id: `${idx}-${e.source}-${e.target}`,
      from: e.source,
      to: e.target,
      arrows: "to",
      label: e.relation_type,
      color: relationColor(e.relation_type),
    }))
  );

  const container = document.getElementById("graph");
  const options = {
    physics: { stabilization: false },
    nodes: { font: { size: 12 } },
    edges: { font: { align: "middle", size: 10 } },
  };

  if (graphInstance) {
    graphInstance.destroy();
  }
  container.innerHTML = "";
  graphInstance = new vis.Network(container, { nodes, edges }, options);
}

function renderTraceTree(data) {
  const tree = document.getElementById("traceTree");
  const links = data.trace_links
    .map((item) => `<li><strong>${item.trace_type}</strong>: ${item.target_ref} ${item.note ? `(${item.note})` : ""}</li>`)
    .join("");

  const rels = data.relations
    .map((r) => `<li>${r.from_req_id} ${r.relation_type} ${r.to_req_id}</li>`)
    .join("");

  tree.innerHTML = `
    <div>
      <p><strong>${data.requirement.id}</strong> - ${data.requirement.title}</p>
      <p class="text-xs text-slate-500">${data.requirement.actor || "?"} - ${data.requirement.action || "?"} - ${data.requirement.object || "?"} - ${data.requirement.constraint || "?"}</p>
      <h3 class="mt-3 font-semibold">Trace Links</h3>
      <ul class="list-disc pl-5">${links || "<li>No trace links</li>"}</ul>
      <h3 class="mt-3 font-semibold">Relationships</h3>
      <ul class="list-disc pl-5">${rels || "<li>No relationships</li>"}</ul>
    </div>
  `;
}

async function refreshAll() {
  await loadDashboard();
  await loadRequirements();
  await loadGraph();
}

function bindEvents() {
  document.getElementById("requirementForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = formToObject(e.target);
    if (!data.id) delete data.id;

    try {
      await fetchJSON(api.requirements, {
        method: "POST",
        body: JSON.stringify(data),
      });
      e.target.reset();
      setMessage("requirementMessage", "Requirement saved successfully.");
      await refreshAll();
    } catch (err) {
      setMessage("requirementMessage", err.message, false);
    }
  });

  document.getElementById("scanConflictBtn").addEventListener("click", async () => {
    try {
      const data = await fetchJSON(api.conflicts);
      setMessage("requirementMessage", `Scanned. Conflicts: ${data.report.conflict_pairs_detected}, Duplicates: ${data.report.duplicate_pairs_detected}`);
      await refreshAll();
    } catch (err) {
      setMessage("requirementMessage", err.message, false);
    }
  });

  document.getElementById("applyFilterBtn").addEventListener("click", async () => {
    await loadRequirements();
  });

  document.getElementById("relationshipForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = formToObject(e.target);
    try {
      await fetchJSON(api.relationships, {
        method: "POST",
        body: JSON.stringify(data),
      });
      e.target.reset();
      setMessage("relationshipMessage", "Relationship saved.");
      await refreshAll();
    } catch (err) {
      setMessage("relationshipMessage", err.message, false);
    }
  });

  document.getElementById("traceForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = formToObject(e.target);
    try {
      await fetchJSON(api.traceability, {
        method: "POST",
        body: JSON.stringify(data),
      });
      e.target.reset();
      setMessage("traceMessage", "Trace link saved.");
    } catch (err) {
      setMessage("traceMessage", err.message, false);
    }
  });

  document.getElementById("traceLookupBtn").addEventListener("click", async () => {
    const id = document.getElementById("traceLookupId").value.trim();
    if (!id) return;
    try {
      const data = await fetchJSON(`${api.traceability}/${id}`);
      renderTraceTree(data);
    } catch (err) {
      document.getElementById("traceTree").innerHTML = `<p class='text-rose-600'>${err.message}</p>`;
    }
  });
}

(async function init() {
  bindEvents();
  await refreshAll();
})();
