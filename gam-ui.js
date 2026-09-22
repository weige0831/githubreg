// 运行前可填写的配置区块（popup 与侧边栏面板共用）：
//   📥 导入管理器：地址 / API Key / 管理密码 / 每组数量
//   📧 临时邮箱：邮局地址 / 邮箱域名
// 后台消息接口：gam_get_status gam_set_config gam_test gam_retry_pending
//               gam_create_apikey mail_get_status mail_set_config mail_test

const $id = (id) => document.getElementById(id);

function uiMsg(el, text, ok) {
  el.textContent = text;
  el.className = "gam-msg" + (ok === true ? " ok" : ok === false ? " err" : "");
}

async function bgSend(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra }).catch(() => null);
  return r || { ok: false, error: "后台无响应" };
}

// 扩展只预授权了 github.com；管理器和邮局地址都是用户自己填的，
// 保存时会用 chrome.permissions.request 现场申请该域名的访问权限。
// 用户改成别的地址，必须现场申请授权，否则后台 fetch 会被浏览器拦掉。
async function ensureHostPermission(rawUrl) {
  if (!String(rawUrl || "").trim()) return { ok: false, error: "请先填写地址" };
  let origin;
  try {
    origin = new URL(rawUrl).origin + "/*";
  } catch (e) {
    return { ok: false, error: "地址格式不对：" + rawUrl };
  }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return { ok: true };
    const granted = await chrome.permissions.request({ origins: [origin] });
    return granted
      ? { ok: true }
      : { ok: false, error: `未授权访问 ${origin}，保存时请在弹窗里点「允许」` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ===== 📥 导入管理器 =====

function initManagerBox() {
  if (!$id("gamBox")) return;
  const enabledEl = $id("gamEnabled");
  const urlEl = $id("gamUrl");
  const passEl = $id("gamPass");
  const keyEl = $id("gamApiKey");
  const sizeEl = $id("gamSize");
  const stateEl = $id("gamState");
  const msgEl = $id("gamMsg");

  function render(s) {
    if (!s) return;
    enabledEl.checked = !!s.enabled;
    urlEl.value = s.baseUrl || "";
    passEl.value = s.masterPassword || "";
    keyEl.value = s.apiKey || "";
    sizeEl.value = s.groupSize || 10;
    const parts = [`已导入 ${s.imported} 个`];
    if (s.enabled) {
      parts.push(`下一备注 ${s.nextNote}`, `鉴权 ${s.authMode}`);
      if (s.pending) parts.push(`待重试 ${s.pending}`);
    } else {
      parts.unshift("已关闭");
    }
    stateEl.textContent = parts.join(" · ");
  }

  async function save() {
    const cfg = {
      enabled: enabledEl.checked,
      baseUrl: urlEl.value.trim(),
      masterPassword: passEl.value.trim(),
      apiKey: keyEl.value.trim(),
      groupSize: Math.max(1, Math.min(100, parseInt(sizeEl.value, 10) || 10)),
    };
    const perm = await ensureHostPermission(cfg.baseUrl);
    if (!perm.ok) return { ok: false, error: perm.error };
    const r = await bgSend("gam_set_config", { config: cfg });
    render(r.status);
    return r;
  }

  $id("gamSave").addEventListener("click", async () => {
    const r = await save();
    uiMsg(msgEl, r.ok ? "已保存" : "保存失败：" + (r.error || "未知错误"), r.ok);
  });

  // 测试用表单里的地址/密码，所以先保存再请求
  $id("gamTest").addEventListener("click", async () => {
    uiMsg(msgEl, "测试中...");
    const saved = await save();
    if (!saved.ok) {
      uiMsg(msgEl, "保存失败：" + (saved.error || "未知错误"), false);
      return;
    }
    const r = await bgSend("gam_test");
    uiMsg(
      msgEl,
      r.ok ? `连接正常，管理器现有 ${r.groups} 个分组` : "连接失败：" + (r.error || "未知错误"),
      r.ok
    );
  });

  // 用管理密码换一个长期 API Key 并直接存起来
  $id("gamGenKey").addEventListener("click", async () => {
    uiMsg(msgEl, "正在生成 API Key...");
    const saved = await save();
    if (!saved.ok) {
      uiMsg(msgEl, "保存失败：" + (saved.error || "未知错误"), false);
      return;
    }
    const r = await bgSend("gam_create_apikey", { name: "github-auto-reg" });
    if (r.ok) {
      keyEl.value = r.key;
      render(r.status);
      uiMsg(msgEl, "已生成并保存 API Key：" + r.key.slice(0, 16) + "...", true);
    } else {
      uiMsg(msgEl, "生成失败：" + (r.error || "未知错误"), false);
    }
  });

  $id("gamRetry").addEventListener("click", async () => {
    uiMsg(msgEl, "补导入中...");
    const r = await bgSend("gam_retry_pending");
    render(r.status);
    uiMsg(msgEl, r.ok ? `本次补导入 ${r.done} 个，剩余待重试 ${r.left} 个` : "补导入失败", r.ok);
  });

  bgSend("gam_get_status").then((r) => render(r.status));
}

// ===== 📧 临时邮箱 =====

function initMailBox() {
  if (!$id("mailBox")) return;
  const urlEl = $id("mailUrl");
  const domainEl = $id("mailDomain");
  const stateEl = $id("mailState");
  const msgEl = $id("mailMsg");

  function render(s) {
    if (!s) return;
    urlEl.value = s.apiUrl || "";
    domainEl.value = s.domain || "";
    stateEl.textContent = s.domain ? `域名 ${s.domain}` : "未配置";
  }

  async function save() {
    const cfg = { apiUrl: urlEl.value.trim(), domain: domainEl.value.trim() };
    if (!cfg.domain) return { ok: false, error: "邮箱域名不能为空" };
    const perm = await ensureHostPermission(cfg.apiUrl);
    if (!perm.ok) return { ok: false, error: perm.error };
    const r = await bgSend("mail_set_config", { config: cfg });
    render(r.status);
    return r;
  }

  $id("mailSave").addEventListener("click", async () => {
    const r = await save();
    uiMsg(msgEl, r.ok ? "已保存" : "保存失败：" + (r.error || "未知错误"), r.ok);
  });

  // 真调一次建邮箱接口（注册流程用的就是它），比 ping 更能说明问题
  $id("mailTest").addEventListener("click", async () => {
    uiMsg(msgEl, "正在建一个测试邮箱...");
    const saved = await save();
    if (!saved.ok) {
      uiMsg(msgEl, "保存失败：" + (saved.error || "未知错误"), false);
      return;
    }
    const r = await bgSend("mail_test");
    uiMsg(msgEl, r.ok ? `建邮箱成功：${r.email}` : "失败：" + (r.error || "未知错误"), r.ok);
  });

  bgSend("mail_get_status").then((r) => render(r.status));
}

document.addEventListener("DOMContentLoaded", () => {
  initManagerBox();
  initMailBox();
});
