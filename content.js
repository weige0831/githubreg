// GitHub 自动注册 - 页面脚本（在 github.com 上运行）
// 流程按阶段（stage）驱动，跨页面导航用 chrome.storage.session 持久化：
//   start ->（首页点 Sign up）-> fill ->（填表提交）-> code ->（填验证码）-> done

const SIGNUP_BUTTON_XPATH =
  "/html/body/div[1]/div[8]/main/react-app/div/div/div/section[1]/" +
  "div[1]/div[5]/div/form/section/div/button";
const EMAIL_SEL = 'input#email, input[name="user[email]"]';
const PW_SEL = 'input#password, input[name="user[password]"], input[type="password"]';
const USER_SEL = 'input#login, input[name="user[login]"]';
const CODE_INPUT_SEL =
  'input#launch-code-0, input[autocomplete="one-time-code"], input[name="otp"], input[inputmode="numeric"]';

// 注册表单里「这个邮箱已经注册过」的几种说法（GitHub 换过文案，都要认）
// 截图里那条：The email you have provided is already associated with an account.
const EMAIL_TAKEN_RE =
  /already associated|already registered|already been taken|already taken|invalid email/i;

// GitHub 限流（429）的几种页面提示
const RATE_LIMIT_RE =
  /too many (requests|attempts)|rate limit|whoa there|try again (in|later)|请求过多|请求太频繁|操作过于频繁|尝试次数过多|过于频繁/i;

// GitHub 的「人机验证 / 访问暂时受限」拦截页（中英文都认）：
//   访问暂时受限 / 我不是机器人 / verify you are human / temporarily restricted ...
// 这一页没有表单也没有验证码框，流程走不下去，按限流一样处理（换节点 + 刷新重试）
const BOT_CHALLENGE_RE =
  /访问暂时受限|暂时受限|我不是机器人|verify you are human|are you a robot|temporarily restricted|unusual (activity|traffic)/i;

// 返回命中的类型（""=没命中），顺手把两类拦截合并成一个入口
function limitKind() {
  const body = document.body ? document.body.innerText : "";
  if (BOT_CHALLENGE_RE.test(body)) return "人机验证拦截";
  if (RATE_LIMIT_RE.test(body)) return "限流";
  return "";
}

// ===== 创建 token 页面 =====
// classic token 页：scopes 由 URL 参数预勾选，页面只需填 Note -> 选 No expiration -> Generate
const TOKEN_SCOPES = [
  "repo", "repo:status", "repo_deployment", "public_repo", "repo:invite",
  "security_events", "workflow", "write:packages", "read:packages",
  "delete:packages", "admin:org", "write:org", "read:org", "manage_runners:org",
  "admin:public_key", "write:public_key", "read:public_key", "admin:repo_hook",
  "write:repo_hook", "read:repo_hook", "admin:org_hook", "gist", "notifications",
  "user", "user:email", "user:follow", "delete_repo", "write:discussion",
  "read:discussion", "admin:enterprise", "manage_runners:enterprise",
  "manage_billing:enterprise", "read:enterprise", "scim:enterprise", "audit_log",
  "read:audit_log", "codespace", "codespace:secrets", "copilot",
  "manage_billing:copilot", "write:network_configurations",
  "read:network_configurations", "project", "read:project", "admin:gpg_key",
  "write:gpg_key", "read:gpg_key", "admin:ssh_signing_key",
  "write:ssh_signing_key", "read:ssh_signing_key",
];
const TOKEN_PAGE =
  "https://github.com/settings/tokens/new?scopes=" + TOKEN_SCOPES.join(",");
// classic 页元素：Note 输入框 / Expiration 下拉 / scopes 复选框
const TOKEN_NOTE_SEL =
  'input#token_description, input[name="token[description]"]';
const TOKEN_EXPIRE_SEL =
  'select#token_expires_at, select[name="token[expires_at]"]';
const TOKEN_SCOPE_BOX_SEL = 'input[type="checkbox"][name="token[scopes][]"]';

// ===== fine-grained token 页面（用户实测的 XPath，作为兜底保留）=====
const LOGIN_SUBMIT_XPATH =
  "/html/body/div[1]/div[4]/main/div/div[2]/form/div[3]/input";
const TOKEN_NAME_XPATH =
  "/html/body/div[1]/div[6]/main/div/div/div[2]/div/div/form/dl/dd/input";
const TOKEN_MENU_XPATH =
  "/html/body/div[1]/div[6]/main/div/div/div[2]/div/div/form/div/div/div/dl[1]/dd/span/div[2]/action-menu/focus-group/anchored-position/div/div/action-list/div/ul/li[4]/button";
const TOKEN_CHECKBOX_XPATH =
  "/html/body/div[1]/div[6]/main/div/div/div[2]/div/div/form/div/dl/dd/div/ul/li[{n}]/div/label/div[1]/input";
const TOKEN_GENERATE_XPATH =
  "/html/body/div[1]/div[6]/main/div/div/div[2]/div/div/form/p/button";
const TOKEN_CODE_XPATH =
  "/html/body/div[1]/div[6]/main/div/div/div[2]/div/div/div[1]/div[2]/div/div/code";

const ADJ = [
  "cool", "fast", "blue", "red", "neo", "sky", "dev", "byte", "code", "pixel",
  "silver", "golden", "crimson", "cosmic", "lunar", "solar", "stormy",
  "winter", "oceanic", "mystic", "quantum", "rapid", "hyper", "mega", "ultra",
];
const NOUN = [
  "fox", "wolf", "cat", "owl", "bear", "hawk", "lion", "frog", "deer", "crab",
  "falcon", "tiger", "panda", "dragon", "phoenix", "panther", "eagle", "shark",
  "otter", "raven", "koala", "badger", "penguin", "jaguar",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => ({}));
}
// 注意：content 的日志用独立类型 content_log，
// 避免消息同时被「面板」和「后台转发」重复显示（面板只认后台转发的 log）
function log(text) {
  window.__ghLastLogAt = Date.now(); // 给"卡住看门狗"当心跳：有日志就说明流程在动
  send({ type: "content_log", text });
}
function randUsername() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return a + n + Math.floor(100000 + Math.random() * 900000);
}

async function getTask() {
  const r = await send({ type: "get_task" });
  return r.task;
}
async function setTask(task) {
  await send({ type: "set_task", task });
}

const qs = (sel) => document.querySelector(sel);

function xpathFirst(xp) {
  try {
    return document.evaluate(
      xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
  } catch (e) {
    return null;
  }
}

// 已登录判断：GitHub 登录后页面有 meta[name=user-login]
function isLoggedIn() {
  try {
    const m = document.querySelector('meta[name="user-login"]');
    if (m && m.content) return true;
  } catch (e) {}
  return bodyText().includes("sign out");
}

// React 受控输入：用原生 value setter + 触发 input/change 事件
function setReactValue(el, value) {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function reactFill(sel, value, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const el = qs(sel);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.focus();
      setReactValue(el, value);
      await sleep(400);
      if (el.value === value) return true;
    }
    await sleep(800);
  }
  return false;
}

async function waitFor(selOrFn, timeoutMs, interval = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = typeof selOrFn === "function" ? selOrFn() : !!qs(selOrFn);
      if (ok) return true;
    } catch (e) {}
    await sleep(interval);
  }
  return false;
}

// ===== 首页：点 Sign up =====

const bodyText = () => (document.body ? document.body.innerText.toLowerCase() : "");

function hasSignupButton() {
  try {
    const el = document.evaluate(
      SIGNUP_BUTTON_XPATH, document, null,
      XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
    if (el) return true;
  } catch (e) {}
  return (
    !!qs('a[href="/signup"]') ||
    [...document.querySelectorAll("a, button")].some((e) => e.textContent.trim() === "Sign up")
  );
}

function clickSignup() {
  try {
    const el = document.evaluate(
      SIGNUP_BUTTON_XPATH, document, null,
      XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
    if (el) {
      el.click();
      log("已点 Sign up（XPath）");
      return true;
    }
  } catch (e) {}
  const link = qs('a[href="/signup"]');
  if (link) {
    link.click();
    log("已点 Sign up（链接）");
    return true;
  }
  const byText = [...document.querySelectorAll("a, button")]
    .find((e) => e.textContent.trim() === "Sign up");
  if (byText) {
    byText.click();
    log("已点 Sign up（文本）");
    return true;
  }
  return false;
}

// ===== 注册表单：填表 + 提交 =====

async function clickCreateAccount() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const btns = [...document.querySelectorAll('button, input[type="submit"]')]
      .filter((b) => b.textContent.trim() === "Create account");
    if (btns.length === 0) return false; // 按钮不存在 = 页面已跳转
    const btn = btns[btns.length - 1]; // submit 是真正的提交按钮
    if (!btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      log("已点 Create account");
      return true;
    }
    await sleep(1000);
  }
  return false;
}

async function runFill(task) {
  if (!(await waitFor(EMAIL_SEL, 30000))) {
    log("找不到邮箱输入框（布局可能变了）");
    return;
  }
  await reactFill(EMAIL_SEL, task.email);
  await reactFill(PW_SEL, task.password);

  // 用户名：填后 GitHub 异步校验可用性，重名则换
  for (let i = 0; i < 3; i++) {
    await reactFill(USER_SEL, task.username);
    await sleep(2500);
    const body = document.body.innerText.toLowerCase();
    if (/unavailable|already taken|not available|is already/.test(body)) {
      task.username = randUsername();
      log("用户名被占用，重试 -> " + task.username);
      continue;
    }
    break;
  }

  // marketing 勾选框：默认未勾，确保不勾（opt-out）
  const cb = qs('input#user_signup\\[marketing_consent\\], input[name="user_signup[marketing_consent]"]');
  if (cb && cb.checked) cb.click();

  log("表单已填好，提交中...");
  await sleep(2000);
  const first = await clickCreateAccount();
  await sleep(4000);
  if (!location.href.includes("account_verifications")) {
    await clickCreateAccount();
    await sleep(3000);
  }

  // 表单报错检查（邮箱已注册等），别傻等验证码
  if (EMAIL_TAKEN_RE.test(document.body.innerText)) {
    await handleEmailTaken(task);
    return;
  }

  task.stage = "code";
  await setTask(task);
  log("等待 GitHub 验证码...");
}

// 回到流程里该在的页面（用干净的 GET 地址，避免 POST 结果页弹「确认重新提交表单」）
function backToFlow(task) {
  location.href = task.stage === "token" ? "https://github.com/" : "https://github.com/signup";
}

// 遇到限流的处理节奏（按用户要求）：
//   ① 一出现限流就**直接拉黑当前节点并换下一个节点**，页面重新打开；
//   ② 在**同一个（新）节点上连续刷新 10 次**；
//   ③ 10 次后还限流 → 等 1 分钟，在当前节点再刷新 10 次；
//   ④ 还限流 → 把当前节点拉黑（时长见面板配置），换下一个节点，回到 ② 重复；
//   一直到不出现限流为止，全程不需要人工。
// 注意：每次页面加载只算一次刷新（页面内观察器不会重复计数）。
async function handleRateLimit(task, kind = "限流") {
  const rl = task.rateLimit || { node: "", refresh: 0, waited: false };

  // ① 刚发现限流：直接拉黑当前节点 + 换下一个节点
  if (!rl.node) {
    rl.refresh = 0;
    rl.waited = false;
    log(`🚦 检测到 GitHub ${kind}：拉黑当前节点并换下一个节点，然后在它上面连续刷新重试`);
    const r = await send({ type: "clash_switch", reason: `GitHub ${kind}：拉黑当前节点并切换`, reload: true, rotate: true, blacklist: true });
    if (r && r.ok) {
      rl.node = r.to || "(当前节点)";
      task.rateLimit = rl;
      await setTask(task);
      log(`已拉黑旧节点并换到「${rl.node}」${r.delay != null ? `（延迟 ${r.delay}ms）` : ""}，开始刷新重试`);
      return true;
    }
    rl.node = "(换节点没成功，先用当前节点)";
    log("换节点没成功：" + ((r && r.error) || "未知原因") + " —— 先在当前节点刷新重试");
  }

  // ② 同一节点上连续刷新，最多 10 次
  if (rl.refresh < 10) {
    rl.refresh += 1;
    task.rateLimit = rl;
    await setTask(task);
    log(`🔄 第 ${rl.refresh}/10 次刷新重试（${kind}，节点：${rl.node}）...`);
    backToFlow(task);
    return true;
  }

  // ③ 刷满 10 次还限流：等 1 分钟，同一节点再刷 10 次
  if (!rl.waited) {
    rl.waited = true;
    rl.refresh = 0;
    task.rateLimit = rl;
    await setTask(task);
    log(`已刷新 10 次仍被${kind}，等 1 分钟后在「${rl.node}」上继续刷新重试...`);
    await sleep(60000);
    backToFlow(task);
    return true;
  }

  // ④ 等过一轮还限流：拉黑当前节点，换下一个节点，回到 ② 继续
  rl.refresh = 0;
  rl.waited = false;
  task.rateLimit = rl;
  await setTask(task);
  log(`「${rl.node}」刷新 10 次 + 等待 1 分钟仍被${kind}：拉黑它并换下一个节点继续重试`);
  const r2 = await send({ type: "clash_switch", reason: `${kind}：拉黑后换下一个节点`, reload: true, rotate: true, blacklist: true });
  if (r2 && r2.ok) {
    rl.node = r2.to || "(当前节点)";
    task.rateLimit = rl;
    await setTask(task);
    log(`已拉黑旧节点并换到「${rl.node}」，重新开始 10 次刷新重试`);
    return true;
  }
  log("没有可换的节点了（可能都在黑名单里，等它们解禁）：1 分钟后自动再试");
  await sleep(60000);
  backToFlow(task);
  return true;
}

// 长等待期间定时"心跳"（只更新进度时间戳，不刷日志）。
// 不这么做的话，>60 秒的合法等待会被卡住看门狗误判成卡住——验证码那两处就是 90 秒。
async function keepAlive(fn) {
  const t = setInterval(() => {
    window.__ghLastLogAt = Date.now();
  }, 15000);
  try {
    return await fn();
  } finally {
    clearInterval(t);
  }
}

// 兜底看门狗：任何页面卡住超过 5 分钟（期间一句日志都没有）就按限流/拦截处理，
// 免得遇到没覆盖到的页面、弹窗、请求卡死就干等在那儿（防止遗漏）
function watchStuck(task) {
  // 第一次发现卡住要等满 5 分钟；已经在重试循环里了就只等 1 分钟
  // （否则每次都要 5 分钟，一轮 10 次刷新要拖 50 分钟）
  const limitMs = task.rateLimit ? 60000 : 5 * 60 * 1000;
  const limitMin = limitMs / 60000;
  const started = Date.now();
  const timer = setInterval(async () => {
    if (window.__ghAutoRegRateLimitHandled) return clearInterval(timer);
    const last = window.__ghLastLogAt || started;
    if (Date.now() - last < limitMs) return; // 还有动静，继续等
    clearInterval(timer);
    window.__ghAutoRegRateLimitHandled = true;
    log(`⏳ 这个页面超过 ${limitMin} 分钟没有任何进展：按拦截/限流处理（拉黑换节点 + 重新打开页面）`);
    await handleRateLimit(task, "页面卡住");
  }, 15000);
}

// 盯着页面：限流提示常常是首屏之后才出现的，出现就立刻处理
// 一次页面加载只处理一次（页面级标记），否则同一次刷新会被重复计数
function watchRateLimit(task) {
  if (window.__ghAutoRegRateLimitWatch) return;
  window.__ghAutoRegRateLimitWatch = true;
  let ticks = 0;
  const timer = setInterval(async () => {
    if (++ticks > 18) return clearInterval(timer); // 最多盯 90 秒
    if (window.__ghAutoRegRateLimitHandled) return clearInterval(timer); // 本次加载已处理过
    const kind = limitKind();
    if (!kind) return;
    clearInterval(timer);
    window.__ghAutoRegRateLimitHandled = true;
    await handleRateLimit(task, kind);
  }, 5000);
}

// 邮箱已经被注册过：直接换一个新邮箱重开这个位置，不做别的判断。
// 上限 3 次，超过就按「无 token」保存收尾，避免整批卡死在这一步。
async function handleEmailTaken(task) {
  task.emailTaken = true; // 防止这个任务的注册表单被重复提交（GitHub 只会再报一次同样的错）
  task.recoverAttempts = (task.recoverAttempts || 0) + 1;
  await setTask(task);
  log(`⚠️ 这个邮箱已被注册过（第 ${task.recoverAttempts} 次）：${task.email}`);

  if (task.recoverAttempts > 3) {
    log("换邮箱重试次数过多，先保存账户（无 token）");
    await finish(task);
    return;
  }

  log("换一个新邮箱重开（批次名额不消耗）...");
  const r = await send({ type: "new_account", attempts: task.recoverAttempts });
  if (r && r.ok) {
    log("已换新邮箱：" + r.email + "（新标签页已打开，本页会被关掉）");
  } else {
    log("换邮箱失败：" + ((r && r.error) || "后台无响应") + "，先保存账户（无 token）");
    await finish(task);
  }
}

// ===== 验证码页：收信 + 填码 =====

async function clickResend() {
  const btns = [...document.querySelectorAll("button")]
    .filter((b) => b.textContent.trim() === "Resend the code");
  if (btns.length) {
    btns[btns.length - 1].click();
    log("已点 Resend the code");
    return true;
  }
  return false;
}

async function fillLaunchCode(code) {
  const digits = code.replace(/\D/g, "").slice(0, 8);
  for (let i = 0; i < digits.length; i++) {
    const el = qs(`input#launch-code-${i}`);
    if (!el) continue;
    setReactValue(el, digits[i]);
    await sleep(120);
  }
  const cont = [...document.querySelectorAll("button")]
    .filter((b) => b.textContent.trim() === "Continue").pop();
  if (cont) {
    cont.click();
    log("已点 Continue");
    return true;
  }
  return false;
}

// 这一个号走不下去了（收不到码 / 码一直无效）：自动回注册页重来，最多 3 次，
// 之后按「无 token」保存并继续下一个 —— 全自动，不留给人工处理。
async function retryOrFinish(task, why) {
  task.signupRetries = (task.signupRetries || 0) + 1;
  await setTask(task);
  if (task.signupRetries > 3) {
    log(`${why}：已自动重来 3 次仍未成功，保存账户（无 token）并继续下一个`);
    await finish(task);
    return;
  }
  log(`${why}：自动回注册页重来（第 ${task.signupRetries} 次）...`);
  location.href = "https://github.com/signup";
}

async function runCode(task) {
  // 等验证码框最多 5 分钟：静默心跳 15 秒一次（防看门狗误判），另外每 90 秒在日志里报一下
  const gotInput = await keepAlive(async () => {
    const hb = setInterval(() => log("还在等 GitHub 的验证码框..."), 90000);
    try {
      return await waitFor(CODE_INPUT_SEL, 300000);
    } finally {
      clearInterval(hb);
    }
  });
  if (!gotInput) {
    // 没等到验证码框：可能已原地成功，否则自动重来
    if (bodyText().includes("created successfully")) {
      await finish(task);
    } else {
      await retryOrFinish(task, "5 分钟没等到验证码输入框");
    }
    return;
  }

  // 自动收信：90s 没到就点一次 Resend 催信，再等 150s
  let code = null;
  for (let attempt = 0; attempt < 3 && !code; attempt++) {
    const resp = await keepAlive(() =>
      send({ type: "request_code", token: task.token, timeoutMs: 90000 })
    );
    code = resp && resp.code;
    if (!code) {
      log("90 秒未收到邮件，催信重试...");
      await clickResend();
    }
  }
  if (!code) {
    await retryOrFinish(task, "验证码获取超时");
    return;
  }
  log("已拿到验证码: " + code);

  await fillLaunchCode(code);
  // 短等待后检查：若页面已跳转（上下文被销毁），由 main() 在下一页识别收尾
  await sleep(4000);
  const body = bodyText();
  if (body.includes("created successfully")) {
    await finish(task);
    return;
  }
  if (/invalid|incorrect|wrong code/.test(body)) {
    task.codeAttempts = (task.codeAttempts || 0) + 1;
    await setTask(task);
    if (task.codeAttempts >= 3) {
      await retryOrFinish(task, "验证码连续 3 次无效");
    } else {
      log("验证码无效或已过期，稍后自动重试...");
    }
    return;
  }
  log("验证码已填，等待跳转...");
  // 若已跳到 /login，下一次页面加载由 main() 识别 "created successfully" 收尾
}

// ===== 注册成功后自动登录 + 创建 fine-grained token =====

async function autoLogin(task) {
  log("注册成功！自动登录中...");
  const userEl = await waitFor(() => qs("#login_field"), 30000);
  if (!userEl) {
    log("登录页没找到用户名输入框");
    return;
  }
  await reactFill("#login_field", task.username);
  const pwEl = qs("#password");
  if (pwEl) await reactFill("#password", task.password);
  // GitHub 登录按钮是 input[type=submit]，没有 textContent，要同时按 value 匹配
  const btn = xpathFirst(LOGIN_SUBMIT_XPATH) ||
    [...document.querySelectorAll('button, input[type="submit"]')]
      .filter((b) => b.textContent.trim() === "Sign in" || b.value === "Sign in").pop();
  if (btn) {
    btn.click();
    log("已点 Sign in");
  } else {
    // 找不到按钮就回车提交，别留给人工
    const pw = qs("#password");
    if (pw) {
      pw.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
      log("Sign in 按钮没找到，已用回车提交登录");
    } else {
      log("登录表单提交不了（找不到按钮和密码框）");
    }
  }
  task.stage = "token";
  await setTask(task);
  log("登录中，进入首页后自动跳转 token 创建页...");
}

// 从当前页面任意位置读 token（code 元素 / 只读输入框 / 页面文本兜底）
function readTokenFromPage() {
  const el = xpathFirst(TOKEN_CODE_XPATH) ||
    [...document.querySelectorAll("code")]
      .find((c) => /github_pat_|gh[pousr]_/.test(c.textContent || "")) ||
    [...document.querySelectorAll("input")]
      .find((i) => /github_pat_|gh[pousr]_/.test(i.value || ""));
  if (el) {
    const t = (el.textContent || el.value || "").trim();
    if (t) return t;
  }
  const m = document.body.innerText.match(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

// token 已生成过：只读 token 收尾，绝不重复创建
async function finalizeToken(task) {
  const token = readTokenFromPage();
  if (token) {
    task.tokenValue = token;
    await setTask(task);
    log("已拿到 token: " + token.slice(0, 24) + "...");
  } else {
    log("token 已生成但没读到（页面可能已跳转），账户先保存（无 token）");
  }
  await finish(task);
}

// classic 页：Expiration 选 No expiration（永久有效）
// 兼容老布局的原生 select 和新版自定义下拉（details / select-menu）
async function selectNoExpiration(root) {
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  const usable = (el) =>
    el && !el.disabled && el.getAttribute("aria-disabled") !== "true";

  // A) 原生 select
  const sel = qs(TOKEN_EXPIRE_SEL);
  if (sel) {
    const opt = [...sel.options].find((o) => /no expiration/i.test(o.textContent));
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
  }

  // B) 自定义下拉：先展开菜单（触发器上是「30 days (Oct 22, 2026)」这类文案）
  // 注意不要把菜单里的「Custom」项当成触发器，只认带天数的当前值或 No expiration
  const findTrigger = (scope) =>
    [...scope.querySelectorAll("summary, button, [role='button'], [aria-haspopup]")]
      .find((el) => usable(el) && /(?:days?\s*\(|no expiration)/i.test(text(el)));
  const trigger = (root && findTrigger(root)) || findTrigger(document);
  if (trigger) {
    const details = trigger.closest("details");
    if (details) details.open = true; // 直接展开，避免点击被遮挡
    else trigger.click();
    await sleep(400);
  }

  // 菜单可能被渲染到表单外（portal），所以在整页里找「No expiration」
  const option = [...document.querySelectorAll(
    "[role='menuitemradio'], [role='option'], button, li, a"
  )]
    .filter((el) => usable(el) && /^no expiration$/i.test(text(el)))
    .pop(); // 取最内层那个（li 里通常还套着 button）
  if (!option) return false;

  option.click();
  await sleep(400);
  // 复检：触发器文案应已变成 No expiration（React 可能换掉节点，所以重新查一次）
  const after = findTrigger(document);
  return !after || /no expiration/i.test(text(after));
}

// classic 页：URL 的 ?scopes= 会把复选框预勾上；万一参数被忽略就按列表补勾
async function ensureClassicScopes() {
  const boxes = [...document.querySelectorAll(TOKEN_SCOPE_BOX_SEL)];
  if (!boxes.length) return;
  const wanted = new Set(TOKEN_SCOPES);
  let fixed = 0;
  for (const b of boxes) {
    if (!wanted.has(b.value) || b.checked || b.disabled) continue;
    b.click();
    fixed++;
    await sleep(60);
  }
  const checked = boxes.filter((b) => b.checked).length;
  log(
    `scopes 已勾选 ${checked} 个` +
      (fixed ? `（URL 未生效，补勾 ${fixed} 个）` : "（URL 预选）")
  );
}

// classic token 页判定：有 scopes 复选框 / form 指向 /settings/tokens；
// fine-grained 页有专属的 Token name 输入框（两页都有描述框，不能只看描述框）
function isClassicTokenPage() {
  if (qs("#fine-grained-personal-access-token-name")) return false;
  return (
    !!qs(TOKEN_SCOPE_BOX_SEL) ||
    !!qs('form[action="/settings/tokens"]') ||
    !!qs(TOKEN_NOTE_SEL)
  );
}

async function runToken(task) {
  task.tokenAttempts = (task.tokenAttempts || 0) + 1;
  if (task.tokenAttempts > 3) {
    log("token 创建多次未成功，先保存账户（无 token）");
    await finish(task);
    return;
  }
  await setTask(task);

  // 名字输入框存在才算真正的表单页（classic: Note 框 / fine-grained: Token name 框）
  const isClassic = isClassicTokenPage();
  const nameInput = isClassic
    ? qs(TOKEN_NOTE_SEL) || qs('form input[type="text"]')
    : xpathFirst(TOKEN_NAME_XPATH) ||
      qs('#fine-grained-personal-access-token-name, input[name="token_name"], form input[type="text"]');
  if (!nameInput) {
    log("没找到 token 名字输入框（布局可能变了）");
    return;
  }

  log(`进入 token 创建页（${isClassic ? "classic" : "fine-grained"}）`);
  // 1) key 名字
  setReactValue(nameInput, "key");
  await sleep(500);

  if (isClassic) {
    // 2) Expiration -> No expiration（永久有效）
    const ok = await selectNoExpiration(nameInput.closest("form"));
    log(ok ? "已选择 Expiration: No expiration" : "Expiration 没选上（可能仍是默认 30 天）");
    await sleep(300);

    // 3) scopes：URL ?scopes= 已预勾选，这里只做兜底补齐
    await ensureClassicScopes();
  } else {
    // 2) 仓库范围：action-list 第 4 项（All repositories）
    const menuBtn = xpathFirst(TOKEN_MENU_XPATH);
    if (menuBtn) {
      menuBtn.click();
      log("已选仓库范围（All repositories）");
    } else {
      log("仓库范围按钮没找到，跳过");
    }
    await sleep(500);

    // 3) 权限勾选：li[2] ~ li[21]（全选）
    let checked = 0;
    for (let i = 2; i <= 21; i++) {
      const el = xpathFirst(TOKEN_CHECKBOX_XPATH.replace("{n}", String(i)));
      if (!el) continue;
      if (!el.checked) {
        el.click();
        checked++;
      }
    }
    log(`已勾选 ${checked} 个权限`);
  }

  // 4) 生成按钮
  const gen = xpathFirst(TOKEN_GENERATE_XPATH) ||
    [...document.querySelectorAll("button")]
      .find((b) => /generate token/i.test(b.textContent.trim()));
  if (!gen) {
    log("生成按钮没找到");
    return;
  }

  // 生成前打标记：页面跳转也不会再重复创建
  task.tokenGenerated = true;
  await setTask(task);
  gen.click();
  log("已点 Generate token");

  // 5) 等 token 出现（最多 30s）
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const token = readTokenFromPage();
    if (token) {
      task.tokenValue = token;
      await setTask(task);
      log("已拿到 token: " + token.slice(0, 24) + "...");
      await finish(task);
      return;
    }
  }
  log("生成后没读到 token，页面可能已跳转；由下一页尝试读取收尾");
}

// ===== 完成 =====

async function finish(task) {
  task.stage = "done";
  await setTask(task);
  await send({
    type: "done",
    account: {
      email: task.email,
      username: task.username,
      password: task.password,
      token: task.tokenValue || "",
    },
  });
  log("🎉 注册成功！账户已保存");
}

// ===== 入口 =====
// 按页面实际状态驱动（不再依赖易被页面跳转打断的 stage 字段）：
//   /login + "created successfully"   -> 完成，保存账户
//   验证码页 / account_verifications  -> 等框填码
//   有邮箱表单                         -> 填表提交
//   首页（有 Sign up 按钮）            -> 点按钮跳注册页
//   其它页面                           -> 不动作，等跳转

(async function main() {
  if (!location.hostname.includes("github.com")) return;

  // 防重复注入 / 重复加载扩展：同一页面只允许一个实例动作，
  // 避免日志翻倍、重复填表、重复提交
  if (window.__ghAutoRegBusy) return;
  window.__ghAutoRegBusy = true;

  const task = await getTask();
  if (!task || task.stage === "done") return;

  const url = location.href;
  // 注册表单：邮箱 + 密码框同时存在才算（首页有订阅邮箱框，不能误判）
  const hasEmail = !!qs(EMAIL_SEL) && !!qs(PW_SEL);
  const hasCodeInput = !!qs(CODE_INPUT_SEL);
  const isVerification = url.includes("account_verifications");
  const isLogin = url.includes("/login");
  const isTokenPage = url.includes("/settings/tokens/new");
  const hasSignup = hasSignupButton();

  log(`页面加载: ${location.pathname}（表单=${hasEmail} 验证码框=${hasCodeInput} 验证页=${isVerification} 首页=${hasSignup} token页=${isTokenPage}）`);

  // 0) GitHub 限流：按「换节点 → 同节点刷 10 次 → 等 1 分钟再刷 10 次 → 拉黑换下一个」循环处理
  const blocked = limitKind();
  if (blocked) {
    window.__ghAutoRegRateLimitHandled = true; // 这次页面加载算一次刷新，别让观察器重复计数
    await handleRateLimit(task, blocked);
    return;
  }
  // 没有限流提示 = 这次过来了，清掉重试状态（下次再遇到限流会从头开始一轮）
  if (task.rateLimit) {
    delete task.rateLimit;
    await setTask(task);
  }
  // 限流提示常常是首屏之后才渲染出来的（日志里就遇到过：先"无需处理"，2 秒后才出现提示），
  // 所以再盯 90 秒，出现就立刻换节点刷新
  watchRateLimit(task);
  watchStuck(task); // 兜底：页面卡住 5 分钟没动静就当限流处理

  // 1) 注册成功落地：登录页提示 created successfully -> 自动登录
  if (isLogin && bodyText().includes("created successfully")) {
    await autoLogin(task);
    return;
  }

  // 2) token 创建页
  if (isTokenPage && task.stage === "token") {
    if (task.tokenGenerated) {
      await finalizeToken(task); // 已生成过：只读收尾，不重复创建
    } else {
      await runToken(task);
    }
    return;
  }

  // 3) 已生成过 token：任何登录页上读 token 收尾（防跳转后重复创建）
  if (task.stage === "token" && task.tokenGenerated) {
    await finalizeToken(task);
    return;
  }

  // 4) 已登录且未生成 token：跳转 token 创建页
  if (task.stage === "token" && !task.tokenGenerated && isLoggedIn()) {
    location.href = TOKEN_PAGE;
    return;
  }

  // 2) 验证码页：等验证码框出现后自动填码
  if (
    isVerification || hasCodeInput ||
    bodyText().includes("launch code") || bodyText().includes("enter the code")
  ) {
    await runCode(task);
    return;
  }

  // 3) 注册表单页：填表提交
  //    邮箱已被注册过的任务不再重复提交（GitHub 只会再报一次同样的错），等后台换好新邮箱
  if (hasEmail && task.emailTaken) {
    log("该任务的邮箱已被注册过，等新邮箱开好后继续（本页会被关掉）");
    return;
  }
  if (hasEmail) {
    await runFill(task);
    // 提交后可能是 SPA 原地出验证码框（无整页导航）
    await sleep(3000);
    if (qs(CODE_INPUT_SEL) || bodyText().includes("launch code")) {
      await runCode(task);
    }
    return;
  }

  // 4) 首页：等有内容后点 Sign up
  if (hasSignup) {
    if (!(await waitFor(() => document.body && document.body.innerText.trim().length > 50, 30000))) {
      return;
    }
    if (!clickSignup()) {
      log("首页 Sign up 按钮没点到，直接跳注册页");
      location.href = "https://github.com/signup";
      return;
    }
    task.stage = "fill";
    await setTask(task);
    return;
  }

  // 5) 其它页面：不动作，等跳转（避免在无关页面乱点）
  log("当前页面无需处理，等待跳转...");
})();
