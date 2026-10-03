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
  hubEl.textContent = status.running ? "Running" : status.error ? "Failed" : "Stopped";
  hubEl.className = `value ${status.running ? "ok" : "bad"}`;

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

hubDesktop.onStatus(paint);
refresh();
setInterval(refresh, 4000);
