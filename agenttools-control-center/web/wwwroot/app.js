const state = {
  activities: [],
  selectedActivityId: null,
  showTaskHistory: false,
  lastActivitySnapshot: null,
  skillImprovements: [],
  selectedSkillId: null,
  communications: [],
  taskCommunications: [],
  taskCommunicationsTaskId: null,
  selectedCommunicationId: null,
  activeDashboardTab: "tasks",
  loadingServices: false,
  loadingActivities: false,
  loadingSkills: false,
  loadingCommunications: false,
  loadingTaskCommunicationIds: new Set(),
  loadingResources: false,
  loadingPlanUsage: false,
  actionCsrfToken: null,
  actionSessionPromise: null,
  taskActionBusy: false,
  detailedInspectionBusyIds: new Set(),
  taskInspection: null,
  controlUpdateStatus: null,
  controlUpdateBusy: false,
  devSpaceRestartBusy: false,
};

const $ = (id) => document.getElementById(id);

function formatTime(value, withDate = false) {
  if (!value) return "未取得";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未取得";
  return new Intl.DateTimeFormat("ja-JP", withDate
    ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit", second: "2-digit" }
  ).format(date);
}

function text(value, fallback = "—") {
  return value == null || value === "" ? fallback : String(value);
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1).replace(/\.0$/, "")}%` : "—";
}

function continuationUsageText(activity) {
  const rawUsed = activity?.continuationUsedPercent;
  const rawRemaining = activity?.continuationRemainingPercent;
  const hasUsed = rawUsed !== null && rawUsed !== undefined && rawUsed !== "" && Number.isFinite(Number(rawUsed));
  const hasRemaining = rawRemaining !== null && rawRemaining !== undefined && rawRemaining !== "" && Number.isFinite(Number(rawRemaining));
  const used = hasUsed ? Number(rawUsed) : null;
  const remaining = hasRemaining ? Number(rawRemaining) : null;
  if (!hasUsed && !hasRemaining) return activity?.continuationStatus ? "Codex利用枠: 未取得" : "";
  if (hasUsed && hasRemaining) return `Codex利用枠: ${formatPercent(used)}使用 / ${formatPercent(remaining)}残り`;
  if (hasUsed) return `Codex利用枠: ${formatPercent(used)}使用`;
  return `Codex利用枠: ${formatPercent(remaining)}残り`;
}

function continuationDetailText(activity) {
  const parts = [];
  if (activity?.continuationStatus) {
    const model = activity.continuationModel ? ` / ${activity.continuationModel}` : "";
    parts.push(`状態: ${activity.continuationStatus}${model}`);
  }
  if (Number(activity?.continuationAttempt) > 0) parts.push(`引き継ぎ回数: ${Number(activity.continuationAttempt)}回`);
  if (activity?.continuationSessionReused) parts.push(`Session: 継続利用（再利用${Number(activity.continuationSessionReuseCount || 0)}回）`);
  const usage = continuationUsageText(activity);
  if (usage) parts.push(`${usage} ※アカウント全体の利用枠スナップショット（このTask単体のtoken消費量ではありません）`);
  return parts.join("\n");
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

function formatMiB(value) {
  const mib = Number(value);
  if (!Number.isFinite(mib) || mib < 0) return "—";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MB`;
}

function setNotice(element, message) {
  element.textContent = message || "";
  element.classList.toggle("hidden", !message);
}

function create(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function setDashboardTab(tabName, focus = false) {
  const tabs = Array.from(document.querySelectorAll("[data-dashboard-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-dashboard-panel]"));
  if (!tabs.some((tab) => tab.dataset.dashboardTab === tabName)) return;
  state.activeDashboardTab = tabName;
  for (const tab of tabs) {
    const active = tab.dataset.dashboardTab === tabName;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  for (const panel of panels) {
    panel.classList.toggle("hidden", panel.dataset.dashboardPanel !== tabName);
  }
}

function renderOverall(services) {
  const warning = services.filter((item) => item.health === "warning" || item.health === "unknown").length;
  const stopped = services.filter((item) => item.health === "stopped").length;
  const busy = services.filter((item) => item.health === "busy").length;

  const dot = $("overall-dot");
  dot.className = "status-dot";

  if (warning > 0) {
    dot.classList.add("warning");
    $("overall-text").textContent = `要確認 ${warning}件 / 停止 ${stopped}件`;
  } else if (stopped > 0) {
    dot.classList.add("stopped");
    $("overall-text").textContent = `停止中のサービスが${stopped}件あります`;
  } else if (busy > 0) {
    dot.classList.add("busy");
    $("overall-text").textContent = `正常稼働中（${busy}件処理中）`;
  } else if (services.length > 0) {
    dot.classList.add("healthy");
    $("overall-text").textContent = "すべて正常です";
  } else {
    dot.classList.add("unknown");
    $("overall-text").textContent = "状態を取得できません";
  }
}

function createResourceCard(label, value, subtitle, percent, metaLeft = "", metaRight = "") {
  const card = create("article", "resource-card");
  const top = create("div", "resource-top");
  top.append(create("div", "resource-label", label));
  card.append(top);
  card.append(create("div", "resource-value", value));
  card.append(create("p", "resource-subtitle", subtitle));

  const progress = create("div", "resource-progress");
  const fill = document.createElement("span");
  const numericPercent = Number(percent);
  fill.style.width = Number.isFinite(numericPercent)
    ? `${Math.max(0, Math.min(100, numericPercent))}%`
    : "0%";
  progress.append(fill);
  card.append(progress);

  const meta = create("div", "resource-meta");
  meta.append(create("span", "", metaLeft));
  meta.append(create("span", "", metaRight));
  card.append(meta);
  return card;
}

function renderResources(snapshot) {
  const root = $("resource-list");
  root.replaceChildren();

  root.append(createResourceCard(
    "CPU",
    formatPercent(snapshot.cpuPercent),
    "システム全体",
    snapshot.cpuPercent,
    "使用率",
    "3秒更新"
  ));

  const ram = snapshot.ram || {};
  root.append(createResourceCard(
    "RAM",
    formatPercent(ram.percent),
    `${formatBytes(ram.usedBytes)} / ${formatBytes(ram.totalBytes)}`,
    ram.percent,
    "使用率",
    "物理メモリ"
  ));

  const gpus = snapshot.gpus || [];
  for (const gpu of gpus) {
    const suffix = gpus.length > 1 ? ` ${gpu.index}` : "";
    root.append(createResourceCard(
      `GPU${suffix}`,
      formatPercent(gpu.utilizationPercent),
      text(gpu.name),
      gpu.utilizationPercent,
      "使用率",
      Number.isFinite(Number(gpu.temperatureC)) ? `${Math.round(Number(gpu.temperatureC))}°C` : "—"
    ));
    root.append(createResourceCard(
      `VRAM${suffix}`,
      formatPercent(gpu.memoryPercent),
      `${formatMiB(gpu.memoryUsedMiB)} / ${formatMiB(gpu.memoryTotalMiB)}`,
      gpu.memoryPercent,
      "使用率",
      "GPUメモリ"
    ));
  }

  if (gpus.length === 0) {
    root.append(createResourceCard("GPU / VRAM", "—", "取得できません", null, "", ""));
  }

  $("resources-updated").textContent = `更新 ${formatTime(snapshot.refreshedAt)}`;
  setNotice($("resource-error"), snapshot.gpuError || "");
}

function planWindowLabel(window, fallback) {
  const minutes = Number(window?.windowDurationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}日枠`;
  if (minutes % 60 === 0) return `${minutes / 60}時間枠`;
  return `${minutes}分枠`;
}

function renderPlanUsage(snapshot) {
  const root = $("plan-usage-list");
  root.replaceChildren();
  const plan = snapshot.planType ? String(snapshot.planType).toUpperCase() : "不明";
  const windows = [
    [snapshot.primary, planWindowLabel(snapshot.primary, "短期枠")],
    [snapshot.secondary, planWindowLabel(snapshot.secondary, "長期枠")],
  ];

  let rendered = 0;
  for (const [window, label] of windows) {
    if (!window) continue;
    const resetText = window.resetsAt ? `リセット ${formatTime(window.resetsAt, true)}` : "リセット時刻 —";
    root.append(createResourceCard(
      `Codex ${label}`,
      `${formatPercent(window.remainingPercent)} 残り`,
      `直近${label}の累積使用 ${formatPercent(window.usedPercent)} / ${resetText}`,
      window.remainingPercent,
      `Plan: ${plan}`,
      "5分キャッシュ"
    ));
    rendered += 1;
  }

  if (rendered === 0) {
    root.append(createResourceCard("Codex利用枠", "—", "取得できません", null, "", ""));
  }

  const creditText = Number.isFinite(Number(snapshot.resetCreditsAvailable))
    ? ` / Full reset ${Number(snapshot.resetCreditsAvailable)}回利用可能`
    : "";
  $("plan-usage-summary").textContent = `ChatGPTプラン: ${plan}${creditText}。表示は現在の瞬間使用量ではなく、5時間・週次それぞれの利用枠内での累積使用率です。`;
  $("plan-usage-updated").textContent = `更新 ${formatTime(snapshot.refreshedAt)}${snapshot.stale ? "（前回値）" : ""}`;
  setNotice($("plan-usage-error"), snapshot.error || "");
}

function renderServices(snapshot) {
  const root = $("service-list");
  root.replaceChildren();
  const services = snapshot.services || [];

  for (const service of services) {
    const card = create("article", "service-card");
    const top = create("div", "service-top");
    top.append(create("div", "service-title", service.displayName));
    top.append(create("div", `health-label ${service.health || "unknown"}`, service.statusText));
    card.append(top);
    card.append(create("p", "service-summary", text(service.summary)));
    if (service.id === "devspace") {
      const actions = create("div", "service-actions");
      const restartButton = create("button", "service-action-button", state.devSpaceRestartBusy ? "停止→起動→正常確認中…" : "安全に再起動");
      restartButton.type = "button";
      restartButton.disabled = state.devSpaceRestartBusy;
      restartButton.addEventListener("click", restartDevSpace);
      actions.append(restartButton);
      card.append(actions);
    }
    card.append(create("p", "service-time", `確認 ${formatTime(service.checkedAt)}`));
    root.append(card);
  }

  renderOverall(services);
  $("services-updated").textContent = `更新 ${formatTime(snapshot.refreshedAt)}`;
  setNotice($("service-error"), snapshot.error || (snapshot.stale ? "直前の情報を表示しています。" : ""));
}

function renderActivities(snapshot) {
  state.lastActivitySnapshot = snapshot;
  state.activities = snapshot.tasks || [];
  const root = $("activity-list");
  root.replaceChildren();

  const activeActivities = state.activities.filter((item) => item.status === "running" || item.status === "blocked");
  const displayedActivities = state.showTaskHistory ? state.activities : activeActivities;
  const historyCount = Math.max(0, state.activities.length - activeActivities.length);
  const historyToggle = $("task-history-toggle");

  $("activity-count").textContent = state.activities.length === 0
    ? "タスクなし"
    : state.showTaskHistory
      ? `アクティブ ${activeActivities.length} / 全 ${state.activities.length}件`
      : `アクティブ ${activeActivities.length}件`;
  historyToggle.textContent = state.showTaskHistory
    ? "アクティブのみ"
    : historyCount > 0 ? `履歴を表示 (${historyCount})` : "履歴なし";
  historyToggle.disabled = !state.showTaskHistory && historyCount === 0;
  $("activity-empty").textContent = state.showTaskHistory
    ? "表示できるユーザータスクはありません。"
    : "アクティブなタスクはありません。";
  $("activity-empty").classList.toggle("hidden", displayedActivities.length !== 0);
  setNotice($("activity-error"), snapshot.error || (snapshot.stale ? "直前の情報を表示しています。" : ""));
  $("activity-updated").textContent = `Task: ${formatTime(snapshot.refreshedAt)}`;

  for (const activity of displayedActivities) {
    const shell = create("div", "activity-card-shell");
    const card = create("button", "activity-card");
    card.type = "button";
    card.dataset.activityId = activity.id;
    if (activity.id === state.selectedActivityId) card.classList.add("selected");

    const top = create("div", "activity-top");
    top.append(create("div", "activity-title", activity.title));
    const statusClass = activity.status === "failed" || activity.state === "paused_timeout"
      ? "stopped"
      : activity.status === "cancelled"
        ? "unknown"
        : activity.status === "blocked" || ["waiting_user", "waiting_dependency", "paused", "blocked"].includes(activity.state)
          ? "warning"
          : "healthy";
    top.append(create("div", `health-label ${statusClass}`, activity.statusText));
    card.append(top);
    card.append(create("p", "activity-worker", text(activity.contributorsDisplay)));
    card.append(create("p", "activity-work", text(activity.currentWork, text(activity.phase, activity.statusText))));
    const continuationUsage = continuationUsageText(activity);
    if (continuationUsage) card.append(create("p", "activity-worker", continuationUsage));
    card.append(create("p", "activity-time", `更新 ${formatTime(activity.updatedAt)}`));
    card.addEventListener("click", () => selectActivity(activity.id));

    const detailButton = create("button", "card-detail-button", "状況確認（詳細）");
    detailButton.type = "button";
    detailButton.dataset.detailedTaskId = activity.id;
    detailButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await enqueueDetailedInspection(activity.id);
    });
    shell.append(card, detailButton);
    root.append(shell);
  }

  refreshDetailedInspectionButtons();

  if (state.selectedActivityId) {
    const selected = displayedActivities.find((item) => item.id === state.selectedActivityId);
    if (selected) renderDetail(selected);
    else closeDetail();
  }
}

function activeCommunicationForTask(taskId, type = null) {
  return state.communications.find((item) => item.taskId === taskId
    && (!type || item.type === type)
    && ["pending", "processing"].includes(item.status)) || null;
}

function isTaskContinuation(item) {
  return item?.type === "task_continue";
}

function communicationStatusLabel(item) {
  const status = item?.status;
  if (isTaskContinuation(item)) {
    if (status === "pending") return "ChatGPT続行待ち";
    if (status === "processing") return "作業続行中";
    if (status === "completed") return "続行完了";
    if (status === "failed") return "続行失敗";
  }
  if (status === "pending") return "ChatGPT処理待ち";
  if (status === "processing") return "DevSpace調査中";
  if (status === "completed") return "調査完了";
  if (status === "failed") return "失敗";
  return text(status, "不明");
}

function communicationStatusClass(status) {
  if (status === "completed") return "healthy";
  if (status === "failed") return "stopped";
  if (status === "processing") return "busy";
  return "warning";
}

function refreshDetailedInspectionButtons() {
  document.querySelectorAll("[data-detailed-task-id]").forEach((button) => {
    const taskId = button.dataset.detailedTaskId;
    const active = activeCommunicationForTask(taskId);
    const detailedActive = activeCommunicationForTask(taskId, "task_detailed_inspection");
    const busy = state.detailedInspectionBusyIds.has(taskId);
    button.disabled = busy || Boolean(active);
    button.textContent = busy
      ? "登録中…"
      : detailedActive?.status === "processing"
        ? "詳細調査中"
        : detailedActive?.status === "pending"
          ? "詳細確認待ち"
          : active
            ? "Host Request処理中"
            : "状況確認（詳細）";
  });
  const selected = state.activities.find((item) => item.id === state.selectedActivityId);
  if (selected && $("task-inspect-detailed")) {
    const active = activeCommunicationForTask(selected.id);
    const detailedActive = activeCommunicationForTask(selected.id, "task_detailed_inspection");
    const busy = state.detailedInspectionBusyIds.has(selected.id);
    $("task-inspect-detailed").disabled = state.taskActionBusy || busy || Boolean(active);
    $("task-inspect-detailed").textContent = busy
      ? "登録中…"
      : detailedActive?.status === "processing"
        ? "詳細調査中"
        : detailedActive?.status === "pending"
          ? "詳細確認待ち"
          : active
            ? "Host Request処理中"
            : "状況確認（詳細）";
  }
}

function createCommunicationCard(item) {
  const card = create("button", "communication-card");
  card.type = "button";
  card.dataset.communicationId = item.requestId;
  if (item.requestId === state.selectedCommunicationId) card.classList.add("selected");
  const top = create("div", "activity-top");
  top.append(create("div", "activity-title", item.taskTitle));
  top.append(create("div", `health-label ${communicationStatusClass(item.status)}`, communicationStatusLabel(item)));
  card.append(top);
  const summary = isTaskContinuation(item)
    ? item.status === "failed"
      ? text(item.failure, "作業続行に失敗しました。")
      : item.status === "completed"
        ? text(item.resultSummary, "作業続行レポートを作成しました。")
        : item.status === "processing"
          ? "ChatGPTが要求を取得し、DevSpaceで作業を続行しています。"
          : "次回のChatGPT Scheduled Taskによる作業再開を待っています。"
    : item.status === "failed"
      ? text(item.failure, "詳細調査に失敗しました。")
      : item.status === "completed"
        ? text(item.resultSummary, "詳細レポートを作成しました。")
        : item.status === "processing"
          ? "ChatGPTが要求を取得し、DevSpaceで調査しています。"
          : "次回のChatGPT Scheduled Taskによる取得を待っています。";
  card.append(create("p", "communication-summary", summary));
  const reportMeta = item.reportCharCount > 0
    ? `レポート ${Number(item.reportCharCount).toLocaleString("ja-JP")}文字 / ${Number(item.reportHeadingCount || 0)}章`
    : "レポート未生成";
  card.append(create("p", "communication-meta", `${reportMeta} / 更新 ${formatTime(item.updatedAt || item.createdAt)}`));
  card.addEventListener("click", () => openCommunicationDetail(item.requestId));
  return card;
}

function renderCommunications(snapshot) {
  state.communications = snapshot.requests || [];
  const root = $("communication-list");
  root.replaceChildren();
  const limit = Number(snapshot.limit || 20);
  $("communication-count").textContent = state.communications.length === 0
    ? "通信なし"
    : `最新${state.communications.length}件 / 最大${limit}件`;
  $("communication-empty").classList.toggle("hidden", state.communications.length !== 0);
  setNotice($("communication-error"), snapshot.error || "");

  for (const item of state.communications) root.append(createCommunicationCard(item));

  refreshDetailedInspectionButtons();
}

function renderTaskCommunications(snapshot) {
  if (!snapshot || snapshot.taskId !== state.selectedActivityId) return;
  state.taskCommunicationsTaskId = snapshot.taskId;
  state.taskCommunications = snapshot.requests || [];
  const root = $("detail-communication-list");
  root.replaceChildren();
  const limit = Number(snapshot.limit || 10);
  $("detail-communication-count").textContent = state.taskCommunications.length === 0
    ? `最新${limit}件`
    : `最新${state.taskCommunications.length}件 / 最大${limit}件`;
  $("detail-communication-empty").textContent = "このタスクの通信履歴はありません。";
  $("detail-communication-empty").classList.toggle("hidden", state.taskCommunications.length !== 0);
  setNotice($("detail-communication-error"), snapshot.error || "");
  for (const item of state.taskCommunications) root.append(createCommunicationCard(item));
}

async function enqueueDetailedInspection(taskId) {
  if (!taskId || state.detailedInspectionBusyIds.has(taskId) || activeCommunicationForTask(taskId)) return;
  state.detailedInspectionBusyIds.add(taskId);
  refreshDetailedInspectionButtons();
  const selected = state.activities.find((item) => item.id === taskId);
  if (selected && selected.id === state.selectedActivityId) $("task-action-status").textContent = "詳細状況確認をQueueへ登録中…";
  try {
    const payload = await postTaskAction(taskId, "inspect-detailed");
    if (selected && selected.id === state.selectedActivityId) {
      $("task-action-status").textContent = payload.duplicate
        ? "詳細確認依頼はすでに待機中です"
        : "詳細確認依頼を登録しました";
    }
    await loadCommunications();
  } catch (error) {
    if (selected && selected.id === state.selectedActivityId) $("task-action-status").textContent = `詳細確認登録失敗: ${error.message}`;
  } finally {
    state.detailedInspectionBusyIds.delete(taskId);
    refreshDetailedInspectionButtons();
  }
}

async function openCommunicationDetail(requestId) {
  state.selectedCommunicationId = requestId;
  setDashboardTab("communications");
  document.querySelectorAll(".communication-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.communicationId === requestId);
  });
  const item = state.communications.find((entry) => entry.requestId === requestId)
    || state.taskCommunications.find((entry) => entry.requestId === requestId);
  if (!item) return;
  $("communication-detail-panel").classList.remove("hidden");
  $("communication-detail-title").textContent = item.taskTitle;
  $("communication-detail-status").textContent = communicationStatusLabel(item);
  $("communication-detail-time").textContent = `更新: ${formatTime(item.updatedAt || item.createdAt, true)}`;
  $("communication-detail-size").textContent = item.reportCharCount > 0
    ? `${Number(item.reportCharCount).toLocaleString("ja-JP")}文字 / ${Number(item.reportHeadingCount || 0)}章`
    : "レポート未生成";
  $("communication-detail-summary").textContent = item.status === "failed"
    ? text(item.failure, isTaskContinuation(item) ? "作業続行に失敗しました。" : "詳細調査に失敗しました。")
    : text(item.resultSummary, communicationStatusLabel(item));
  $("communication-detail-report").textContent = item.status === "completed" ? "レポートを読み込み中…" : "レポートはまだ生成されていません。";
  if (item.status === "completed") {
    try {
      const payload = await fetchJson(`/api/communications/${encodeURIComponent(requestId)}`);
      $("communication-detail-report").textContent = payload.detail?.reportContent || "レポート本文を取得できませんでした。";
    } catch (error) {
      $("communication-detail-report").textContent = `レポート取得失敗: ${error.message}`;
    }
  }
  $("communication-detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeCommunicationDetail() {
  state.selectedCommunicationId = null;
  $("communication-detail-panel").classList.add("hidden");
  document.querySelectorAll(".communication-card").forEach((card) => card.classList.remove("selected"));
}

function skillStatusClass(proposal) {
  if (proposal.status === "stale") return "stopped";
  if (proposal.status === "rejected") return "unknown";
  if (proposal.status === "approved" || proposal.status === "applied") return "healthy";
  return "warning";
}

function renderSkillImprovements(snapshot) {
  state.skillImprovements = snapshot.proposals || [];
  const root = $("skill-list");
  root.replaceChildren();
  const activeCount = state.skillImprovements.filter((item) => ["pending", "approved", "stale"].includes(item.status)).length;
  $("skill-count").textContent = state.skillImprovements.length === 0
    ? "候補なし"
    : `要確認 ${activeCount} / 表示 ${state.skillImprovements.length}件`;
  $("skill-empty").classList.toggle("hidden", state.skillImprovements.length !== 0);
  setNotice($("skill-error"), snapshot.error || "");

  for (const proposal of state.skillImprovements) {
    const card = create("button", "activity-card skill-card");
    card.type = "button";
    card.dataset.skillId = proposal.id;
    if (proposal.id === state.selectedSkillId) card.classList.add("selected");
    const top = create("div", "activity-top");
    top.append(create("div", "activity-title", proposal.skillName));
    top.append(create("div", `health-label ${skillStatusClass(proposal)}`, proposal.statusText));
    card.append(top);
    card.append(create("p", "activity-worker", text(proposal.summary)));
    card.append(create("p", "activity-work", text(proposal.reason)));
    card.append(create("p", "activity-time", `更新 ${formatTime(proposal.updatedAt)}`));
    card.addEventListener("click", () => selectSkillImprovement(proposal.id));
    root.append(card);
  }

  if (state.selectedSkillId) {
    const selected = state.skillImprovements.find((item) => item.id === state.selectedSkillId);
    if (selected) renderSkillDetail(selected);
    else closeSkillDetail();
  }
}

function selectSkillImprovement(id) {
  state.selectedSkillId = id;
  const selected = state.skillImprovements.find((item) => item.id === id);
  if (!selected) return;
  document.querySelectorAll(".skill-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.skillId === id);
  });
  renderSkillDetail(selected);
  $("skill-detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSkillDetail(proposal) {
  $("skill-detail-panel").classList.remove("hidden");
  $("skill-detail-title").textContent = proposal.skillName;
  $("skill-detail-status").textContent = proposal.statusText;
  $("skill-detail-source").textContent = `提案元: ${text(proposal.source)} / ${text(proposal.proposedBy)}`;
  $("skill-detail-updated").textContent = `更新: ${formatTime(proposal.updatedAt, true)}`;
  $("skill-detail-reason").textContent = proposal.staleReason
    ? `${text(proposal.reason)}\n\n再確認理由: ${proposal.staleReason}`
    : text(proposal.reason);
  $("skill-detail-diff").textContent = text(proposal.diff, "差分はありません。");
}

function closeSkillDetail() {
  state.selectedSkillId = null;
  $("skill-detail-panel").classList.add("hidden");
  document.querySelectorAll(".skill-card").forEach((card) => card.classList.remove("selected"));
}

function selectActivity(id) {
  if (state.taskInspection?.taskId !== id) state.taskInspection = null;
  state.selectedActivityId = id;
  const selected = state.activities.find((item) => item.id === id);
  if (!selected) return;
  document.querySelectorAll(".activity-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.activityId === id);
  });
  renderDetail(selected);
  loadTaskCommunications(id);
  $("detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setTaskActionState(activity) {
  const active = activity && ["running", "blocked"].includes(activity.status);
  const hostRequestActive = activity ? activeCommunicationForTask(activity.id) : null;
  const detailedActive = activity ? activeCommunicationForTask(activity.id, "task_detailed_inspection") : null;
  const continueActive = activity ? activeCommunicationForTask(activity.id, "task_continue") : null;
  $("task-inspect").disabled = state.taskActionBusy || !activity;
  $("task-inspect-detailed").disabled = state.taskActionBusy || !activity || state.detailedInspectionBusyIds.has(activity?.id) || Boolean(hostRequestActive);
  $("task-inspect-detailed").textContent = state.detailedInspectionBusyIds.has(activity?.id)
    ? "登録中…"
    : detailedActive?.status === "processing"
      ? "詳細調査中"
      : detailedActive?.status === "pending"
        ? "詳細確認待ち"
        : hostRequestActive
          ? "Host Request処理中"
          : "状況確認（詳細）";
  $("task-continue").disabled = state.taskActionBusy || activity?.status !== "blocked" || Boolean(hostRequestActive);
  $("task-continue").textContent = continueActive?.status === "processing"
    ? "作業続行中"
    : continueActive?.status === "pending"
      ? "続行待ち"
      : hostRequestActive
        ? "Host Request処理中"
        : "作業続行";
  $("task-continue-codex").disabled = state.taskActionBusy || activity?.status !== "blocked" || Boolean(hostRequestActive);
  $("task-complete").disabled = state.taskActionBusy || !active || Boolean(hostRequestActive);
}

function formatInspection(inspection) {
  const lines = [
    `Task状態: ${text(inspection.status)}${inspection.state ? ` / ${inspection.state}` : ""}`,
    `Phase: ${text(inspection.phase)}`,
    `現在の進行: ${text(inspection.currentWork)}`,
  ];
  if (inspection.stateReason) lines.push(`停止・待機理由: ${inspection.stateReason}`);
  if (inspection.updatedAt) lines.push(`Task更新: ${formatTime(inspection.updatedAt, true)}`);
  if (inspection.continueRequestedAt) {
    const continueLabel = inspection.continueRequestStatus === "waiting_host"
      ? "再開待ち"
      : inspection.continueRequestStatus === "requested"
        ? "続行要求済み"
        : text(inspection.continueRequestStatus, "続行要求済み");
    lines.push(`続行要求: ${continueLabel} / ${formatTime(inspection.continueRequestedAt, true)}${inspection.continueRequestedBy ? ` / ${inspection.continueRequestedBy}` : ""}`);
  }
  lines.push("", "Task記録上の最新ChatGPT進捗:");
  if (inspection.latestChatGptMessage) {
    const stamp = inspection.latestChatGptAt ? `[${formatTime(inspection.latestChatGptAt, true)}] ` : "";
    const phase = inspection.latestChatGptPhase ? `${inspection.latestChatGptPhase}: ` : "";
    lines.push(`${stamp}${phase}${inspection.latestChatGptMessage}`);
  } else {
    lines.push("記録なし");
  }
  lines.push("", "DevSpace:");
  lines.push(inspection.devSpaceFound
    ? `${text(inspection.devSpaceStatus, "検出")} / ${inspection.devSpaceReusable ? "既存Workspace再利用可能" : "Workspace履歴あり"}`
    : "Workspace未検出");
  if (inspection.devSpaceLastUsedAt) lines.push(`最終利用: ${formatTime(inspection.devSpaceLastUsedAt, true)}`);
  lines.push("", "Git:");
  lines.push(inspection.gitAvailable
    ? `Branch: ${text(inspection.gitBranch)} / 変更 ${Number(inspection.gitChangeCount || 0)}件`
    : "Git状態を取得できませんでした。");
  if (inspection.resumeNextStep) {
    lines.push("", `再開候補: ${inspection.resumeNextStep}`);
    lines.push(`次操作: ${text(inspection.resumeImpact, "不明")}${inspection.resumeRequiresUserConfirmation ? " / ユーザー確認必須" : ""}`);
  }
  lines.push("", inspection.note || "ChatGPT製品の完全な会話履歴ではなく、Work Taskに記録された最新のChatGPT進捗です。");
  return lines.join("\n");
}

function renderDetail(activity) {
  $("detail-panel").classList.remove("hidden");
  $("detail-title").textContent = activity.title;
  $("detail-status").textContent = text(activity.phase ? `${activity.statusText} / ${activity.phase}` : activity.statusText);
  $("detail-owner").textContent = `担当: ${text(activity.ownerDisplay)}`;
  $("detail-updated").textContent = `更新: ${formatTime(activity.updatedAt, true)}`;
  $("detail-current").textContent = text(activity.currentWork, text(activity.phase, activity.statusText));
  $("detail-project").textContent = text(activity.project);
  const continuationCard = $("detail-continuation-card");
  const continuationDetail = continuationDetailText(activity);
  continuationCard.classList.toggle("hidden", continuationDetail === "");
  $("detail-continuation").textContent = continuationDetail;
  const reasonCard = $("detail-reason-card");
  const reason = text(activity.stateReason);
  reasonCard.classList.toggle("hidden", reason === "—");
  $("detail-reason").textContent = reason;
  $("detail-contributors").textContent = text(activity.contributorsDisplay);
  setTaskActionState(activity);
  $("task-action-status").textContent = "";
  const inspection = state.taskInspection?.taskId === activity.id ? state.taskInspection.text : "";
  $("detail-inspection").textContent = inspection;
  $("detail-inspection-card").classList.toggle("hidden", !inspection);
  if (state.taskCommunicationsTaskId === activity.id) {
    renderTaskCommunications({ taskId: activity.id, limit: 10, requests: state.taskCommunications });
  } else {
    $("detail-communication-list").replaceChildren();
    $("detail-communication-count").textContent = "最新10件";
    $("detail-communication-empty").textContent = "通信履歴を読み込み中…";
    $("detail-communication-empty").classList.remove("hidden");
    setNotice($("detail-communication-error"), "");
  }
}

function closeDetail() {
  state.selectedActivityId = null;
  state.taskInspection = null;
  state.taskCommunicationsTaskId = null;
  state.taskCommunications = [];
  $("detail-panel").classList.add("hidden");
  document.querySelectorAll(".activity-card").forEach((card) => card.classList.remove("selected"));
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

async function ensureActionSession() {
  if (state.actionCsrfToken) return state.actionCsrfToken;
  if (!state.actionSessionPromise) {
    state.actionSessionPromise = fetchJson("/api/task-actions/session")
      .then((session) => {
        if (!session?.csrfToken) throw new Error("Task操作セッションを開始できませんでした。");
        state.actionCsrfToken = session.csrfToken;
        return state.actionCsrfToken;
      })
      .finally(() => { state.actionSessionPromise = null; });
  }
  return await state.actionSessionPromise;
}

async function postJsonAction(url, body = {}) {
  const csrfToken = await ensureActionSession();
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Control-Center-CSRF": csrfToken,
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* ignore non-JSON error bodies */ }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
  }
  return payload;
}

async function postTaskAction(taskId, action, body = {}) {
  return await postJsonAction(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, body);
}

function renderControlUpdateStatus(status) {
  state.controlUpdateStatus = status || null;
  const available = status?.updateAvailable === true;
  const button = $("apply-control-update");
  button.disabled = state.controlUpdateBusy || !available;
  button.textContent = state.controlUpdateBusy ? "更新反映中…" : available ? "更新反映して再起動" : "更新なし";
  const label = $("control-update-status");
  label.textContent = available
    ? `Control Center更新あり${status.latestSourceAt ? ` / ${formatTime(status.latestSourceAt)}` : ""}`
    : "Control Centerは最新Releaseです";
  label.classList.toggle("available", available);
}

async function loadControlUpdateStatus() {
  try {
    renderControlUpdateStatus(await fetchJson("/api/control-center/update-status"));
  } catch {
    state.controlUpdateStatus = null;
    const button = $("apply-control-update");
    button.disabled = true;
    button.textContent = "更新状態不明";
    $("control-update-status").textContent = "Control Center更新状態を取得できません";
  }
}

async function waitForControlCenterRestart() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const status = await fetchJson("/api/control-center/update-status");
      if (status?.updateAvailable === false) return status;
    } catch {
      // Expected while the old Web process is being replaced.
    }
  }
  throw new Error("再起動後のWeb Control Centerを確認できませんでした。");
}

async function applyControlCenterUpdate() {
  if (state.controlUpdateBusy || state.controlUpdateStatus?.updateAvailable !== true) return;
  const confirmed = window.confirm("Control Centerの更新をReleaseへ反映し、Desktop/Webを再起動します。\n\nビルド中は現在のWebを維持し、切り替え時だけ一時的に接続が切れます。実行しますか？");
  if (!confirmed) return;

  state.controlUpdateBusy = true;
  renderControlUpdateStatus(state.controlUpdateStatus);
  $("control-update-status").textContent = "Releaseを準備して再起動します…";
  try {
    await postJsonAction("/api/control-center/apply-update", { confirm: true });
    $("control-update-status").textContent = "再起動中…接続復帰を待っています";
    const status = await waitForControlCenterRestart();
    renderControlUpdateStatus(status);
    window.location.reload();
  } catch (error) {
    state.controlUpdateBusy = false;
    renderControlUpdateStatus(state.controlUpdateStatus);
    $("control-update-status").textContent = `更新反映失敗: ${error.message}`;
  }
}

async function withTaskAction(activity, message, callback) {
  if (!activity || state.taskActionBusy) return;
  state.taskActionBusy = true;
  setTaskActionState(activity);
  $("task-action-status").textContent = message;
  try {
    await callback();
  } finally {
    state.taskActionBusy = false;
    const selected = state.activities.find((item) => item.id === state.selectedActivityId);
    setTaskActionState(selected || null);
  }
}

async function inspectSelectedTask() {
  const activity = state.activities.find((item) => item.id === state.selectedActivityId);
  await withTaskAction(activity, "DevSpaceとTask記録を確認中…", async () => {
    try {
      const payload = await postTaskAction(activity.id, "inspect");
      const inspectionText = formatInspection(payload.inspection || {});
      state.taskInspection = { taskId: activity.id, text: inspectionText };
      $("detail-inspection").textContent = inspectionText;
      $("detail-inspection-card").classList.remove("hidden");
      $("task-action-status").textContent = "状況確認完了";
    } catch (error) {
      $("task-action-status").textContent = `状況確認失敗: ${error.message}`;
    }
  });
}

async function continueSelectedTask() {
  const activity = state.activities.find((item) => item.id === state.selectedActivityId);
  await withTaskAction(activity, "作業続行をChatGPT Host Request Queueへ登録中…", async () => {
    try {
      const payload = await postTaskAction(activity.id, "continue-chatgpt");
      await loadCommunications();
      $("task-action-status").textContent = payload.duplicate
        ? "作業続行依頼はすでに待機中です"
        : "作業続行依頼を登録しました。次回のChatGPT Scheduled Taskで再開します。";
    } catch (error) {
      $("task-action-status").textContent = `作業続行登録失敗: ${error.message}`;
    }
  });
}

async function continueSelectedTaskWithCodex() {
  const activity = state.activities.find((item) => item.id === state.selectedActivityId);
  if (!activity) return;
  const confirmed = window.confirm(`「${activity.title}」をCodexで続行しますか？\n\nGPT-5.6系のCodex使用枠を消費します。通常は「作業続行」を使ってChatGPT Host (Sol) に依頼してください。`);
  if (!confirmed) return;
  await withTaskAction(activity, "Codexで続行を開始中…", async () => {
    try {
      const payload = await postTaskAction(activity.id, "continue-codex");
      state.taskInspection = null;
      await loadActivities();
      $("task-action-status").textContent = payload.message || "Codexで続行を開始しました。";
    } catch (error) {
      $("task-action-status").textContent = `Codex続行失敗: ${error.message}`;
    }
  });
}

async function completeSelectedTask() {
  const activity = state.activities.find((item) => item.id === state.selectedActivityId);
  if (!activity) return;
  const confirmed = window.confirm(`「${activity.title}」を閉じ忘れタスクとして完了にしますか？\n\nTaskが更新されていた場合は安全のため完了を拒否します。`);
  if (!confirmed) return;
  await withTaskAction(activity, "タスクを完了にしています…", async () => {
    try {
      const payload = await postTaskAction(activity.id, "complete", {
        confirm: true,
        expectedUpdatedAt: activity.updatedAt,
      });
      $("task-action-status").textContent = payload.message || "タスクを完了にしました。";
      state.taskInspection = null;
      await loadActivities();
    } catch (error) {
      $("task-action-status").textContent = `タスク終了失敗: ${error.message}`;
    }
  });
}

async function restartDevSpace() {
  if (state.devSpaceRestartBusy) return;
  const confirmed = window.confirm("DevSpaceを安全な既定手順で再起動します。\n\n実行中のDevSpace接続は一時的に切断されます。実行しますか？");
  if (!confirmed) return;

  state.devSpaceRestartBusy = true;
  try {
    const snapshot = await fetchJson("/api/services");
    renderServices(snapshot);
    await postJsonAction("/api/devspace/restart", { confirm: true });
    await new Promise((resolve) => setTimeout(resolve, 1200));
  } catch (error) {
    window.alert(`DevSpace再起動失敗: ${error.message}`);
  } finally {
    state.devSpaceRestartBusy = false;
    await loadServices();
  }
}

async function loadResources() {
  if (state.loadingResources) return;
  state.loadingResources = true;
  try {
    renderResources(await fetchJson("/api/resources"));
  } catch {
    setNotice($("resource-error"), "PCリソースを取得できませんでした。");
  } finally {
    state.loadingResources = false;
  }
}

async function loadPlanUsage() {
  if (state.loadingPlanUsage) return;
  state.loadingPlanUsage = true;
  try {
    renderPlanUsage(await fetchJson("/api/plan-usage"));
  } catch {
    setNotice($("plan-usage-error"), "Codex利用枠を取得できませんでした。");
  } finally {
    state.loadingPlanUsage = false;
  }
}

async function loadServices() {
  if (state.loadingServices) return;
  state.loadingServices = true;
  try {
    renderServices(await fetchJson("/api/services"));
  } catch {
    setNotice($("service-error"), "サービス状態を取得できませんでした。");
    $("overall-text").textContent = "サービス状態を取得できません";
  } finally {
    state.loadingServices = false;
  }
}

async function loadActivities() {
  if (state.loadingActivities) return;
  state.loadingActivities = true;
  try {
    renderActivities(await fetchJson("/api/tasks"));
  } catch {
    setNotice($("activity-error"), "作業状況を取得できませんでした。");
  } finally {
    state.loadingActivities = false;
  }
}

async function loadTaskCommunications(taskId) {
  if (!taskId || state.loadingTaskCommunicationIds.has(taskId)) return;
  state.loadingTaskCommunicationIds.add(taskId);
  try {
    const snapshot = await fetchJson(`/api/tasks/${encodeURIComponent(taskId)}/communications`);
    renderTaskCommunications(snapshot);
  } catch (error) {
    if (state.selectedActivityId === taskId) {
      renderTaskCommunications({ taskId, limit: 10, requests: [], error: `通信履歴を取得できませんでした: ${error.message}` });
    }
  } finally {
    state.loadingTaskCommunicationIds.delete(taskId);
  }
}

async function loadCommunications() {
  if (state.loadingCommunications) return;
  state.loadingCommunications = true;
  try {
    renderCommunications(await fetchJson("/api/communications"));
    if (state.selectedActivityId) await loadTaskCommunications(state.selectedActivityId);
  } catch {
    setNotice($("communication-error"), "通信履歴を取得できませんでした。");
  } finally {
    state.loadingCommunications = false;
  }
}

async function loadSkillImprovements() {
  if (state.loadingSkills) return;
  state.loadingSkills = true;
  try {
    renderSkillImprovements(await fetchJson("/api/skill-improvements"));
  } catch {
    setNotice($("skill-error"), "Skill改善候補を取得できませんでした。");
  } finally {
    state.loadingSkills = false;
  }
}

async function refreshServicesAndTasks() {
  const button = $("refresh-services");
  button.disabled = true;
  try {
    await Promise.all([loadServices(), loadActivities(), loadCommunications(), loadSkillImprovements(), loadPlanUsage(), loadControlUpdateStatus()]);
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll("[data-dashboard-tab]").forEach((tab) => {
  tab.addEventListener("click", () => setDashboardTab(tab.dataset.dashboardTab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(document.querySelectorAll("[data-dashboard-tab]"));
    const index = tabs.indexOf(tab);
    let target = index;
    if (event.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
    if (event.key === "Home") target = 0;
    if (event.key === "End") target = tabs.length - 1;
    event.preventDefault();
    setDashboardTab(tabs[target].dataset.dashboardTab, true);
  });
});

$("refresh-services").addEventListener("click", refreshServicesAndTasks);
$("task-history-toggle").addEventListener("click", () => {
  state.showTaskHistory = !state.showTaskHistory;
  if (state.lastActivitySnapshot) renderActivities(state.lastActivitySnapshot);
});
$("apply-control-update").addEventListener("click", applyControlCenterUpdate);
$("task-inspect").addEventListener("click", inspectSelectedTask);
$("task-inspect-detailed").addEventListener("click", () => {
  const activity = state.activities.find((item) => item.id === state.selectedActivityId);
  if (activity) enqueueDetailedInspection(activity.id);
});
$("task-continue").addEventListener("click", continueSelectedTask);
$("task-continue-codex").addEventListener("click", continueSelectedTaskWithCodex);
$("task-complete").addEventListener("click", completeSelectedTask);
$("detail-close").addEventListener("click", closeDetail);
$("skill-detail-close").addEventListener("click", closeSkillDetail);
$("communication-detail-close").addEventListener("click", closeCommunicationDetail);

setDashboardTab(state.activeDashboardTab);
loadServices();
loadActivities();
loadCommunications();
loadSkillImprovements();
loadResources();
loadPlanUsage();
loadControlUpdateStatus();
setInterval(loadActivities, 3000);
setInterval(loadResources, 3000);
setInterval(loadCommunications, 15000);
setInterval(loadSkillImprovements, 15000);
setInterval(loadControlUpdateStatus, 15000);
setInterval(loadServices, 60000);
setInterval(loadPlanUsage, 60000);
