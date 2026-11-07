// Learnloop cross-device sync
// GET /api/progress?code=ABC123  -> { done: ["sql:0:1", ...] }
// POST /api/progress { code, done: [...] } -> { done: [...] }
// Progress is durable via Vercel Blob (private). Falls back to in-memory when
// BLOB_READ_WRITE_TOKEN is not set (local dev).

let blob;
try {
  blob = require("@vercel/blob");
} catch {
  blob = null;
}

const PREFIX = "learnloop-progress";
const CODE_RE = /^[A-Z0-9]{4,32}$/;
const DONE_RE = /^[a-z0-9-]+:\d+:\d+$/;

if (!globalThis.learnloopProgress) globalThis.learnloopProgress = new Map();

function blobPath(code) {
  return `${PREFIX}/${code}.json`;
}

function validDone(v) {
  return typeof v === "string" && DONE_RE.test(v);
}

function normalizeDone(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const item of list.slice(0, 5000)) {
    if (validDone(String(item).toLowerCase())) out.add(String(item).toLowerCase());
  }
  return [...out];
}

function mergeDone(a, b) {
  const set = new Set(normalizeDone(a));
  for (const item of normalizeDone(b)) set.add(item);
  return [...set].sort();
}

async function readRemote(code) {
  // in-memory first (helps serverless warm instances)
  const mem = globalThis.learnloopProgress.get(code) || [];
  if (!process.env.BLOB_READ_WRITE_TOKEN || !blob) return mem;
  try {
    const result = await blob.get(blobPath(code), { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return mem;
    const text = await new Response(result.stream).text();
    const parsed = JSON.parse(text);
    const done = normalizeDone(parsed && parsed.done);
    return mergeDone(mem, done);
  } catch {
    return mem;
  }
}

async function writeRemote(code, done) {
  const clean = normalizeDone(done);
  globalThis.learnloopProgress.set(code, clean);
  if (!process.env.BLOB_READ_WRITE_TOKEN || !blob) return clean;
  try {
    await blob.put(blobPath(code), JSON.stringify({ done: clean, updatedAt: Date.now() }), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch {
    /* durable write is best-effort */
  }
  return clean;
}

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
      resolve(req.body);
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET") {
      const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
      if (!CODE_RE.test(code)) return sendJson(res, 400, { error: "invalid code" });
      const done = await readRemote(code);
      return sendJson(res, 200, { done });
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      const code = String(body.code || "").trim().toUpperCase();
      if (!CODE_RE.test(code)) return sendJson(res, 400, { error: "invalid code" });
      const incoming = normalizeDone(body.done);
      const existing = await readRemote(code);
      const merged = mergeDone(existing, incoming);
      await writeRemote(code, merged);
      return sendJson(res, 200, { done: merged });
    }
    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[progress] failed", err && err.message);
    return sendJson(res, 500, { error: "sync failed" });
  }
};
