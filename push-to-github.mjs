// 把当前工作区推送到 GitHub
//
//   node push-to-github.mjs
//
// 推送方式：优先用本机 git（工作区是 git 仓库时），否则退回 GitHub API ——
// 没装 git 的机器也能用，装了 git 的就走正常的 git commit / push。
// 设 PUSH_FORCE_API=1 可以强制走 API 那条路。
//
// API 方式的 token 来源（按顺序）：环境变量 GITHUB_TOKEN / GH_TOKEN，或 ~/.zcode/github-token.txt
// git 方式的凭据来自 git 自己的 credential store（见 README）。
// 输出全部写到 stderr —— ZCode 的 hook 会把 stdout 当 JSON 解析，所以 stdout 保持为空。
//
// API 方式会用 git blob sha 比对本地文件与仓库当前的 tree，只上传有变化的文件，
// 删掉的文件也会同步删除；没有任何变化就直接退出，不产生空提交。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const OWNER = "weige0831";
const REPO = "githubreg";
const BRANCH = "main";
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 不推送的内容：本地配置与密钥、依赖、临时文件
const SKIP_DIRS = new Set([".git", ".zcode", "node_modules", ".vscode"]);
const SKIP_FILE_RE = /^\.tmp-/;
// 这个推送脚本本身是**本机工具**，不属于扩展、也不该出现在公开仓库里：
// 它带着本机的目录结构，而且它是"把工作区同步上去"的 —— 不排除自己就会每次又传回去。
const SKIP_FILES = new Set(["push-to-github.mjs"]);

const LOCK_FILE = path.join(os.tmpdir(), "githubreg-push.lock");
const PATTERN_FILE = path.join(ROOT, ".zcode", "private-patterns.json");
const log = (...args) => console.error(...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 私人信息闸门 =====
// 推送前扫一遍工作区：命中 .zcode/private-patterns.json 里的任何一条就拒绝推送，
// 免得把管理器地址、邮局域名、密码这类东西推到这个公开仓库里。
// 确认无误要强推：PUSH_ALLOW_SECRETS=1
function loadPatterns() {
  try {
    const json = JSON.parse(fs.readFileSync(PATTERN_FILE, "utf8"));
    return Array.isArray(json.patterns) ? json.patterns.filter((p) => typeof p === "string" && p.trim()) : [];
  } catch (e) {
    return []; // 没有这个文件就不检查
  }
}

function scanPrivateInfo(files) {
  const patterns = loadPatterns();
  if (!patterns.length) return [];
  const hits = [];
  for (const f of files) {
    if (/\.(png|jpe?g|gif|ico|zip|exe|dll)$/i.test(f.rel)) continue;
    const text = f.buf.toString("utf8");
    for (const p of patterns) if (text.includes(p)) hits.push(`${f.rel} ← ${p}`);
  }
  return hits;
}

// API 方式用的 token（走 git 时不需要，所以延迟到真的要用时再读）
let token = "";
function readToken() {
  const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(path.join(os.homedir(), ".zcode", "github-token.txt"), "utf8").trim();
  } catch (e) {
    return "";
  }
}

async function api(method, endpoint, body, { allow404 = false } = {}) {
  const resp = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "githubreg-push",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  if (resp.status === 404 && allow404) return null;
  if (!resp.ok) {
    throw new Error(`${method} ${endpoint} → ${resp.status} ${(json && json.message) || text.slice(0, 200)}`);
  }
  return json;
}

// git 的对象寻址：sha1("blob " + 字节数 + "\0" + 内容)
const blobSha = (buf) =>
  crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && !SKIP_FILE_RE.test(entry.name) && !SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function localFiles() {
  return walk(ROOT).map((full) => {
    const buf = fs.readFileSync(full);
    return { rel: path.relative(ROOT, full).split(path.sep).join("/"), buf, sha: blobSha(buf) };
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function pushOnce() {
  const files = localFiles();

  // 远端当前状态；空仓库（409 Git Repository is empty）或分支还不存在（404）都算第一次推送
  let headSha = null;
  let baseTree = null;
  let ref = null;
  try {
    ref = await api("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  } catch (e) {
    if (!/404|409|empty/i.test(String(e.message || e))) throw e;
  }
  if (ref) {
    headSha = ref.object.sha;
    const commit = await api("GET", `/repos/${OWNER}/${REPO}/git/commits/${headSha}`);
    baseTree = commit.tree.sha;
  }
  if (!headSha) {
    // 空仓库：Git Data API 会一律返回 409，得先用 Contents API 建立第一个提交
    const first = files.find((f) => f.rel === "README.md") || files[0];
    if (!first) {
      log("= 工作区没有可推送的文件");
      return null;
    }
    const encPath = first.rel.split("/").map(encodeURIComponent).join("/");
    const put = await api("PUT", `/repos/${OWNER}/${REPO}/contents/${encPath}`, {
      message: `${stamp()} 初始化仓库`,
      content: first.buf.toString("base64"),
    });
    headSha = put.commit.sha;
    baseTree = put.commit.tree.sha;
    log(`· 空仓库：已用 ${first.rel} 建立首个提交`);
  }
  const remote = new Map();
  if (baseTree) {
    const tree = await api("GET", `/repos/${OWNER}/${REPO}/git/trees/${baseTree}?recursive=1`);
    for (const e of tree.tree || []) if (e.type === "blob") remote.set(e.path, e.sha);
  }

  const local = new Map(files.map((f) => [f.rel, f.sha]));
  const changed = files.filter((f) => !remote.has(f.rel) || remote.get(f.rel) !== f.sha);
  const removed = [...remote.keys()].filter((p) => !local.has(p));
  if (!changed.length && !removed.length) {
    log(`= 没有变更（${files.length} 个文件与仓库一致）`);
    return null;
  }

  // 只上传有变化的文件
  const entries = [];
  for (const f of changed) {
    const blob = await api("POST", `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: f.buf.toString("base64"),
      encoding: "base64",
    });
    entries.push({ path: f.rel, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const p of removed) entries.push({ path: p, mode: "100644", type: "blob", sha: null });

  const tree = await api("POST", `/repos/${OWNER}/${REPO}/git/trees`, {
    tree: entries,
    ...(baseTree ? { base_tree: baseTree } : {}),
  });

  const summary = [...changed.map((f) => f.rel), ...removed.map((p) => `${p}(删除)`)];
  const commit = await api("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `${stamp()} 同步 ${summary.length} 个文件\n\n${summary.join("\n")}`,
    tree: tree.sha,
    parents: headSha ? [headSha] : [],
  });

  if (headSha) {
    await api("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  } else {
    await api("POST", `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }
  log(`✓ 已推送 ${summary.length} 个文件（${commit.sha.slice(0, 7)}）：${summary.join(", ")}`);
  return commit.sha;
}

// ===== 方式一：本机 git =====

function findGit() {
  const candidates = [
    process.env.GIT_EXE,
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "/usr/bin/git",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {}
  }
  return "git"; // 交给 PATH
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e.message) }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

// 有 .git 就走 git：add -A -> commit -> push origin HEAD:main
async function pushViaGit() {
  if (!fs.existsSync(path.join(ROOT, ".git"))) return { ok: false, reason: "工作区不是 git 仓库" };

  const git = findGit();
  const status = await run(git, ["status", "--porcelain"]);
  if (status.code !== 0) return { ok: false, reason: (status.err || status.out).trim() || "git status 失败" };

  // 注意不要先 trim 整体输出：porcelain 每行前两位是状态码，trim 会把首行的前导空格吃掉
  const changed = status.out
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());
  if (!changed.length) {
    log("= 没有变更（git 工作区干净）");
    return { ok: true, pushed: false };
  }

  const add = await run(git, ["add", "-A"]);
  if (add.code !== 0) return { ok: false, reason: (add.err || add.out).trim() };

  const message = `${stamp()} 同步 ${changed.length} 个文件\n\n${changed.slice(0, 30).join("\n")}`;
  const commit = await run(git, ["commit", "-m", message]);
  if (commit.code !== 0) return { ok: false, reason: (commit.err || commit.out).trim() };

  const push = await run(git, ["push", "origin", `HEAD:${BRANCH}`]);
  if (push.code !== 0) {
    // GitHub 的 HTTPS 偶尔会被重置，重试一次再决定是否交给 API 兜底
    log("· git push 失败，3 秒后重试：" + (push.err || push.out).trim().split(/\r?\n/)[0]);
    await sleep(3000);
    const retry = await run(git, ["push", "origin", `HEAD:${BRANCH}`]);
    if (retry.code !== 0) return { ok: false, reason: (retry.err || retry.out).trim() };
  }

  const head = await run(git, ["rev-parse", "--short", "HEAD"]);
  log(`✓ 已推送 ${changed.length} 个文件（git ${head.out.trim()}）：${changed.slice(0, 10).join(", ")}${changed.length > 10 ? " …" : ""}`);
  return { ok: true, pushed: true };
}

// API 兜底推送之后，本地 git 可能留下一个没推上去的提交（远端已有等价内容）。
// 不处理的话下次 git push 会因为「远端有你没有的提交」一直被拒。内容一致就自动对齐。
async function reconcileGitAfterApiPush() {
  if (!fs.existsSync(path.join(ROOT, ".git"))) return;
  const git = findGit();
  const fetched = await run(git, ["fetch", "origin"]);
  if (fetched.code !== 0) {
    log("· 连不上远端（git fetch 失败），本地分支暂不对齐；等网络恢复后再跑一次即可");
    return;
  }
  const local = await run(git, ["rev-parse", "HEAD^{tree}"]);
  const remote = await run(git, ["rev-parse", `origin/${BRANCH}^{tree}`]);
  if (local.code !== 0 || remote.code !== 0) return;
  if (local.out.trim() !== remote.out.trim()) {
    log("· 本地 git 与远端内容不一致，未自动对齐（下次 git push 前先 git pull）");
    return;
  }
  const reset = await run(git, ["reset", "--mixed", `origin/${BRANCH}`]);
  if (reset.code === 0) log("· 远端内容与本地一致，已把本地分支对齐到远端（历史不再分叉）");
}

// ===== 方式二：GitHub API（不需要本机 git）=====

// 同一时刻只允许一次推送（hook 可能被连续的编辑触发）
function acquireLock() {
  try {
    if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs < 60000) return false;
  } catch (e) {
    // 没有锁文件：正常情况
  }
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) {
    // 写不了锁文件就不加锁，照常推送
  }
  return true;
}
const releaseLock = () => {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (e) {}
};

if (!acquireLock()) {
  log("= 上一次推送还在进行，本次跳过");
  process.exit(0);
}

let ok = true;
try {
  // 私人信息闸门：命中就拒绝推送（否则公开仓库里会出现你的服务地址）
  if (!process.env.PUSH_ALLOW_SECRETS) {
    const hits = scanPrivateInfo(localFiles());
    if (hits.length) {
      log("✗ 检测到私人信息，已拒绝推送：");
      for (const h of hits) log("   " + h);
      log("  规则来自 .zcode/private-patterns.json（本机文件，不推送）");
      log("  确实要推的话：PUSH_ALLOW_SECRETS=1 node push-to-github.mjs");
      throw new Error("命中私人信息关键字");
    }
  }

  // 先用 git；失败或强制 API 时才走 GitHub API
  const forced = !!process.env.PUSH_FORCE_API;
  const viaGit = forced ? { ok: false, reason: "PUSH_FORCE_API=1，强制走 API" } : await pushViaGit();

  if (!viaGit.ok) {
    log(`· 改用 GitHub API 推送（${viaGit.reason}）`);
    token = readToken();
    if (!token) {
      throw new Error("没找到 GitHub token：设置环境变量 GITHUB_TOKEN，或写入 ~/.zcode/github-token.txt");
    }
    try {
      await pushOnce();
    } catch (e) {
      if (/fast.?forward|422/i.test(String(e.message || e))) {
        log("↻ 远端引用已变动，重试一次");
        await pushOnce();
      } else {
        throw e;
      }
    }
    await reconcileGitAfterApiPush();
  }
} catch (e) {
  ok = false;
  log("✗ 推送失败：" + String(e.message || e));
} finally {
  releaseLock();
}
process.exit(ok ? 0 : 1);
