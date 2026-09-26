// 管理器导入逻辑的离线测试：stub 掉 chrome API 和 fetch，直接跑真实的 background.js。
// 运行：node test-manager-import.mjs
// 覆盖：
//   1) 分组名 = 日期 + 6 位随机字符，同日不重复
//   2) 备注 分组名-0 … 分组名-9，第 11 个自动开新组
//   3) 管理器不可用时进待重试队列，可用后补导入并写回账户
//   4) 永久性错误不重试不入队；JWT 过期（401）会自动重新登录
import fs from "node:fs";
import vm from "node:vm";

// ===== 测试加速 =====
// 被测代码里有"故意"的等待（导入重试 3s/6s、批量衔接 10s、开号重试 5s/10s 等），
// 真实跑一遍要 70 多秒。这里把 setTimeout 的延时统一压到 20ms：
// 只影响本测试进程，不改任何产品代码，也不改变执行顺序与逻辑。
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const SLEEP_CAP_MS = 20;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(Number(ms) || 0, SLEEP_CAP_MS), ...rest);
// setInterval 不动（content.js 的定时器不在这里跑），保持原样更安全
void realSetInterval;

// ---------- 从 workflow 传入的参数（不传就用默认值）----------
// 注意：这些参数只用于测试断言，测试里不会真的去注册任何账号。
const BATCH_COUNT = Math.min(999, Math.max(1, parseInt(process.env.BATCH_COUNT, 10) || 20));
const GROUP_SIZE = Math.min(100, Math.max(1, parseInt(process.env.MANAGER_GROUP_SIZE, 10) || 10));
console.log(`参数：连续注册数量=${BATCH_COUNT}，每组数量=${GROUP_SIZE}`);

// ---------- chrome stub ----------
const store = { local: {}, session: {} };
const listeners = [];
const startupListeners = []; // onStartup / onInstalled 注册的自检函数
const logs = [];
const calls = []; // 记录 chrome API 调用顺序，用来验证「先清理环境，再开新标签页」
const navUrls = []; // 记录 tabs.update 导航到的地址
const tabsDead = new Set(); // 被标记为「已被关掉」的 tabId（默认没有，见 tabs.get/update 的桩）
let lastTabCreate = null; // 最近一次 tabs.create 传的参数（用来验证 autoDiscardable）
const area = (name) => ({
  get: async (k) => {
    const o = store[name];
    if (k == null) return { ...o };
    const out = {};
    for (const key of [].concat(k)) if (key in o) out[key] = o[key];
    return out;
  },
  set: async (obj) => Object.assign(store[name], obj),
  remove: async (k) => { for (const key of [].concat(k)) delete store[name][key]; },
});
globalThis.chrome = {
  storage: { local: area("local"), session: area("session"), onChanged: { addListener() {} } },
  runtime: {
    sendMessage: async (msg) => { if (msg && msg.type === "log") logs.push(msg.text); },
    getURL: (p) => "chrome-extension://test/" + p,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onStartup: { addListener: (fn) => startupListeners.push(fn) },
    onInstalled: { addListener: (fn) => startupListeners.push(fn) },
  },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  offscreen: { createDocument: async () => {} },
  notifications: { create: async () => {} },
  alarms: {
    create: async () => {},
    clear: async () => {},
    onAlarm: { addListener: () => {} },
  },
  permissions: {
    // 默认认为已授权；测试里可以改成 false 模拟"扩展还没拿到 127.0.0.1 权限"
    contains: async () => api.permitted,
    request: async () => api.permitted,
  },
  tabs: {
    // liveTabs：哪些 tabId 还算"存在"。不在里面的 id，tabs.get 会像真实 Chrome 那样抛
    // "No tab with id: xxx" —— 用来复现「标签页被关掉后换节点重开失败」那个 bug。
    create: async (props) => { calls.push("tabs.create"); lastTabCreate = props || {}; return { id: 1 }; },
    get: async (id) => {
      calls.push("tabs.get");
      if (tabsDead.has(id)) throw new Error("No tab with id: " + id + ".");
      return { id };
    },
    remove: async () => { calls.push("tabs.remove"); },
    query: async () => { calls.push("tabs.query"); return [{ id: 10 }, { id: 11 }]; },
    update: async (id, props) => {
      calls.push("tabs.update");
      if (tabsDead.has(id)) throw new Error("No tab with id: " + id + ".");
      navUrls.push((props && props.url) || "");
      if (props && props.autoDiscardable === false) calls.push("tabs.autoDiscardable=false");
    },
    reload: async () => { calls.push("tabs.reload"); },
  },
  browsingData: { remove: async () => { calls.push("browsingData.remove"); } },
};

// ---------- 假的管理器 / 邮局 API ----------
const api = {
  accounts: [],            // { id, github_login, token, group, note }
  groups: ["L", "TEST"],   // 管理器里已有的分组
  nextId: 100,
  down: false,             // true = 服务器不可用
  invalidTokens: new Set(),
  loginCount: 0,
  jwt: "jwt-1",
  expiredJwt: "jwt-expired",
  validKey: "gam_test_key",
  adminPassword: "test-admin-pw", // 只是测试用的假密码
  keysCreated: [],         // 通过 POST /apikeys 建出来的 key
  mailCalls: [],           // 邮局收到的请求 { path, body }
  mailHost: "",
  mailFailTimes: 0, // 让前 N 次建邮箱失败，用来测重试
  mailListFailTimes: 0, // 让收件箱列表接口失败 N 次（测邮局连不上时的换节点）
  // ---- 假的 Clash 控制器 ----
  clashSwitches: [],       // 每次 PUT /proxies/{group} 记录 { group, name }
  clashDelays: {},         // 节点 -> 延迟；null/未设置 = 测不通
  clashNodes: ["HK-01", "JP-02", "SG-03", "US-04"],
  clashNow: "HK-01",
  clashGroup: "🚀 节点选择",
  clashRequests: 0,
  clashDeadPorts: new Set(),        // 模拟没开的端口
  clashSecretPorts: new Set(),      // 模拟像 Clash Verge 那样需要密钥的端口
  clashSecretValue: "verge-secret",
  permitted: true,                  // 扩展有没有被授权访问本地地址
};
globalThis.fetch = async (url, opts = {}) => {
  const full = String(url);
  const path = full.replace(/^https?:\/\/[^/]+/, "");
  const host = full.replace(/^(https?:\/\/[^/]+).*/, "$1");
  const body = opts.body ? JSON.parse(opts.body) : null;
  const headers = opts.headers || {};
  const auth = headers.Authorization || "";
  const apiKey = headers["X-API-Key"] || "";
  const json = (status, obj) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  const bad = (message) => json(400, { code: 400, error: "bad_request", message });

  // ---- 假的 Clash 控制器（external-controller）----
  // 端口行为可配置：clashDeadPorts 模拟没开，clashSecretPorts 模拟需要密钥（像 Clash Verge）
  if (/^https?:\/\/127\.0\.0\.1:(\d+)\/(proxies|version)/.test(full)) {
    const port = full.match(/^https?:\/\/127\.0\.0\.1:(\d+)\//)[1];
    // 没授权时浏览器会直接拦掉请求，表现就是 fetch 抛「Failed to fetch」
    if (!api.permitted) throw new TypeError("Failed to fetch");
    if (api.clashDeadPorts.has(port)) throw new TypeError("fetch failed"); // 端口没开
    if (
      api.clashSecretPorts.has(port) &&
      (opts.headers && opts.headers.Authorization) !== `Bearer ${api.clashSecretValue}`
    ) {
      return json(401, { message: "Unauthorized" });
    }
    api.clashRequests++;
    if (path === "/version") return json(200, { version: "1.18.2", meta: true });
    if (path === "/proxies") {
      return json(200, {
        proxies: {
          [api.clashGroup]: { type: "Selector", now: api.clashNow, all: [...api.clashNodes] },
          DIRECT: { type: "Direct", now: "", all: [] },
        },
      });
    }
    const delayMatch = path.match(/^\/proxies\/([^/]+)\/delay/);
    if (delayMatch) {
      const node = decodeURIComponent(delayMatch[1]);
      const d = api.clashDelays[node];
      if (d == null) return json(200, { message: "An error occurred in the delay test" });
      return json(200, { delay: d });
    }
    const groupMatch = path.match(/^\/proxies\/([^/]+)$/);
    if (groupMatch) {
      if (opts.method === "PUT") {
        api.clashNow = body.name;
        api.clashSwitches.push({ group: decodeURIComponent(groupMatch[1]), name: body.name });
        return json(200, {});
      }
      return json(200, { type: "Selector", now: api.clashNow, all: [...api.clashNodes] });
    }
    return json(404, { message: "not found" });
  }

  // ---- 邮局（临时邮箱）----
  if (path.startsWith("/api/v1/")) {
    api.mailCalls.push({ path, body, host });
    api.mailHost = host;
    if (path === "/api/v1/addresses") {
      if (api.mailFailTimes > 0) { api.mailFailTimes--; throw new TypeError("fetch failed"); }
      const email = `${body.username}@${body.domain}`;
      return json(200, { email, token: "mail-token-1" });
    }
    if (path === "/api/v1/mail-token-1/emails") {
      if (api.mailListFailTimes > 0) { api.mailListFailTimes--; throw new TypeError("fetch failed"); }
      return json(200, { emails: [{ id: 7, subject: "Your GitHub launch code", from_address: "noreply@github.com" }] });
    }
    if (path === "/api/v1/mail-token-1/emails/7") {
      return json(200, {
        body: "https://github.com/account_verifications/confirm/11111111-2222-3333-4444-555555555555/87654321",
      });
    }
    return json(404, { error: "not found" });
  }

  // ---- 管理器：登录 ----
  if (path === "/api/auth/login") {
    api.loginCount++;
    if (!body || body.masterPassword !== api.adminPassword) return json(401, { message: "管理密码错误" });
    api.jwt = "jwt-" + api.loginCount;
    return json(200, { ok: true, data: { token: api.jwt } });
  }
  if (api.down) return json(500, { message: "服务器炸了" });
  // 鉴权：X-API-Key 优先，其次 Bearer JWT
  if (apiKey) {
    if (apiKey !== api.validKey) {
      return json(401, { code: 401, error: "invalid_api_key", message: "API Key 无效或已过期" });
    }
  } else if (auth !== `Bearer ${api.jwt}`) {
    return json(401, { code: 401, error: "unauthorized", message: "登录已过期" });
  }

  if (path === "/api/accounts/groups") {
    return json(200, { ok: true, data: [...api.groups] });
  }
  if (path === "/api/apikeys") {
    if (auth !== `Bearer ${api.jwt}`) return json(401, { message: "登录已过期" });
    api.keysCreated.push(body.name);
    return json(200, { ok: true, data: { id: 9, key: api.validKey, key_prefix: "gam_test", name: body.name } });
  }
  if (path === "/api/accounts/import") {
    if (!body.token) return bad("token 不能为空");
    if (!/^key_valid_\d+$/.test(body.token) || api.invalidTokens.has(body.token)) {
      return bad("token 无效：无法获取用户信息");
    }
    if (api.accounts.some((a) => a.token === body.token)) return bad("该账户已存在");
    api.nextId++;
    const acc = {
      id: api.nextId, github_login: "user" + api.nextId, token: body.token,
      password: body.password, recovery_email: body.recovery_email,
      note: body.note, group: body.group,
    };
    api.accounts.push(acc);
    if (acc.group && !api.groups.includes(acc.group)) api.groups.push(acc.group);
    return json(200, { ok: true, data: acc });
  }
  // ---- 假的 Clash 控制器（external-controller）----
  if (/^https?:\/\/127\.0\.0\.1:\d+\/proxies/.test(full)) {
    api.clashRequests++;
    if (path === "/proxies") {
      return json(200, {
        proxies: {
          [api.clashGroup]: { type: "Selector", now: api.clashNow, all: [...api.clashNodes] },
          DIRECT: { type: "Direct", now: "", all: [] },
        },
      });
    }
    const delayMatch = path.match(/^\/proxies\/([^/]+)\/delay/);
    if (delayMatch) {
      const node = decodeURIComponent(delayMatch[1]);
      const d = api.clashDelays[node];
      if (d == null) return json(200, { message: "An error occurred in the delay test" });
      return json(200, { delay: d });
    }
    const groupMatch = path.match(/^\/proxies\/([^/]+)$/);
    if (groupMatch) {
      if (opts.method === "PUT") {
        api.clashNow = body.name;
        api.clashSwitches.push({ group: decodeURIComponent(groupMatch[1]), name: body.name });
        return json(200, {});
      }
      return json(200, { type: "Selector", now: api.clashNow, all: [...api.clashNodes] });
    }
    return json(404, { message: "not found" });
  }

  return json(404, { error: "not found" });
};

// ---------- 加载真实 background.js ----------
// Service Worker 里的 importScripts 在 Node 里没有，用同样的方式把 clash.js 加载进同一作用域
globalThis.importScripts = (...files) => {
  for (const f of files) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
};
vm.runInThisContext(fs.readFileSync("background.js", "utf8"), { filename: "background.js" });
const onMessage = listeners[0];
const send = (msg) => new Promise((res) => { onMessage(msg, {}, res); });

const acct = (n) => ({
  email: `gh_test${n}@example.com`, username: `user${n}`, password: `Pw${n}!`,
  token: `key_valid_${n}`, tabId: n,
});
const status = async () => (await send({ type: "gam_get_status" })).status;
const localAccounts = async () => (await send({ type: "get_accounts" })).accounts;

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  if (!cond) failures++;
}

// 用例 0：没填管理器地址时不动作、不报错、不占编号
await send({ type: "gam_set_config", config: { baseUrl: "", masterPassword: "", apiKey: "" } });
const noCfg = await send({ type: "done", account: acct(99) });
const noCfgStatus = await status();
check("未配置地址时不导入、不排队", noCfgStatus.pending === 0 && !noCfgStatus.group, JSON.stringify(noCfgStatus.group));
check("未配置地址时账户照样保存", (await localAccounts()).some((a) => a.email === "gh_test99@example.com"));
await send({ type: "clear_accounts" });

// 运行前填好管理器配置（对应面板里填一次并保存）
await send({ type: "gam_set_config", config: { baseUrl: "http://manager.test", masterPassword: api.adminPassword } });

// 用例 1：前 10 个账户 → 同一组，备注 -0 … -9
for (let i = 1; i <= 10; i++) await send({ type: "done", account: acct(i) });
let st = await status();
const g1 = st.group;
const today = new Date();
const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
check("分组名 = 日期(8位) + 随机字符(6位)", /^\d{8}[a-z2-9]{6}$/.test(g1), g1);
check("分组名含当天日期", g1.startsWith(stamp), `${g1} vs ${stamp}`);
check("分组名避开管理器已有分组", !["L", "TEST"].includes(g1), g1);
const inG1 = api.accounts.filter((a) => a.group === g1);
check("10 个账户全在同一分组", inG1.length === 10, `${inG1.length} 个`);
check("备注依次是 分组名-0 … 分组名-9",
  inG1.map((a) => a.note).join(" ") === Array.from({ length: 10 }, (_, i) => `${g1}-${i}`).join(" "),
  inG1.map((a) => a.note.split("-").pop()).join(","));
check("组满后状态提示开新组", st.nextNote.includes("新建分组"), st.nextNote);
check("本地账户都记下了分组+备注", (await localAccounts()).every((a) => a.gamNote), "");

// 用例 2：第 11 个 → 新分组，备注 -0
await send({ type: "done", account: acct(11) });
st = await status();
check("第 11 个账户自动开新分组", st.group !== g1 && st.group !== "L" && st.index === 1, `新组 ${st.group}`);
check("新分组第一个备注是 -0", api.accounts.at(-1).note === `${st.group}-0`, api.accounts.at(-1).note);
check("新分组名当日不与上一组重复", st.group !== g1, `${g1} → ${st.group}`);

// 用例 3：管理器暂时不可用（5xx）→ 重试 3 次后进待重试队列；账户照样保存，编号不被占用
api.down = true;
const nextNoteBefore = (await status()).nextNote;
await send({ type: "done", account: acct(12) });
const st3 = await status();
check("失败账户仍然保存到本地", (await localAccounts()).some((a) => a.email === "gh_test12@example.com"));
check("失败账户进入待重试队列", st3.pending === 1, `pending=${st3.pending}`);
check("失败不占用备注编号", st3.nextNote === nextNoteBefore, `${nextNoteBefore} → ${st3.nextNote}`);
check("服务器故障会重试 3 次", logs.filter((l) => l.includes("导入管理器失败")).length === 3,
  `${logs.filter((l) => l.includes("导入管理器失败")).length} 次`);

// 用例 4：管理器恢复 → 补导入成功，并把分组/备注写回本地账户
api.down = false;
const retry = await send({ type: "gam_retry_pending" });
const acc12 = (await localAccounts()).find((a) => a.email === "gh_test12@example.com");
check("补导入成功 1 个且队列清空", retry.ok && retry.done === 1 && retry.left === 0, `done=${retry.done} left=${retry.left}`);
check("补导入账户拿到正确备注", acc12.gamNote === nextNoteBefore, `${acc12.gamNote}`);
check("补导入账户的分组写回本地", acc12.gamGroup === st.group, acc12.gamGroup);

// 用例 5：永久性错误（token 无效 / 重复账户）→ 不重试、不入队
const retryLogsBefore = logs.filter((l) => l.includes("导入管理器失败")).length;
api.invalidTokens.add("key_valid_13");
await send({ type: "done", account: acct(13) });
check("token 无效的账户不重试", logs.filter((l) => l.includes("导入管理器失败")).length === retryLogsBefore);
check("token 无效的账户不进队列", (await status()).pending === 0);
api.invalidTokens.delete("key_valid_13");
await send({ type: "done", account: { ...acct(14), token: "key_valid_1" } });
check("重复账户不重复入库", api.accounts.filter((a) => a.token === "key_valid_1").length === 1);
check("重复账户不进待重试队列", (await status()).pending === 0, `pending=${(await status()).pending}`);

// 用例 6：没有 token 的账户 → 跳过导入
const n = api.accounts.length;
const noteBefore6 = (await status()).nextNote;
await send({ type: "done", account: { ...acct(15), token: "" } });
check("没有 token 的账户不导入管理器", api.accounts.length === n);
check("没有 token 的账户不占编号", (await status()).nextNote === noteBefore6, `${noteBefore6} → ${(await status()).nextNote}`);

// 用例 7：JWT 过期 → 自动重新登录后继续导入
const loginBefore = api.loginCount;
api.jwt = api.expiredJwt; // 模拟服务端已换发新 JWT
await send({ type: "done", account: { ...acct(16), token: "key_valid_16" } });
check("401 后自动重登并成功导入", api.loginCount > loginBefore && api.accounts.some((a) => a.token === "key_valid_16"),
  `登录次数 ${loginBefore} → ${api.loginCount}`);

// 用例 8：关掉自动导入 → 不再导入
await send({ type: "gam_set_config", config: { enabled: false } });
const n2 = api.accounts.length;
await send({ type: "done", account: { ...acct(17), token: "key_valid_17" } });
check("关闭后不再导入", api.accounts.length === n2);
await send({ type: "gam_set_config", config: { enabled: true } });

// 用例 9：邮局地址与邮箱域名可在运行前改
const mailCfg = await send({ type: "mail_set_config", config: { apiUrl: "https://mail.example.com/", domain: "example.com" } });
check("邮局配置已保存", mailCfg.ok && mailCfg.status.domain === "example.com", JSON.stringify(mailCfg.status));
const mailTest = await send({ type: "mail_test" });
check("改完邮局地址后真的去新地址建邮箱", mailTest.ok && api.mailHost === "https://mail.example.com",
  `${api.mailHost} → ${mailTest.email}`);
check("建邮箱用的是配置的域名", String(mailTest.email).endsWith("@example.com"), mailTest.email);
const addrCall = api.mailCalls.find((c) => c.path === "/api/v1/addresses");
check("末尾斜杠不会拼出双斜杠", addrCall && addrCall.host === "https://mail.example.com", addrCall && addrCall.host);
const codeResp = await send({ type: "request_code", token: "mail-token-1", timeoutMs: 8000 });
check("收验证码也走配置的邮局地址", codeResp.code === "87654321", String(codeResp.code));

// 用例 9b：没配置邮局时不乱发请求，而是给出明确提示
await send({ type: "mail_set_config", config: { apiUrl: "", domain: "" } });
const noMail = await send({ type: "mail_test" });
check("未配置邮局时报错而不是瞎请求", !noMail.ok && /未配置邮局/.test(noMail.error || ""), String(noMail.error));
await send({ type: "mail_set_config", config: { apiUrl: "https://mail.example.com", domain: "example.com" } });

// 用例 10：填了 API Key 就用 Key 鉴权，不再登录
const loginBefore10 = api.loginCount;
await send({ type: "gam_set_config", config: { apiKey: "gam_test_key", masterPassword: "" } });
const test10 = await send({ type: "gam_test" });
check("API Key 模式连接正常", test10.ok === true, JSON.stringify(test10));
check("API Key 模式不再走登录", api.loginCount === loginBefore10, `loginCount=${api.loginCount}`);
const st10 = (await send({ type: "gam_get_status" })).status;
check("状态接口回显 API Key 与鉴权方式", st10.apiKey === "gam_test_key" && st10.authMode === "API Key", st10.authMode);
const importWithKey = await send({ type: "done", account: { ...acct(20), token: "key_valid_20" } });
const imported20 = api.accounts.find((a) => a.token === "key_valid_20");
check("API Key 模式下能正常导入", !!imported20 && api.loginCount === loginBefore10, imported20 ? imported20.note : "未导入");

// 用例 11：API Key 失效 → 明确报错，不再退回密码登录
await send({ type: "gam_set_config", config: { apiKey: "gam_wrong_key" } });
const test11 = await send({ type: "gam_test" });
check("无效 API Key 会报错而不是静默回退", !test11.ok && /API Key/.test(test11.error || ""), String(test11.error));

// 用例 12：一键生成 API Key（用管理密码换）
await send({ type: "gam_set_config", config: { apiKey: "", masterPassword: api.adminPassword } });
const gen = await send({ type: "gam_create_apikey", name: "github-auto-reg" });
const st12 = (await send({ type: "gam_get_status" })).status;
check("生成 API Key 成功", gen.ok && gen.key === "gam_test_key", String(gen.key));
check("生成的 Key 已自动保存进配置", st12.apiKey === "gam_test_key" && st12.authMode === "API Key", st12.apiKey);
check("生成 Key 用的是管理密码登录", api.keysCreated.includes("github-auto-reg"), JSON.stringify(api.keysCreated));

// 用例 13：连续数量不再卡在 10；开始前先清理环境
await send({ type: "mail_set_config", config: { apiUrl: "https://mail.example.com", domain: "example.com" } });
calls.length = 0;
const started = await send({ type: "start", count: BATCH_COUNT });
const q = (await send({ type: "get_queue" })).queue;
check(`连续 ${BATCH_COUNT} 个能生效（上限已放开）`, started.ok && started.count === BATCH_COUNT && q && q.total === BATCH_COUNT,
  `count=${started.count} queue.total=${q && q.total}`);
check("开始前清了 GitHub 登录态", calls.includes("browsingData.remove"), calls.join(" → "));
check("清理发生在开新标签页之前",
  calls.indexOf("browsingData.remove") !== -1 && calls.indexOf("browsingData.remove") < calls.indexOf("tabs.create"),
  calls.join(" → "));
check("清理时关掉了多余标签页", calls.includes("tabs.remove"), calls.join(" → "));
check("开跑前不额外做一次无用的跳转", !calls.includes("tabs.update"), calls.join(" → "));
check("超大数量会被夹到上限（防手滑）", (await send({ type: "start", count: 999999 })).count === 999, "");

// 用例 14：关掉「本地也存一份」→ 进了管理器的号不再留本地副本
const importedBefore = (await send({ type: "gam_get_status" })).status.imported;
await send({ type: "gam_set_config", config: { saveLocal: false } });
await send({ type: "done", account: { ...acct(31), token: "key_valid_31" } });
let local31 = (await localAccounts()).find((a) => a.email === "gh_test31@example.com");
let st14 = (await send({ type: "gam_get_status" })).status;
check("导入成功的号不在本地留副本", !local31, local31 ? "竟然存了" : "未存（符合设置）");
check("管理器里确实有这个号", api.accounts.some((a) => a.token === "key_valid_31"));
check("进度计数照旧往前走", st14.imported === importedBefore + 1, `${importedBefore} → ${st14.imported}`);
check("状态里标明本地不留副本", st14.saveLocal === false && st14.localCount !== undefined, `localCount=${st14.localCount}`);

// 用例 15：同一个设置下，没进管理器的号必须本地留一份（防丢号）
await send({ type: "done", account: { ...acct(32), token: "" } }); // 没有 token → 进不了管理器
let local32 = (await localAccounts()).find((a) => a.email === "gh_test32@example.com");
check("没 token 的号仍然本地保留", !!local32, local32 ? local32.username : "丢了");
const pendingBefore15 = (await send({ type: "gam_get_status" })).status.pending;
api.down = true;
await send({ type: "done", account: { ...acct(33), token: "key_valid_33" } }); // 管理器挂了 → 进待重试
api.down = false;
let local33 = (await localAccounts()).find((a) => a.email === "gh_test33@example.com");
check("导入失败的号仍然本地保留", !!local33, local33 ? local33.username : "丢了");
check("导入失败的号同时进待重试队列", (await send({ type: "gam_get_status" })).status.pending === pendingBefore15 + 1, "");
await send({ type: "gam_retry_pending" }); // 管理器恢复后补导入
local33 = (await localAccounts()).find((a) => a.email === "gh_test33@example.com");
check("补导入成功后本地这条记录补上了分组备注", !!local33.gamNote, String(local33.gamNote));

// 用例 16：打开「本地也存一份」→ 恢复原来的行为
await send({ type: "gam_set_config", config: { saveLocal: true } });
await send({ type: "done", account: { ...acct(34), token: "key_valid_34" } });
check("打开后本地照旧留一份", !!(await localAccounts()).find((a) => a.email === "gh_test34@example.com"));

// 用例 17：邮箱被注册过时换邮箱重开（不占批次名额，重试次数要带过去）
await send({ type: "mail_set_config", config: { apiUrl: "https://mail.example.com", domain: "example.com" } });
const queueBefore17 = (await send({ type: "get_queue" })).queue;
const mailsBefore17 = api.mailCalls.filter((c) => c.path === "/api/v1/addresses").length;
const reroll = await send({ type: "new_account", attempts: 2 });
const taskAfter17 = (await send({ type: "get_task" })).task;
const queueAfter17 = (await send({ type: "get_queue" })).queue;
check("换邮箱重开成功并给出新邮箱", reroll.ok && /@example\.com$/.test(reroll.email || ""), String(reroll.email));
check("确实新建了一个邮箱", api.mailCalls.filter((c) => c.path === "/api/v1/addresses").length === mailsBefore17 + 1, "");
check("新任务带上了重试次数（不会被清零）", !!taskAfter17 && taskAfter17.recoverAttempts === 2, JSON.stringify(taskAfter17 && taskAfter17.recoverAttempts));
check("换邮箱不消耗批次名额", JSON.stringify(queueAfter17) === JSON.stringify(queueBefore17),
  `${JSON.stringify(queueBefore17)} → ${JSON.stringify(queueAfter17)}`);
check("新任务是全新起点（stage=start，有邮箱密码）",
  taskAfter17.stage === "start" && !!taskAfter17.email && !!taskAfter17.password, JSON.stringify({ stage: taskAfter17.stage, email: taskAfter17.email }));

// 用例 18：Clash 换节点（GitHub 限流时触发）
await send({ type: "clash_set_config", config: { enabled: false } });
const offSwitch = await send({ type: "clash_switch", reason: "未启用时" });
check("未启用时不碰 Clash", !offSwitch.ok && api.clashRequests === 0, `请求数 ${api.clashRequests}`);

await send({ type: "clash_set_config", config: { enabled: true, baseUrl: "http://127.0.0.1:9090", secret: "s", group: "" } });
api.clashNow = "HK-01";
api.clashDelays = { "JP-02": 320, "SG-03": 800, "US-04": null };
api.clashSwitches.length = 0;
const sw = await send({ type: "clash_switch", reason: "GitHub 限流" });
check("换节点成功并挑最快的候选", sw.ok && sw.to === "JP-02" && api.clashNow === "JP-02", `${sw.from} → ${sw.to}（延迟 ${sw.delay}）`);
check("换节点写进了 Clash（PUT 分组）", api.clashSwitches.some((s) => s.name === "JP-02" && s.group === api.clashGroup), JSON.stringify(api.clashSwitches));
check("旧节点被拉黑（默认 25 分钟）", (await send({ type: "clash_get_status" })).status.blacklistCount === 1,

  `黑名单 ${(await send({ type: "clash_get_status" })).status.blacklistCount} 个`);

// 拉黑时长要真的是 25 分钟（读黑名单里的解禁时间）
const blMins = Object.values(store.local.clashBlacklist || {}).map((t) => Math.round((t - Date.now()) / 60000));
check("拉黑时长按配置来（默认 25 分钟）", blMins.some((m) => m >= 24 && m <= 25), blMins.join(",") + " 分钟");

api.clashDelays = { "SG-03": 500, "US-04": 700, "HK-01": 100 };
const sw2 = await send({ type: "clash_switch", reason: "再换一次" });
check("拉黑中的节点不会再被选中（哪怕它最快）", sw2.ok && sw2.to === "SG-03", `换到 ${sw2.to}`);

await send({ type: "clash_set_config", config: { clearBlacklist: true } });
check("清空黑名单生效", (await send({ type: "clash_get_status" })).status.blacklistCount === 0, "");

// 用例 19：健康检查（太慢就换、够快就不动）
api.clashNow = "HK-01";
api.clashDelays = { "HK-01": 300 };
const test19 = await send({ type: "clash_test" });
check("测试连接返回当前节点与延迟", test19.ok && test19.node === "HK-01" && test19.delay === 300,
  `节点 ${test19.node} 延迟 ${test19.delay} 共 ${test19.total} 个`);
const hcFast = await send({ type: "clash_health" });
check("节点够快就不换", hcFast.ok && !hcFast.switched && hcFast.delay === 300, `延迟 ${hcFast.delay}`);

api.clashDelays = { "HK-01": 9000, "JP-02": 400 };
const hcSlow = await send({ type: "clash_health" });
check("超过阈值（5000ms）自动换掉", hcSlow.ok && hcSlow.switched && hcSlow.to === "JP-02", `换到 ${hcSlow.to}`);
check("太慢的节点被拉黑", (await send({ type: "clash_get_status" })).status.blacklistCount >= 1, "");

// 用例 20：候选都拉黑之后要明确失败，而不是静默乱换
api.clashDelays = { "JP-02": 200, "SG-03": 210, "US-04": 220, "HK-01": 230 };
let last = null;
for (let i = 0; i < 6; i++) {
  last = await send({ type: "clash_switch", reason: "把候选用完" });
  if (!last.ok) break;
}
check("可换节点用完后明确失败", !!last && !last.ok && /没有可换的节点/.test(last.error || ""), String(last && last.error));
await send({ type: "clash_set_config", config: { enabled: false, clearBlacklist: true } });

// 用例 21：Clash Verge 场景——只有 9097 在监听（且要密钥），9090 等常见端口都没开
api.clashDeadPorts = new Set(["9090", "9091", "9098", "9099", "63443"]);
api.clashSecretPorts = new Set(["9097"]);
await send({ type: "clash_set_config", config: { enabled: true, baseUrl: "http://127.0.0.1:9090", secret: "", group: "" } });
const probe1 = await send({ type: "clash_test" });
check("地址不通时会自动探测并指出正确端口", !probe1.ok && !!probe1.probe && probe1.probe.found === "http://127.0.0.1:9097",
  `探测到 ${probe1.probe && probe1.probe.found}`);
check("没填密钥时明确提示「需要密钥」（而不是含糊的连不上）",
  !!probe1.probe && probe1.probe.needSecret === true && probe1.probe.wrongSecret === false,
  JSON.stringify({ needSecret: probe1.probe && probe1.probe.needSecret }));

// 用例 22：填对地址 + Verge 的密钥 → 正常读到节点
await send({ type: "clash_set_config", config: { baseUrl: "http://127.0.0.1:9097", secret: "verge-secret" } });
api.clashNow = "HK-01";
api.clashDelays = { "HK-01": 420 };
const verge = await send({ type: "clash_test" });
check("Clash Verge（9097 + 密钥）能正常连上", verge.ok && verge.node === "HK-01" && verge.delay === 420,
  `节点 ${verge.node} 延迟 ${verge.delay}`);

// 用例 23：地址对但密钥写错 → 提示密钥不对，而不是让人去查端口
await send({ type: "clash_set_config", config: { secret: "wrong-secret" } });
const probe2 = await send({ type: "clash_test" });
check("密钥写错时提示密钥不对", !probe2.ok && !!probe2.probe && probe2.probe.wrongSecret === true
  && probe2.probe.needSecret === false, JSON.stringify({ wrongSecret: probe2.probe && probe2.probe.wrongSecret }));

await send({ type: "clash_set_config", config: { enabled: false, baseUrl: "http://127.0.0.1:9090", secret: "", clearBlacklist: true } });

// 用例 24：从 Clash Verge 的配置文件里解析地址和密钥
const vergeYaml = [
  "# Generated by Clash Verge",
  "mixed-port: 7890",
  "socks-port: 7898",
  "external-controller: 127.0.0.1:9097",
  "secret: fake-verge-secret",
  "external-controller-cors:",
  "  allow-private-network: true",
  "external-controller-pipe: \\\\.\\pipe\\verge-mihomo",
].join("\n");
const imported = await send({ type: "clash_import_config", text: vergeYaml });
check("从 Verge 配置里读到控制器地址", imported.ok && imported.baseUrl === "http://127.0.0.1:9097", imported.baseUrl);
check("同时读到了密钥", imported.secret === "fake-verge-secret", imported.secret);
check("不会把 external-controller-pipe 误读成地址", !/pipe/.test(imported.baseUrl), imported.baseUrl);

const noSecret = await send({ type: "clash_import_config", text: "external-controller: 0.0.0.0:9090\nmode: rule\n" });
check("没写 secret 的配置也能读（密钥留空）", noSecret.ok && noSecret.baseUrl === "http://0.0.0.0:9090" && noSecret.secret === "",
  `${noSecret.baseUrl} / 密钥「${noSecret.secret}」`);
const emptyCfg = await send({ type: "clash_import_config", text: "mode: rule\n" });
check("不是 Clash 配置时明确报错", !emptyCfg.ok && /external-controller/.test(emptyCfg.error || ""), String(emptyCfg.error));

// 内核实际加载的配置里 external-controller 是空值（Verge 关了「外部控制」开关）→ 要指出开关没开
const offCfg = await send({
  type: "clash_import_config",
  text: ["mixed-port: 7890", "external-controller: ''", "secret: x", "external-controller-pipe: \\\\.\\pipe\\verge-mihomo"].join("\n"),
});
check("开关关闭（external-controller 为空）时点明「外部控制没打开」",
  !offCfg.ok && offCfg.controllerOff === true && /外部控制/.test(offCfg.error || ""), String(offCfg.error));

// 用例 25：还没拿到本地地址权限时，要指出「没授权」而不是含糊的"连不上"
api.permitted = false;
api.clashDeadPorts = new Set();
api.clashSecretPorts = new Set();
await send({ type: "clash_set_config", config: { enabled: true, baseUrl: "http://127.0.0.1:9097", secret: "", group: "" } });
const notPermitted = await send({ type: "clash_test" });
check("没授权时明确回报 permitted=false", !notPermitted.ok && notPermitted.permitted === false,
  `permitted=${notPermitted.permitted}`);
check("没授权时不去瞎探测（省时间）", notPermitted.probe === null, JSON.stringify(notPermitted.probe));
api.permitted = true;
await send({ type: "clash_set_config", config: { enabled: false, clearBlacklist: true } });


// 用例 26：没授权时状态里要如实标出来（否则用户只看到一句 Failed to fetch）
api.permitted = false;
await send({ type: "gam_set_config", config: { enabled: true, baseUrl: "http://manager.test", masterPassword: api.adminPassword } });
const st26 = (await send({ type: "gam_get_status" })).status;
check("管理器状态上报 permitted=false", st26.permitted === false, "permitted=" + st26.permitted);
const mail26 = await send({ type: "mail_set_config", config: { apiUrl: "https://mail.example.com", domain: "example.com" } });
check("邮局状态上报 permitted=false", mail26.status.permitted === false, "permitted=" + mail26.status.permitted);

// 用例 27：启动自检——有未授权的自定义地址时要明确告警
logs.length = 0;
await startupListeners[0]();
const warn = logs.find((l) => /还没授权/.test(l)) || "";
check("启动自检指出未授权的地址", /管理器|邮局/.test(warn), warn.slice(0, 70));
api.permitted = true;
logs.length = 0;
await startupListeners[0]();
check("都授权后不再告警", !logs.some((l) => /还没授权/.test(l)), "");




// 用例 29：邮局抖动时自动重试开号（原来会直接中断整批）
await send({ type: "mail_set_config", config: { apiUrl: "https://mail.example.com", domain: "example.com" } });
api.mailFailTimes = 1; // 第一次建邮箱失败，之后成功
logs.length = 0;
const started29 = await send({ type: "start", count: 2 });
check("邮局首次失败会自动重试并成功开号", started29.ok && !!started29.email, JSON.stringify(started29).slice(0, 80));
check("日志里有重试提示（且说明不会中断）", logs.some((l) => /开新号失败（第 1 次）/.test(l) && /不会中断/.test(l)), logs.filter((l) => /开新号/.test(l)).join(" | ").slice(0, 90));
api.mailFailTimes = 0;

// 用例 30：换节点后是导航到干净的 GET 地址，不用 chrome.tabs.reload（会弹"确认重新提交表单"）
calls.length = 0;
const { task: t0 } = await send({ type: "get_task" });
await send({ type: "set_task", task: { ...t0, stage: "fill", tabId: 42 } });
api.clashNow = "HK-01";
api.clashNodes = ["HK-01", "JP-02"];
api.clashDelays = { "JP-02": 100 };
await send({ type: "clash_set_config", config: { enabled: true, baseUrl: "http://127.0.0.1:9090", secret: "s", clearBlacklist: true } });
const sw30 = await send({ type: "clash_switch", reason: "GitHub 限流", reload: true });
check("换节点后确实重新打开了页面", sw30.ok && sw30.reloaded === true, JSON.stringify({ reloaded: sw30.reloaded }));
check("用的是 tabs.update 导航（不是 reload）", calls.includes("tabs.update") && !calls.includes("tabs.reload"), calls.join(" → "));
const { task: t1 } = await send({ type: "get_task" });
check("fill 阶段回到注册页", navUrls.includes("https://github.com/signup"), JSON.stringify(navUrls));

await send({ type: "clash_set_config", config: { clearBlacklist: true } }); // 放开黑名单，否则没节点可换
await send({ type: "set_task", task: { ...t1, stage: "token", tabId: 42 } });
calls.length = 0;
navUrls.length = 0;
const sw30b = await send({ type: "clash_switch", reason: "手动", reload: true });
const { task: t2 } = await send({ type: "get_task" });
check("token 阶段回首页（首页自己会跳 token 页）", sw30b.ok && sw30b.reloaded === true && navUrls.includes("https://github.com/"),
  "stage=" + t2.stage + " 导航到 " + JSON.stringify(navUrls));
await send({ type: "clash_set_config", config: { enabled: false, clearBlacklist: true } });



// 用例 28：限流第一步＝拉黑当前节点并换下一个；之后在同节点上刷 10 次
api.clashNodes = ["HK-01", "JP-02", "SG-03", "US-04"];
api.clashNow = "HK-01";
api.clashDelays = { "JP-02": 500, "SG-03": 100, "US-04": 50 };
await send({ type: "clash_set_config", config: { enabled: true, baseUrl: "http://127.0.0.1:9090", secret: "s", clearBlacklist: true } });

const rl1 = await send({ type: "clash_switch", reason: "GitHub 限流：拉黑当前节点并切换", rotate: true, blacklist: true });
check("限流第一步：拉黑当前节点并换下一个", rl1.ok && rl1.blacklisted === true && rl1.to === "JP-02",
  "换到 " + rl1.to + "，黑名单 " + (await send({ type: "clash_get_status" })).status.blacklistCount + " 个");
check("按顺序换（不是挑最快的）", rl1.to === "JP-02", "最快的是 SG-03 100ms，但按顺序轮到 JP-02");

const rl2 = await send({ type: "clash_switch", reason: "同节点刷满 10 次后拉黑换下一个", rotate: true, blacklist: true });
check("刷新 10 次仍限流：再拉黑当前并换下一个", rl2.ok && rl2.blacklisted === true && rl2.to === "SG-03",
  "换到 " + rl2.to + "，黑名单 " + (await send({ type: "clash_get_status" })).status.blacklistCount + " 个");

// 跳过黑名单：把当前设成 HK-01（它的下一个 JP-02 已在黑名单里）
api.clashNow = "HK-01";
const rl4 = await send({ type: "clash_switch", reason: "限流", rotate: true, blacklist: true });
check("顺序换节点时跳过黑名单里的节点", rl4.ok && rl4.to === "SG-03",
  "换到 " + rl4.to + "（JP-02 在黑名单里被跳过）");

api.clashNodes = ["HK-01", "JP-02", "SG-03", "US-04"];
api.clashDelays = {};
await send({ type: "clash_set_config", config: { enabled: false, clearBlacklist: true } });

await send({ type: "clash_set_config", config: { enabled: false, clearBlacklist: true } });


// 用例 31：黑名单到期自动解禁（25 分钟是并行倒计时，不是排队累加）
api.clashNodes = ["HK-01", "JP-02"];
api.clashNow = "HK-01";
api.clashDelays = { "JP-02": 120 };
await send({ type: "clash_set_config", config: { enabled: true, baseUrl: "http://127.0.0.1:9090", secret: "s", clearBlacklist: true } });
store.local.clashBlacklist = { "JP-02": Date.now() - 1000 }; // 模拟 25 分钟前拉黑、已经到期的节点
const exp = await send({ type: "clash_switch", reason: "限流", rotate: true, blacklist: false });
check("到期的节点能重新被选中", exp.ok && exp.to === "JP-02", "换到 " + exp.to);
check("到期条目会被自动清理", Object.keys(store.local.clashBlacklist || {}).length === 0, JSON.stringify(store.local.clashBlacklist));
api.clashNodes = ["HK-01", "JP-02", "SG-03", "US-04"];
await send({ type: "clash_set_config", config: { enabled: false, clearBlacklist: true } });


// 用例 32（静态不变式）：超过 60 秒的等待必须包在 keepAlive 里，
// 否则会被「卡住看门狗」（循环内阈值 60 秒）误判成卡住
const contentSrc = fs.readFileSync("content.js", "utf8");
check("收验证码的 90 秒轮询在 keepAlive 里",
  /keepAlive\(\(\) =>[\s\S]{0,80}?request_code/.test(contentSrc), "");
check("等验证码框的 5 分钟等待在 keepAlive 里",
  /keepAlive\(async \(\) => \{[\s\S]{0,400}?waitFor\(CODE_INPUT_SEL/.test(contentSrc), "");
check("keepAlive 心跳间隔 15 秒（小于 60 秒阈值）",
  /__ghLastLogAt = Date\.now\(\)[\s\S]{0,400}?15000/.test(contentSrc), "");
check("看门狗首轮阈值 5 分钟、循环内 1 分钟",
  /task\.rateLimit \? 60000 : 5 \* 60 \* 1000/.test(contentSrc), "");

// 用例 33（静态不变式）：不依赖文字的「结构判断」必须在，阈值是 60 秒（循环内）/ 90 秒（首次）
check("有 pageLooksBlank 结构判断", /function pageLooksBlank\(\)/.test(contentSrc), "");
check("结构判断只看流程页", /signup\|login\|account_verifications/.test(contentSrc) && /settings\/tokens/.test(contentSrc), "");
check("结构异常阈值 60 秒（循环内）/ 90 秒（首次）", /task\.rateLimit \? 12 : 18/.test(contentSrc), "");
check("没有可操作元素时按拦截处理", /页面异常（没有可操作元素）/.test(contentSrc), "");

// 用例 34：遇到「访问暂时受限」/卡住时清 GitHub 会话（而不是换节点）
calls.length = 0;
const sess = await send({ type: "clear_github_session" });
check("清会话接口可用", sess.ok === true, JSON.stringify(sess));
check("确实调了浏览数据清理（只清 github.com）", calls.includes("browsingData.remove"), calls.join(" → "));
const src34 = fs.readFileSync("content.js", "utf8");
check("分流：只有限流页走换节点，其它走清会话", /if \(kind === .限流.\) return handleRateLimit/.test(src34) && /handleBlockedPage\(task, kind\)/.test(src34), "");
check("清会话清 cookie + localStorage，且连 DataDome 的一起清（换 IP 才有意义）",
  /origins: \[[\s\S]{0,400}github\.com[\s\S]{0,300}captcha-delivery\.com[\s\S]{0,150}cookies: true, localStorage: true/.test(fs.readFileSync("background.js", "utf8")), "");
// 用例 34b：GitHub 对可疑 IP 会把 /signup 换成 DataDome 滑块验证页（body 里只有一个跨域 iframe，
// 文字读不到、也没有任何输入框）—— 按 DOM 结构认出来，才能早点换 IP + 清 cookie
check("有 DataDome 验证页识别", /function dataDomeBlocked\(\)/.test(src34), "");
check("按 iframe src/title 认 captcha-delivery/datadome", /captcha-delivery\\\.com\|datadome/i.test(src34) && /script\[src\*="captcha-delivery\.com"\]/.test(src34), "");
check("只有页面上没表单/按钮时才算验证页（别拦能走的流程）",
  /return !qs\(EMAIL_SEL\)[\s\S]{0,90}hasSignupButton\(\)/.test(src34), "");
check("limitKind 会把 DataDome 页判成拦截", /if \(dataDomeBlocked\(\)\) return/.test(src34), "");
check("重置没有次数上限（一直重试到过去为止）", !/n > 7/.test(src34), "");
check("token 阶段清会话后换新邮箱重开", /task\.stage === .token.[\s\S]{0,200}new_account/.test(src34), "");

// 用例 35：遇到「访问暂时受限」超上限时是「丢弃」而不是「存空号」
await send({ type: "clear_accounts" });
const impBefore35 = api.accounts.length;
const q35 = (await send({ type: "get_queue" })).queue;
await send({ type: "done", save: false, account: { email: "gh_drop@example.com", username: "dropme", password: "Pw!", token: "" } });
const accs35 = (await send({ type: "get_accounts" })).accounts;
check("丢弃的号没有写进账户列表", !accs35.some((a) => a.email === "gh_drop@example.com"), "账户数 " + accs35.length);
check("丢弃的号也没有进管理器", api.accounts.length === impBefore35, "管理器 " + api.accounts.length);
check("日志里有明确的丢弃记录", logs.some((l) => /这个号按要求丢弃/.test(l)), logs.filter((l) => /丢弃/.test(l)).join(" | ").slice(0, 80));
check("丢弃也照常推进批次（队列有变化或已清空）", JSON.stringify((await send({ type: "get_queue" })).queue) !== JSON.stringify({ total: 0, left: 0 }), JSON.stringify(q35));
const src35 = fs.readFileSync("content.js", "utf8");

// 用例 36（静态不变式）：清会话路径每次都要「拉黑当前节点并换下一个」
check("清会话路径里有拉黑换节点", /clash_switch[\s\S]{0,120}blacklist: true/.test(src35) && /handleBlockedPage/.test(src35), "");
check("换节点在清会话之前（先换 IP 再清会话）",
  src35.indexOf("clash_switch") < src35.indexOf("clear_github_session"), "");
check("清会话路径不再调用丢弃（无上限重试）", !/finish\(task, \{ save: false \}\)/.test(src35), "");
check("每 7 次报一次进度与凭据", /\(n - 1\) % 7 === 0/.test(src35) && /凭据/.test(src35), "");
// 用例 36b（静态不变式）：重试计数不能在被拦后的"从首页重开"里被清零
// （首页上没有拦截提示 → 老代码在那儿 delete resetCount，于是每次都"第 1 次"、
//   既不显示进度也不进入等待节奏，变成一秒一轮猛打 GitHub）
check("重试计数只在流程页清零（首页不清）",
  /const onFlowPage = hasEmail \|\| hasCodeInput \|\| isTokenPage \|\| isVerification/.test(src35) &&
    /if \(onFlowPage && \(task\.rateLimit \|\| task\.resetCount\)\)/.test(src35), "");
check("被拦重开之间有节奏（换不了节点等更久）",
  /const ms = switched \? 15000 : 60000/.test(src35) && /n >= 2/.test(src35), "");

// 用例 37：中途停止（不再开新号）+ 页面侧自动重试停下
api.mailFailTimes = 0;
const started37 = await send({ type: "start", count: 3 });
check("先正常开一批", started37.ok === true, "");
const q37a = (await send({ type: "get_queue" })).queue;
check("批量队列在跑", !!q37a && q37a.total === 3, JSON.stringify(q37a));
const stopped = await send({ type: "stop" });
check("停止指令生效", stopped.ok === true, JSON.stringify(stopped));
check("队列被清空（不会再开新号）", (await send({ type: "get_queue" })).queue === null, "");
const t37 = (await send({ type: "get_task" })).task;
check("当前任务被打上停止标记（页面脚本据此停手）", !!t37 && t37.stopped === true, JSON.stringify(t37 && t37.stopped));
check("日志说明怎么恢复", logs.some((l) => /已停止/.test(l) && /开始注册/.test(l)), logs.filter((l) => /已停止/.test(l)).slice(-1)[0] || "");

// 用例 38：开着批量时再点开始 = 重写开始（队列重置，任务不带停止标记）
const restarted = await send({ type: "start", count: 2 });
const t38 = (await send({ type: "get_task" })).task;
check("重新开始会重置队列", restarted.ok && (await send({ type: "get_queue" })).queue.total === 2, "");
check("新任务没有停止标记（自动重试恢复工作）", !t38.stopped, JSON.stringify(t38.stopped));

// 用例 39（静态不变式）：开新号失败不限次数、且会检查停止标记
const bg39 = fs.readFileSync("background.js", "utf8");
check("开新号重试没有次数上限", /async function startOneWithRetry\(extra = \{\}\)/.test(bg39) && /for \(;;\)/.test(bg39), "");
check("重试循环检查停止标记", /task\.stopped\) throw new Error\("已停止/.test(bg39), "");
check("连续失败会换节点再试", /fails % 3 === 0/.test(bg39) && /开新号连续失败，换节点重试/.test(bg39), "");
check("等待时间封顶 60 秒（不会越等越离谱）", /Math\.min\(60, 5 \* Math\.min\(fails, 12\)\)/.test(bg39), "");

// 用例 40：邮局连不上 → 换节点重试（邮局也经 Clash 转发）
api.clashNodes = ["HK-01", "JP-02", "SG-03"];
api.clashNow = "HK-01";
api.clashDelays = {};
await send({ type: "clash_set_config", config: { enabled: true, baseUrl: "http://127.0.0.1:9090", secret: "s", clearBlacklist: true } });
api.clashSwitches.length = 0;
api.mailListFailTimes = 99; // 邮局列表接口一直连不上
await send({ type: "request_code", token: "mail-token-1", timeoutMs: 700 });
check("邮局连不上时会换节点", api.clashSwitches.length >= 1, JSON.stringify(api.clashSwitches));
check("换节点日志写明原因", logs.some((l) => /邮局连续 .* 次连不上/.test(l)), logs.filter((l) => /邮局连续/.test(l)).slice(-1)[0] || "");
api.mailListFailTimes = 0;

// 用例 41：管理器连不上 → 换节点再试一次，仍失败才入队
api.clashSwitches.length = 0;
api.down = true;
const pend41 = (await send({ type: "gam_get_status" })).status.pending;
await send({ type: "done", account: { ...acct(41), token: "key_valid_41" } });
check("管理器连不上时会换节点重试", api.clashSwitches.length >= 1, JSON.stringify(api.clashSwitches));
check("换节点后仍失败才进待重试队列", (await send({ type: "gam_get_status" })).status.pending === pend41 + 1, "pending " + pend41 + " → " + (await send({ type: "gam_get_status" })).status.pending);
check("日志写明换了节点再试", logs.some((l) => /连续失败：换个节点再试一次/.test(l)), logs.filter((l) => /换个节点再试/.test(l)).slice(-1)[0] || "");
api.down = false;
await send({ type: "clash_set_config", config: { enabled: false, clearBlacklist: true } });

// 用例 43：每组数量按传入参数生效（默认 10）——G 个一组，第 G+1 个自动开新组
store.local.gamState = { group: "", index: 0 }; // 从干净状态开始，方便数分组
store.local.gamUsedNames = null;
store.local.gamPending = []; // 清掉前面用例残留的待重试队列，免得补导入混进来
await send({ type: "gam_set_config", config: { enabled: true, baseUrl: "http://manager.test", masterPassword: api.adminPassword, groupSize: GROUP_SIZE, saveLocal: true, clearBlacklist: true } });
const impBefore43 = api.accounts.length;
for (let i = 0; i < GROUP_SIZE + 1; i++) {
  await send({ type: "done", account: { ...acct(300 + i), token: `key_valid_${300 + i}` } });
}
const imported43 = api.accounts.slice(impBefore43);
const byGroup43 = {};
for (const a of imported43) (byGroup43[a.group] = byGroup43[a.group] || []).push(a.note);
const groupNames43 = Object.keys(byGroup43);
const sizes43 = Object.values(byGroup43).map((v) => v.length).sort((a, b) => b - a);
check(`每组 ${GROUP_SIZE} 个：${GROUP_SIZE + 1} 个号正好分成两组（${GROUP_SIZE} 个 + 1 个）`,
  groupNames43.length === 2 && sizes43.join(",") === `${GROUP_SIZE},1`,
  JSON.stringify(byGroup43));
const fullGroup43 = groupNames43.find((g) => byGroup43[g].length === GROUP_SIZE);
if (fullGroup43) {
  check(`每组 ${GROUP_SIZE} 个：满组的备注依次是 ${fullGroup43}-0 … ${fullGroup43}-${GROUP_SIZE - 1}`,
    byGroup43[fullGroup43].join(",") === Array.from({ length: GROUP_SIZE }, (_, i) => `${fullGroup43}-${i}`).join(","),
    byGroup43[fullGroup43].join(","));
}
const oneGroup43 = groupNames43.find((g) => byGroup43[g].length === 1);
if (oneGroup43) {
  check(`每组 ${GROUP_SIZE} 个：新组的第一条备注是 ${oneGroup43}-0`,
    byGroup43[oneGroup43][0] === `${oneGroup43}-0`, byGroup43[oneGroup43][0]);
}

// 用例 44：标签页被关掉后，换节点重开要能自己把页面重新开出来
// （本地实测 bug：tabs.update 抛 "No tab with id: xxx" → 流程就停在那儿不动了）
calls.length = 0; navUrls.length = 0;
await send({ type: "set_task", task: { stage: "fill", email: "a@example.com", tabId: 999 } }); // 999 标记为已被关掉
tabsDead.add(999);
const re1 = await reloadTaskTab("测试：标签页没了");
check("标签页不在时不再报 'No tab with id' 失败", re1 === true, String(re1));
check("标签页不在时重新开了一个", calls.includes("tabs.create"), calls.join(" → "));
check("重开后把 task 指到新标签页", (await send({ type: "get_task" })).task.tabId === 1, JSON.stringify((await send({ type: "get_task" })).task));
check("新标签页也禁止被浏览器回收", lastTabCreate && lastTabCreate.autoDiscardable === false, JSON.stringify(lastTabCreate));

calls.length = 0; navUrls.length = 0;
await send({ type: "set_task", task: { stage: "fill", email: "a@example.com", tabId: 10 } }); // 10 是活的（没被标记）
const re2 = await reloadTaskTab("测试：标签页还在");
check("标签页还在时只导航、不新开", re2 === true && navUrls.includes("https://github.com/signup") && !calls.includes("tabs.create"), calls.join(" → "));

calls.length = 0; navUrls.length = 0;
await send({ type: "set_task", task: { stage: "token", email: "a@example.com", tabId: 10 } });
await reloadTaskTab("测试：token 阶段回首页");
check("token 阶段回首页（不是注册页）", navUrls.includes("https://github.com/"), navUrls.join(","));

// 用例 45：后台看门狗（关掉远程桌面后页面被系统冻结时，靠它把页面重新拉起来）
calls.length = 0; navUrls.length = 0;
await send({ type: "set_task", task: { stage: "fill", email: "a@example.com", tabId: 10 } });
store.session.queue = { total: 3, left: 2 };
store.session.lastPageBeat = Date.now() - 5 * 60 * 1000; // 5 分钟没动静 = 冻住了
const wd1 = await onWatchdogTick();
check("页面冻住超过 3 分钟 → 看门狗重开页面", wd1.action.includes("重开页面") && navUrls.length > 0, JSON.stringify(wd1) + " / " + navUrls.join(","));
check("看门狗重开后重置了心跳（不连环重开）", Date.now() - store.session.lastPageBeat < 5000, String(store.session.lastPageBeat));

calls.length = 0; navUrls.length = 0;
store.session.lastPageBeat = Date.now() - 10 * 1000; // 10 秒前刚有动静
const wd2 = await onWatchdogTick();
check("页面有动静时看门狗不动手", navUrls.length === 0 && wd2.action === "页面有动静", JSON.stringify(wd2));

calls.length = 0;
store.session.queue = null;
store.session.lastPageBeat = Date.now() - 30 * 60 * 1000;
const wd3 = await onWatchdogTick();
check("没有批量在跑时看门狗不动手", navUrls.length === 0 && wd3.action === "无批量在跑", JSON.stringify(wd3));

// 用例 46（静态不变量）：页面心跳要报给后台，否则看门狗把正常等待当成冻结
const content46 = fs.readFileSync("content.js", "utf8");
check("页面 keepAlive 会报心跳给后台", /page_beat/.test(content46) && /__ghLastLogAt = Date\.now\(\)[\s\S]{0,300}page_beat/.test(content46), "");
check("后台收到日志就记一次心跳", /content_log[\s\S]{0,200}markPageBeat/.test(fs.readFileSync("background.js", "utf8")), "");
check("看门狗阈值是 3 分钟", /PAGE_IDLE_LIMIT_MS = 3 \* 60 \* 1000/.test(fs.readFileSync("background.js", "utf8")), "");

console.log("\n=== 管理器侧最终数据 ===");
for (const a of api.accounts) console.log(`  ${a.group.padEnd(16)} ${a.note.padEnd(22)} ${a.github_login}`);

console.log("\n=== 关键日志 ===");
for (const l of logs.filter((l) => /分组|导入|待重试/.test(l))) console.log("  " + l);

console.log(failures ? `\nFAILED: ${failures}` : "\nALL PASS");
process.exit(failures ? 1 : 0);
