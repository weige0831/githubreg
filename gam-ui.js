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
// 用户改成别的地址，必须现场申请授权，否则后台 fetch 会被浏览器拦掉（表现是 Failed to fetch）。
// 权限匹配模式里不带端口（Chrome 的匹配模式忽略端口），写 http://127.0.0.1/* 就覆盖它的所有端口。
async function ensureHostPermission(rawUrl) {
  if (!String(rawUrl || "").trim()) return { ok: false, error: "请先填写地址" };
  let pattern;
  try {
    const u = new URL(rawUrl);
    pattern = `${u.protocol}//${u.hostname}/*`;
  } catch (e) {
    return { ok: false, error: "地址格式不对：" + rawUrl };
  }
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return { ok: true };
    const granted = await chrome.permissions.request({ origins: [pattern] });
    return granted
      ? { ok: true }
      : { ok: false, error: `未授权访问 ${pattern}，只在弹窗里点「允许」才能用` };
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
  const localEl = $id("gamSaveLocal");
  const stateEl = $id("gamState");
  const msgEl = $id("gamMsg");

  function render(s) {
    if (!s) return;
    enabledEl.checked = !!s.enabled;
    urlEl.value = s.baseUrl || "";
    passEl.value = s.masterPassword || "";
    keyEl.value = s.apiKey || "";
    sizeEl.value = s.groupSize || 10;
    localEl.checked = s.saveLocal !== false;
    const parts = [`已导入 ${s.imported} 个`];
    if (s.enabled) {
      parts.push(`下一备注 ${s.nextNote}`, `鉴权 ${s.authMode}`);
      if (s.pending) parts.push(`待重试 ${s.pending}`);
      if (s.saveLocal === false) parts.push(`本地 ${s.localCount} 个`);
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
      saveLocal: localEl.checked,
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

// ===== 🔀 Clash 自动换节点 =====

function initClashBox() {
  if (!$id("clashBox")) return;
  const enabledEl = $id("clashEnabled");
  const urlEl = $id("clashUrl");
  const secretEl = $id("clashSecret");
  const groupEl = $id("clashGroup");
  const slowEl = $id("clashSlow");
  const blockEl = $id("clashBlock");
  const stateEl = $id("clashState");
  const msgEl = $id("clashMsg");

  function render(s) {
    if (!s) return;
    enabledEl.checked = !!s.enabled;
    urlEl.value = s.baseUrl || "";
    secretEl.value = s.secret || "";
    groupEl.value = s.group || "";
    slowEl.value = s.slowMs || 5000;
    blockEl.value = s.blacklistMinutes || 10;
    if (!s.enabled) {
      stateEl.textContent = "未启用";
      return;
    }
    const parts = [];
    if (s.error) parts.push("连不上：" + s.error);
    else parts.push(`当前节点 ${s.current || "?"}`, `分组 ${s.groupUsed || "?"}`);
    if (s.blacklistCount) parts.push(`黑名单 ${s.blacklistCount} 个`);
    stateEl.textContent = parts.join(" · ");
  }

  async function save() {
    const cfg = {
      enabled: enabledEl.checked,
      baseUrl: urlEl.value.trim(),
      secret: secretEl.value.trim(),
      group: groupEl.value.trim(),
      slowMs: Math.max(500, Math.min(60000, parseInt(slowEl.value, 10) || 5000)),
      blacklistMinutes: Math.max(1, Math.min(1440, parseInt(blockEl.value, 10) || 10)),
    };
    // 不管开关开没开，只要填了地址就申请授权：否则「测试连接」会直接 Failed to fetch
    if (cfg.baseUrl) {
      const perm = await ensureHostPermission(cfg.baseUrl);
      if (!perm.ok) return { ok: false, error: perm.error };
    }
    const r = await bgSend("clash_set_config", { config: cfg });
    render(r.status);
    return r;
  }

  $id("clashSave").addEventListener("click", async () => {
    const r = await save();
    uiMsg(msgEl, r.ok ? "已保存" : "保存失败：" + (r.error || "未知错误"), r.ok);
  });

  $id("clashTest").addEventListener("click", async () => {
    uiMsg(msgEl, "测试中...");
    const saved = await save();
    if (!saved.ok) {
      uiMsg(msgEl, "保存失败：" + (saved.error || "未知错误"), false);
      return;
    }
    const r = await bgSend("clash_test");
    if (r.ok) {
      render({ ...(saved.status || {}), enabled: true, current: r.node, groupUsed: r.group });
      uiMsg(
        msgEl,
        `连接正常：分组「${r.group}」当前节点「${r.node}」，延迟 ${r.delay == null ? "测不通" : r.delay + "ms"}，共 ${r.total} 个节点`,
        true
      );
      return;
    }
    // 连不上时给点能直接照做的结论（Clash Verge 默认在 9097 且带随机密钥）
    if (r.permitted === false) {
      uiMsg(
        msgEl,
        `连不上：${r.error}\n` +
          `**扩展还没被授权访问这个地址**——Chrome 会直接拦掉本地请求（看起来就像端口不通）。\n` +
          `再点一次「保存」，弹出授权窗口时点「允许」，然后重新测试。`,
        false
      );
      return;
    }
    const p = r.probe;
    if (p && p.found) {
      urlEl.value = p.found;
      const hint = p.wrongSecret
        ? `控制器在 ${p.found}，但**密钥不对**——去 Clash Verge 的「设置 → 外部控制」重新复制 Secret`
        : p.needSecret
          ? `控制器在 ${p.found}，**需要密钥**——去 Clash Verge 的「设置 → 外部控制」复制 Secret 填到「密钥」里`
          : `已在 ${p.found} 找到控制器并自动填入地址，点「保存」再用`;
      uiMsg(msgEl, `连不上：${r.error}\n${hint}`, false);
    } else {
      const tried = (p && p.tried || []).map((t) => t.base.replace("http://", "")).join(" / ");
      uiMsg(
        msgEl,
        `连不上：${r.error}\n试过 ${tried || "常见端口"} 都没有响应——确认 Clash Verge 里「外部控制」是开着的，并核对端口`,
        false
      );
    }
  });

  $id("clashSwitch").addEventListener("click", async () => {
    uiMsg(msgEl, "换节点中...");
    const saved = await save();
    if (!saved.ok) {
      uiMsg(msgEl, "保存失败：" + (saved.error || "未知错误"), false);
      return;
    }
    const r = await bgSend("clash_switch", { reason: "手动切换" });
    render(r.status);
    uiMsg(
      msgEl,
      r.ok
        ? `已换到「${r.to}」` + (r.delay != null ? `（延迟 ${r.delay}ms）` : "") + `，旧节点已拉黑`
        : "换节点失败：" + (r.error || "未知错误"),
      r.ok
    );
  });

  $id("clashClear").addEventListener("click", async () => {
    const r = await bgSend("clash_set_config", { config: { clearBlacklist: true } });
    render(r.status);
    uiMsg(msgEl, "已清空黑名单（节点可以再被选中）", r.ok);
  });

  // 从 Clash 的配置文件里直接读地址和密钥（用户自己选文件，扩展不会主动读磁盘）
  $id("clashImport").addEventListener("click", () => $id("clashFile").click());
  $id("clashFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ""; // 同一个文件能再选一次
    if (!file) return;
    uiMsg(msgEl, `读取 ${file.name} ...`);
    const text = (await file.text()).slice(0, 20000); // 控制器配置都在文件开头
    const r = await bgSend("clash_import_config", { text });
    if (!r.ok) {
      uiMsg(msgEl, "没读到控制器配置：" + (r.error || "未知错误"), false);
      return;
    }
    urlEl.value = r.baseUrl;
    secretEl.value = r.secret;
    const saved = await save();
    uiMsg(
      msgEl,
      saved.ok
        ? `已从配置里读到 ${r.baseUrl}${r.secret ? " + 密钥" : "（这份配置没有密钥）"}，已保存`
        : "读到了但要先授权：" + (saved.error || ""),
      saved.ok
    );
  });

  bgSend("clash_get_status").then((r) => render(r.status));
}

document.addEventListener("DOMContentLoaded", () => {
  initManagerBox();
  initMailBox();
  initClashBox();
});
