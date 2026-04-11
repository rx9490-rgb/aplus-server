/**
 * A+ Medical Platform — Standalone Server
 * يعمل على Render.com / Railway / Glitch / أي منصة
 * لا ينام طالما المنصة شغّالة
 */

import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pg from "pg";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── قاعدة البيانات ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const db = {
  async query(text, params) {
    const client = await pool.connect();
    try { return await client.query(text, params); }
    finally { client.release(); }
  }
};

// ── إنشاء الجداول تلقائياً ──────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      full_name TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      is_super_admin BOOLEAN DEFAULT FALSE,
      is_moderator BOOLEAN DEFAULT FALSE,
      permissions JSONB DEFAULT '{}',
      premium_expiry BIGINT DEFAULT 0,
      trial_counters JSONB DEFAULT '{}',
      points INTEGER DEFAULT 0,
      badges JSONB DEFAULT '[]',
      usage_count INTEGER DEFAULT 0,
      rank TEXT DEFAULT 'طالب ⭐',
      banned BOOLEAN DEFAULT FALSE,
      activation_code TEXT,
      deleted_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      type TEXT DEFAULT 'premium',
      duration_days INTEGER DEFAULT 30,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      used_by JSONB DEFAULT '[]',
      active BOOLEAN DEFAULT TRUE,
      created_at BIGINT,
      expires_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS ads (
      ad_id TEXT PRIMARY KEY,
      title TEXT,
      ad_text TEXT,
      type TEXT DEFAULT 'text',
      image_data TEXT,
      video_url TEXT,
      link TEXT,
      active BOOLEAN DEFAULT TRUE,
      start_delay INTEGER DEFAULT 180,
      interval_sec INTEGER DEFAULT 600,
      auto_dismiss INTEGER,
      start_time TEXT,
      end_time TEXT,
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS feedback (
      feedback_id TEXT PRIMARY KEY,
      user_email TEXT,
      user_name TEXT,
      message TEXT,
      type TEXT DEFAULT 'general',
      rating INTEGER,
      created_at BIGINT,
      read BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_email TEXT PRIMARY KEY,
      settings JSONB DEFAULT '{}',
      updated_at BIGINT DEFAULT 0
    );
  `);

  // seed admin
  const ADMIN_EMAIL = "tx.9490@gmail.com";
  const ADMIN_PASS = "Aa0010@@";
  const existing = await db.query("SELECT email FROM users WHERE email=$1", [ADMIN_EMAIL]);
  if (existing.rows.length === 0) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(ADMIN_PASS, salt, 64).toString("hex");
    const passwordHash = `${salt}:${hash}`;
    await db.query(`
      INSERT INTO users (email, full_name, password_hash, is_admin, is_super_admin, is_moderator)
      VALUES ($1, $2, $3, TRUE, TRUE, TRUE)
    `, [ADMIN_EMAIL, "المدير الرئيسي", passwordHash]);
    console.log("✅ Admin account created");
  }
}

// ── مساعدات ─────────────────────────────────────────────────
const ADMIN_KEY = "APLUS9490";

function checkAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.adminKey;
  return key === ADMIN_KEY;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, "hex");
  const supplied = scryptSync(password, salt, 64);
  if (hashBuf.length !== supplied.length) return false;
  return timingSafeEqual(hashBuf, supplied);
}

function generateToken() {
  return randomBytes(32).toString("hex");
}

async function getSessionUser(token) {
  if (!token) return null;
  const s = await db.query("SELECT user_id FROM sessions WHERE token=$1", [token]);
  if (!s.rows.length) return null;
  const u = await db.query("SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL", [s.rows[0].user_id]);
  return u.rows[0] || null;
}

function formatUser(u) {
  return {
    email: u.email,
    fullName: u.full_name,
    isAdmin: u.is_admin,
    isSuperAdmin: u.is_super_admin,
    isModerator: u.is_moderator,
    permissions: u.permissions || {},
    premiumExpiry: u.premium_expiry || 0,
    trialCounters: u.trial_counters || {},
    points: u.points || 0,
    badges: u.badges || [],
    usageCount: u.usage_count || 0,
    rank: u.rank || "طالب ⭐",
    banned: u.banned || false,
  };
}

// ── SSE ─────────────────────────────────────────────────────
const sseClients = new Set();

function broadcastEvent(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// ── Express ──────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(compression({ level: 6, threshold: 1024 }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-session-token", "x-admin-key", "Accept", "Cache-Control"],
  exposedHeaders: ["x-session-token"],
  optionsSuccessStatus: 204,
}));
app.use(rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── Health ───────────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

// ── SSE ──────────────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ── Auth ─────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!email || !password) return res.json({ ok: false, msg: "البريد الإلكتروني وكلمة المرور مطلوبان" });
    const norm = email.toLowerCase().trim();
    if (password.length < 6) return res.json({ ok: false, msg: "كلمة المرور 6 أحرف على الأقل" });
    const ex = await db.query("SELECT email, deleted_at FROM users WHERE email=$1", [norm]);
    if (ex.rows.length > 0) {
      if (ex.rows[0].deleted_at) {
        await db.query("UPDATE users SET deleted_at=NULL, full_name=$1, password_hash=$2 WHERE email=$3",
          [fullName || ex.rows[0].full_name, hashPassword(password), norm]);
        return res.json({ ok: true, msg: "تم إعادة تفعيل حسابك", reactivated: true });
      }
      return res.json({ ok: false, msg: "البريد الإلكتروني مسجل مسبقاً" });
    }
    await db.query("INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3)",
      [norm, fullName || "", hashPassword(password)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, msg: "خطأ في الخادم" }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ ok: false, msg: "البريد الإلكتروني وكلمة المرور مطلوبان" });
    const norm = email.toLowerCase().trim();
    const rows = await db.query("SELECT * FROM users WHERE email=$1", [norm]);
    if (!rows.rows.length) return res.json({ ok: false, msg: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    const user = rows.rows[0];
    if (user.deleted_at) return res.json({ ok: false, msg: "هذا الحساب محذوف" });
    if (user.banned) return res.json({ ok: false, msg: "هذا الحساب محظور" });
    if (!verifyPassword(password, user.password_hash)) return res.json({ ok: false, msg: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    const token = generateToken();
    await db.query("INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)",
      [token, norm, Date.now()]);
    res.json({ ok: true, token, user: formatUser(user) });
  } catch (e) { res.status(500).json({ ok: false, msg: "خطأ في الخادم" }); }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user || user.banned) return res.json({ ok: false });
    res.json({ ok: true, user: formatUser(user) });
  } catch { res.json({ ok: false }); }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = req.headers["x-session-token"];
    if (token) await db.query("DELETE FROM sessions WHERE token=$1", [token]);
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.post("/api/auth/change-password", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false, msg: "غير مصرح" });
    const { currentPassword, newPassword } = req.body;
    if (!verifyPassword(currentPassword, user.password_hash)) return res.json({ ok: false, msg: "كلمة المرور الحالية غير صحيحة" });
    if (!newPassword || newPassword.length < 6) return res.json({ ok: false, msg: "كلمة المرور الجديدة قصيرة" });
    await db.query("UPDATE users SET password_hash=$1 WHERE email=$2", [hashPassword(newPassword), user.email]);
    res.json({ ok: true, msg: "تم تغيير كلمة المرور بنجاح" });
  } catch { res.status(500).json({ ok: false, msg: "خطأ في الخادم" }); }
});

// ── Codes ────────────────────────────────────────────────────
app.get("/api/codes/list", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const all = await db.query("SELECT * FROM codes");
    res.json(all.rows.map(c => ({
      id: c.id, code: c.code, type: c.type, durationDays: c.duration_days,
      maxUses: c.max_uses, usedCount: c.used_count, usedBy: c.used_by,
      active: c.active, createdAt: c.created_at, expiresAt: c.expires_at
    })));
  } catch { res.json([]); }
});

app.post("/api/codes/generate", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { count = 1, type = "premium", durationDays = 30, maxUses = 1, expiresAt } = req.body;
    const generated = [];
    for (let i = 0; i < Math.min(count, 100); i++) {
      const code = "APLUS-" + randomBytes(4).toString("hex").toUpperCase();
      const id = randomBytes(8).toString("hex");
      await db.query(`INSERT INTO codes (id, code, type, duration_days, max_uses, used_count, used_by, active, created_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,0,'[]',TRUE,$6,$7)`,
        [id, code, type, durationDays, maxUses, Date.now(), expiresAt || null]);
      generated.push(code);
    }
    broadcastEvent({ type: "codes_updated" });
    res.json({ ok: true, codes: generated });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.post("/api/codes/redeem", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false, msg: "يجب تسجيل الدخول" });
    const { code } = req.body;
    const rows = await db.query("SELECT * FROM codes WHERE code=$1", [code?.trim().toUpperCase()]);
    if (!rows.rows.length) return res.json({ ok: false, msg: "الكود غير صحيح" });
    const c = rows.rows[0];
    if (!c.active) return res.json({ ok: false, msg: "الكود غير مفعّل" });
    if (c.expires_at && c.expires_at < Date.now()) return res.json({ ok: false, msg: "الكود منتهي الصلاحية" });
    if (c.used_count >= c.max_uses) return res.json({ ok: false, msg: "الكود وصل الحد الأقصى" });
    const usedBy = c.used_by || [];
    if (usedBy.includes(user.email)) return res.json({ ok: false, msg: "استخدمت هذا الكود مسبقاً" });
    const newExpiry = Math.max(user.premium_expiry || 0, Date.now()) + c.duration_days * 86400000;
    const newUsed = [...usedBy, user.email];
    await db.query("UPDATE codes SET used_count=used_count+1, used_by=$1 WHERE id=$2", [JSON.stringify(newUsed), c.id]);
    await db.query("UPDATE users SET premium_expiry=$1, activation_code=$2 WHERE email=$3", [newExpiry, code, user.email]);
    broadcastEvent({ type: "subscription_updated", email: user.email });
    res.json({ ok: true, msg: "تم تفعيل الاشتراك بنجاح", premiumExpiry: newExpiry });
  } catch { res.status(500).json({ ok: false, msg: "خطأ في الخادم" }); }
});

app.delete("/api/codes/:id", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    await db.query("DELETE FROM codes WHERE id=$1", [req.params.id]);
    broadcastEvent({ type: "codes_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/codes/:id", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    if (req.body.active !== undefined) {
      await db.query("UPDATE codes SET active=$1 WHERE id=$2", [req.body.active, req.params.id]);
    }
    broadcastEvent({ type: "codes_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ── Ads ──────────────────────────────────────────────────────
app.get("/api/ads/list", async (_req, res) => {
  try {
    const all = await db.query("SELECT * FROM ads");
    res.json(all.rows.map(a => ({
      id: a.ad_id, title: a.title, text: a.ad_text, type: a.type,
      imageData: a.image_data, videoUrl: a.video_url, link: a.link,
      active: a.active, startDelay: a.start_delay, interval: a.interval_sec,
      autoDismiss: a.auto_dismiss, startTime: a.start_time, endTime: a.end_time
    })));
  } catch { res.json([]); }
});

app.post("/api/ads", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const b = req.body;
    const adId = b.id || randomBytes(8).toString("hex");
    const ex = await db.query("SELECT ad_id FROM ads WHERE ad_id=$1", [adId]);
    if (ex.rows.length > 0) {
      await db.query(`UPDATE ads SET title=$1,ad_text=$2,type=$3,image_data=$4,video_url=$5,link=$6,
        active=$7,start_delay=$8,interval_sec=$9,auto_dismiss=$10,start_time=$11,end_time=$12 WHERE ad_id=$13`,
        [b.title||null,b.text||null,b.type||"text",b.imageData||null,b.videoUrl||null,b.link||null,
         b.active!==false,b.startDelay||180,b.interval||600,b.autoDismiss||null,b.startTime||null,b.endTime||null,adId]);
    } else {
      await db.query(`INSERT INTO ads (ad_id,title,ad_text,type,image_data,video_url,link,active,start_delay,interval_sec,auto_dismiss,start_time,end_time,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [adId,b.title||null,b.text||null,b.type||"text",b.imageData||null,b.videoUrl||null,b.link||null,
         b.active!==false,b.startDelay||180,b.interval||600,b.autoDismiss||null,b.startTime||null,b.endTime||null,Date.now()]);
    }
    broadcastEvent({ type: "ads_updated" });
    res.json({ ok: true, id: adId });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.delete("/api/ads/:id", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    await db.query("DELETE FROM ads WHERE ad_id=$1", [req.params.id]);
    broadcastEvent({ type: "ads_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/ads/:id", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const updates = [];
    const vals = [];
    let i = 1;
    if (req.body.active !== undefined) { updates.push(`active=$${i++}`); vals.push(req.body.active); }
    if (req.body.title !== undefined) { updates.push(`title=$${i++}`); vals.push(req.body.title); }
    if (req.body.text !== undefined) { updates.push(`ad_text=$${i++}`); vals.push(req.body.text); }
    if (updates.length) {
      vals.push(req.params.id);
      await db.query(`UPDATE ads SET ${updates.join(",")} WHERE ad_id=$${i}`, vals);
    }
    broadcastEvent({ type: "ads_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ── Feedback ─────────────────────────────────────────────────
app.get("/api/feedback/list", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const all = await db.query("SELECT * FROM feedback ORDER BY created_at DESC");
    res.json(all.rows.map(f => ({
      id: f.feedback_id, userEmail: f.user_email, userName: f.user_name,
      message: f.message, type: f.type, rating: f.rating, createdAt: f.created_at, read: f.read
    })));
  } catch { res.json([]); }
});

app.post("/api/feedback", async (req, res) => {
  try {
    const { message, type, rating, userName, userEmail } = req.body;
    if (!message) return res.json({ ok: false, msg: "الرسالة مطلوبة" });
    const id = randomBytes(8).toString("hex");
    await db.query("INSERT INTO feedback (feedback_id,user_email,user_name,message,type,rating,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, userEmail||null, userName||null, message, type||"general", rating||null, Date.now()]);
    res.json({ ok: true });
  } catch { res.status(500).json({ ok: false }); }
});

app.patch("/api/feedback/:id/read", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    await db.query("UPDATE feedback SET read=TRUE WHERE feedback_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ ok: false }); }
});

app.delete("/api/feedback/:id", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    await db.query("DELETE FROM feedback WHERE feedback_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ ok: false }); }
});

// ── Settings ─────────────────────────────────────────────────
app.get("/api/settings", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const all = await db.query("SELECT * FROM settings");
    const result = {};
    for (const row of all.rows) result[row.key] = row.value;
    res.json(result);
  } catch { res.json({}); }
});

app.post("/api/settings", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { key, value } = req.body;
    await db.query("INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
      [key, JSON.stringify(value)]);
    broadcastEvent({ type: "settings_updated", key, value });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ── User Settings (per-user sync) ────────────────────────────
app.get("/api/user/settings", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false, settings: {} });
    const result = await db.query("SELECT settings FROM user_settings WHERE user_email=$1", [user.email]);
    const settings = result.rows.length > 0 ? result.rows[0].settings : {};
    res.json({ ok: true, settings });
  } catch { res.json({ ok: false, settings: {} }); }
});

app.post("/api/user/settings", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false });
    const { settings } = req.body;
    if (!settings || typeof settings !== "object") return res.json({ ok: false });
    const allowed = ["theme", "lang", "brightness", "groq_api_key_enc", "google_translate_key"];
    const filtered = {};
    for (const k of allowed) { if (settings[k] !== undefined) filtered[k] = settings[k]; }
    await db.query(
      "INSERT INTO user_settings (user_email, settings, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_email) DO UPDATE SET settings=user_settings.settings || $2::jsonb, updated_at=$3",
      [user.email, JSON.stringify(filtered), Date.now()]
    );
    res.json({ ok: true });
  } catch { res.status(500).json({ ok: false }); }
});

// ── Users ────────────────────────────────────────────────────
app.get("/api/users/list", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const all = await db.query("SELECT * FROM users WHERE deleted_at IS NULL");
    res.json(all.rows.map(u => ({
      email: u.email, fullName: u.full_name, isAdmin: u.is_admin,
      isSuperAdmin: u.is_super_admin, isModerator: u.is_moderator,
      permissions: u.permissions||{}, premiumExpiry: u.premium_expiry||0,
      trialCounters: u.trial_counters||{}, points: u.points||0,
      badges: u.badges||[], usageCount: u.usage_count||0, rank: u.rank,
      banned: u.banned, activationCode: u.activation_code
    })));
  } catch { res.json([]); }
});

app.patch("/api/users/:email/ban", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { banned } = req.body;
    await db.query("UPDATE users SET banned=$1 WHERE email=$2", [banned, req.params.email]);
    broadcastEvent({ type: "user_updated", email: req.params.email });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/users/:email/role", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { isAdmin, isModerator, isSuperAdmin } = req.body;
    const updates = [];
    const vals = [];
    let i = 1;
    if (isAdmin !== undefined) { updates.push(`is_admin=$${i++}`); vals.push(isAdmin); }
    if (isModerator !== undefined) { updates.push(`is_moderator=$${i++}`); vals.push(isModerator); }
    if (isSuperAdmin !== undefined) { updates.push(`is_super_admin=$${i++}`); vals.push(isSuperAdmin); }
    if (updates.length) {
      vals.push(req.params.email);
      await db.query(`UPDATE users SET ${updates.join(",")} WHERE email=$${i}`, vals);
    }
    broadcastEvent({ type: "user_updated", email: req.params.email });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.delete("/api/users/:email", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    await db.query("UPDATE users SET deleted_at=$1 WHERE email=$2", [Date.now(), req.params.email]);
    broadcastEvent({ type: "user_updated", email: req.params.email });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ── Subscriptions ────────────────────────────────────────────
app.get("/api/subscriptions/list", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const all = await db.query("SELECT email, premium_expiry, activation_code FROM users WHERE premium_expiry > 0");
    const subs = {};
    for (const u of all.rows) {
      subs[u.email] = { premiumExpiry: u.premium_expiry, activationCode: u.activation_code, active: u.premium_expiry > Date.now() };
    }
    res.json(subs);
  } catch { res.json({}); }
});

// ── Broadcast ────────────────────────────────────────────────
app.post("/api/broadcast", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { message, type } = req.body;
    broadcastEvent({ type: "broadcast", message, notifType: type || "info" });
    res.json({ ok: true, msg: "Broadcast sent" });
  } catch { res.status(500).json({ ok: false }); }
});

// ── Ping (keep-alive) ────────────────────────────────────────
app.get("/ping", (_req, res) => res.send("pong"));

// ── تحميل HTML ───────────────────────────────────────────────
app.get("/download-html", (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="aplus-medical.html"');
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── ملفات ثابتة + SPA fallback ───────────────────────────────
app.use(express.static(path.join(__dirname, "public"), { etag: true, lastModified: true }));
app.use((_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── تشغيل السيرفر ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ A+ Medical Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("❌ Database init failed:", err);
    process.exit(1);
  });
