// GitHub 自动注册 - 常驻侧边栏面板
// 面板不随点击关闭，切页/跳转都持续显示；负责启动注册、实时日志、批量进度

const $ = (s) => document.querySelector(s);
const logBox = $("#log");
const startBtn = $("#startBtn");
const exportBtn = $("#exportBtn");
const manageBtn = $("#manageBtn");
const countInput = $("#countInput");
const infoBox = $("#info");
const countEl = $("#count");
const queueBar = $("#queueBar");
const queueText = $("#queueText");
const queueFill = $("#queueFill");

// 当前账户凭据：**每换一个号都会变**。
// 原来是在点「开始注册」时用那次响应渲染一次，所以永远显示第一个号；
// 现在改成订阅 task 的变化，换号、打开面板时都会刷新。
async function refreshCurrentAccount() {
  let task = null;
  try {
    ({ task } = await chrome.storage.session.get("task"));
  } catch (e) {}
  if (!task || !task.email) {
    infoBox.classList.add("hidden");
    return;
  }
  infoBox.classList.remove("hidden");
  infoBox.innerHTML = `
      <div>📧 邮箱：<b>${task.email}</b></div>
      <div>👤 用户名：<b>${task.username || ""}</b></div>
      <div>🔑 密码：<b>${task.password || ""}</b></div>
    `;
}
try {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.task) refreshCurrentAccount();
  });
} catch (e) {}
refreshCurrentAccount();


function appendLog(text, cls = "") {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logBox.appendChild(div);
  // 只保留最近 200 行，避免内存膨胀
  while (logBox.children.length > 200) logBox.removeChild(logBox.firstChild);
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
}

// 批量进度：进行中禁用开始按钮并显示进度条
async function refreshQueue() {
  const resp = await chrome.runtime.sendMessage({ type: "get_queue" });
  const q = resp && resp.queue;
  if (q) {
    const done = q.total - q.left;
    queueText.textContent = `${done}/${q.total}`;
    queueFill.style.width = `${(done / q.total) * 100}%`;
    queueBar.classList.remove("hidden");
    startBtn.disabled = true;
  } else {
    queueBar.classList.add("hidden");
    queueFill.style.width = "0%";
    startBtn.disabled = false;
  }
}

stopBtn.addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "stop" });
  appendLog(resp && resp.ok ? "⏹ 已停止：不再开新号（点「开始注册」可重新开始）" : "停止失败", resp && resp.ok ? "" : "err");
  startBtn.disabled = false;
  refreshQueue();
});

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  const count = Math.max(1, Math.min(100000, parseInt(countInput.value, 10) || 1));
  appendLog(`开始注册（连续 ${count} 个）...`);
  const resp = await chrome.runtime.sendMessage({ type: "start", count });
  if (resp && resp.ok) {
    refreshCurrentAccount(); // 当前账户凭据（会跟着换号自动刷新）
    // 在当前标签页呼出侧边栏（用户手势上下文里更可靠）
    if (resp.tabId) {
      try {
        await chrome.sidePanel.open({ tabId: resp.tabId });
      } catch (e) {
        appendLog("提示：可点扩展图标在侧边栏固定本面板", "err");
      }
    }
    appendLog("已打开 GitHub 页面，开始自动注册");
  } else {
    appendLog("启动失败：" + ((resp && resp.error) || "未知错误"), "err");
    startBtn.disabled = false;
  }
  refreshQueue();
});

manageBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("accounts.html") });
});

exportBtn.addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "get_accounts" });
  const accounts = (resp && resp.accounts) || [];
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

// 面板常驻期间持续刷新进度
refreshCount();
refreshQueue();
setInterval(() => {
  refreshCount();
  refreshQueue();
  refreshCurrentAccount(); // 保险：就算 storage 事件漏了，每 1.5 秒也会把当前账户对齐一次
}, 1500);
