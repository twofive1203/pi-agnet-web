const $ = (id) => document.getElementById(id);

function showError(message) {
  $("error").textContent = message || "";
}

async function send(type, payload = {}) {
  let timer;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage({ channel: "snail-pi-popup", type, ...payload }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Extension service worker did not respond")), 4000);
      }),
    ]);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refresh() {
  showError("");
  const status = await send("status");
  if (status?.error) {
    $("connection").textContent = "Extension unavailable";
    $("pair-section").classList.add("hidden");
    $("actions").classList.add("hidden");
    showError(status.error);
    return;
  }

  const connected = status.connected;
  const install = status.install;
  $("connection").textContent = install
    ? `${connected ? "Connected" : "Disconnected"} · client ${install.clientId.slice(0, 12)}…`
    : "Not paired";

  $("pair-section").classList.toggle("hidden", Boolean(install));
  $("actions").classList.toggle("hidden", !install);
  $("unpair-btn").classList.toggle("hidden", !install);
  $("reconnect-btn").classList.toggle("hidden", !install);

  const pending = status.pending;
  $("pending-section").classList.toggle("hidden", !pending || !install);
  if (pending) {
    $("pending-detail").textContent = `Session ${pending.sessionLabel || pending.sessionId} requests tab access (expires soon).`;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      $("page-detail").textContent = tab
        ? `${tab.title || ""}\n${tab.url || ""}`
        : "No active tab";
    } catch {
      $("page-detail").textContent = "";
    }
  }

  const bindings = status.bindings || [];
  const debugConsent = status.debugConsent || {};
  const debuggerPermission = Boolean(status.debuggerPermission);
  $("bindings-section").classList.toggle("hidden", bindings.length === 0);
  const list = $("bindings-list");
  list.innerHTML = "";
  for (const binding of bindings) {
    const li = document.createElement("li");
    const consented = Boolean(debugConsent[binding.bindingId]);
    const label = document.createElement("div");
    label.textContent = `${binding.state} · ${binding.title || binding.origin || binding.bindingId}`;
    li.appendChild(label);
    if (binding.state === "suspended") {
      const resumeBtn = document.createElement("button");
      resumeBtn.type = "button";
      resumeBtn.className = "primary";
      resumeBtn.textContent = "Confirm continue on this page";
      resumeBtn.addEventListener("click", async () => {
        showError("");
        const result = await send("resume", { bindingId: binding.bindingId });
        if (result?.error) showError(result.error);
        await refresh();
      });
      li.appendChild(resumeBtn);
    }
    if (binding.state === "active_dom" || binding.state === "active_debug") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary";
      btn.textContent = consented && debuggerPermission
        ? (binding.state === "active_debug" ? "Debug allowed" : "Debug consent granted")
        : "Allow debug (optional)";
      btn.disabled = consented && debuggerPermission && binding.state === "active_debug";
      btn.addEventListener("click", async () => {
        showError("");
        const result = await send("grant_debug", { bindingId: binding.bindingId });
        if (result?.error) showError(result.error);
        await refresh();
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

$("pair-btn").addEventListener("click", async () => {
  showError("");
  const pairingCode = $("pairing-code").value;
  const webPort = Number($("web-port").value || 62666);
  const result = await send("pair", { pairingCode, webPort });
  if (result?.error) showError(result.error);
  await refresh();
});

$("accept-btn").addEventListener("click", async () => {
  showError("");
  const result = await send("accept");
  if (result?.error) showError(result.error);
  await refresh();
});

$("unpair-btn").addEventListener("click", async () => {
  showError("");
  const result = await send("unpair");
  if (result?.error) showError(result.error);
  await refresh();
});

$("reconnect-btn").addEventListener("click", async () => {
  showError("");
  const result = await send("reconnect");
  if (result?.error) showError(result.error);
  await refresh();
});

void refresh();
