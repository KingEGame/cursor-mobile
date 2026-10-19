/* global hubDesktop */

function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  $(id).textContent = text ?? "—";
}

function paint(status) {
  if (!status) return;
  const hubEl = $("hubState");
  // stateLabel comes from the supervisor ("Starting…", "Hub restarting (attempt 2)…", "Running").
  hubEl.textContent = status.stateLabel || (status.running ? "Running" : status.error ? "Failed" : "Stopped");
  const tone = status.running ? "ok" : status.phase === "starting" || status.phase === "restarting" ? "warn" : "bad";
  hubEl.className = `value ${tone}`;

  setText("listen", status.listenUrl);
  setText("tailscale", status.tailscaleHint || "(none detected — install Tailscale)");
  setText("cdp", status.cdpUrl);
  setText("workspace", status.workspace || "(unset — open a project in Cursor)");
  setText("live", status.liveState || "—");

  const err = $("error");
  if (status.error) {
    err.hidden = false;
    err.textContent = status.error;
  } else {
    err.hidden = true;
    err.textContent = "";
  }

  $("btnFirewall").hidden = !(status.platform === "win32" && status.running);
  $("btnPair").disabled = !status.running;
  $("btnHealth").disabled = !status.running;
}

async function refresh() {
  const status = await hubDesktop.getStatus();
  paint(status);
}

$("btnPair").addEventListener("click", () => hubDesktop.openPair());
$("btnHealth").addEventListener("click", () => hubDesktop.openHealth());
$("btnRefresh").addEventListener("click", () => refresh());

let updateInfo = null;

function paintUpdate(u) {
  if (!u) return;
  updateInfo = u;
  setText("version", u.current);
  const btn = $("btnUpdate");
  const labels = {
    idle: "Not checked yet",
    checking: "Checking…",
    "up-to-date": "Up to date",
    verifying: "Verifying download…",
    available: `Version ${u.latest} available`,
    downloading: `Downloading ${u.percent ?? 0}%`,
    installing: "Installing — Hub restarts…",
    manual: `Downloaded ${u.latest}: ${u.message}`,
    error: u.message || "Update failed",
  };
  const el = $("updateState");
  el.textContent = labels[u.phase] || u.phase;
  el.className = `value ${u.phase === "error" ? "bad" : u.phase === "available" ? "warn" : ""}`;
  btn.disabled = u.phase === "verifying" || u.phase === "checking" || u.phase === "downloading" || u.phase === "installing";
  btn.textContent = u.phase === "available" ? `Update to ${u.latest}` : "Check for updates";
}

$("btnUpdate").addEventListener("click", () =>
  updateInfo?.phase === "available" ? hubDesktop.installUpdate() : hubDesktop.checkUpdate(),
);
$("btnFirewall").addEventListener("click", () => hubDesktop.allowFirewall());
hubDesktop.onUpdate(paintUpdate);

const RU = {
  startup: "Запускать вместе с системой",
  diag: "Почему телефон не подключается?",
  logs: "Открыть папку логов",
};
if ((navigator.language || "").toLowerCase().startsWith("ru")) {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    if (RU[el.dataset.i18n]) el.textContent = RU[el.dataset.i18n];
  });
}

$("btnLogs").addEventListener("click", () => hubDesktop.openLogs());
$("autostart").addEventListener("change", (e) => hubDesktop.autostart(e.target.checked));
hubDesktop.autostart().then((r) => ($("autostart").checked = Boolean(r?.enabled)), () => {});
$("btnDiag").addEventListener("click", async () => {
  const list = $("diagList");
  list.hidden = false;
  list.textContent = "…";
  const checks = await hubDesktop.diagnostics();
  list.textContent = "";
  for (const c of checks) {
    const li = document.createElement("li");
    li.className = c.ok === true ? "ok" : c.ok === false ? "bad" : "warn";
    li.textContent = `${c.ok === true ? "✓" : c.ok === false ? "✗" : "•"} ${c.title} — ${c.detail}`;
    list.appendChild(li);
  }
});
hubDesktop.checkUpdate().then(() => {}, () => {});

hubDesktop.onStatus(paint);
refresh();
setInterval(refresh, 4000);
