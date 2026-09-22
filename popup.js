// GitHub 自动注册 - 弹窗 UI（中文界面）

const $ = (s) => document.querySelector(s);
const logBox = $("#log");
const startBtn = $("#startBtn");
const exportBtn = $("#exportBtn");
const manageBtn = $("#manageBtn");
const countInput = $("#countInput");
const infoBox = $("#info");
const countEl = $("#count");
const queueEl = $("#queueStatus");

function appendLog(text, cls = "") {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

// 接收后台/页面脚本转发过来的日志
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "log") return;
  let cls = "";
  if (/成功|完成|已保存|🎉/.test(msg.text)) cls = "ok";
  if (/失败|错误|超时|报错|无效|中断/.test(msg.text)) cls = "err";
  appendLog(msg.text, cls);
});

async function refreshCount() {
  const { accounts = [] } = await chrome.storage.local.get("accounts");
  countEl.textContent = `${accounts.length} 个账户`;
  return accounts;
}

// 批量进度：进行中时禁用开始按钮并显示进度
async function refreshQueue() {
  const resp = await chrome.runtime.sendMessage({ type: "get_queue" });
  const q = resp && resp.queue;
  if (q) {
    const done = q.total - q.left;
    queueEl.textContent = `⏳ 批量进行中：${done}/${q.total}`;
    queueEl.classList.remove("hidden");
    startBtn.disabled = true;
  } else {
    queueEl.classList.add("hidden");
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  const count = Math.max(1, Math.min(999, parseInt(countInput.value, 10) || 1));
  appendLog(`开始注册（连续 ${count} 个）...`);
  const resp = await chrome.runtime.sendMessage({ type: "start", count });
  if (resp && resp.ok) {
    infoBox.classList.remove("hidden");
    infoBox.innerHTML = `
      <div>📧 邮箱：<b>${resp.email}</b></div>
      <div>👤 用户名：<b>${resp.username}</b></div>
      <div>🔑 密码：<b>${resp.password}</b></div>
    `;
    appendLog("已打开 GitHub 页面，开始自动注册");
    // 打开常驻侧边栏面板，注册过程可一直查看
    if (resp.tabId) {
      try {
        await chrome.sidePanel.open({ tabId: resp.tabId });
      } catch (e) {
        appendLog("提示：可点扩展图标在侧边栏固定面板", "err");
      }
    }
  } else {
    appendLog("启动失败：" + ((resp && resp.error) || "未知错误"), "err");
    startBtn.disabled = false;
  }
  refreshQueue();
});

// 管理账户：新标签页打开账户列表
manageBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("accounts.html") });
});

exportBtn.addEventListener("click", async () => {
  const accounts = await refreshCount();
  if (!accounts.length) {
    appendLog("还没有账户可导出", "err");
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
  appendLog(`已导出 ${accounts.length} 个账户`);
});

refreshCount();
refreshQueue();
// popup 打开期间持续刷新批量进度
setInterval(refreshQueue, 1500);
