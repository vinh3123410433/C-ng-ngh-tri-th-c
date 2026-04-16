const api = {
  requirements: "/api/requirements",
  conflicts: "/api/conflicts",
  relationships: "/api/relationships",
  traceability: "/api/traceability",
  dashboard: "/api/dashboard",
  graph: "/api/graph",
  resetDemo: "/api/demo/reset",
};

let typeChart;
let priorityChart;
let graphInstance;

function showNotice(message, ok = true) {
  const el = document.getElementById("globalNotice");
  if (!el) return;
  el.textContent = message;
  el.className = ok
    ? "mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
    : "mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700";
  el.classList.remove("hidden");

  window.clearTimeout(showNotice._timer);
  showNotice._timer = window.setTimeout(() => {
    el.classList.add("hidden");
  }, 3200);
}

function setButtonLoading(button, isLoading, loadingText = "Đang xử lý...") {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.classList.add("opacity-70", "cursor-not-allowed");
    button.textContent = loadingText;
    return;
  }
  button.disabled = false;
  button.classList.remove("opacity-70", "cursor-not-allowed");
  button.textContent = button.dataset.originalText || button.textContent;
}

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function renderKPIs(dashboard) {
  const cards = [
    ["Tổng yêu cầu", dashboard.total_requirements, "bg-cyan-600"],
    ["FR", dashboard.fr, "bg-blue-600"],
    ["NFR", dashboard.nfr, "bg-indigo-600"],
    ["Xung đột", dashboard.conflicts, "bg-rose-600"],
    ["Trùng lặp", dashboard.duplicates, "bg-amber-600"],
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

function priorityLabel(priority) {
  if (priority === "low") return "Thấp";
  if (priority === "medium") return "Trung bình";
  if (priority === "high") return "Cao";
  return priority;
}

function sourceLabel(source) {
  if (source === "user") return "Người dùng";
  if (source === "stakeholder") return "Bên liên quan";
  if (source === "system") return "Hệ thống";
  return source;
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
      labels: ["Thấp", "Trung bình", "Cao"],
      datasets: [{
        label: "Số lượng yêu cầu",
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
      <td class="px-2 py-2">${priorityLabel(req.priority)}</td>
      <td class="px-2 py-2 text-xs">${template}</td>
      <td class="px-2 py-2">${req.conflict_flag ? "Có" : "Không"}</td>
      <td class="px-2 py-2">
        <button class="rounded bg-rose-600 px-2 py-1 text-xs text-white" data-delete="${req.id}">Xóa</button>
      </td>
    </tr>
  `;
}

async function loadRequirements() {
  const type = document.getElementById("filterType").value;
  const priority = document.getElementById("filterPriority").value;
  const keyword = document.getElementById("filterKeyword").value.trim().toLowerCase();
  const query = new URLSearchParams();
  if (type) query.set("type", type);
  if (priority) query.set("priority", priority);
  const rawData = await fetchJSON(`${api.requirements}?${query.toString()}`);
  const data = keyword
    ? rawData.filter((req) => {
      const haystack = `${req.id || ""} ${req.title || ""} ${req.description || ""}`.toLowerCase();
      return haystack.includes(keyword);
    })
    : rawData;

  const info = document.getElementById("filterResultInfo");
  if (info) {
    info.textContent = `Hiển thị ${data.length}/${rawData.length} yêu cầu`;
  }

  const body = document.getElementById("requirementsBody");
  if (!data.length) {
    renderEmptyTableState("Chưa có requirement. Dữ liệu mẫu sẽ được nạp tự động khi CSDL rỗng.");
    return;
  }
  body.innerHTML = data.map(requirementRow).join("");

  body.querySelectorAll("button[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmDelete = confirm(`Bạn có chắc muốn xóa yêu cầu ${btn.dataset.delete}?`);
      if (!confirmDelete) return;
      try {
        setButtonLoading(btn, true, "Đang xóa...");
        await fetchJSON(`${api.requirements}/${btn.dataset.delete}`, { method: "DELETE" });
        await refreshAll();
        showNotice("Đã xóa yêu cầu thành công.");
      } catch (err) {
        showNotice(err.message, false);
      } finally {
        setButtonLoading(btn, false);
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
    renderEmptyGraphState("Chưa có dữ liệu đồ thị");
    return;
  }

  const compactTitle = (text, max = 26) => {
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max)}...` : text;
  };

  const nodes = new vis.DataSet(
    data.nodes.map((n) => ({
      id: n.id,
      label: `${n.id}\n${compactTitle(n.title)}`,
      title: `${n.id} - ${n.title}`,
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
      title: `${e.source} ${e.relation_type} ${e.target}`,
      color: relationColor(e.relation_type),
    }))
  );

  const container = document.getElementById("graph");
  const options = {
    layout: {
      improvedLayout: true,
      randomSeed: 7,
    },
    physics: {
      stabilization: true,
      barnesHut: {
        springLength: 200,
        springConstant: 0.035,
      },
    },
    nodes: {
      font: { size: 11, face: "Tahoma" },
      widthConstraint: { maximum: 170 },
    },
    edges: {
      font: { align: "middle", size: 9, strokeWidth: 2, strokeColor: "#ffffff" },
      smooth: { enabled: true, type: "dynamic" },
    },
    interaction: {
      hover: true,
      tooltipDelay: 150,
    },
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
      <p class="mt-1 text-xs text-slate-500">Nguồn: ${sourceLabel(data.requirement.source)}, Ưu tiên: ${priorityLabel(data.requirement.priority)}</p>
      <h3 class="mt-3 font-semibold">Liên kết truy vết</h3>
      <ul class="list-disc pl-5">${links || "<li>Chưa có liên kết truy vết</li>"}</ul>
      <h3 class="mt-3 font-semibold">Quan hệ</h3>
      <ul class="list-disc pl-5">${rels || "<li>Chưa có quan hệ</li>"}</ul>
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
    const submitBtn = e.target.querySelector("button[type='submit']");
    const data = formToObject(e.target);
    if (!data.id) delete data.id;

    try {
      setButtonLoading(submitBtn, true, "Đang lưu...");
      await fetchJSON(api.requirements, {
        method: "POST",
        body: JSON.stringify(data),
      });
      e.target.reset();
      setMessage("requirementMessage", "Đã lưu requirement thành công.");
      showNotice("Tạo yêu cầu mới thành công.");
      await refreshAll();
    } catch (err) {
      setMessage("requirementMessage", err.message, false);
      showNotice(err.message, false);
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });

  document.getElementById("scanConflictBtn").addEventListener("click", async () => {
    const scanBtn = document.getElementById("scanConflictBtn");
    try {
      setButtonLoading(scanBtn, true, "Đang quét...");
      const data = await fetchJSON(api.conflicts);
      setMessage("requirementMessage", `Đã quét xong. Xung đột: ${data.report.conflict_pairs_detected}, Trùng lặp: ${data.report.duplicate_pairs_detected}`);
      showNotice("Đã quét xung đột và trùng lặp.");
      await refreshAll();
    } catch (err) {
      setMessage("requirementMessage", err.message, false);
      showNotice(err.message, false);
    } finally {
      setButtonLoading(scanBtn, false);
    }
  });

  document.getElementById("applyFilterBtn").addEventListener("click", async () => {
    await loadRequirements();
  });

  document.getElementById("clearFilterBtn").addEventListener("click", async () => {
    document.getElementById("filterType").value = "";
    document.getElementById("filterPriority").value = "";
    document.getElementById("filterKeyword").value = "";
    await loadRequirements();
  });

  document.getElementById("filterKeyword").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await loadRequirements();
    }
  });

  document.getElementById("relationshipForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector("button[type='submit']");
    const data = formToObject(e.target);
    try {
      setButtonLoading(submitBtn, true, "Đang lưu...");
      await fetchJSON(api.relationships, {
        method: "POST",
        body: JSON.stringify(data),
      });
      e.target.reset();
      setMessage("relationshipMessage", "Đã lưu quan hệ.");
      showNotice("Đã thêm quan hệ giữa các yêu cầu.");
      await refreshAll();
    } catch (err) {
      setMessage("relationshipMessage", err.message, false);
      showNotice(err.message, false);
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });

  document.getElementById("traceForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector("button[type='submit']");
    const data = formToObject(e.target);
    try {
      setButtonLoading(submitBtn, true, "Đang lưu...");
      await fetchJSON(api.traceability, {
        method: "POST",
        body: JSON.stringify(data),
      });
      e.target.reset();
      setMessage("traceMessage", "Đã lưu liên kết truy vết.");
      showNotice("Đã thêm liên kết truy vết.");
    } catch (err) {
      setMessage("traceMessage", err.message, false);
      showNotice(err.message, false);
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });

  const runTraceLookup = async () => {
    const id = document.getElementById("traceLookupId").value.trim();
    if (!id) {
      showNotice("Vui lòng nhập ID requirement để tra cứu.", false);
      return;
    }
    try {
      const data = await fetchJSON(`${api.traceability}/${id}`);
      renderTraceTree(data);
      showNotice(`Đã tải truy vết cho ${id}.`);
    } catch (err) {
      document.getElementById("traceTree").innerHTML = `<p class='text-rose-600'>${err.message}</p>`;
      showNotice(err.message, false);
    }
  };

  document.getElementById("traceLookupBtn").addEventListener("click", runTraceLookup);
  document.getElementById("traceLookupId").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await runTraceLookup();
    }
  });

  document.getElementById("resetDemoBtn").addEventListener("click", async () => {
    const resetBtn = document.getElementById("resetDemoBtn");
    try {
      setButtonLoading(resetBtn, true, "Đang reset...");
      const data = await fetchJSON(api.resetDemo, {
        method: "POST",
      });
      setMessage("demoMessage", "Đã reset dữ liệu mẫu. Bạn có thể demo lại từ đầu.");
      showNotice("Đã reset dữ liệu demo.");
      if (data?.message) {
        setMessage("requirementMessage", "Dữ liệu demo đã được nạp lại.");
      }
      await refreshAll();
    } catch (err) {
      setMessage("demoMessage", err.message, false);
      showNotice(err.message, false);
    } finally {
      setButtonLoading(resetBtn, false);
    }
  });
}

(async function init() {
  bindEvents();
  await refreshAll();
})();
