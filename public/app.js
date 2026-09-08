const state = {
  target: null,
  references: [],
  polling: new Map(),
  jobs: []
};

const $ = (selector) => document.querySelector(selector);
const loginView = $("#loginView");
const appView = $("#appView");
const targetInput = $("#targetInput");
const referenceInput = $("#referenceInput");
const promptInput = $("#promptInput");
const generateButton = $("#generateButton");
const toast = $("#toast");

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.className = "toast"; }, 3400);
}

function showApp(authenticated) {
  loginView.classList.toggle("hidden", authenticated);
  appView.classList.toggle("hidden", !authenticated);
  if (authenticated) loadHistory();
}

function updateGenerateState() {
  generateButton.disabled = !state.target || !promptInput.value.trim();
}

function previewTarget(file) {
  const url = URL.createObjectURL(file);
  $("#targetPreview").style.backgroundImage = `url("${url}")`;
  $(".target-zone").classList.add("has-file");
}

function previewReferences(files) {
  const preview = $("#referencePreview");
  preview.innerHTML = "";
  state.references = Array.from(files).slice(0, 2);
  state.references.forEach((file) => {
    const image = document.createElement("img");
    image.src = URL.createObjectURL(file);
    image.alt = "Reference preview";
    preview.appendChild(image);
  });
  $(".reference-zone").classList.toggle("has-file", state.references.length > 0);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function renderHistory() {
  const list = $("#historyList");
  $("#historyCount").textContent = state.jobs.filter((job) => job.status === "completed").length;
  if (!state.jobs.length) {
    list.innerHTML = '<div class="empty-state"><span>✦</span><p>Your finished edits<br />will live here.</p></div>';
    return;
  }
  list.innerHTML = "";
  state.jobs.forEach((job) => {
    const item = document.createElement("article");
    item.className = "history-item";
    if (job.status === "completed" && job.resultUrl) {
      item.innerHTML = `<img class="history-image" src="${job.resultUrl}" alt="Generated edit" /><div class="history-caption"><p>${escapeHtml(job.prompt)}</p><small>${formatDate(job.createdAt)}</small></div>`;
      item.addEventListener("click", () => openModal(job));
    } else if (job.status === "processing") {
      item.innerHTML = `<div class="history-progress"><span class="mini-spinner"></span><span>${escapeHtml(job.step || "Creating your edit")}</span></div>`;
    } else {
      item.innerHTML = `<div class="history-progress"><span>×</span><span>Generation failed</span></div>`;
    }
    list.appendChild(item);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

async function loadHistory() {
  try {
    const data = await api("/api/history");
    state.jobs = data.jobs || [];
    renderHistory();
    state.jobs.filter((job) => job.status === "processing").forEach((job) => pollJob(job.id));
  } catch (error) {
    if (error.message === "Authentication required.") showApp(false);
  }
}

async function pollJob(id) {
  if (state.polling.has(id)) return;
  state.polling.set(id, true);
  const poll = async () => {
    try {
      const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
      const index = state.jobs.findIndex((job) => job.id === id);
      if (index > -1) state.jobs[index] = data.job;
      renderHistory();
      if (data.job.status === "processing") return window.setTimeout(poll, 2200);
      state.polling.delete(id);
      if (data.job.status === "completed") showToast("Your edit is ready.");
      else showToast(data.job.error || "The edit could not be completed.", true);
    } catch {
      state.polling.delete(id);
    }
  };
  poll();
}

async function submitGeneration() {
  if (!state.target || !promptInput.value.trim()) return;
  generateButton.disabled = true;
  generateButton.innerHTML = '<span class="spinner"></span> Creating your edit…';
  const form = new FormData();
  form.append("target", state.target);
  state.references.forEach((file) => form.append("references", file));
  form.append("prompt", promptInput.value.trim());
  try {
    const data = await api("/api/generate", { method: "POST", body: form });
    state.jobs.unshift(data.job);
    renderHistory();
    pollJob(data.job.id);
    showToast("Your studio edit has started.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    generateButton.innerHTML = 'Generate edit <span>↗</span>';
    updateGenerateState();
  }
}

function openModal(job) {
  $("#modalImage").src = job.resultUrl;
  $("#modalPrompt").textContent = job.prompt;
  $("#downloadLink").href = job.resultUrl;
  $("#previewModal").classList.remove("hidden");
}

function closeModal() {
  $("#previewModal").classList.add("hidden");
  $("#modalImage").src = "";
}

targetInput.addEventListener("change", () => {
  state.target = targetInput.files[0] || null;
  if (state.target) previewTarget(state.target);
  updateGenerateState();
});

referenceInput.addEventListener("change", () => previewReferences(referenceInput.files));
promptInput.addEventListener("input", () => {
  $("#promptCount").textContent = promptInput.value.length;
  updateGenerateState();
});
generateButton.addEventListener("click", submitGeneration);
$("#logoutButton").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  showApp(false);
});
document.querySelectorAll("[data-close-modal]").forEach((element) => element.addEventListener("click", closeModal));
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $("#loginError").textContent = "";
  try {
    await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
    });
    event.currentTarget.reset();
    showApp(true);
  } catch (error) {
    $("#loginError").textContent = error.message;
  }
});

api("/api/auth/me").then((data) => showApp(data.authenticated)).catch(() => showApp(false));