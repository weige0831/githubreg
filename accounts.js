// 账户管理页面：列表、复制、删除、清空、导出

const $ = (s) => document.querySelector(s);
const tbody = $("#table tbody");
const countEl = $("#count");
const toastEl = $("#toast");

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 1600);
}

function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("已复制到剪贴板");
  }
}

async function load() {
  const resp = await chrome.runtime.sendMessage({ type: "get_accounts" });
  const accounts = (resp && resp.accounts) || [];
  countEl.textContent = `共 ${accounts.length} 个`;
  tbody.innerHTML = "";
  accounts.forEach((a, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="mono">${escapeHtml(a.email)}</td>
      <td class="mono">${escapeHtml(a.username)}</td>
      <td class="mono">${escapeHtml(a.password)}</td>
      <td class="mono token">${escapeHtml(a.token || "-")}</td>
      <td class="mono">${escapeHtml(a.gamGroup || "-")}</td>
      <td class="mono">${escapeHtml(a.gamNote || "-")}</td>
      <td>${formatTime(a.time)}</td>
      <td class="ops">
        <button class="small copy">复制</button>
        <button class="small del">删除</button>
      </td>`;
    tr.querySelector(".copy").addEventListener("click", () =>
      copyText(`${a.username}:${a.password}--${a.email}${a.token ? "--" + a.token : ""}`)
    );
    tr.querySelector(".del").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "delete_account", index: i });
      load();
    });
    tbody.appendChild(tr);
  });
  $("#empty").classList.toggle("hidden", accounts.length > 0);
}

$("#exportBtn").addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "get_accounts" });
  const accounts = (resp && resp.accounts) || [];
  if (!accounts.length) {
    toast("还没有账户可导出");
    return;
  }
  const lines = accounts.map((a) => `${a.username}:${a.password}--${a.email}${a.token ? "--" + a.token : ""}`);
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "github_accounts.txt";
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${accounts.length} 个账户`);
});

$("#clearBtn").addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "get_accounts" });
  const n = (resp && resp.accounts || []).length;
  if (!n) {
    toast("已经是空的了");
    return;
  }
  if (!confirm(`确定清空全部 ${n} 个账户吗？此操作不可恢复。`)) return;
  await chrome.runtime.sendMessage({ type: "clear_accounts" });
  load();
  toast("已清空");
});

// 账户变化时自动刷新（比如扩展面板批量注册成功）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.accounts) load();
});

load();
