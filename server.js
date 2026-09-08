const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const APP_USERNAME = process.env.APP_USERNAME || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || "v1";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-image";
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REAL_ESRGAN_MODEL = process.env.REPLICATE_REAL_ESRGAN_MODEL || "nightmareai/real-esrgan";
const CONTROLNET_MODEL = process.env.REPLICATE_CONTROLNET_MODEL || "lucataco/sdxl-lightning-multi-controlnet";
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_MB || 3) * 1024 * 1024;
const MAX_STORAGE_BYTES = Number(process.env.MAX_STORAGE_GB || 10) * 1024 * 1024 * 1024;
const MAX_AGE_MS = Number(process.env.MAX_AGE_DAYS || 40) * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const COOKIE_NAME = "bella_session";
const IS_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === "true"
  : process.env.NODE_ENV === "production";
let activeJobId = null;

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 3,
    fields: 4,
    fieldSize: 2 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    cb(null, allowedImageTypes.has(file.mimetype));
  }
});

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

function safeName(value) {
  return String(value || "").replace(/[^a-z0-9._-]/gi, "_").slice(0, 90) || "image";
}

function extensionForMime(mime) {
  return mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sessionToken() {
  const payload = Buffer.from(JSON.stringify({
    sub: APP_USERNAME,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function isValidSession(token) {
  if (!token || !SESSION_SECRET) return false;
  const [payload, signature] = String(token).split(".");
  if (!payload || !signature) return false;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.sub === APP_USERNAME && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header) {
  return String(header || "").split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index > -1) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function setSessionCookie(res, token) {
  const secure = IS_SECURE ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function authConfigured() {
  return Boolean(APP_USERNAME && APP_PASSWORD && SESSION_SECRET && GEMINI_API_KEY && REPLICATE_API_TOKEN);
}

function requireAuth(req, res, next) {
  if (!isValidSession(parseCookies(req.headers.cookie)[COOKIE_NAME])) {
    return res.status(401).json({ error: "Authentication required." });
  }
  next();
}

async function ensureStorage() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
}

async function readMetadata(jobId) {
  try {
    return JSON.parse(await fsp.readFile(path.join(JOBS_DIR, jobId, "job.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeMetadata(job) {
  job.updatedAt = nowIso();
  const jobDir = path.join(JOBS_DIR, job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  await fsp.writeFile(path.join(jobDir, "job.json"), JSON.stringify(job, null, 2));
}

function publicJob(job) {
  return {
    id: job.id,
    prompt: job.prompt,
    status: job.status,
    step: job.step,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    hasResult: Boolean(job.resultFile),
    resultUrl: job.resultFile ? `/media/${encodeURIComponent(job.id)}/${encodeURIComponent(job.resultFile)}` : null
  };
}

async function directoryBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else {
      try {
        total += (await fsp.stat(full)).size;
      } catch {}
    }
  }
  return total;
}

async function cleanupStorage() {
  await ensureStorage();
  const entries = (await fsp.readdir(JOBS_DIR, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const jobs = [];
  for (const entry of entries) {
    const dir = path.join(JOBS_DIR, entry.name);
    const metadata = await readMetadata(entry.name);
    const stat = await fsp.stat(dir).catch(() => ({ mtimeMs: 0 }));
    jobs.push({
      id: entry.name,
      dir,
      size: await directoryBytes(dir),
      createdAt: metadata?.createdAt || new Date(stat.mtimeMs).toISOString(),
      active: metadata?.status === "processing"
    });
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const job of jobs) {
    if (!job.active && new Date(job.createdAt).getTime() < cutoff) {
      await fsp.rm(job.dir, { recursive: true, force: true });
      job.size = 0;
    }
  }
  let used = jobs.reduce((sum, job) => sum + job.size, 0);
  if (used <= MAX_STORAGE_BYTES) return;
  const removable = jobs
    .filter((job) => !job.active && job.size > 0)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const target = 5 * 1024 * 1024 * 1024;
  let removed = 0;
  for (const job of removable) {
    if (removed >= target) break;
    await fsp.rm(job.dir, { recursive: true, force: true });
    used -= job.size;
    removed += job.size;
  }
}

function imageDataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { detail: text.slice(0, 1000) };
  }
  if (!response.ok) {
    const message = body?.detail || body?.error?.message || body?.error || `Request failed with ${response.status}`;
    throw new Error(String(message));
  }
  return body;
}

function replicateModelPath(model) {
  return model.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function replicatePrediction(model, input, options = {}) {
  const response = await fetchWithTimeout(`https://api.replicate.com/v1/models/${replicateModelPath(model)}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ input })
  });
  const prediction = await readJsonResponse(response);
  let current = prediction;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (["succeeded", "failed", "canceled"].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pollUrl = current.urls?.get || `https://api.replicate.com/v1/predictions/${current.id}`;
    const poll = await fetchWithTimeout(pollUrl, {
      headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` }
    });
    current = await readJsonResponse(poll);
  }
  if (current.status !== "succeeded") {
    throw new Error(current.error || `Image refinement ${current.status || "timed out"}.`);
  }
  const outputs = Array.isArray(current.output) ? current.output : [current.output];
  let output = outputs[options.outputIndex ?? 0];
  if (options.outputIndex === -1) output = outputs[outputs.length - 1];
  const outputUrl = typeof output === "string" ? output : output?.url;
  if (!outputUrl) throw new Error("The image refinement service returned no image.");
  const imageResponse = await fetchWithTimeout(outputUrl, {}, 180000);
  if (!imageResponse.ok) throw new Error("Could not download the refined image.");
  return {
    buffer: Buffer.from(await imageResponse.arrayBuffer()),
    mime: imageResponse.headers.get("content-type")?.split(";")[0] || "image/png"
  };
}

async function geminiEdit(parts) {
  const endpoint = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
  };
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify(body)
  }, 180000);
  const data = await readJsonResponse(response);
  const responseParts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const inline = imagePart?.inlineData || imagePart?.inline_data;
  if (!inline?.data) throw new Error("Gemini returned no edited image. Try a more specific prompt.");
  return {
    buffer: Buffer.from(inline.data, "base64"),
    mime: inline.mimeType || inline.mime_type || "image/png"
  };
}

function buildGeminiPrompt(prompt, referenceCount) {
  return [
    "You are Bella's Studio's precision photo editor.",
    "Edit the target image according to the user's instruction.",
    "The target image is the source of truth for the person's identity and physical proportions.",
    "Strictly preserve facial features, identity, skin tone, body size, body height, age, and natural anatomy.",
    "Do not beautify, reshape, slim, stretch, shorten, or change the person's face unless the user explicitly asks for a permitted visual treatment; even then, preserve identity.",
    "Keep the target's composition and background unless the prompt requires a change.",
    referenceCount ? "Reference images are optional style or clothing guidance only; never copy their face or body identity onto the target." : "",
    `User instruction: ${prompt.trim()}`
  ].filter(Boolean).join("\n\n");
}

function buildControlNetPrompt(prompt) {
  return [
    "Preserve the exact person, facial identity, skin tone, body size, height, and anatomy from the original target image.",
    "Use the original target as structural and proportion guidance. Correct only unintended scale, body proportion, or posture drift while preserving the requested edit.",
    `Requested edit: ${prompt.trim()}`
  ].join("\n");
}

async function processJob(job) {
  const dir = path.join(JOBS_DIR, job.id);
  try {
    job.status = "processing";
    job.step = "Preparing your images";
    await writeMetadata(job);
    const target = await fsp.readFile(path.join(dir, job.targetFile));
    const targetDataUrl = imageDataUrl(target, job.targetMime);

    job.step = "Improving source clarity";
    await writeMetadata(job);
    const upscaled = await replicatePrediction(REAL_ESRGAN_MODEL, {
      image: targetDataUrl,
      scale: 2,
      face_enhance: true
    });
    const upscaledDataUrl = imageDataUrl(upscaled.buffer, upscaled.mime);

    job.step = "Applying your direction";
    await writeMetadata(job);
    const parts = [{ text: buildGeminiPrompt(job.prompt, job.referenceFiles.length) }];
    for (const ref of job.referenceFiles) {
      const refBuffer = await fsp.readFile(path.join(dir, ref.file));
      parts.push({ inlineData: { mimeType: ref.mime, data: refBuffer.toString("base64") } });
    }
    parts.push({ inlineData: { mimeType: upscaled.mime, data: upscaled.buffer.toString("base64") } });
    const gemini = await geminiEdit(parts);

    job.step = "Balancing proportions";
    await writeMetadata(job);
    const generatedDataUrl = imageDataUrl(gemini.buffer, gemini.mime);
    const controlInput = {
      // Img2img source: keep the Gemini edit as the visual base.
      image: generatedDataUrl,
      prompt: buildControlNetPrompt(job.prompt),
      negative_prompt: "warped anatomy, changed identity, different skin tone, altered body proportions, low quality, blurry",
      sizing_strategy: "input_image",
      num_outputs: 1,
      num_inference_steps: 4,
      prompt_strength: 0.28,
      seed: 0,
      // The original target supplies identity/proportion edges.
      controlnet_1: "canny",
      controlnet_1_image: targetDataUrl,
      controlnet_1_conditioning_scale: 0.55,
      controlnet_1_start: 0,
      controlnet_1_end: 1,
      // The Gemini result supplies the requested pose structure.
      controlnet_2: "openpose",
      controlnet_2_image: generatedDataUrl,
      controlnet_2_conditioning_scale: 0.65,
      controlnet_2_start: 0,
      controlnet_2_end: 1,
      controlnet_3: "none"
    };
    // This model returns preprocessed control images before the generated
    // result. Select the last output so the frontend never receives a guide.
    const controlled = await replicatePrediction(CONTROLNET_MODEL, controlInput, { outputIndex: -1 });

    job.step = "Polishing final resolution";
    await writeMetadata(job);
    const final = await replicatePrediction(REAL_ESRGAN_MODEL, {
      image: imageDataUrl(controlled.buffer, controlled.mime),
      scale: 4,
      face_enhance: true
    });
    const resultFile = `result${extensionForMime(final.mime)}`;
    await fsp.writeFile(path.join(dir, resultFile), final.buffer);
    job.resultFile = resultFile;
    job.status = "completed";
    job.step = "Ready";
    await writeMetadata(job);
    await cleanupStorage();
  } catch (error) {
    job.status = "failed";
    job.step = "Could not complete";
    job.error = error.message || "Something went wrong while creating the image.";
    await writeMetadata(job);
  } finally {
    if (activeJobId === job.id) activeJobId = null;
  }
}

app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: authConfigured() });
});

app.post("/api/auth/login", (req, res) => {
  if (!authConfigured()) return res.status(503).json({ error: "The studio is not configured yet." });
  const { username, password } = req.body || {};
  if (!constantTimeEqual(username, APP_USERNAME) || !constantTimeEqual(password, APP_PASSWORD)) {
    return res.status(401).json({ error: "That username or password is not correct." });
  }
  setSessionCookie(res, sessionToken());
  res.json({ ok: true });
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ authenticated: isValidSession(parseCookies(req.headers.cookie)[COOKIE_NAME]) });
});

app.get("/api/history", requireAuth, async (_req, res) => {
  await ensureStorage();
  const entries = await fsp.readdir(JOBS_DIR, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = await readMetadata(entry.name);
    if (job) jobs.push(publicJob(job));
  }
  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ jobs });
});

app.get("/api/jobs/:id", requireAuth, async (req, res) => {
  const job = await readMetadata(req.params.id);
  if (!job) return res.status(404).json({ error: "Generation not found." });
  res.json({ job: publicJob(job) });
});

app.post("/api/generate", requireAuth, upload.fields([
  { name: "target", maxCount: 1 },
  { name: "references", maxCount: 2 }
]), async (req, res) => {
  if (activeJobId) return res.status(409).json({ error: "One edit is already being created. Please wait for it to finish." });
  if (!req.files?.target?.[0]) return res.status(400).json({ error: "Upload a target image first." });
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Describe the edit you want to make." });
  const target = req.files.target[0];
  const references = req.files.references || [];
  const id = randomId();
  const dir = path.join(JOBS_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  const targetFile = `target${extensionForMime(target.mimetype)}`;
  await fsp.writeFile(path.join(dir, targetFile), target.buffer);
  const referenceFiles = [];
  for (let i = 0; i < references.length; i += 1) {
    const ref = references[i];
    const file = `reference-${i + 1}${extensionForMime(ref.mimetype)}`;
    await fsp.writeFile(path.join(dir, file), ref.buffer);
    referenceFiles.push({ file, mime: ref.mimetype });
  }
  const job = {
    id,
    prompt,
    targetFile,
    targetMime: target.mimetype,
    referenceFiles,
    status: "processing",
    step: "Preparing your images",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await writeMetadata(job);
  processJob(job);
  res.status(202).json({ job: publicJob(job) });
});

app.delete("/api/jobs/:id", requireAuth, async (req, res) => {
  const job = await readMetadata(req.params.id);
  if (!job) return res.status(404).json({ error: "Generation not found." });
  if (job.status === "processing") return res.status(409).json({ error: "This generation is still running." });
  await fsp.rm(path.join(JOBS_DIR, req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get("/media/:jobId/:filename", requireAuth, async (req, res) => {
  const jobId = safeName(req.params.jobId);
  const filename = safeName(req.params.filename);
  const job = await readMetadata(jobId);
  if (!job || filename !== job.resultFile) return res.status(404).end();
  const file = path.join(JOBS_DIR, jobId, filename);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError || error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `Each image must be ${process.env.MAX_IMAGE_MB || 3}MB or smaller.` });
  }
  if (error?.message === "Unexpected field") return res.status(400).json({ error: "Use one target image and up to two reference images." });
  console.error(error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

async function start() {
  await ensureStorage();
  const entries = await fsp.readdir(JOBS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const staleJob = await readMetadata(entry.name);
    if (staleJob?.status === "processing") {
      staleJob.status = "failed";
      staleJob.step = "Could not complete";
      staleJob.error = "The server restarted while this edit was running. Please try again.";
      await writeMetadata(staleJob);
    }
  }
  await cleanupStorage();
  setInterval(() => cleanupStorage().catch((error) => console.error("Cleanup failed:", error.message)), CLEANUP_INTERVAL_MS).unref();
  app.listen(PORT, HOST, () => {
    console.log(`Bella's Studio listening on ${HOST}:${PORT}`);
    if (!authConfigured()) console.warn("Set APP_USERNAME, APP_PASSWORD, SESSION_SECRET, GEMINI_API_KEY, and REPLICATE_API_TOKEN before using the studio.");
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});