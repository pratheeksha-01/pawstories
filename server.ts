import express from "express";
import { createHash, randomUUID } from "crypto";
import { createServer as createViteServer } from "vite";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import admin from "firebase-admin";

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// --- Structured logging ---------------------------------------------------
// Single-line JSON logs so they stay greppable and parse cleanly in Cloud
// Logging / any log aggregator. Every AI request carries a `reqId` so the
// full lifecycle (received -> cache -> model -> tokens/cost -> done) can be
// traced end to end.
type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LOG_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || "info"] ?? LOG_LEVELS.info;

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  if (LOG_LEVELS[level] < MIN_LOG_LEVEL) return;
  const entry = { ts: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const ANALYZE_TIMEOUT_MS = 30000; // extra headroom for backoff retries on 429
const IMAGE_TIMEOUT_MS = 45000;
const CACHE_TTL_MS = 15 * 60 * 1000;

app.use(express.json({ limit: '20mb' }));

import { GoogleGenAI } from "@google/genai";

let aiClient: GoogleGenAI | null = null;

function getConfiguredProjectId() {
  const candidate = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!candidate || /YOUR_GCP_PROJECT_ID|your-project-id|changeme/i.test(candidate)) {
    throw new Error("Google Cloud project is not configured. Set GCP_PROJECT_ID to your real Google Cloud project ID and ensure the service account has Vertex AI access.");
  }
  return candidate;
}

function getAnalyzeModelCandidates() {
  return [...new Set([
    process.env.GEMINI_ANALYZE_MODEL,
    // This step also does the human/pet safety gate — a nuanced multimodal
    // judgment call, not just cheap text extraction. flash-lite proved too weak
    // here (it let human photos through), so flash is the floor for correctness;
    // flash-lite is intentionally NOT in this fallback chain.
    "gemini-2.5-flash",
    "gemini-2.5-pro"
  ].filter(Boolean))] as string[];
}

function getImageModelCandidates() {
  return [...new Set([
    process.env.GEMINI_IMAGE_MODEL,
    // Prefer newer 3.1 image-capable models where available, then fall back to 2.5 image
    "gemini-3.1-flash-image",
    "gemini-2.5-flash-image"
  ].filter(Boolean))] as string[];
}

function getAnalyzeModel() {
  return getAnalyzeModelCandidates()[0];
}

function getImageModel() {
  return getImageModelCandidates()[0];
}

function logEnvDebug() {
  log("info", "server.config", {
    project: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || "<missing>",
    location: process.env.GCP_LOCATION || "us-central1",
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || "<missing>",
    analyzeModel: getAnalyzeModel(),
    imageModel: getImageModel(),
    logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID || "<missing — auth/quota enforcement will fail>",
    firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      ? "dedicated key file configured (local-dev pattern)"
      : process.env.GOOGLE_APPLICATION_CREDENTIALS
        ? "falling back to GOOGLE_APPLICATION_CREDENTIALS — verify that file exists here and has Firestore IAM"
        : "no key file configured — expecting an attached Cloud Run service account with Firestore IAM (production pattern)",
  });
}

logEnvDebug();

function getGeminiClient() {
  if (aiClient) {
    return aiClient;
  }

  // Same footgun as FIREBASE_SERVICE_ACCOUNT_PATH: this points at a real file for local
  // dev, but if it gets copied into Cloud Run's runtime env vars, the (gitignored) key
  // file was never in the deployed container, and the underlying auth library's ENOENT
  // is not obviously actionable. On Cloud Run, don't set this — attach the service
  // account to the service instead (Security tab); ADC resolves it via the metadata server.
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credsPath && !fs.existsSync(credsPath)) {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS is set to "${credsPath}" but that file doesn't exist here. ` +
      `If this is Cloud Run: don't set this var there — delete it from Variables & Secrets and instead ` +
      `attach the service account directly (Security tab). See docs/GCP_SETUP.md Step 11.`
    );
  }

  const projectId = getConfiguredProjectId();
  const location = process.env.GCP_LOCATION || "us-central1";

  aiClient = new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location,
    apiVersion: 'v1',
    httpOptions: {
      headers: {
        'User-Agent': 'pawstories-gcp',
      }
    }
  });

  return aiClient;
}

// --- Firebase Admin: server-side auth verification + quota enforcement -----
// The Vertex AI project (GCP_PROJECT_ID) and the Firebase project (Auth/Firestore)
// are DIFFERENT GCP projects in this app. Token verification works with the
// existing Vertex service account (verifyIdToken only checks the JWT signature
// against Google's public certs + the configured projectId — it doesn't need
// project-specific IAM). Firestore admin reads/writes DO need real IAM on the
// Firebase project, so they use a dedicated credential if one is provided, and
// fail loudly (not silently) if quota can't be verified — see .env.example.
let adminApp: import('firebase-admin/app').App | null = null;

function getFirebaseAdmin() {
  if (adminApp) return adminApp;

  const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
  if (!firebaseProjectId) {
    throw new Error("FIREBASE_PROJECT_ID is not configured. Set it to your Firebase project ID (e.g. pawstories-fun) in .env.");
  }

  const dedicatedKeyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (dedicatedKeyPath && !fs.existsSync(dedicatedKeyPath)) {
    // The #1 way this breaks in production: FIREBASE_SERVICE_ACCOUNT_PATH gets copied
    // from a local .env into Cloud Run's runtime env vars, but the key file itself is
    // (rightly) gitignored, so it never made it into the deployed container. On Cloud
    // Run, don't set this var at all — remove it and attach the service account to the
    // service directly (Security tab); applicationDefault() then resolves it via the
    // metadata server with no key file needed. This var is for local dev only.
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT_PATH is set to "${dedicatedKeyPath}" but that file doesn't exist here. ` +
      `If this is Cloud Run: don't set this var there — delete it from Variables & Secrets and instead ` +
      `attach the service account directly (Security tab). See docs/GCP_SETUP.md Step 11.`
    );
  }
  const credential = dedicatedKeyPath
    ? admin.credential.cert(JSON.parse(fs.readFileSync(dedicatedKeyPath, 'utf-8')))
    : admin.credential.applicationDefault();

  adminApp = admin.initializeApp({ credential, projectId: firebaseProjectId }, 'pawstories-admin');
  return adminApp;
}

interface AuthedUser {
  uid: string;
  email: string;
  name: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function verifyAuth(req: express.Request): Promise<AuthedUser> {
  const header = req.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    throw new HttpError(401, 'SIGN IN REQUIRED: missing or malformed Authorization header.');
  }
  try {
    const decoded = await admin.auth(getFirebaseAdmin()).verifyIdToken(match[1]);
    return { uid: decoded.uid, email: (decoded.email || '').toLowerCase(), name: decoded.name || '' };
  } catch (err) {
    throw new HttpError(401, 'SIGN IN REQUIRED: your session is invalid or expired. Please sign in again.');
  }
}

const FREE_GENERATIONS_PER_MONTH = 3;

function getTestAccountEmails(): string[] {
  return (process.env.VITE_TEST_ACCOUNT_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Authoritative quota check + increment, run server-side inside a Firestore
// transaction so a client can no longer bypass the 3-generation/month limit by
// calling the API directly or writing to Firestore itself (generationCount /
// lastGenerationMonth are no longer client-writable — see firestore.rules).
async function checkAndIncrementQuota(user: AuthedUser): Promise<{ generationCount: number; isTestAccount: boolean }> {
  let db;
  try {
    db = admin.firestore(getFirebaseAdmin());
  } catch (err: any) {
    throw new HttpError(500, `Quota enforcement is not configured on the server: ${err.message}`);
  }

  const userRef = db.collection('users').doc(user.uid);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const isTestAccount = getTestAccountEmails().includes(user.email);

  try {
    const generationCount = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : null;
      const monthMatches = data?.lastGenerationMonth === currentMonth;
      const currentCount = monthMatches ? (data?.generationCount || 0) : 0;

      if (!isTestAccount && currentCount >= FREE_GENERATIONS_PER_MONTH) {
        throw new HttpError(429, 'PAW LIMIT REACHED: You can only generate up to 3 spy files this month. Request extra quota below!');
      }

      const newCount = currentCount + 1;
      tx.set(userRef, {
        email: user.email,
        displayName: user.name || 'Anonymous Agent',
        generationCount: newCount,
        lastGenerationMonth: currentMonth,
        ...(data ? {} : { requestStatus: 'none', requestedAmount: 0 })
      }, { merge: true });

      return newCount;
    });

    return { generationCount, isTestAccount };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `Quota enforcement failed: ${(err as any)?.message || 'unknown error'}. If this is a fresh deploy, the server's credentials may lack Firestore access on the Firebase project — see FIREBASE_SERVICE_ACCOUNT_PATH in .env.example.`);
  }
}

// Cheap guard for the (quota-free) image-gen endpoint: require the caller to have
// at least one real generation on record, so it can't be hit standalone by an
// authenticated-but-otherwise-arbitrary caller with no completed dossier.
async function requireHasGenerated(user: AuthedUser): Promise<void> {
  if (getTestAccountEmails().includes(user.email)) return;
  let db;
  try {
    db = admin.firestore(getFirebaseAdmin());
  } catch (err: any) {
    throw new HttpError(500, `Server Firestore access is not configured: ${err.message}`);
  }
  const snap = await db.collection('users').doc(user.uid).get();
  const count = snap.exists ? (snap.data()?.generationCount || 0) : 0;
  if (count < 1) {
    throw new HttpError(403, 'Generate your dossier first before requesting a spy portrait.');
  }
}

function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function verifyAdmin(req: express.Request): Promise<AuthedUser> {
  const user = await verifyAuth(req);
  if (!getAdminEmails().includes(user.email)) {
    throw new HttpError(403, 'Admin access required.');
  }
  return user;
}

// --- Analytics: generation events + daily rollups --------------------------
// Written server-side only (Admin SDK bypasses firestore.rules; clients never
// get direct read/write access to these collections — see firestore.rules).
// `generations` is the per-attempt log; `stats_daily/{YYYY-MM-DD}` is a rollup
// updated via atomic increments in the same batch, so the admin dashboard can
// read a handful of daily docs instead of scanning every event.
type GenerationOutcome = 'success' | 'rejected' | 'error';

async function recordGenerationEvent(params: {
  user: AuthedUser;
  type: 'analyze' | 'image';
  outcome: GenerationOutcome;
  model?: string;
  tokens?: { prompt: number; candidates: number; total: number };
  estimatedUsd?: number;
  latencyMs: number;
  errorReason?: string;
  language?: string;
}) {
  try {
    const db = admin.firestore(getFirebaseAdmin());
    const { user, type, outcome, model, tokens, estimatedUsd, latencyMs, errorReason, language } = params;
    const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const eventRef = db.collection('generations').doc();
    const dailyRef = db.collection('stats_daily').doc(dateKey);
    const outcomeSuffix = outcome === 'success' ? 'Success' : outcome === 'rejected' ? 'Rejected' : 'Error';

    const dailyIncrements: Record<string, FirebaseFirestore.FieldValue> = {
      [`${type}${outcomeSuffix}`]: admin.firestore.FieldValue.increment(1),
    };
    if (tokens?.total) dailyIncrements[`${type}Tokens`] = admin.firestore.FieldValue.increment(tokens.total);
    if (estimatedUsd) dailyIncrements[`${type}CostUsd`] = admin.firestore.FieldValue.increment(estimatedUsd);

    const batch = db.batch();
    batch.set(eventRef, {
      uid: user.uid,
      email: user.email,
      type,
      outcome,
      model: model || null,
      promptTokens: tokens?.prompt || 0,
      candidatesTokens: tokens?.candidates || 0,
      totalTokens: tokens?.total || 0,
      estimatedUsd: estimatedUsd || 0,
      latencyMs,
      errorReason: errorReason || null,
      language: language || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(dailyRef, dailyIncrements, { merge: true });
    await batch.commit();
  } catch (err: any) {
    // Analytics must never break the user-facing flow — log and move on.
    log("warn", "analytics.write_failed", { message: (err?.message || '').slice(0, 200) });
  }
}

// Best-effort classification of the analyze model's raw text, purely for
// analytics — mirrors the client's own parsing but never affects the response
// sent to the client, only which bucket this attempt is recorded under.
function classifyAnalysisOutcome(rawText: string): { outcome: GenerationOutcome; errorReason?: string } {
  try {
    const cleanText = rawText.replace(/```json\n?|```/g, '').trim();
    const parsed = JSON.parse(cleanText);
    if (parsed && parsed.errorType === 'HUMAN_OR_INVALID') {
      return { outcome: 'rejected' };
    }
    return { outcome: 'success' };
  } catch {
    return { outcome: 'error', errorReason: 'unparseable_json' };
  }
}

// Simple in-memory per-user cooldown to stop /api/notify-creator being spammed.
// Per-instance only (fine for this — it's a soft abuse guard, not a hard limit).
const notifyCooldown = new Map<string, number>();
const NOTIFY_COOLDOWN_MS = 60_000;

function checkNotifyCooldown(uid: string) {
  const last = notifyCooldown.get(uid);
  const now = Date.now();
  if (last && now - last < NOTIFY_COOLDOWN_MS) {
    throw new HttpError(429, 'Please wait a moment before requesting again.');
  }
  notifyCooldown.set(uid, now);
}

const responseCache = new Map<string, { expiresAt: number; response: any }>();

function getCacheKey(kind: string, payload: string, prompt: string) {
  return `${kind}:${createHash('sha256').update(`${payload}:${prompt}`).digest('hex')}`;
}

function getCachedResponse(cacheKey: string) {
  const cached = responseCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    responseCache.delete(cacheKey);
    return null;
  }
  return cached.response;
}

function setCachedResponse(cacheKey: string, response: any) {
  responseCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, response });
  if (responseCache.size > 200) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) responseCache.delete(oldestKey);
  }
}

function parseCostRate(envName: string, fallback: number) {
  const raw = process.env[envName];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getCostConfig(kind: 'analyze' | 'image') {
  // NOTE: defaults below are approximate USD list prices per 1M tokens as of
  // early 2026 and exist only for rough cost logging. Override via env to match
  // your actual model + billing plan. Image *output* is by far the dominant cost.
  if (kind === 'image') {
    return {
      inputPerMillion: parseCostRate('GEMINI_IMAGE_INPUT_COST_PER_1M_TOKENS', 0.30),
      outputPerMillion: parseCostRate('GEMINI_IMAGE_OUTPUT_COST_PER_1M_TOKENS', 30.0),
      currency: 'USD'
    };
  }

  return {
    inputPerMillion: parseCostRate('GEMINI_ANALYZE_INPUT_COST_PER_1M_TOKENS', 0.10),
    outputPerMillion: parseCostRate('GEMINI_ANALYZE_OUTPUT_COST_PER_1M_TOKENS', 0.40),
    currency: 'USD'
  };
}

function estimateGenerationCost(usageMetadata: any, kind: 'analyze' | 'image') {
  const meta = usageMetadata || {};
  const promptTokens = Number(meta.promptTokenCount || 0);
  const candidateTokens = Number(meta.candidatesTokenCount || 0);
  const totalTokens = Number(meta.totalTokenCount || promptTokens + candidateTokens);
  const config = getCostConfig(kind);
  const inputCostUsd = (promptTokens / 1_000_000) * config.inputPerMillion;
  const outputCostUsd = (candidateTokens / 1_000_000) * config.outputPerMillion;
  const estimatedUsd = inputCostUsd + outputCostUsd;

  return {
    promptTokens,
    candidatesTokens: candidateTokens,
    totalTokens,
    estimatedUsd,
    estimatedUsdFormatted: estimatedUsd.toFixed(6),
    currency: config.currency,
    inputRatePerMillion: config.inputPerMillion,
    outputRatePerMillion: config.outputPerMillion
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimited(error: any) {
  const status = error?.status ?? error?.code;
  const message = error?.message || '';
  return status === 429 || /RESOURCE_EXHAUSTED|resource exhausted|\b429\b/i.test(message);
}

async function runWithModelFallback(
  ai: any,
  kind: 'analyze' | 'image',
  request: any,
  reqId: string
): Promise<{ response: any; model: string }> {
  const candidates = kind === 'analyze' ? getAnalyzeModelCandidates() : getImageModelCandidates();
  const MAX_RETRIES = 2; // per-model retries for transient 429s
  let lastError: any = null;

  for (const model of candidates) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const startedAt = Date.now();
      try {
        log("debug", "model.attempt", { reqId, kind, model, attempt });
        const response = await ai.models.generateContent({ ...request, model });
        log("info", "model.success", { reqId, kind, model, attempt, latencyMs: Date.now() - startedAt });
        return { response, model };
      } catch (error: any) {
        lastError = error;
        const message = error?.message || '';
        const isModelMissing = /not found|does not have access|404|NOT_FOUND/i.test(message);
        if (isModelMissing) {
          log("warn", "model.unavailable", { reqId, kind, model });
          break; // move on to the next candidate model
        }
        // 429 / RESOURCE_EXHAUSTED is usually transient (dynamic shared quota) — back off and retry.
        if (isRateLimited(error) && attempt < MAX_RETRIES) {
          const backoffMs = 800 * Math.pow(2, attempt); // 800ms, then 1600ms
          log("warn", "model.rate_limited", { reqId, kind, model, attempt, backoffMs, latencyMs: Date.now() - startedAt });
          await sleep(backoffMs);
          continue;
        }
        log("error", "model.error", {
          reqId, kind, model, attempt,
          status: error?.status ?? error?.code,
          latencyMs: Date.now() - startedAt,
          message: message.slice(0, 300),
        });
        throw error; // non-retriable, or retries exhausted
      }
    }
  }

  throw lastError || new Error(`No supported ${kind} model was available.`);
}

function ensureValidImagePayload(base64Data: string, mimeType?: string) {
  if (typeof base64Data !== 'string' || base64Data.length < 32) {
    throw new Error('Invalid image data. Please try another photo.');
  }
  if (Buffer.byteLength(base64Data, 'base64') > MAX_INPUT_BYTES) {
    throw new Error('Image payload is too large. Please use a smaller photo.');
  }
  if (!mimeType || typeof mimeType !== 'string') {
    return 'image/jpeg';
  }
  const normalizedMimeType = mimeType.toLowerCase().trim();
  if (!normalizedMimeType.startsWith('image/')) {
    throw new Error('NOT A PHOTO: Please upload an image of your pet.');
  }
  return normalizedMimeType;
}

function extractTextFromResponse(response: any): string | null {
  if (!response) return null;

  const directText = typeof response.text === 'string' ? response.text : null;
  if (directText && directText.trim()) return directText;

  const nestedText = typeof response?.response?.text === 'string' ? response.response.text : null;
  if (nestedText && nestedText.trim()) return nestedText;

  const candidates = response.candidates || response?.response?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || candidate?.parts || [];
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        return part.text;
      }
    }
  }

  return null;
}

function extractImageFromResponse(response: any): string | null {
  if (!response) return null;

  const candidates = response.candidates || response?.response?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || candidate?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  }

  return null;
}

app.post("/api/analyze-pet", async (req, res) => {
  const reqId = randomUUID();
  const startedAt = Date.now();
  let authedUser: AuthedUser | undefined;
  let quota: { generationCount: number; isTestAccount: boolean } | undefined;
  try {
    authedUser = await verifyAuth(req);
    log("info", "analyze.authed", { reqId, uid: authedUser.uid });

    // Authoritative, server-side quota check + increment — the dossier IS the
    // billable generation. This runs BEFORE the Gemini call so a caller over
    // quota never triggers paid AI usage in the first place.
    quota = await checkAndIncrementQuota(authedUser);
    log("info", "analyze.quota", { reqId, uid: authedUser.uid, generationCount: quota.generationCount, isTestAccount: quota.isTestAccount });

    const { base64Data, mimeType, analysisPrompt, language } = req.body;
    const normalizedMimeType = ensureValidImagePayload(base64Data, mimeType);
    const inputBytes = Buffer.byteLength(base64Data, 'base64');
    const normalizedAnalysisPrompt = typeof analysisPrompt === 'string' && analysisPrompt.trim()
      ? analysisPrompt
      : `You are a strict pet-photo moderator and satirical spy analyst.
STEP 1 — SAFETY CHECK (do this before anything else, it overrides every other instruction): look at the image and decide whether its MAIN SUBJECT is a real animal/pet (dog, cat, bird, hamster, rabbit, reptile, fish, horse, guinea pig, ferret, turtle, lizard, farm animal, or other household pet) or not. Return the rejection below if the main subject is a human being — a selfie, a portrait, a person's face or body, a group photo of people — or if there is no clear animal subject at all. A human hand, arm, leg, or person incidentally holding, petting, or standing near the animal is fine and still counts as valid, AS LONG AS an animal is the clear main subject of the photo. If the image fails this check, respond with EXACTLY this JSON and nothing else: {"errorType":"HUMAN_OR_INVALID"}
STEP 2 — Only if STEP 1 passed, return only one compact JSON object in "${typeof language === 'string' && language ? language : 'English'}" with exactly these 10 keys: identity, codeId, vibe, opHub, desc, talent, nemesis, zoomies, heist, imagePrompt. Use short values. desc must be one short sentence under 110 chars. imagePrompt must be a vivid one-sentence English description of THIS pet dressed as a secret agent — name a specific spy costume, a signature prop/gadget, and a themed scene that matches opHub.
Never skip STEP 1. Do not add comments, markdown, or extra text.`;
    log("info", "analyze.received", { reqId, mimeType: normalizedMimeType, inputBytes, promptChars: normalizedAnalysisPrompt.length });

    const cacheKey = getCacheKey('analyze', base64Data, normalizedAnalysisPrompt);
    const cachedResponse = getCachedResponse(cacheKey);
    if (cachedResponse) {
      log("info", "analyze.cache_hit", { reqId, latencyMs: Date.now() - startedAt });
      const { outcome } = classifyAnalysisOutcome(cachedResponse.text || '');
      await recordGenerationEvent({
        user: authedUser, type: 'analyze', outcome, language,
        tokens: cachedResponse.costEstimate ? {
          prompt: cachedResponse.costEstimate.promptTokens,
          candidates: cachedResponse.costEstimate.candidatesTokens,
          total: cachedResponse.costEstimate.totalTokens,
        } : undefined,
        estimatedUsd: cachedResponse.costEstimate?.estimatedUsd,
        latencyMs: Date.now() - startedAt,
      });
      // quota is per-request truth, never cached — a cache hit still charges
      // THIS caller's quota (done above) and must report THEIR fresh count,
      // not whoever's count happened to populate the cache entry.
      return res.json({ ...cachedResponse, quota });
    }
    log("debug", "analyze.cache_miss", { reqId });

    const ai = getGeminiClient();

    const { response: analysisResponse, model } = await Promise.race([
      runWithModelFallback(ai, 'analyze', {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { data: base64Data, mimeType: normalizedMimeType } },
              { text: normalizedAnalysisPrompt }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          // Gemini 2.5's internal "thinking" tokens draw from the SAME budget as
          // maxOutputTokens. This is a simple classify-and-fill-JSON task with no
          // need for multi-step reasoning, so thinking is disabled outright —
          // otherwise it can silently eat the whole budget and truncate the JSON
          // mid-field (seen in prod: 488 thinking tokens vs 8 answer tokens).
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 768, // headroom for the 10-key JSON across non-English scripts
          temperature: 0.2,
        }
      }, reqId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ANALYZE_TIMEOUT_MS))
    ]);

    const parsedText = extractTextFromResponse(analysisResponse);
    if (!parsedText) {
      // Full raw model response is logged server-side only — it's diagnostic detail,
      // not something the client needs (or should receive) in the error body.
      const rawPayload = JSON.stringify(analysisResponse, null, 2).slice(0, 8000);
      log("error", "analyze.empty_response", { reqId, model, latencyMs: Date.now() - startedAt, rawResponse: rawPayload.slice(0, 500) });
      await recordGenerationEvent({
        user: authedUser, type: 'analyze', outcome: 'error', model, language,
        errorReason: 'empty_response', latencyMs: Date.now() - startedAt,
      });
      return res.status(500).json({
        error: 'Analysis response was empty or not parseable.'
      });
    }

    const usageMetadata = analysisResponse.usageMetadata || analysisResponse?.response?.usageMetadata || null;
    const costEstimate = estimateGenerationCost(usageMetadata, 'analyze');
    log("info", "analyze.done", {
      reqId, model, latencyMs: Date.now() - startedAt,
      promptTokens: costEstimate.promptTokens,
      candidatesTokens: costEstimate.candidatesTokens,
      totalTokens: costEstimate.totalTokens,
      estimatedUsd: costEstimate.estimatedUsdFormatted,
    });

    const { outcome, errorReason } = classifyAnalysisOutcome(parsedText);
    await recordGenerationEvent({
      user: authedUser, type: 'analyze', outcome, model, language, errorReason,
      tokens: { prompt: costEstimate.promptTokens, candidates: costEstimate.candidatesTokens, total: costEstimate.totalTokens },
      estimatedUsd: costEstimate.estimatedUsd,
      latencyMs: Date.now() - startedAt,
    });

    const payload = {
      text: parsedText,
      usageMetadata,
      costEstimate
    };
    setCachedResponse(cacheKey, payload);
    res.json({ ...payload, quota });
  } catch (error: any) {
    const isTimeout = error?.message === 'TIMEOUT';
    const httpStatus = error instanceof HttpError ? error.status : 500;
    log("error", "analyze.failed", {
      reqId, latencyMs: Date.now() - startedAt,
      httpStatus,
      status: error?.status ?? error?.code,
      timeout: isTimeout,
      message: (error?.message || 'Analysis failed').slice(0, 300),
    });
    // Only record as a generation attempt if quota was actually charged (i.e. auth
    // and quota checks passed) — a bare 401/429 never became a real attempt.
    if (authedUser && quota) {
      await recordGenerationEvent({
        user: authedUser, type: 'analyze', outcome: 'error',
        errorReason: isTimeout ? 'timeout' : (error?.message || 'unknown').slice(0, 100),
        latencyMs: Date.now() - startedAt,
      });
    }
    res.status(httpStatus).json({ error: error.message || 'Analysis failed' });
  }
});

app.post("/api/generate-pet-image", async (req, res) => {
  const reqId = randomUUID();
  const startedAt = Date.now();
  let authedUser: AuthedUser | undefined;
  try {
    authedUser = await verifyAuth(req);
    // Not quota-metered (the dossier already charged quota), but still gated to
    // signed-in users who've completed at least one real generation — stops this
    // endpoint being hit standalone by an authenticated-but-arbitrary caller.
    await requireHasGenerated(authedUser);
    log("info", "image.authed", { reqId, uid: authedUser.uid });

    const { base64Data, mimeType, imagePrompt } = req.body;
    const normalizedMimeType = ensureValidImagePayload(base64Data, mimeType);
    const inputBytes = Buffer.byteLength(base64Data, 'base64');
    log("info", "image.received", { reqId, mimeType: normalizedMimeType, inputBytes, promptChars: (imagePrompt || '').length });

    const cacheKey = getCacheKey('image', base64Data, imagePrompt || '');
    const cachedResponse = getCachedResponse(cacheKey);
    if (cachedResponse) {
      log("info", "image.cache_hit", { reqId, latencyMs: Date.now() - startedAt });
      await recordGenerationEvent({
        user: authedUser, type: 'image', outcome: cachedResponse.image ? 'success' : 'error',
        tokens: cachedResponse.costEstimate ? {
          prompt: cachedResponse.costEstimate.promptTokens,
          candidates: cachedResponse.costEstimate.candidatesTokens,
          total: cachedResponse.costEstimate.totalTokens,
        } : undefined,
        estimatedUsd: cachedResponse.costEstimate?.estimatedUsd,
        latencyMs: Date.now() - startedAt,
      });
      return res.json(cachedResponse);
    }
    log("debug", "image.cache_miss", { reqId });

    const ai = getGeminiClient();

    const { response: imageResponse, model } = await Promise.race([
      runWithModelFallback(ai, 'image', {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { data: base64Data, mimeType: normalizedMimeType } },
              { text: imagePrompt }
            ]
          }
        ],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '1:1' },
          maxOutputTokens: 2048,
          // Higher temperature lets the image model actually transform the pet
          // into an in-character spy instead of returning the input photo unchanged.
          temperature: 0.95,
          topP: 0.95,
        }
      }, reqId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), IMAGE_TIMEOUT_MS))
    ]);

    const finalGenImage = extractImageFromResponse(imageResponse);
    if (!finalGenImage) {
      log("warn", "image.no_image_in_response", { reqId, model, latencyMs: Date.now() - startedAt });
    }

    const usageMetadata = (imageResponse as any).usageMetadata || (imageResponse as any)?.response?.usageMetadata || null;
    const costEstimate = estimateGenerationCost(usageMetadata, 'image');
    log("info", "image.done", {
      reqId, model, latencyMs: Date.now() - startedAt,
      hasImage: !!finalGenImage,
      promptTokens: costEstimate.promptTokens,
      candidatesTokens: costEstimate.candidatesTokens,
      totalTokens: costEstimate.totalTokens,
      estimatedUsd: costEstimate.estimatedUsdFormatted,
    });

    await recordGenerationEvent({
      user: authedUser, type: 'image', outcome: finalGenImage ? 'success' : 'error', model,
      errorReason: finalGenImage ? undefined : 'no_image_in_response',
      tokens: { prompt: costEstimate.promptTokens, candidates: costEstimate.candidatesTokens, total: costEstimate.totalTokens },
      estimatedUsd: costEstimate.estimatedUsd,
      latencyMs: Date.now() - startedAt,
    });

    const payload = {
      image: finalGenImage,
      usageMetadata,
      costEstimate
    };
    setCachedResponse(cacheKey, payload);
    res.json(payload);
  } catch (error: any) {
    const isTimeout = error?.message === 'TIMEOUT';
    const httpStatus = error instanceof HttpError ? error.status : 500;
    log("error", "image.failed", {
      reqId, latencyMs: Date.now() - startedAt,
      httpStatus,
      status: error?.status ?? error?.code,
      timeout: isTimeout,
      message: (error?.message || 'Image generation failed').slice(0, 300),
    });
    // Only auth/requireHasGenerated failures short-circuit before this point;
    // record everything past that as a real (failed) attempt.
    if (authedUser && !(error instanceof HttpError)) {
      await recordGenerationEvent({
        user: authedUser, type: 'image', outcome: 'error',
        errorReason: isTimeout ? 'timeout' : (error?.message || 'unknown').slice(0, 100),
        latencyMs: Date.now() - startedAt,
      });
    }
    res.status(httpStatus).json({ error: error.message || 'Image generation failed' });
  }
});


// API routes first
app.post("/api/notify-creator", async (req, res) => {
  const reqId = randomUUID();
  const { userId, email, displayName, requestedAmount } = req.body;

  let authedUser: AuthedUser;
  try {
    authedUser = await verifyAuth(req);
    // Require the claimed identity in the body to match the verified token —
    // otherwise any signed-in user could submit requests impersonating another uid/email.
    if (userId !== authedUser.uid || (email || '').toLowerCase() !== authedUser.email) {
      throw new HttpError(403, 'Request identity does not match the authenticated session.');
    }
    checkNotifyCooldown(authedUser.uid);
  } catch (error: any) {
    const httpStatus = error instanceof HttpError ? error.status : 401;
    log("warn", "notify.rejected", { reqId, httpStatus, message: (error?.message || '').slice(0, 200) });
    return res.status(httpStatus).json({ error: error.message || 'Request could not be authenticated.' });
  }

  // No hardcoded fallback recipient — a quota-notification email silently going to
  // a specific person's inbox by default (rather than failing loudly) is exactly
  // the kind of hardcoded-credential smell we don't want shipping to another deploy.
  const recipient = process.env.CREATOR_EMAIL;
  if (!recipient) {
    log("error", "notify.misconfigured", { reqId, reason: "CREATOR_EMAIL not set" });
    return res.status(500).json({ error: "Notification recipient is not configured on the server." });
  }
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || "587");
  const smtpSecure = process.env.SMTP_SECURE === "true";

  log("info", "notify.received", { reqId, userId, email, requestedAmount });

  const emailSubject = `🐾 pawstories.fun Quota Request from ${displayName || email}`;
  const emailBodyText = `Hi Pawstories Creator,\n\nAn agent limit has been reached! A user of pawstories.fun has requested a quota upgrade:\n\n` + 
    `• User UID: ${userId}\n` +
    `• Account Email: ${email}\n` +
    `• Agent Name: ${displayName || 'Unknown'}\n` +
    `• Requested Extra Runs: ${requestedAmount || 5} Runs\n\n` +
    `Please log in to your Firestore console to approve or apply changes!\n\n` +
    `Sent securely via pawstories.fun Undercover Bureau 🕵️‍♂️`;

  // Check if SMTP is configured
  if (smtpUser && smtpPass && smtpHost) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      await transporter.sendMail({
        from: `"Pawstories Bureau" <${smtpUser}>`,
        to: recipient,
        subject: emailSubject,
        text: emailBodyText,
      });

      log("info", "notify.smtp_sent", { reqId, recipient });
      return res.status(200).json({ success: true, method: "smtp" });
    } catch (smtpError: any) {
      log("error", "notify.smtp_failed", { reqId, recipient, message: (smtpError?.message || '').slice(0, 300) });
      // Fallback: request will be recorded in firestore and logged to stdout, so return 200 with fallback status
      return res.status(200).json({
        success: true,
        method: "fallback",
        warning: "SMTP failed but requester logged to terminal stdout",
        error: smtpError.message
      });
    }
  } else {
    // No SMTP configured — the request is still persisted in Firestore by the client.
    log("warn", "notify.smtp_unconfigured", { reqId, recipient, subject: emailSubject });
    log("debug", "notify.payload", { reqId, body: emailBodyText });

    return res.status(200).json({
      success: true,
      method: "logged",
      warning: "SMTP not configured. Request logged securely on backend server node."
    });
  }
});

function dateKeysForWindow(days: number): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

app.get("/api/admin/dashboard", async (req, res) => {
  const reqId = randomUUID();
  try {
    const admin_ = await verifyAdmin(req);
    log("info", "admin.dashboard.request", { reqId, uid: admin_.uid });

    const windowDays = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const db = admin.firestore(getFirebaseAdmin());
    const dayKeys = dateKeysForWindow(windowDays);
    const todayKey = dayKeys[dayKeys.length - 1];

    // Daily rollups for the trend window — one batched read, not one per collection scan.
    const dailyRefs = dayKeys.map((d) => db.collection('stats_daily').doc(d));
    const dailySnaps = await db.getAll(...dailyRefs);
    const daily = dailySnaps.map((snap, i) => ({ date: dayKeys[i], ...(snap.exists ? snap.data() : {}) })) as any[];

    // Active users in the window: distinct uids across generation events.
    // Bounded read (capped) — fine at this app's scale; see docs/GCP_SETUP.md context.
    const windowStart = new Date();
    windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
    const recentEvents = await db.collection('generations')
      .where('createdAt', '>=', windowStart)
      .limit(5000)
      .get();
    const activeUids = new Set<string>();
    recentEvents.forEach((doc) => activeUids.add(doc.data().uid));

    // Total + new users. New-user count only reflects users created after this
    // feature shipped (createdAt is a new field) — older accounts are simply
    // excluded from "new," not miscounted as old.
    const totalUsersSnap = await db.collection('users').count().get();
    let newUsersWindow = 0;
    try {
      const newUsersSnap = await db.collection('users').where('createdAt', '>=', windowStart).count().get();
      newUsersWindow = newUsersSnap.data().count;
    } catch {
      // createdAt index/field may not exist yet on a fresh deploy — non-fatal.
    }

    // Pending credit requests.
    const pendingReqSnap = await db.collection('requests').where('status', '==', 'pending').count().get();
    const recentRequestsSnap = await db.collection('requests').orderBy('createdAt', 'desc').limit(25).get();
    const creditRequests = recentRequestsSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        email: data.email,
        userId: data.userId,
        requestedQuantity: data.requestedQuantity,
        status: data.status || 'pending',
        createdAt: data.createdAt,
      };
    });

    // Window sums, straight off the daily rollups — no per-event scan needed.
    const sum = (field: string) => daily.reduce((acc, d) => acc + (Number(d[field]) || 0), 0);
    const analyzeSuccess = sum('analyzeSuccess');
    const analyzeRejected = sum('analyzeRejected');
    const analyzeError = sum('analyzeError');
    const imageSuccess = sum('imageSuccess');
    const imageError = sum('imageError');
    const analyzeAttempts = analyzeSuccess + analyzeRejected + analyzeError;
    const imageAttempts = imageSuccess + imageError;
    const totalCostUsd = sum('analyzeCostUsd') + sum('imageCostUsd');
    const todayRollup = daily.find((d) => d.date === todayKey) || {};
    const generationsToday = (todayRollup.analyzeSuccess || 0) + (todayRollup.analyzeRejected || 0) + (todayRollup.analyzeError || 0);

    res.json({
      windowDays,
      overview: {
        totalUsers: totalUsersSnap.data().count,
        newUsersWindow,
        activeUsersWindow: activeUids.size,
        generationsToday,
        generationsWindow: analyzeAttempts,
        successRateWindow: analyzeAttempts ? analyzeSuccess / analyzeAttempts : null,
        estimatedCostWindowUsd: totalCostUsd,
        portraitAttachRateWindow: analyzeSuccess ? Math.min(1, imageSuccess / analyzeSuccess) : null,
        pendingCreditRequests: pendingReqSnap.data().count,
      },
      trend: {
        days: dayKeys,
        analyzeSuccess: daily.map((d) => d.analyzeSuccess || 0),
        analyzeRejected: daily.map((d) => d.analyzeRejected || 0),
        analyzeError: daily.map((d) => d.analyzeError || 0),
        imageSuccess: daily.map((d) => d.imageSuccess || 0),
        imageError: daily.map((d) => d.imageError || 0),
        analyzeCostUsd: daily.map((d) => d.analyzeCostUsd || 0),
        imageCostUsd: daily.map((d) => d.imageCostUsd || 0),
        analyzeTokens: daily.map((d) => d.analyzeTokens || 0),
        imageTokens: daily.map((d) => d.imageTokens || 0),
      },
      reliability: {
        analyzeSuccess, analyzeRejected, analyzeError, analyzeAttempts,
        imageSuccess, imageError, imageAttempts,
      },
      creditRequests,
    });
  } catch (error: any) {
    const httpStatus = error instanceof HttpError ? error.status : 500;
    log("error", "admin.dashboard.failed", { reqId, httpStatus, message: (error?.message || '').slice(0, 300) });
    res.status(httpStatus).json({ error: error.message || 'Failed to load dashboard.' });
  }
});

// Start Vite middleware or static serving
async function bootstrap() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, () => {
    log("info", "server.listening", { port: PORT, mode: process.env.NODE_ENV || "development" });
  });
}

bootstrap();
