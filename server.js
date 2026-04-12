/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   A+ Medical Platform — Ultra Server v5.0               ║
 * ║   بث مباشر حقيقي · لا ينام · صفر أعطال                 ║
 * ╚══════════════════════════════════════════════════════════╝
 * يعمل على: Render · Railway · Fly.io · Glitch · VPS
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

// ══════════════════════════════════════════════
// 1. قاعدة البيانات — Connection Pool محسّن
// ══════════════════════════════════════════════

// sleep أولاً قبل أي استخدام
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 20,                    // حتى 20 اتصال موازي
  idleTimeoutMillis: 60000,   // يُغلق الاتصال الخامل بعد دقيقة
  connectionTimeoutMillis: 8000,
  allowExitOnIdle: false,
});

pool.on("error", (err) => {
  console.error("❌ خطأ في pool قاعدة البيانات:", err.message);
});

// DB wrapper مع retry تلقائي — إغلاق الاتصال مرة واحدة فقط
const db = {
  async query(text, params, retries = 3) {
    let lastError;
    for (let i = 0; i < retries; i++) {
      const client = await pool.connect();
      try {
        const result = await client.query(text, params);
        client.release();      // نجح → أغلق مرة واحدة
        return result;
      } catch (e) {
        client.release(true);  // فشل → أغلق مع إشارة الخطأ (مرة واحدة فقط)
        lastError = e;
        if (i < retries - 1) await sleep(300 * (i + 1));
      }
    }
    throw lastError;
  }
};

// ══════════════════════════════════════════════
// 2. إنشاء الجداول تلقائياً مع أعمدة جديدة
// ══════════════════════════════════════════════
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      email             TEXT PRIMARY KEY,
      full_name         TEXT DEFAULT '',
      password_hash     TEXT NOT NULL,
      is_admin          BOOLEAN DEFAULT FALSE,
      is_super_admin    BOOLEAN DEFAULT FALSE,
      is_moderator      BOOLEAN DEFAULT FALSE,
      permissions       JSONB DEFAULT '{}',
      premium_expiry    BIGINT DEFAULT 0,
      trial_counters    JSONB DEFAULT '{}',
      points            INTEGER DEFAULT 0,
      badges            JSONB DEFAULT '[]',
      usage_count       INTEGER DEFAULT 0,
      rank              TEXT DEFAULT 'طالب ⭐',
      banned            BOOLEAN DEFAULT FALSE,
      activation_code   TEXT,
      deleted_at        BIGINT,
      created_at        BIGINT DEFAULT 0,
      last_seen         BIGINT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      last_used   BIGINT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS codes (
      id            TEXT PRIMARY KEY,
      code          TEXT UNIQUE NOT NULL,
      type          TEXT DEFAULT 'premium',
      duration_days INTEGER DEFAULT 30,
      max_uses      INTEGER DEFAULT 1,
      used_count    INTEGER DEFAULT 0,
      used_by       JSONB DEFAULT '[]',
      active        BOOLEAN DEFAULT TRUE,
      created_at    BIGINT,
      expires_at    BIGINT,
      label         TEXT
    );
    CREATE TABLE IF NOT EXISTS ads (
      ad_id        TEXT PRIMARY KEY,
      title        TEXT,
      ad_text      TEXT,
      type         TEXT DEFAULT 'text',
      image_data   TEXT,
      video_url    TEXT,
      link         TEXT,
      active       BOOLEAN DEFAULT TRUE,
      start_delay  INTEGER DEFAULT 180,
      interval_sec INTEGER DEFAULT 600,
      auto_dismiss INTEGER,
      start_time   TEXT,
      end_time     TEXT,
      created_at   BIGINT
    );
    CREATE TABLE IF NOT EXISTS feedback (
      feedback_id  TEXT PRIMARY KEY,
      user_email   TEXT,
      user_name    TEXT,
      message      TEXT,
      type         TEXT DEFAULT 'general',
      rating       INTEGER,
      created_at   BIGINT,
      read         BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value JSONB
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_email  TEXT PRIMARY KEY,
      settings    JSONB DEFAULT '{}',
      updated_at  BIGINT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      user_email TEXT,
      message    TEXT,
      type       TEXT DEFAULT 'info',
      read       BOOLEAN DEFAULT FALSE,
      created_at BIGINT
    );
  `);

  // أعمدة جديدة لم تكن موجودة — آمن للتشغيل أكثر من مرة
  const safeCols = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen BIGINT DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used BIGINT DEFAULT 0`,
    `ALTER TABLE codes ADD COLUMN IF NOT EXISTS label TEXT`,
  ];
  for (const sql of safeCols) {
    try { await db.query(sql); } catch {}
  }

  // إنشاء حساب الأدمن إذا لم يكن موجوداً
  const ADMIN_EMAIL = "tx.9490@gmail.com";
  const ADMIN_PASS  = "Aa0010@@";
  const ex = await db.query("SELECT email FROM users WHERE email=$1", [ADMIN_EMAIL]);
  if (!ex.rows.length) {
    await db.query(
      `INSERT INTO users (email, full_name, password_hash, is_admin, is_super_admin, is_moderator, created_at)
       VALUES ($1,$2,$3,TRUE,TRUE,TRUE,$4)`,
      [ADMIN_EMAIL, "المدير الرئيسي", hashPassword(ADMIN_PASS), Date.now()]
    );
    console.log("✅ حساب الأدمن أُنشئ");
  }
}

// ══════════════════════════════════════════════
// 3. مساعدات الأمان
// ══════════════════════════════════════════════
const ADMIN_KEY = "APLUS9490";

function checkAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.adminKey || req.body?.adminKey;
  return key === ADMIN_KEY;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const hashBuf = Buffer.from(hash, "hex");
    const supplied = scryptSync(password, salt, 64);
    return hashBuf.length === supplied.length && timingSafeEqual(hashBuf, supplied);
  } catch { return false; }
}

function generateToken() { return randomBytes(40).toString("hex"); }

// Cache بسيط للجلسات — يقلل queries
const sessionCache = new Map();
const SESSION_CACHE_TTL = 30_000; // 30 ثانية

async function getSessionUser(token) {
  if (!token) return null;
  const cached = sessionCache.get(token);
  if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL) return cached.user;
  const s = await db.query("SELECT user_id FROM sessions WHERE token=$1", [token]);
  if (!s.rows.length) { sessionCache.delete(token); return null; }
  const u = await db.query(
    "SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL", [s.rows[0].user_id]
  );
  const user = u.rows[0] || null;
  if (user) {
    sessionCache.set(token, { user, ts: Date.now() });
    // تحديث last_used بدون انتظار
    db.query("UPDATE sessions SET last_used=$1 WHERE token=$2", [Date.now(), token]).catch(() => {});
    db.query("UPDATE users SET last_seen=$1 WHERE email=$2", [Date.now(), user.email]).catch(() => {});
  }
  return user;
}

function invalidateSessionCache(email) {
  for (const [k, v] of sessionCache.entries()) {
    if (v.user?.email === email) sessionCache.delete(k);
  }
}

function formatUser(u) {
  return {
    email: u.email,
    fullName: u.full_name,
    isAdmin: u.is_admin,
    isSuperAdmin: u.is_super_admin,
    isModerator: u.is_moderator,
    permissions: u.permissions || {},
    premiumExpiry: Number(u.premium_expiry) || 0,
    trialCounters: u.trial_counters || {},
    points: u.points || 0,
    badges: u.badges || [],
    usageCount: u.usage_count || 0,
    rank: u.rank || "طالب ⭐",
    banned: u.banned || false,
    activationCode: u.activation_code || null,
    createdAt: u.created_at || 0,
    lastSeen: u.last_seen || 0,
  };
}

// ══════════════════════════════════════════════
// 4. SSE — البث المباشر الحقيقي
// ══════════════════════════════════════════════
const sseClients = new Map(); // id → res
let sseIdCounter = 0;

function broadcastEvent(data, targetEmail = null) {
  const eventType = data.type || "message";
  const payload   = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead = [];

  for (const [id, client] of sseClients) {
    // إذا كان الحدث مخصصاً لمستخدم معين → أرسل فقط لذلك المستخدم (تجاهل المجهولين)
    if (targetEmail && client._email !== targetEmail) continue;
    try {
      client.write(payload);
    } catch {
      dead.push(id);
    }
  }
  dead.forEach((id) => sseClients.delete(id));
}

// Heartbeat كل 20 ثانية — يمنع انتهاء مهلة الاتصال
setInterval(() => {
  const ping = `: ping ${Date.now()}\n\n`;
  const dead = [];
  for (const [id, client] of sseClients) {
    try { client.write(ping); } catch { dead.push(id); }
  }
  dead.forEach((id) => sseClients.delete(id));
}, 20_000);

// ══════════════════════════════════════════════
// 5. Express Setup
// ══════════════════════════════════════════════
const app = express();
app.set("trust proxy", 1);

app.use(compression({ level: 6, threshold: 512 }));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type","Authorization","x-session-token",
    "x-admin-key","Accept","Cache-Control","X-Requested-With"
  ],
  exposedHeaders: ["x-session-token"],
  optionsSuccessStatus: 204,
  credentials: true,
}));

// Rate limiting مرن — auth له حد منفصل، API العام لا يعيد احتساب auth
app.use("/api/auth", rateLimit({
  windowMs: 60_000, max: 60,
  message: { ok: false, msg: "محاولات كثيرة، انتظر دقيقة" },
  standardHeaders: true, legacyHeaders: false,
}));
app.use("/api", rateLimit({
  windowMs: 60_000, max: 600,
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path.startsWith("/auth"), // لا تعيد احتساب auth
}));

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// ══════════════════════════════════════════════
// 6. Health & Ping
// ══════════════════════════════════════════════
app.get("/api/healthz", (_req, res) =>
  res.json({ status: "ok", time: Date.now(), clients: sseClients.size })
);

app.get("/ping", (_req, res) => res.send("pong"));

// ══════════════════════════════════════════════
// 7. SSE Stream — بث مباشر
// ══════════════════════════════════════════════
app.get("/api/stream", async (req, res) => {
  const id = ++sseIdCounter;
  const token = req.headers["x-session-token"] || req.query.token;
  let userEmail = null;

  if (token) {
    try {
      const u = await getSessionUser(token);
      userEmail = u?.email || null;
    } catch {}
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",        // Nginx: لا تُخزن مؤقتاً
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
  });

  // رسالة ترحيب فورية
  res.write(`event: connected\ndata: ${JSON.stringify({ type: "connected", id, clients: sseClients.size + 1 })}\n\n`);

  res._email = userEmail;
  sseClients.set(id, res);

  req.on("close", () => {
    sseClients.delete(id);
  });
  req.on("error", () => {
    sseClients.delete(id);
  });
});

// ══════════════════════════════════════════════
// 8. Auth — تسجيل / دخول
// ══════════════════════════════════════════════
app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!email || !password)
      return res.json({ ok: false, msg: "البريد الإلكتروني وكلمة المرور مطلوبان" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return res.json({ ok: false, msg: "صيغة البريد الإلكتروني غير صحيحة" });
    if (password.length < 6)
      return res.json({ ok: false, msg: "كلمة المرور 6 أحرف على الأقل" });

    const norm = email.toLowerCase().trim();
    const ex = await db.query("SELECT email, deleted_at FROM users WHERE email=$1", [norm]);

    if (ex.rows.length > 0) {
      if (ex.rows[0].deleted_at) {
        await db.query(
          "UPDATE users SET deleted_at=NULL, full_name=$1, password_hash=$2, last_seen=$3 WHERE email=$4",
          [fullName || "", hashPassword(password), Date.now(), norm]
        );
        return res.json({ ok: true, msg: "تم إعادة تفعيل حسابك", reactivated: true });
      }
      return res.json({ ok: false, msg: "البريد الإلكتروني مسجل مسبقاً" });
    }

    await db.query(
      `INSERT INTO users (email, full_name, password_hash, created_at, last_seen)
       VALUES ($1,$2,$3,$4,$4)`,
      [norm, fullName?.trim() || "", hashPassword(password), Date.now()]
    );

    // تسجيل دخول تلقائي
    const token = generateToken();
    await db.query(
      "INSERT INTO sessions (token, user_id, created_at, last_used) VALUES ($1,$2,$3,$3)",
      [token, norm, Date.now()]
    );
    const userRow = await db.query("SELECT * FROM users WHERE email=$1", [norm]);

    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true, token, user: formatUser(userRow.rows[0]) });
  } catch (e) {
    console.error("register error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.json({ ok: false, msg: "البريد الإلكتروني وكلمة المرور مطلوبان" });

    const norm = email.toLowerCase().trim();
    const rows = await db.query("SELECT * FROM users WHERE email=$1", [norm]);

    if (!rows.rows.length)
      return res.json({ ok: false, msg: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });

    const user = rows.rows[0];
    if (user.deleted_at)  return res.json({ ok: false, msg: "هذا الحساب محذوف" });
    if (user.banned)      return res.json({ ok: false, msg: "هذا الحساب محظور" });
    if (!verifyPassword(password, user.password_hash))
      return res.json({ ok: false, msg: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });

    const token = generateToken();
    await db.query(
      "INSERT INTO sessions (token, user_id, created_at, last_used) VALUES ($1,$2,$3,$3)",
      [token, norm, Date.now()]
    );
    db.query("UPDATE users SET last_seen=$1 WHERE email=$2", [Date.now(), norm]).catch(() => {});

    res.json({ ok: true, token, user: formatUser(user) });
  } catch (e) {
    console.error("login error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
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
    if (token) {
      sessionCache.delete(token);
      await db.query("DELETE FROM sessions WHERE token=$1", [token]);
    }
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.post("/api/auth/change-password", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false, msg: "غير مصرح" });
    const { currentPassword, newPassword } = req.body;
    if (!verifyPassword(currentPassword, user.password_hash))
      return res.json({ ok: false, msg: "كلمة المرور الحالية غير صحيحة" });
    if (!newPassword || newPassword.length < 6)
      return res.json({ ok: false, msg: "كلمة المرور الجديدة قصيرة" });
    await db.query("UPDATE users SET password_hash=$1 WHERE email=$2",
      [hashPassword(newPassword), user.email]);
    invalidateSessionCache(user.email);
    res.json({ ok: true, msg: "تم تغيير كلمة المرور بنجاح" });
  } catch { res.status(500).json({ ok: false, msg: "خطأ في الخادم" }); }
});

app.patch("/api/auth/update", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false });
    const { fullName, trialCounters, points, badges, usageCount, rank } = req.body;
    await db.query(
      `UPDATE users SET full_name=COALESCE($1,full_name), trial_counters=COALESCE($2,trial_counters),
       points=COALESCE($3,points), badges=COALESCE($4,badges), usage_count=COALESCE($5,usage_count),
       rank=COALESCE($6,rank) WHERE email=$7`,
      [fullName||null, trialCounters?JSON.stringify(trialCounters):null,
       points??null, badges?JSON.stringify(badges):null,
       usageCount??null, rank||null, user.email]
    );
    invalidateSessionCache(user.email);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// ══════════════════════════════════════════════
// 9. Codes — نظام الأكواد الكامل
// ══════════════════════════════════════════════
app.get("/api/codes/list", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const all = await db.query("SELECT * FROM codes ORDER BY created_at DESC");
    res.json(all.rows.map((c) => ({
      id: c.id, code: c.code, type: c.type,
      durationDays: c.duration_days,
      maxUses: c.max_uses, usedCount: c.used_count,
      usedBy: c.used_by || [], active: c.active,
      createdAt: c.created_at, expiresAt: c.expires_at,
      label: c.label || "",
    })));
  } catch { res.json([]); }
});

app.get("/api/codes/user-status", async (req, res) => {
  try {
    const { email, code } = req.query;
    if (!email) return res.json({ valid: false, reason: "no-email" });
    const uRows = await db.query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
    if (!uRows.rows.length) return res.json({ valid: false, reason: "no-user" });
    const u = uRows.rows[0];
    const now = Date.now();
    const expiry = Number(u.premium_expiry) || 0;
    if (!expiry || expiry < now)
      return res.json({ valid: false, reason: "expired", expiry });
    if (code) {
      const cRows = await db.query("SELECT active FROM codes WHERE code=$1", [code.trim().toUpperCase()]);
      if (!cRows.rows.length || !cRows.rows[0].active)
        return res.json({ valid: false, reason: "code-deleted" });
    }
    const daysLeft = Math.ceil((expiry - now) / 86_400_000);
    res.json({ valid: true, expiry, daysLeft });
  } catch { res.json({ valid: false, reason: "error" }); }
});

app.post("/api/codes/generate", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { count = 1, type = "premium", durationDays, months = 1, maxUses = 1, expiresAt, label } = req.body;
    const actualDays = durationDays || Math.max(1, parseInt(months, 10) || 1) * 30;
    const generated = [];
    for (let i = 0; i < Math.min(count, 500); i++) {
      const code = "APLUS-" + randomBytes(4).toString("hex").toUpperCase();
      const id   = randomBytes(8).toString("hex");
      await db.query(
        `INSERT INTO codes (id,code,type,duration_days,max_uses,used_count,used_by,active,created_at,expires_at,label)
         VALUES ($1,$2,$3,$4,$5,0,'[]',TRUE,$6,$7,$8)`,
        [id, code, type, actualDays, maxUses, Date.now(), expiresAt || null, label || null]
      );
      generated.push(code);
    }
    broadcastEvent({ type: "codes_updated" });
    res.json({ ok: true, success: true, codes: generated });
  } catch (e) {
    console.error("generate codes error:", e.message);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/codes/redeem", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false, msg: "يجب تسجيل الدخول أولاً" });

    const { code } = req.body;
    if (!code) return res.json({ ok: false, msg: "أدخل الكود" });

    const cRows = await db.query("SELECT * FROM codes WHERE code=$1", [code.trim().toUpperCase()]);
    if (!cRows.rows.length) return res.json({ ok: false, msg: "الكود غير صحيح" });

    const c = cRows.rows[0];
    if (!c.active)                              return res.json({ ok: false, msg: "الكود معطّل" });
    if (c.expires_at && c.expires_at < Date.now()) return res.json({ ok: false, msg: "انتهت صلاحية الكود" });
    if (c.used_count >= c.max_uses)             return res.json({ ok: false, msg: "الكود وصل الحد الأقصى للاستخدام" });

    const usedBy = Array.isArray(c.used_by) ? c.used_by : [];
    if (usedBy.includes(user.email))            return res.json({ ok: false, msg: "استخدمت هذا الكود من قبل" });

    const base      = Math.max(Number(user.premium_expiry) || 0, Date.now());
    const newExpiry = base + c.duration_days * 86_400_000;
    const newUsed   = [...usedBy, user.email];

    await db.query("UPDATE codes SET used_count=used_count+1, used_by=$1 WHERE id=$2",
      [JSON.stringify(newUsed), c.id]);
    await db.query("UPDATE users SET premium_expiry=$1, activation_code=$2 WHERE email=$3",
      [newExpiry, code.trim().toUpperCase(), user.email]);

    invalidateSessionCache(user.email);

    // إشعارات فورية للجميع
    broadcastEvent({ type: "subscription_updated", email: user.email, premiumExpiry: newExpiry });
    broadcastEvent({ type: "users_updated" });
    broadcastEvent({ type: "codes_updated" });

    const daysLeft = Math.ceil((newExpiry - Date.now()) / 86_400_000);
    res.json({ ok: true, msg: `🎉 تم تفعيل الاشتراك — ${daysLeft} يوم متبقي`, premiumExpiry: newExpiry, daysLeft });
  } catch (e) {
    console.error("redeem error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
});

app.delete("/api/codes/:id", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const val = decodeURIComponent(req.params.id);
    await db.query("DELETE FROM codes WHERE id=$1 OR code=$1", [val]);
    broadcastEvent({ type: "codes_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/codes/:id", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const updates = [], vals = [];
    let i = 1;
    if (req.body.active !== undefined) { updates.push(`active=$${i++}`); vals.push(req.body.active); }
    if (req.body.label  !== undefined) { updates.push(`label=$${i++}`);  vals.push(req.body.label); }
    if (updates.length) {
      vals.push(req.params.id);
      await db.query(`UPDATE codes SET ${updates.join(",")} WHERE id=$${i}`, vals);
    }
    broadcastEvent({ type: "codes_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ══════════════════════════════════════════════
// 10. Ads — الإعلانات
// ══════════════════════════════════════════════
app.get("/api/ads/list", async (_req, res) => {
  try {
    const all = await db.query("SELECT * FROM ads ORDER BY created_at DESC");
    res.json(all.rows.map((a) => ({
      id: a.ad_id, title: a.title, text: a.ad_text, type: a.type,
      imageData: a.image_data, videoUrl: a.video_url, link: a.link,
      active: a.active, startDelay: a.start_delay, interval: a.interval_sec,
      autoDismiss: a.auto_dismiss, startTime: a.start_time, endTime: a.end_time,
    })));
  } catch { res.json([]); }
});

app.post("/api/ads", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const b   = req.body;
    const adId = b.id || randomBytes(8).toString("hex");
    const ex  = await db.query("SELECT ad_id FROM ads WHERE ad_id=$1", [adId]);
    if (ex.rows.length) {
      await db.query(
        `UPDATE ads SET title=$1,ad_text=$2,type=$3,image_data=$4,video_url=$5,link=$6,
         active=$7,start_delay=$8,interval_sec=$9,auto_dismiss=$10,start_time=$11,end_time=$12 WHERE ad_id=$13`,
        [b.title||null,b.text||null,b.type||"text",b.imageData||null,b.videoUrl||null,
         b.link||null,b.active!==false,b.startDelay||180,b.interval||600,
         b.autoDismiss||null,b.startTime||null,b.endTime||null,adId]
      );
    } else {
      await db.query(
        `INSERT INTO ads (ad_id,title,ad_text,type,image_data,video_url,link,active,start_delay,interval_sec,auto_dismiss,start_time,end_time,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [adId,b.title||null,b.text||null,b.type||"text",b.imageData||null,b.videoUrl||null,
         b.link||null,b.active!==false,b.startDelay||180,b.interval||600,
         b.autoDismiss||null,b.startTime||null,b.endTime||null,Date.now()]
      );
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
    const updates = [], vals = [];
    let i = 1;
    if (req.body.active !== undefined) { updates.push(`active=$${i++}`);  vals.push(req.body.active); }
    if (req.body.title  !== undefined) { updates.push(`title=$${i++}`);   vals.push(req.body.title); }
    if (req.body.text   !== undefined) { updates.push(`ad_text=$${i++}`); vals.push(req.body.text); }
    if (updates.length) {
      vals.push(req.params.id);
      await db.query(`UPDATE ads SET ${updates.join(",")} WHERE ad_id=$${i}`, vals);
    }
    broadcastEvent({ type: "ads_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ══════════════════════════════════════════════
// 11. Feedback — التقييمات
// ══════════════════════════════════════════════
app.get("/api/feedback/list", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const all = await db.query("SELECT * FROM feedback ORDER BY created_at DESC");
    res.json(all.rows.map((f) => ({
      id: f.feedback_id, userEmail: f.user_email, userName: f.user_name,
      message: f.message, type: f.type, rating: f.rating,
      createdAt: f.created_at, read: f.read,
    })));
  } catch { res.json([]); }
});

app.post("/api/feedback", async (req, res) => {
  try {
    const { message, type, rating, userName, userEmail } = req.body;
    if (!message) return res.json({ ok: false, msg: "الرسالة مطلوبة" });
    const id = randomBytes(8).toString("hex");
    await db.query(
      "INSERT INTO feedback (feedback_id,user_email,user_name,message,type,rating,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, userEmail||null, userName||null, message, type||"general", rating||null, Date.now()]
    );
    broadcastEvent({ type: "feedback_received", id });
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

// ══════════════════════════════════════════════
// 12. Settings — الإعدادات
// ══════════════════════════════════════════════
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
    await db.query(
      "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
      [key, JSON.stringify(value)]
    );
    broadcastEvent({ type: "settings_updated", key, value });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.put("/api/settings", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const body = req.body || {};
    const skip = ["adminKey"];
    for (const [k, v] of Object.entries(body)) {
      if (skip.includes(k)) continue;
      await db.query(
        "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
        [k, JSON.stringify(v)]
      );
    }
    broadcastEvent({ type: "settings_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ══════════════════════════════════════════════
// 13. User Settings
// ══════════════════════════════════════════════
app.get("/api/user/settings", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false, settings: {} });
    const row = await db.query("SELECT settings FROM user_settings WHERE user_email=$1", [user.email]);
    res.json({ ok: true, settings: row.rows[0]?.settings || {} });
  } catch { res.json({ ok: false, settings: {} }); }
});

app.post("/api/user/settings", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.json({ ok: false });
    const { settings } = req.body;
    await db.query(
      `INSERT INTO user_settings (user_email, settings, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (user_email) DO UPDATE SET settings=$2, updated_at=$3`,
      [user.email, JSON.stringify(settings || {}), Date.now()]
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// ══════════════════════════════════════════════
// 14. Users Management — إدارة المستخدمين
// ══════════════════════════════════════════════
app.get("/api/users/list", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const all = await db.query(
      "SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC"
    );
    res.json(all.rows.map(formatUser));
  } catch { res.json([]); }
});

app.patch("/api/users/:email/ban", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { banned } = req.body;
    const email = decodeURIComponent(req.params.email);
    await db.query("UPDATE users SET banned=$1 WHERE email=$2", [!!banned, email]);
    invalidateSessionCache(email);
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/users/:email/role", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { isAdmin, isModerator } = req.body;
    const email = decodeURIComponent(req.params.email);
    await db.query(
      "UPDATE users SET is_admin=$1, is_moderator=$2 WHERE email=$3",
      [!!isAdmin, !!isModerator, email]
    );
    invalidateSessionCache(email);
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/users/:email/premium", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const email    = decodeURIComponent(req.params.email);
    const { premiumExpiry, activationCode } = req.body;
    await db.query(
      "UPDATE users SET premium_expiry=$1, activation_code=$2 WHERE email=$3",
      [premiumExpiry || 0, activationCode || null, email]
    );
    invalidateSessionCache(email);
    broadcastEvent({ type: "subscription_updated", email, premiumExpiry: premiumExpiry || 0 });
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.delete("/api/users/:email", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const email = decodeURIComponent(req.params.email);
    await db.query("UPDATE users SET deleted_at=$1 WHERE email=$2", [Date.now(), email]);
    await db.query("DELETE FROM sessions WHERE user_id=$1", [email]);
    invalidateSessionCache(email);
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ══════════════════════════════════════════════
// 15. Subscriptions List
// ══════════════════════════════════════════════
app.get("/api/subscriptions/list", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const now = Date.now();
    const all = await db.query(
      "SELECT * FROM users WHERE premium_expiry > 0 AND deleted_at IS NULL ORDER BY premium_expiry DESC"
    );
    res.json(all.rows.map((u) => ({
      email: u.email,
      fullName: u.full_name,
      premiumExpiry: Number(u.premium_expiry),
      activationCode: u.activation_code,
      isActive: Number(u.premium_expiry) > now,
      daysLeft: Math.max(0, Math.ceil((Number(u.premium_expiry) - now) / 86_400_000)),
    })));
  } catch { res.json([]); }
});

// ══════════════════════════════════════════════
// 16. Broadcast — إذاعة للجميع
// ══════════════════════════════════════════════
app.post("/api/broadcast", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { message, notifType, targetEmail } = req.body;
    if (!message) return res.json({ ok: false });
    broadcastEvent({ type: "broadcast", message, notifType: notifType || "info" }, targetEmail || null);
    res.json({ ok: true, reached: sseClients.size });
  } catch { res.status(500).json({ error: "server error" }); }
});

// ══════════════════════════════════════════════
// 17. Stats — إحصائيات لوحة التحكم
// ══════════════════════════════════════════════
app.get("/api/stats", async (req, res) => {
  try {
    if (!checkAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const now = Date.now();
    const [users, codes, subs, feedback] = await Promise.all([
      db.query("SELECT COUNT(*) FROM users WHERE deleted_at IS NULL"),
      db.query("SELECT COUNT(*) FROM codes WHERE active=TRUE"),
      db.query("SELECT COUNT(*) FROM users WHERE premium_expiry>$1 AND deleted_at IS NULL", [now]),
      db.query("SELECT COUNT(*) FROM feedback WHERE read=FALSE"),
    ]);
    res.json({
      totalUsers:     parseInt(users.rows[0].count),
      activeCodes:    parseInt(codes.rows[0].count),
      activeSubcriptions: parseInt(subs.rows[0].count),
      unreadFeedback: parseInt(feedback.rows[0].count),
      onlineClients:  sseClients.size,
    });
  } catch { res.json({}); }
});

// ══════════════════════════════════════════════
// 18. Download files
// ══════════════════════════════════════════════
app.get("/download-html", (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="aplus-medical.html"');
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/download-server", (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="server.js"');
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "server.js"));
});

app.get("/download-pkg", (_req, res) => {
  res.sendFile(path.join(__dirname, "package.json"));
});

// Static files
app.use(express.static(path.join(__dirname, "public"), { etag: true, lastModified: true }));

// API 404 — طلبات /api غير الموجودة تعيد JSON وليس HTML
app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: "endpoint not found" });
});

// Global error handler — يمنع انهيار السيرفر
app.use((err, _req, res, _next) => {
  console.error("❌ خطأ غير متوقع:", err?.message || err);
  res.status(500).json({ ok: false, error: "server error" });
});

// SPA fallback — للصفحات الأمامية فقط
app.use((_req, res) => {
  const htmlPath = path.join(__dirname, "public", "index.html");
  res.sendFile(htmlPath, (err) => {
    if (err) res.status(200).send("<h1>A+ Medical Platform</h1>");
  });
});

// ══════════════════════════════════════════════
// 19. Anti-Sleep — يمنع Render من النوم
// ══════════════════════════════════════════════
function startAntiSleep() {
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (!selfUrl) return;
  setInterval(async () => {
    try {
      const url = selfUrl.replace(/\/$/, "") + "/ping";
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
    } catch {}
  }, 4 * 60 * 1000); // كل 4 دقائق
  console.log("🔄 Anti-sleep مفعّل →", selfUrl);
}

// ══════════════════════════════════════════════
// 20. Cleanup تلقائي — يُنظّف الجلسات القديمة
// ══════════════════════════════════════════════
function startCleanup() {
  setInterval(async () => {
    try {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 يوم
      await db.query("DELETE FROM sessions WHERE created_at < $1", [cutoff]);
    } catch {}
  }, 6 * 60 * 60 * 1000); // كل 6 ساعات
}

// ══════════════════════════════════════════════
// 21. التشغيل
// ══════════════════════════════════════════════
const PORT = parseInt(process.env.PORT || "3000", 10);

initDB()
  .then(() => {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`\n🚀 A+ Medical Server v5.0 يعمل على المنفذ ${PORT}`);
      console.log(`🔴 بث مباشر SSE مفعّل`);
      console.log(`💎 قاعدة بيانات متصلة`);
      startAntiSleep();
      startCleanup();
    });

    // Keep-alive للـ HTTP server
    server.keepAliveTimeout = 120_000;
    server.headersTimeout   = 125_000;

    // إغلاق نظيف
    process.on("SIGTERM", () => {
      console.log("⏹ إغلاق نظيف...");
      server.close(() => pool.end());
    });
    process.on("SIGINT", () => {
      server.close(() => pool.end());
    });
  })
  .catch((err) => {
    console.error("❌ فشل تشغيل قاعدة البيانات:", err);
    process.exit(1);
  });
