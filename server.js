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
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import https from "node:https";
import nodemailer from "nodemailer";
import path from "node:path";
import fs from "node:fs/promises";
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
      let client = null;
      try {
        client = await pool.connect();
        const result = await client.query(text, params);
        client.release();
        return result;
      } catch (e) {
        if (client) client.release(true);
        lastError = e;
        if (i < retries - 1) await sleep(300 * (i + 1));
      }
    }
    throw lastError;
  }
};

async function withDbTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

// يبدأ HTTP فوراً، وتنتظر طلبات الدخول جاهزية قاعدة البيانات
let dbReady = false;
let dbInitError = null;
let dbInitPromise = Promise.resolve();

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
      employee_code     TEXT,
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
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teacher_applications (
      id              TEXT PRIMARY KEY,
      user_email      TEXT NOT NULL UNIQUE REFERENCES users(email) ON DELETE CASCADE,
      full_name       TEXT NOT NULL,
      subject         TEXT NOT NULL,
      bio             TEXT DEFAULT '',
      gender          TEXT NOT NULL CHECK (gender IN ('male','female')),
      image_data      TEXT NOT NULL,
      status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      rejection_reason TEXT DEFAULT '',
      reviewed_by     TEXT DEFAULT '',
      reviewed_at     BIGINT DEFAULT 0,
      created_at      BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_tutors (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      bio            TEXT DEFAULT '',
      subject        TEXT DEFAULT '',
      image_url      TEXT DEFAULT '',
      video_url      TEXT DEFAULT '',
      lesson_price   NUMERIC(10,2) DEFAULT 0,
      monthly_price  NUMERIC(10,2) DEFAULT 0,
      daily_salla_url TEXT DEFAULT '',
      monthly_salla_url TEXT DEFAULT '',
      package_salla_url TEXT DEFAULT '',
      package_lessons INTEGER DEFAULT 10,
      salla_url      TEXT DEFAULT '',
      free_access    BOOLEAN DEFAULT FALSE,
      active         BOOLEAN DEFAULT TRUE,
      created_at     BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_tutor_codes (
      id             TEXT PRIMARY KEY,
      tutor_id       TEXT NOT NULL REFERENCES private_tutors(id) ON DELETE CASCADE,
      code           TEXT UNIQUE NOT NULL,
      student_email  TEXT,
      plan           TEXT DEFAULT 'month',
      lessons_remaining INTEGER DEFAULT 0,
      status         TEXT DEFAULT 'available',
      expires_at     BIGINT,
      activated_at   BIGINT,
      created_at     BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_tutor_bookings (
      id             TEXT PRIMARY KEY,
      tutor_id       TEXT NOT NULL REFERENCES private_tutors(id) ON DELETE CASCADE,
      student_email  TEXT NOT NULL,
      day_of_week    TEXT NOT NULL,
      time_text      TEXT NOT NULL,
      requested_date TEXT DEFAULT '',
      requested_time TEXT DEFAULT '',
      proposed_date  TEXT DEFAULT '',
      proposed_time  TEXT DEFAULT '',
      response_note  TEXT DEFAULT '',
      responded_at   BIGINT DEFAULT 0,
      notes          TEXT DEFAULT '',
      status         TEXT DEFAULT 'pending',
      created_at     BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_tutor_reviews (
      id             TEXT PRIMARY KEY,
      tutor_id       TEXT NOT NULL REFERENCES private_tutors(id) ON DELETE CASCADE,
      student_email  TEXT NOT NULL,
      rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment        TEXT DEFAULT '',
      created_at     BIGINT NOT NULL,
      UNIQUE (tutor_id, student_email)
    );
    CREATE TABLE IF NOT EXISTS private_tutor_likes (
      tutor_id       TEXT NOT NULL REFERENCES private_tutors(id) ON DELETE CASCADE,
      student_email  TEXT NOT NULL,
      created_at     BIGINT NOT NULL,
      PRIMARY KEY (tutor_id, student_email)
    );
    CREATE TABLE IF NOT EXISTS private_tutor_payments (
      id                TEXT PRIMARY KEY,
      transaction_no    TEXT UNIQUE NOT NULL,
      order_number      TEXT UNIQUE NOT NULL,
      tutor_id          TEXT NOT NULL REFERENCES private_tutors(id) ON DELETE CASCADE,
      student_email     TEXT NOT NULL,
      plan              TEXT NOT NULL CHECK (plan IN ('lesson','month')),
      amount            NUMERIC(10,2) NOT NULL,
      status            TEXT DEFAULT 'pending',
      lessons_remaining INTEGER DEFAULT 0,
      expires_at        BIGINT DEFAULT 0,
      paid_at           BIGINT DEFAULT 0,
      created_at        BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_tutor_rooms (
      id TEXT PRIMARY KEY, tutor_id TEXT NOT NULL REFERENCES private_tutors(id) ON DELETE CASCADE,
      booking_id TEXT REFERENCES private_tutor_bookings(id) ON DELETE SET NULL,
      student_email TEXT NOT NULL, tutor_email TEXT DEFAULT '', status TEXT DEFAULT 'waiting',
      started_at BIGINT, ended_at BIGINT, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_tutor_messages (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES private_tutor_rooms(id) ON DELETE CASCADE,
      sender_email TEXT NOT NULL, sender_role TEXT DEFAULT 'student', message TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_tutor_recordings (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES private_tutor_rooms(id) ON DELETE CASCADE,
      uploaded_by TEXT NOT NULL, recording_url TEXT NOT NULL, duration_sec INTEGER DEFAULT 0,
      mime_type TEXT DEFAULT 'video/webm', file_size BIGINT DEFAULT 0, file_path TEXT DEFAULT '', created_at BIGINT NOT NULL
    );
  `);

  // أعمدة جديدة لم تكن موجودة — آمن للتشغيل أكثر من مرة
  const safeCols = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen BIGINT DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used BIGINT DEFAULT 0`,
    `ALTER TABLE codes ADD COLUMN IF NOT EXISTS label TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS login_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until BIGINT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_code TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'student'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS teacher_status TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS teacher_subject TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS teacher_bio TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS teacher_gender TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS teacher_image_data TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS tutor_email TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS application_id TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS video_url TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS lesson_price NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS monthly_price NUMERIC(10,2) DEFAULT 0`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS daily_salla_url TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS monthly_salla_url TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS package_salla_url TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS package_lessons INTEGER DEFAULT 10`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS salla_url TEXT DEFAULT ''`,
    `ALTER TABLE private_tutors ADD COLUMN IF NOT EXISTS free_access BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE private_tutor_codes ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'month'`,
    `ALTER TABLE private_tutor_codes ADD COLUMN IF NOT EXISTS lessons_remaining INTEGER DEFAULT 0`,
    `ALTER TABLE private_tutor_bookings ADD COLUMN IF NOT EXISTS requested_date TEXT DEFAULT ''`,
    `ALTER TABLE private_tutor_bookings ADD COLUMN IF NOT EXISTS requested_time TEXT DEFAULT ''`,
    `ALTER TABLE private_tutor_bookings ADD COLUMN IF NOT EXISTS proposed_date TEXT DEFAULT ''`,
    `ALTER TABLE private_tutor_bookings ADD COLUMN IF NOT EXISTS proposed_time TEXT DEFAULT ''`,
    `ALTER TABLE private_tutor_bookings ADD COLUMN IF NOT EXISTS response_note TEXT DEFAULT ''`,
    `ALTER TABLE private_tutor_bookings ADD COLUMN IF NOT EXISTS responded_at BIGINT DEFAULT 0`,
    `ALTER TABLE private_tutor_recordings ADD COLUMN IF NOT EXISTS file_path TEXT DEFAULT ''`,
  ];
  for (const sql of safeCols) {
    try { await db.query(sql); } catch {}
  }
  try {
    await db.query("CREATE UNIQUE INDEX IF NOT EXISTS users_employee_code_unique ON users(employee_code) WHERE employee_code IS NOT NULL");
    await ensureEmployeeCodes();
  } catch (e) {
    console.warn("employee_code migration warning:", e.message);
  }

  // إنشاء حساب الأدمن من أسرار الخادم فقط — لا تضع بيانات الدخول في الكود
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
  const ADMIN_PASS  = process.env.ADMIN_PASS  || "";
  if (ADMIN_EMAIL && ADMIN_PASS) {
    const ex = await db.query("SELECT email FROM users WHERE email=$1", [ADMIN_EMAIL]);
    if (!ex.rows.length) {
      await db.query(
        `INSERT INTO users (email, full_name, password_hash, is_admin, is_super_admin, is_moderator, created_at)
         VALUES ($1,$2,$3,TRUE,TRUE,TRUE,$4)`,
        [ADMIN_EMAIL, "المدير الرئيسي", hashPassword(ADMIN_PASS), Date.now()]
      );
      console.log("✅ حساب الأدمن أُنشئ");
    }
  } else {
    console.warn("⚠️ ADMIN_EMAIL و ADMIN_PASS غير مضبوطين — لن يُنشأ حساب أدمن تلقائياً");
  }
}

// ══════════════════════════════════════════════
// 3. مساعدات الأمان — مُحصَّنة
// ══════════════════════════════════════════════
// 🔒 يُقرأ من متغير بيئة (Render Secret) فقط
const ADMIN_KEY = process.env.ADMIN_KEY || "";

if (!ADMIN_KEY) {
  console.error("❌ ADMIN_KEY غير مضبوط — اضبطه في أسرار Render قبل التشغيل");
  if (process.env.NODE_ENV === "production") process.exit(1);
}

// مقارنة آمنة من الناحية الزمنية (تمنع timing attacks)
function safeKeyCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch { return false; }
}

function checkAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.adminKey || req.body?.adminKey;
  return !!ADMIN_KEY && safeKeyCompare(String(key || ""), ADMIN_KEY);
}

// تحقق مزدوج: مفتاح المدير + جلسة صالحة لمستخدم مدير في DB
async function checkAdminStrict(req) {
  if (!checkAdmin(req)) return null;
  const token = req.headers["x-session-token"] || req.query.token;
  if (!token) return null;
  const user = await getSessionUser(token);
  if (!user) return null;
  if (!user.is_admin && !user.isAdmin && !user.is_super_admin && !user.isSuperAdmin) return null;
  return user;
}

// مصادقة الإدارة بالطريقة الصحيحة للواجهة:
// لا نضع ADMIN_KEY داخل JavaScript العام؛ نستخدم جلسة المدير، مع إبقاء
// مفتاح البيئة متاحاً للطلبات الخلفية/التكاملات القديمة.
async function isAdminRequest(req) {
  if (checkAdmin(req)) return true;
  const token = req.headers["x-session-token"] || req.query.token;
  if (!token) return false;
  const user = await getSessionUser(token);
  return !!(user && (
    user.is_admin || user.isAdmin ||
    user.is_super_admin || user.isSuperAdmin
  ));
}

// حماية استخدام الذكاء الاصطناعي — لا تسمح لأي شخص باستنزاف مفتاح OpenRouter
// من خلال استدعاء /api/openrouter مباشرة خارج الواجهة.
const aiUsage = new Map();
const AI_PER_MINUTE_LIMIT = Math.max(1, Number(process.env.AI_REQUESTS_PER_MINUTE || 8));
const AI_PER_DAY_LIMIT = Math.max(AI_PER_MINUTE_LIMIT, Number(process.env.AI_REQUESTS_PER_DAY || 30));
// سقف موحّد للإجابات الطويلة عالية الدقة — يمكن تخفيضه من متغير البيئة عند الحاجة.
const AI_MAX_TOKENS_PER_REQUEST = Math.max(1000, Number(process.env.AI_MAX_TOKENS_PER_REQUEST || 12000));
const AI_MAX_TOKENS_PER_DAY = Math.max(
  AI_MAX_TOKENS_PER_REQUEST,
  Number(process.env.AI_MAX_TOKENS_PER_DAY || 120000)
);
const AI_MAX_PROMPT_CHARS = Math.max(
  10_000,
  Number(process.env.AI_MAX_PROMPT_CHARS || 60_000)
);
const AI_MAX_IMAGE_CHARS = Math.max(
  1_000_000,
  Number(process.env.AI_MAX_IMAGE_CHARS || 20_000_000)
);

async function requireAiUser(req, res, requestedTokens = 0) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = req.headers["x-session-token"] || bearer;
  const user = await getSessionUser(token);
  if (!user) {
    res.status(401).json({ ok: false, error: "login_required" });
    return null;
  }
  if (user.banned) {
    res.status(403).json({ ok: false, error: "account_blocked" });
    return null;
  }

  const now = Date.now();
  const key = String(user.email || req.ip || "unknown");
  const old = aiUsage.get(key);
  const record = old && now - old.dayStart < 86_400_000
    ? old
    : { minuteStart: now, minuteCount: 0, dayStart: now, dayCount: 0, tokenCount: 0 };
  if (now - record.minuteStart >= 60_000) {
    record.minuteStart = now;
    record.minuteCount = 0;
  }
  const reservedTokens = Math.min(
    Math.max(Number(requestedTokens) || 12000, 1000),
    AI_MAX_TOKENS_PER_REQUEST
  );
  if (
    record.minuteCount >= AI_PER_MINUTE_LIMIT ||
    record.dayCount >= AI_PER_DAY_LIMIT ||
    record.tokenCount + reservedTokens > AI_MAX_TOKENS_PER_DAY
  ) {
    res.status(429).json({
      ok: false,
      error: "ai_usage_limit",
      message: "تم تجاوز حد استخدام الذكاء الاصطناعي مؤقتاً."
    });
    return null;
  }
  record.minuteCount += 1;
  record.dayCount += 1;
  record.tokenCount += reservedTokens;
  aiUsage.set(key, record);
  return user;
}

// تسجيل أحداث إدارية حرجة (Audit Log)
async function auditLog(action, actor, details = {}) {
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT,
        details JSONB,
        ip TEXT,
        ts BIGINT NOT NULL
      )`
    );
    await db.query(
      "INSERT INTO audit_log (action, actor, details, ip, ts) VALUES ($1,$2,$3,$4,$5)",
      [String(action), String(actor || "unknown"), JSON.stringify(details || {}), String(details.ip || ""), Date.now()]
    );
  } catch (e) { console.warn("audit_log error:", e.message); }
}

// ══════════════════════════════════════════════
// إرسال إيميل استعادة كلمة المرور عبر Gmail SMTP
// ══════════════════════════════════════════════
const GMAIL_USER   = process.env.GMAIL_USER  || "";
const GMAIL_PASS   = process.env.GMAIL_APP_PASS || "";
const RESEND_KEY   = process.env.RESEND_API_KEY || "";
// FRONTEND_URL: رابط صفحة reset-password.html
const FRONTEND_URL = process.env.FRONTEND_URL || "https://aplus-server-w6wb.onrender.com";

async function _sendViaResend(toEmail, subject, htmlBody) {
  const fromAddr = process.env.RESEND_FROM || "A+ الطبي <onboarding@resend.dev>";
  const body = JSON.stringify({ from: fromAddr, to: [toEmail], subject, html: htmlBody });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('resend-timeout')), 12000);
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(timeout);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else reject(new Error(`resend-${res.statusCode}: ${d}`));
      });
    });
    req.on('error', e => { clearTimeout(timeout); reject(e); });
    req.write(body);
    req.end();
  });
}

async function sendResetEmail(toEmail, token, fullName) {
  const resetLink = `${FRONTEND_URL}/reset-password.html?token=${token}`;
  const displayName = fullName || "المستخدم";

  const htmlBody = `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>استعادة كلمة المرور — A+ الطبي</title></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1a0a3a 0%,#2d0f5e 50%,#1a0a3a 100%);border-radius:20px 20px 0 0;padding:40px 32px 32px;text-align:center;border:1px solid #d4af3733;">
          <div style="font-size:2.8rem;margin-bottom:8px;">⚕️</div>
          <div style="font-size:2rem;font-weight:900;background:linear-gradient(135deg,#d4af37,#f0d060,#b8960c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:1px;direction:ltr;">A+ الطبي</div>
          <div style="color:#9b7fd4;font-size:0.78rem;margin-top:4px;letter-spacing:0.5px;">ذكاء اصطناعي طبي متقدم</div>
          <div style="width:60px;height:2px;background:linear-gradient(90deg,transparent,#d4af37,transparent);margin:16px auto 0;"></div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#110d1f;border:1px solid #2d1f4a;border-top:none;padding:36px 32px;">
          <h2 style="color:#e8e0f8;font-size:1.25rem;font-weight:800;margin:0 0 12px;">مرحباً، ${displayName} 👋</h2>
          <p style="color:#9b8ec4;font-size:0.93rem;line-height:1.7;margin:0 0 24px;">
            تلقّينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك في منصة <strong style="color:#d4af37;">A+ الطبي</strong>.
            إذا لم تطلب ذلك، يمكنك تجاهل هذا الإيميل بأمان.
          </p>

          <!-- Countdown info -->
          <div style="background:#1a1030;border:1px solid #3d2a6a;border-radius:12px;padding:14px 18px;margin-bottom:28px;display:flex;align-items:center;gap:10px;">
            <span style="font-size:1.4rem;">⏱️</span>
            <span style="color:#c4b5e8;font-size:0.85rem;">هذا الرابط صالح لمدة <strong style="color:#d4af37;">60 دقيقة</strong> فقط من وقت الإرسال.</span>
          </div>

          <!-- CTA Button -->
          <div style="text-align:center;margin:28px 0;">
            <a href="${resetLink}" style="display:inline-block;padding:15px 40px;background:linear-gradient(135deg,#d4af37,#b8960c,#d4af37);color:#0a0a0f;font-size:1rem;font-weight:900;text-decoration:none;border-radius:12px;letter-spacing:0.3px;box-shadow:0 6px 24px rgba(212,175,55,0.4);">
              🔑 إعادة تعيين كلمة المرور
            </a>
          </div>

          <!-- Link fallback -->
          <div style="background:#0d0819;border:1px solid #2a1f48;border-radius:10px;padding:14px 16px;margin-top:16px;">
            <p style="color:#7a6d9a;font-size:0.75rem;margin:0 0 6px;">أو انسخ هذا الرابط في متصفحك:</p>
            <p style="color:#8b7bd4;font-size:0.72rem;word-break:break-all;margin:0;direction:ltr;text-align:left;">${resetLink}</p>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#0d0819;border:1px solid #2d1f4a;border-top:none;border-radius:0 0 20px 20px;padding:20px 32px;text-align:center;">
          <p style="color:#4a3d6a;font-size:0.72rem;margin:0 0 4px;">هذا الإيميل أُرسل تلقائياً — لا ترد عليه</p>
          <p style="color:#4a3d6a;font-size:0.72rem;margin:0;">© 2025 <span style="color:#d4af3788;">A+ الطبي</span> — جميع الحقوق محفوظة</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // أولاً: جرّب Resend (أكثر موثوقية على cloud)
  if (RESEND_KEY) {
    try {
      await _sendViaResend(toEmail, "🔑 استعادة كلمة المرور — A+ الطبي", htmlBody);
      console.log(`✅ [Resend] إيميل أُرسل إلى: ${toEmail}`);
      return true;
    } catch (err) {
      console.error("❌ [Resend] فشل:", err.message);
    }
  }

  // ثانياً: fallback لـ Gmail SMTP
  if (!GMAIL_USER || !GMAIL_PASS) {
    console.log(`\n📧 [DEV] رابط الاستعادة: ${resetLink}\n`);
    return true;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 12000)
    );
    await Promise.race([
      transporter.sendMail({
        from: `"A+ الطبي" <${GMAIL_USER}>`,
        to: toEmail,
        subject: "🔑 استعادة كلمة المرور — A+ الطبي",
        html: htmlBody
      }),
      timeout
    ]);
    console.log(`✅ [Gmail] إيميل أُرسل إلى: ${toEmail}`);
    return true;
  } catch (err) {
    console.error("❌ [Gmail] خطأ:", err.message);
    return false;
  }
}

// تنظيف التوكنات المنتهية كل ساعة
setInterval(() => {
  db.query("DELETE FROM password_reset_tokens WHERE expires_at < $1 OR used = TRUE", [Date.now()])
    .catch(() => {});
  db.query("DELETE FROM email_verification_tokens WHERE expires_at < $1 OR used = TRUE", [Date.now()])
    .catch(() => {});
}, 60 * 60_000);

// ══════════════════════════════════════════════
// إرسال إيميل تأكيد البريد الإلكتروني
// ══════════════════════════════════════════════
async function sendVerificationEmail(toEmail, code, fullName) {
  const displayName = fullName || "المستخدم";
  const htmlBody = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>تأكيد الحساب — A+ الطبي</title></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;padding:40px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <tr><td style="background:linear-gradient(135deg,#065f46 0%,#047857 50%,#064e3b 100%);border-radius:20px 20px 0 0;padding:36px 32px 28px;text-align:center;border:1px solid rgba(16,185,129,0.3);">
          <div style="font-size:2.5rem;margin-bottom:8px;">⚕️</div>
          <div style="font-size:1.9rem;font-weight:900;color:#fff;direction:ltr;">A+ الطبي</div>
          <div style="color:rgba(167,243,208,0.8);font-size:0.78rem;margin-top:4px;">تأكيد البريد الإلكتروني</div>
          <div style="width:50px;height:2px;background:linear-gradient(90deg,transparent,#10b981,transparent);margin:14px auto 0;"></div>
        </td></tr>
        <tr><td style="background:#0a1f17;border:1px solid rgba(16,185,129,0.2);border-top:none;padding:32px;">
          <h2 style="color:#d1fae5;font-size:1.15rem;font-weight:800;margin:0 0 12px;">أهلاً، ${displayName} 👋</h2>
          <p style="color:#6ee7b7;font-size:0.9rem;line-height:1.7;margin:0 0 20px;">
            شكراً لتسجيلك في <strong style="color:#10b981;">A+ الطبي</strong>. أدخل الكود أدناه لتأكيد بريدك الإلكتروني وتفعيل حسابك.
          </p>
          <div style="background:#022c22;border:2px solid rgba(16,185,129,0.4);border-radius:16px;padding:28px;text-align:center;margin:16px 0;">
            <div style="color:#6ee7b7;font-size:0.78rem;margin-bottom:10px;letter-spacing:0.5px;">كود التأكيد</div>
            <div style="font-size:2.8rem;font-weight:900;letter-spacing:14px;color:#10b981;direction:ltr;font-family:'Courier New',monospace;">${code}</div>
            <div style="color:#34d399;font-size:0.75rem;margin-top:12px;">⏱️ صالح لمدة 15 دقيقة فقط</div>
          </div>
          <div style="background:#071510;border:1px solid rgba(16,185,129,0.15);border-radius:10px;padding:14px 16px;margin-top:16px;">
            <p style="color:#4a7a60;font-size:0.78rem;margin:0;">إذا لم تسجّل في منصة A+ الطبي، يمكنك تجاهل هذا الإيميل بأمان.</p>
          </div>
        </td></tr>
        <tr><td style="background:#050f0a;border:1px solid rgba(16,185,129,0.15);border-top:none;border-radius:0 0 20px 20px;padding:18px 32px;text-align:center;">
          <p style="color:#2d5040;font-size:0.72rem;margin:0 0 4px;">هذا الإيميل أُرسل تلقائياً — لا ترد عليه</p>
          <p style="color:#2d5040;font-size:0.72rem;margin:0;">© 2025 <span style="color:rgba(16,185,129,0.5);">A+ الطبي</span> — جميع الحقوق محفوظة</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  if (RESEND_KEY) {
    try {
      await _sendViaResend(toEmail, "🔐 كود تأكيد حسابك — A+ الطبي", htmlBody);
      console.log(`✅ [Resend] كود التحقق أُرسل إلى: ${toEmail}`);
      return true;
    } catch (err) {
      console.error("❌ [Resend] فشل إرسال التحقق:", err.message);
    }
  }
  if (GMAIL_USER && GMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000
      });
      await transporter.sendMail({
        from: `"A+ الطبي" <${GMAIL_USER}>`,
        to: toEmail,
        subject: "🔐 كود تأكيد حسابك — A+ الطبي",
        html: htmlBody
      });
      console.log(`✅ [Gmail] كود التحقق أُرسل إلى: ${toEmail}`);
      return true;
    } catch (err) {
      console.error("❌ [Gmail] فشل إرسال التحقق:", err.message);
    }
  }
  console.log(`\n📧 [DEV] كود التحقق لـ ${toEmail}: ${code}\n`);
  return true;
}

async function sendTeacherDecisionEmail(toEmail, fullName, approved, reason = "") {
  const safeName = String(fullName || "المعلم").replace(/[<>&"]/g, "");
  const safeReason = String(reason || "").replace(/[<>&"]/g, "");
  const subject = approved
    ? "✅ تمت الموافقة على طلبك — A+ الطبي"
    : "❌ تحديث طلب التسجيل كمعلم — A+ الطبي";
  const htmlBody = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"></head>
  <body style="margin:0;background:#0a0a0f;font-family:Tahoma,Arial,sans-serif;direction:rtl">
    <div style="max-width:560px;margin:35px auto;background:#151021;border:1px solid ${approved ? "#10b981" : "#ef4444"};border-radius:18px;padding:30px;color:#eee">
      <div style="font-size:28px;text-align:center">${approved ? "🎓✅" : "📩❌"}</div>
      <h2 style="text-align:center;color:${approved ? "#6ee7b7" : "#fca5a5"}">A+ الطبي</h2>
      <p>مرحباً ${safeName}،</p>
      <p>${approved
        ? "تمت الموافقة على طلب تسجيلك كمعلم خصوصي. أصبح ملفك ظاهراً للطلاب ويمكنك تسجيل الدخول بحسابك."
        : "نعتذر، لم تتم الموافقة على طلب تسجيلك كمعلم خصوصي حالياً."}</p>
      ${!approved && safeReason ? `<div style="background:#2a1620;border-radius:10px;padding:12px;margin-top:18px">سبب الرفض: ${safeReason}</div>` : ""}
      <p style="color:#9b8ec4;font-size:13px;margin-top:25px">هذه رسالة آلية من منصة A+ الطبي.</p>
    </div>
  </body></html>`;

  if (RESEND_KEY) {
    try {
      await _sendViaResend(toEmail, subject, htmlBody);
      return true;
    } catch (e) {
      console.error("teacher decision resend:", e.message);
    }
  }
  if (GMAIL_USER && GMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
        connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000
      });
      await transporter.sendMail({ from: `"A+ الطبي" <${GMAIL_USER}>`, to: toEmail, subject, html: htmlBody });
      return true;
    } catch (e) {
      console.error("teacher decision gmail:", e.message);
    }
  }
  console.log(`[DEV] teacher decision email for ${toEmail}: ${approved ? "approved" : "rejected"}`);
  return true;
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

function generateEmployeeCode() {
  return String(randomInt(1000, 10000));
}

async function getUniqueEmployeeCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = generateEmployeeCode();
    const found = await db.query("SELECT 1 FROM users WHERE employee_code=$1 LIMIT 1", [code]);
    if (!found.rows.length) return code;
  }
  throw new Error("لا توجد رموز موظفين متاحة");
}

async function ensureEmployeeCodes() {
  const rows = await db.query(
    "SELECT email, employee_code FROM users WHERE is_moderator=TRUE AND is_admin=FALSE AND deleted_at IS NULL ORDER BY email"
  );
  const used = new Set(
    rows.rows.map((row) => String(row.employee_code || "")).filter((code) => /^\d{4}$/.test(code))
  );
  for (const row of rows.rows) {
    if (/^\d{4}$/.test(String(row.employee_code || ""))) continue;
    let code = null;
    for (let attempt = 0; attempt < 100 && !code; attempt++) {
      const candidate = generateEmployeeCode();
      if (used.has(candidate)) continue;
      const collision = await db.query("SELECT 1 FROM users WHERE employee_code=$1 LIMIT 1", [candidate]);
      if (!collision.rows.length) code = candidate;
    }
    if (!code) throw new Error("لا توجد رموز موظفين متاحة");
    await db.query("UPDATE users SET employee_code=$1 WHERE email=$2", [code, row.email]);
    used.add(code);
  }
}

// ══════════════════════════════════════════════
// حماية Brute Force — تتبع IPs المشبوهة في الذاكرة
// ══════════════════════════════════════════════
const MAX_FAIL_PER_IP = 15;        // أقصى محاولات فاشلة لكل IP قبل الحظر المؤقت
const IP_BAN_DURATION = 15 * 60_000; // 15 دقيقة حظر IP
const ipFailMap = new Map(); // ip → { count, bannedUntil }

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function isIpBanned(ip) {
  const entry = ipFailMap.get(ip);
  if (!entry) return false;
  if (entry.bannedUntil && Date.now() < entry.bannedUntil) return true;
  if (entry.bannedUntil && Date.now() >= entry.bannedUntil) {
    ipFailMap.delete(ip); // رُفع الحظر
    return false;
  }
  return false;
}

function recordIpFail(ip) {
  const entry = ipFailMap.get(ip) || { count: 0, bannedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_FAIL_PER_IP) {
    entry.bannedUntil = Date.now() + IP_BAN_DURATION;
    console.warn(`🚫 IP محظور مؤقتاً: ${ip} (${entry.count} محاولة فاشلة)`);
  }
  ipFailMap.set(ip, entry);
}

function resetIpFails(ip) {
  ipFailMap.delete(ip);
}

// تنظيف الذاكرة كل ساعة
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipFailMap.entries()) {
    if (!entry.bannedUntil || now >= entry.bannedUntil) ipFailMap.delete(ip);
  }
}, 60 * 60_000);

// ثوابت قفل الحساب
const ACCOUNT_LOCK_ATTEMPTS = 5;   // عدد المحاولات الفاشلة قبل قفل الحساب
const ACCOUNT_LOCK_DURATION = 15 * 60_000; // 15 دقيقة قفل

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



// صلاحيات المشرف المسموح بها — تُحفظ في السيرفر وتُعاد مع كل جلسة
const MODERATOR_PERMISSION_KEYS = new Set([
  "canViewDashboard", "canManageUsers", "canManageAds", "canAddCodes",
  "canManageActivations", "canManageSubscriptions", "canViewFeedback",
  "canManageSettings", "canManageModerators", "canViewStats", "canManageServices",
  "canManageStore", "canManageDictionary", "canManageSocial", "canManageBanners",
  "canManageQuotes", "canManageServiceSettings", "canManageBans", "canManageApi"
]);

function sanitizePermissions(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const output = {};
  for (const key of MODERATOR_PERMISSION_KEYS) {
    if (input[key] === true) output[key] = true;
  }
  return output;
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
    employeeCode: u.employee_code || null,
    createdAt: u.created_at || 0,
    lastSeen: u.last_seen || 0,
    loginAttempts: Number(u.login_attempts) || 0,
    lockedUntil: Number(u.locked_until) || 0,
    accountType: u.account_type || "student",
    teacherStatus: u.teacher_status || "",
    teacherSubject: u.teacher_subject || "",
    teacherBio: u.teacher_bio || "",
    teacherGender: u.teacher_gender || "",
    teacherImageData: u.teacher_image_data || "",
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
// حد تسجيل الدخول: 10 محاولات فقط في الدقيقة لكل IP
app.use("/api/auth", rateLimit({
  windowMs: 60_000, max: 10,
  message: { ok: false, msg: "⚠️ محاولات كثيرة جداً. انتظر دقيقة ثم حاول مجدداً." },
  standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true, // لا يُحسب الدخول الناجح ضمن الحد
}));
app.use("/api", rateLimit({
  windowMs: 60_000, max: 600,
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path.startsWith("/auth"), // لا تعيد احتساب auth
}));
app.use("/api/openrouter", rateLimit({
  windowMs: 60_000,
  max: Math.max(1, Number(process.env.AI_GLOBAL_PER_MINUTE || 20)),
  standardHeaders: true,
  legacyHeaders: false
}));

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// ══════════════════════════════════════════════
// 6. Health & Ping
// ══════════════════════════════════════════════
app.get("/api/healthz", (_req, res) => {
  if (!dbReady) {
    return res.status(503).json({ status: "starting", message: "قاعدة البيانات قيد التشغيل" });
  }
  res.json({ status: "ok", time: Date.now(), clients: sseClients.size });
});

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


// إنشاء حساب موظف/مشرف من لوحة الإدارة — يتم الحفظ في قاعدة البيانات مباشرة
app.post("/api/auth/admin-create", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: "forbidden", msg: "غير مصرح" });

    const body = req.body || {};
    const fullName = String(body.fullName || "").trim().slice(0, 120);
    const email = String(body.email || "").toLowerCase().trim();
    const password = String(body.password || "");
    const isModerator = body.isModerator !== false;
    const permissions = sanitizePermissions(body.permissions);
    const requestedEmployeeCode = String(body.employeeCode || "").trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ ok: false, msg: "صيغة البريد الإلكتروني غير صحيحة" });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, msg: "كلمة المرور 6 أحرف على الأقل" });
    }
    if (isModerator && requestedEmployeeCode && !/^\d{4}$/.test(requestedEmployeeCode)) {
      return res.status(400).json({ ok: false, msg: "رمز الموظف يجب أن يكون 4 أرقام فقط" });
    }

    const existing = await db.query("SELECT email, deleted_at FROM users WHERE email=$1", [email]);
    if (existing.rows.length && !existing.rows[0].deleted_at) {
      return res.status(409).json({ ok: false, exists: true, msg: "البريد الإلكتروني مسجل مسبقاً" });
    }
    let employeeCode = null;
    if (isModerator) {
      if (requestedEmployeeCode) {
        const owner = await db.query(
          "SELECT email FROM users WHERE employee_code=$1 AND email<>$2 LIMIT 1",
          [requestedEmployeeCode, email]
        );
        if (owner.rows.length) {
          return res.status(409).json({ ok: false, msg: "رمز الموظف مستخدم مسبقاً، اختر رمزاً آخر" });
        }
        employeeCode = requestedEmployeeCode;
      } else {
        employeeCode = await getUniqueEmployeeCode();
      }
    }

    const now = Date.now();
    let row;
    if (existing.rows.length) {
      const updated = await db.query(
        "UPDATE users SET full_name=$1, password_hash=$2, is_admin=FALSE, is_super_admin=FALSE, is_moderator=$3, permissions=$4, employee_code=$5, banned=FALSE, deleted_at=NULL, email_verified=TRUE, login_attempts=0, locked_until=0, last_seen=$6 WHERE email=$7 RETURNING *",
        [fullName || email.split("@")[0], hashPassword(password), isModerator, JSON.stringify(permissions), employeeCode, now, email]
      );
      row = updated.rows[0];
    } else {
      const inserted = await db.query(
        "INSERT INTO users (email, full_name, password_hash, is_admin, is_super_admin, is_moderator, permissions, employee_code, email_verified, created_at, last_seen) VALUES ($1,$2,$3,FALSE,FALSE,$4,$5,$6,TRUE,$7,$7) RETURNING *",
        [email, fullName || email.split("@")[0], hashPassword(password), isModerator, JSON.stringify(permissions), employeeCode, now]
      );
      row = inserted.rows[0];
    }

    invalidateSessionCache(email);
    await auditLog("admin_create_user", email, { email, isModerator, permissions, ip: getClientIp(req) });
    broadcastEvent({ type: "users_updated" });
    res.status(existing.rows.length ? 200 : 201).json({ ok: true, created: !existing.rows.length, user: formatUser(row) });
  } catch (e) {
    console.error("admin-create error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    const accountType = String(req.body?.accountType || "student").toLowerCase();
    const teacherGender = String(req.body?.teacherGender || "").toLowerCase();
    const teacherSubject = String(req.body?.teacherSubject || "").trim().slice(0, 120);
    const teacherBio = String(req.body?.teacherBio || "").trim().slice(0, 2000);
    const teacherImageData = String(req.body?.teacherImageData || "");
    if (!email || !password)
      return res.json({ ok: false, msg: "البريد الإلكتروني وكلمة المرور مطلوبان" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return res.json({ ok: false, msg: "صيغة البريد الإلكتروني غير صحيحة" });
    if (password.length < 6)
      return res.json({ ok: false, msg: "كلمة المرور 6 أحرف على الأقل" });
    if (!["student", "teacher"].includes(accountType))
      return res.json({ ok: false, msg: "نوع الحساب غير صحيح" });
    if (accountType === "teacher") {
      if (!teacherSubject || !["male", "female"].includes(teacherGender))
        return res.json({ ok: false, msg: "اسم التخصص ونوع المعلم مطلوبان" });
      if (!/^data:image\/(?:jpeg|jpg|png|webp);base64,[a-z0-9+/=\r\n]+$/i.test(teacherImageData) ||
          teacherImageData.length > 7_000_000) {
        return res.json({ ok: false, msg: "ارفع صورة شخصية واضحة بصيغة JPG أو PNG أو WEBP وحجم أقل من 5MB" });
      }
    }

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

    if (accountType === "teacher") {
      await db.query(
        `INSERT INTO users
         (email, full_name, password_hash, account_type, teacher_status,
          teacher_subject, teacher_bio, teacher_gender, teacher_image_data,
          created_at, last_seen)
         VALUES ($1,$2,$3,'teacher','pending',$4,$5,$6,$7,$8,$8)`,
        [norm, fullName?.trim() || "", hashPassword(password), teacherSubject,
          teacherBio, teacherGender, teacherImageData, Date.now()]
      );
      await db.query(
        `INSERT INTO teacher_applications
         (id,user_email,full_name,subject,bio,gender,image_data,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
        [randomBytes(12).toString("hex"), norm, fullName?.trim() || "",
          teacherSubject, teacherBio, teacherGender, teacherImageData, Date.now()]
      );
      const verifyCode = String(Math.floor(100000 + Math.random() * 900000));
      await db.query("DELETE FROM email_verification_tokens WHERE email=$1", [norm]);
      await db.query(
        "INSERT INTO email_verification_tokens (token,email,expires_at,used,created_at) VALUES ($1,$2,$3,FALSE,$4)",
        [verifyCode, norm, Date.now() + 15 * 60_000, Date.now()]
      );
      await sendVerificationEmail(norm, verifyCode, fullName?.trim() || "");
      broadcastEvent({ type: "teacher_applications_updated" });
      return res.json({
        ok: true, requiresVerification: true, teacherPending: true, email: norm,
        msg: "تم إرسال كود التأكيد. بعد التأكيد سيراجع المدير طلبك."
      });
    }

    await db.query(
      `INSERT INTO users (email, full_name, password_hash, created_at, last_seen)
       VALUES ($1,$2,$3,$4,$4)`,
      [norm, fullName?.trim() || "", hashPassword(password), Date.now()]
    );

    // إرسال كود تأكيد البريد الإلكتروني
    const verifyCode   = String(Math.floor(100000 + Math.random() * 900000));
    const verifyExpiry = Date.now() + 15 * 60_000;
    await db.query("DELETE FROM email_verification_tokens WHERE email=$1", [norm]);
    await db.query(
      "INSERT INTO email_verification_tokens (token, email, expires_at, used, created_at) VALUES ($1,$2,$3,FALSE,$4)",
      [verifyCode, norm, verifyExpiry, Date.now()]
    );
    await sendVerificationEmail(norm, verifyCode, fullName?.trim() || "");
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true, requiresVerification: true, email: norm, msg: "تم إرسال كود التأكيد على بريدك الإلكتروني" });
  } catch (e) {
    console.error("register error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    // يمنع فشل الدخول أثناء استيقاظ Render أو قاعدة البيانات
    await dbInitPromise;
    if (dbInitError) {
      return res.status(503).json({ ok: false, msg: "قاعدة البيانات غير جاهزة، أعد المحاولة بعد قليل" });
    }
    const ip = getClientIp(req);

    // ❶ فحص حظر IP
    if (isIpBanned(ip)) {
      return res.status(429).json({ ok: false, msg: "تم تعليق دخولك مؤقتاً بسبب محاولات متكررة. حاول بعد 15 دقيقة." });
    }

    const { email, password } = req.body;
    if (!email || !password)
      return res.json({ ok: false, msg: "البريد الإلكتروني وكلمة المرور مطلوبان" });

    const norm = email.toLowerCase().trim();
    const rows = await db.query("SELECT * FROM users WHERE email=$1", [norm]);

    // ❷ إذا البريد غير موجود — سجّل IP فقط (لا نخبر المهاجم)
    if (!rows.rows.length) {
      recordIpFail(ip);
      return res.json({ ok: false, msg: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    }

    const user = rows.rows[0];

    // ❸ فحوصات الحساب
    if (user.deleted_at) return res.json({ ok: false, msg: "هذا الحساب محذوف" });
    if (user.banned)     return res.json({ ok: false, msg: "هذا الحساب محظور من قِبل الإدارة" });

    // ❸٫٥ فحص تأكيد البريد الإلكتروني
    if (!user.email_verified && !user.is_admin && !user.is_super_admin) {
      return res.json({ ok: false, requiresVerification: true, email: norm, msg: "⚠️ يرجى تأكيد بريدك الإلكتروني أولاً — راجع صندوق الوارد" });
    }
    if (user.account_type === "teacher" && user.teacher_status !== "approved") {
      return res.json({
        ok: false,
        teacherPending: user.teacher_status === "pending",
        teacherRejected: user.teacher_status === "rejected",
        msg: user.teacher_status === "rejected"
          ? "تم رفض طلب المعلم. يمكنك التواصل مع الإدارة وتقديم طلب جديد."
          : "طلب المعلم قيد مراجعة المدير. سيصلك إشعار بالبريد عند القرار."
      });
    }

    // ❹ فحص قفل الحساب
    const lockedUntil = Number(user.locked_until || 0);
    if (lockedUntil > Date.now()) {
      const mins = Math.ceil((lockedUntil - Date.now()) / 60_000);
      return res.json({ ok: false, msg: `🔒 الحساب مقفل بسبب محاولات فاشلة متكررة. انتظر ${mins} دقيقة.` });
    }

    // ❺ التحقق من كلمة المرور
    if (!verifyPassword(password, user.password_hash)) {
      const newAttempts = (Number(user.login_attempts || 0)) + 1;
      const shouldLock = newAttempts >= ACCOUNT_LOCK_ATTEMPTS;
      const lockUntil  = shouldLock ? Date.now() + ACCOUNT_LOCK_DURATION : 0;

      await db.query(
        "UPDATE users SET login_attempts=$1, locked_until=$2 WHERE email=$3",
        [newAttempts, lockUntil, norm]
      );
      invalidateSessionCache(norm);
      recordIpFail(ip);

      if (shouldLock) {
        console.warn(`🔒 حساب مقفل: ${norm} (${newAttempts} محاولة من IP: ${ip})`);
        return res.json({ ok: false, msg: `🔒 تم قفل الحساب لـ 15 دقيقة بعد ${newAttempts} محاولات فاشلة.` });
      }

      const remaining = ACCOUNT_LOCK_ATTEMPTS - newAttempts;
      return res.json({ ok: false, msg: `كلمة المرور غير صحيحة. ${remaining} محاولة متبقية قبل القفل.` });
    }

    // ❻ تسجيل دخول ناجح — إعادة ضبط العداد
    await db.query(
      "UPDATE users SET login_attempts=0, locked_until=0, last_seen=$1 WHERE email=$2",
      [Date.now(), norm]
    );
    resetIpFails(ip);
    invalidateSessionCache(norm);

    const token = generateToken();
    await db.query(
      "INSERT INTO sessions (token, user_id, created_at, last_used) VALUES ($1,$2,$3,$3)",
      [token, norm, Date.now()]
    );

    res.json({ ok: true, token, user: formatUser(user) });
  } catch (e) {
    console.error("login error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
});

// ══════════════════════════════════════════════
// تأكيد البريد الإلكتروني بالكود
// ══════════════════════════════════════════════
app.post("/api/auth/verify-email", async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.json({ ok: false, msg: "البريد والكود مطلوبان" });
    const norm = email.toLowerCase().trim();
    const rows = await db.query(
      "SELECT * FROM email_verification_tokens WHERE token=$1 AND email=$2 AND used=FALSE",
      [String(code).trim(), norm]
    );
    if (!rows.rows.length) return res.json({ ok: false, msg: "❌ الكود غير صحيح" });
    if (Date.now() > rows.rows[0].expires_at)
      return res.json({ ok: false, msg: "❌ انتهت صلاحية الكود — اطلب كوداً جديداً" });

    await db.query("UPDATE users SET email_verified=TRUE WHERE email=$1", [norm]);
    await db.query("UPDATE email_verification_tokens SET used=TRUE WHERE token=$1", [String(code).trim()]);

    const verifiedRow = await db.query("SELECT * FROM users WHERE email=$1", [norm]);
    if (verifiedRow.rows[0]?.account_type === "teacher" &&
        verifiedRow.rows[0]?.teacher_status !== "approved") {
      return res.json({
        ok: true, teacherPending: true, email: norm,
        msg: "تم تأكيد البريد، وطلبك الآن بانتظار موافقة المدير."
      });
    }
    const token = generateToken();
    await db.query(
      "INSERT INTO sessions (token, user_id, created_at, last_used) VALUES ($1,$2,$3,$3)",
      [token, norm, Date.now()]
    );
    console.log(`✅ تم تأكيد البريد: ${norm}`);
    res.json({ ok: true, token, user: formatUser(verifiedRow.rows[0]) });
  } catch (e) {
    console.error("verify-email error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
});

app.post("/api/auth/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ ok: false, msg: "البريد الإلكتروني مطلوب" });
    const norm = email.toLowerCase().trim();
    const uRow = await db.query("SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL", [norm]);
    if (!uRow.rows.length) return res.json({ ok: false, msg: "البريد غير مسجل" });
    if (uRow.rows[0].email_verified) return res.json({ ok: false, msg: "البريد مؤكد مسبقاً" });

    const code   = String(Math.floor(100000 + Math.random() * 900000));
    const expiry = Date.now() + 15 * 60_000;
    await db.query("DELETE FROM email_verification_tokens WHERE email=$1", [norm]);
    await db.query(
      "INSERT INTO email_verification_tokens (token, email, expires_at, used, created_at) VALUES ($1,$2,$3,FALSE,$4)",
      [code, norm, expiry, Date.now()]
    );
    await sendVerificationEmail(norm, code, uRow.rows[0].full_name || "");
    res.json({ ok: true, msg: "تم إرسال كود جديد على بريدك" });
  } catch (e) {
    console.error("resend-verification error:", e.message);
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

// رمز الموظف — يُنشأ تلقائياً للحسابات القديمة التي لا تملك رمزاً
app.get("/api/auth/employee-code", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.status(401).json({ ok: false, msg: "غير مصرح" });
    if (!user.is_moderator || user.is_admin || user.is_super_admin) {
      return res.status(403).json({ ok: false, msg: "هذا الحساب ليس حساب موظف" });
    }
    if (user.employee_code) {
      return res.json({ ok: true, employeeCode: user.employee_code });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const code = generateEmployeeCode();
        const updated = await db.query(
          "UPDATE users SET employee_code=$1 WHERE email=$2 AND employee_code IS NULL RETURNING employee_code",
          [code, user.email]
        );
        if (updated.rows.length) {
          invalidateSessionCache(user.email);
          broadcastEvent({ type: "users_updated" });
          return res.json({ ok: true, employeeCode: updated.rows[0].employee_code });
        }
        const fresh = await db.query("SELECT employee_code FROM users WHERE email=$1", [user.email]);
        return res.json({ ok: true, employeeCode: fresh.rows[0]?.employee_code || null });
      } catch (e) {
        if (attempt === 4) throw e;
      }
    }
    res.status(500).json({ ok: false, msg: "تعذر إنشاء رمز الموظف" });
  } catch (e) {
    console.error("employee-code error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
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

// ══════════════════════════════════════════════
// استعادة كلمة المرور — طلب الرابط
// ══════════════════════════════════════════════
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ ok: false, msg: "يرجى إدخال البريد الإلكتروني" });

    const norm = email.toLowerCase().trim();
    const rows = await db.query(
      "SELECT email, full_name, banned, deleted_at FROM users WHERE email=$1", [norm]
    );

    // دائماً أرسل رسالة إيجابية حتى لا يكشف عن وجود الإيميل
    if (!rows.rows.length || rows.rows[0].deleted_at || rows.rows[0].banned) {
      return res.json({ ok: true, msg: "إذا كان البريد مسجلاً، ستصلك رسالة قريباً" });
    }

    const user = rows.rows[0];

    // احذف أي توكنات قديمة لهذا الإيميل
    await db.query("DELETE FROM password_reset_tokens WHERE email=$1", [norm]);

    // أنشئ توكن جديد
    const token      = randomBytes(32).toString("hex");
    const expiresAt  = Date.now() + 60 * 60_000; // ساعة واحدة
    await db.query(
      "INSERT INTO password_reset_tokens (token, email, expires_at, used, created_at) VALUES ($1,$2,$3,FALSE,$4)",
      [token, norm, expiresAt, Date.now()]
    );

    // أرسل الإيميل
    const sent = await sendResetEmail(norm, token, user.full_name);
    if (!sent) {
      console.warn(`⚠️ فشل إرسال إيميل استعادة كلمة المرور إلى: ${norm}`);
    }

    // دائماً أرسل رسالة إيجابية — لا نكشف عن فشل الإرسال للمستخدم
    res.json({ ok: true, msg: "إذا كان البريد مسجلاً، ستصلك رسالة قريباً" });
  } catch (e) {
    console.error("forgot-password error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
});

// ══════════════════════════════════════════════
// استعادة كلمة المرور — تعيين كلمة مرور جديدة
// ══════════════════════════════════════════════
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword)
      return res.json({ ok: false, msg: "بيانات ناقصة" });

    if (newPassword.length < 6)
      return res.json({ ok: false, msg: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });

    // تحقق من التوكن
    const rows = await db.query(
      "SELECT * FROM password_reset_tokens WHERE token=$1 AND used=FALSE", [token]
    );
    if (!rows.rows.length)
      return res.json({ ok: false, msg: "رابط الاستعادة غير صالح أو منتهي" });

    const resetRow = rows.rows[0];
    if (Date.now() > resetRow.expires_at)
      return res.json({ ok: false, msg: "انتهت صلاحية رابط الاستعادة. أطلب رابطاً جديداً." });

    // حدّث كلمة المرور وألغِ التوكن
    await db.query("UPDATE users SET password_hash=$1, login_attempts=0, locked_until=0 WHERE email=$2",
      [hashPassword(newPassword), resetRow.email]
    );
    await db.query("UPDATE password_reset_tokens SET used=TRUE WHERE token=$1", [token]);

    // أنهِ جميع جلسات المستخدم (تسجيل خروج من كل الأجهزة)
    await db.query("DELETE FROM sessions WHERE user_id=$1", [resetRow.email]);
    invalidateSessionCache(resetRow.email);

    console.log(`✅ كلمة المرور أُعيدت لـ: ${resetRow.email}`);
    res.json({ ok: true, msg: "تم تغيير كلمة المرور بنجاح. يمكنك تسجيل الدخول الآن." });
  } catch (e) {
    console.error("reset-password error:", e.message);
    res.status(500).json({ ok: false, msg: "خطأ في الخادم" });
  }
});

// التحقق من صحة توكن الاستعادة (للواجهة)
app.get("/api/auth/reset-password/verify", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.json({ ok: false, msg: "توكن مفقود" });
    const rows = await db.query(
      "SELECT email, expires_at FROM password_reset_tokens WHERE token=$1 AND used=FALSE", [token]
    );
    if (!rows.rows.length) return res.json({ ok: false, msg: "رابط غير صالح" });
    if (Date.now() > rows.rows[0].expires_at) return res.json({ ok: false, msg: "انتهت صلاحية الرابط" });
    res.json({ ok: true, email: rows.rows[0].email });
  } catch { res.json({ ok: false, msg: "خطأ في الخادم" }); }
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
    const val = decodeURIComponent(req.params.id);
    await db.query("DELETE FROM codes WHERE id=$1 OR code=$1", [val]);
    broadcastEvent({ type: "codes_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/codes/:id", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
    await db.query("DELETE FROM ads WHERE ad_id=$1", [req.params.id]);
    broadcastEvent({ type: "ads_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/ads/:id", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
    await db.query("UPDATE feedback SET read=TRUE WHERE feedback_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ ok: false }); }
});

app.delete("/api/feedback/:id", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
    await db.query("DELETE FROM feedback WHERE feedback_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ ok: false }); }
});

// ══════════════════════════════════════════════
// 12. Settings — الإعدادات
// ══════════════════════════════════════════════
// إعدادات آمنة للواجهة العامة فقط — لا تُرجع مفاتيح API أو بيانات الإدارة.
const PUBLIC_SETTING_KEYS = new Set([
  "systemName", "primaryColor", "social_links", "sala_store_url",
  "adsEnabled", "servicesOrder", "screenBanners", "socialFooterText",
  "svcSettings", "subscriptionPrice", "allowRegistration",
  "welcomeMessage", "allFree", "allFreeStamp"
]);

app.get("/api/public/settings", async (_req, res) => {
  try {
    const all = await db.query("SELECT key, value FROM settings");
    const result = {};
    for (const row of all.rows) {
      if (PUBLIC_SETTING_KEYS.has(row.key)) result[row.key] = row.value;
    }
    res.set("Cache-Control", "no-store");
    res.json(result);
  } catch {
    res.json({});
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
    const all = await db.query("SELECT * FROM settings");
    const result = {};
    for (const row of all.rows) result[row.key] = row.value;
    res.json(result);
  } catch { res.json({}); }
});

app.post("/api/settings", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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


// تعديل المستخدم من لوحة الإدارة — المسار الموحد الذي تستخدمه الواجهة
app.patch("/api/users/:email", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: "forbidden", msg: "غير مصرح" });

    const email = decodeURIComponent(req.params.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ ok: false, msg: "البريد الإلكتروني مطلوب" });

    const found = await db.query("SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL", [email]);
    if (!found.rows.length) return res.status(404).json({ ok: false, msg: "المستخدم غير موجود" });

    const body = req.body || {};
    const setParts = [];
    const values = [];
    const add = (column, value) => {
      setParts.push(column + "=$" + (values.length + 1));
      values.push(value);
    };

    if (typeof body.fullName !== "undefined") add("full_name", String(body.fullName || "").trim().slice(0, 120));
    if (typeof body.isModerator !== "undefined") add("is_moderator", body.isModerator === true);
    if (typeof body.isAdmin !== "undefined") add("is_admin", body.isAdmin === true);
    if (typeof body.permissions !== "undefined") add("permissions", JSON.stringify(sanitizePermissions(body.permissions)));
    if (typeof body.banned !== "undefined") add("banned", body.banned === true);
    if (typeof body.emailVerified !== "undefined") add("email_verified", body.emailVerified === true);
    if (typeof body.premiumExpiry !== "undefined") {
      const expiry = Number(body.premiumExpiry);
      if (!Number.isFinite(expiry) || expiry < 0) return res.status(400).json({ ok: false, msg: "قيمة الاشتراك غير صحيحة" });
      add("premium_expiry", Math.trunc(expiry));
    }
    if (typeof body.activationCode !== "undefined") add("activation_code", body.activationCode ? String(body.activationCode).slice(0, 200) : null);
    if (typeof body.employeeCode !== "undefined") {
      const employeeCode = String(body.employeeCode || "").trim();
      if (!/^\d{4}$/.test(employeeCode)) {
        return res.status(400).json({ ok: false, msg: "رمز الموظف يجب أن يكون 4 أرقام فقط" });
      }
      const owner = await db.query(
        "SELECT email FROM users WHERE employee_code=$1 AND email<>$2 LIMIT 1",
        [employeeCode, email]
      );
      if (owner.rows.length) {
        return res.status(409).json({ ok: false, msg: "رمز الموظف مستخدم مسبقاً، اختر رمزاً آخر" });
      }
      add("employee_code", employeeCode);
    }
    if (typeof body.password !== "undefined" && String(body.password).length > 0) {
      const password = String(body.password);
      if (password.length < 6) return res.status(400).json({ ok: false, msg: "كلمة المرور 6 أحرف على الأقل" });
      add("password_hash", hashPassword(password));
      add("login_attempts", 0);
      add("locked_until", 0);
    }

    // حساب الموظف الذي يُرقّى إدارياً لا يتوقف على تأكيد البريد
    if (body.isModerator === true && typeof body.emailVerified === "undefined") add("email_verified", true);
    if (body.isModerator === false && typeof body.permissions === "undefined") add("permissions", JSON.stringify({}));

    if (!setParts.length) return res.status(400).json({ ok: false, msg: "لا توجد تغييرات" });

    values.push(email);
    const updated = await db.query(
      "UPDATE users SET " + setParts.join(", ") + " WHERE email=$" + values.length + " AND deleted_at IS NULL RETURNING *",
      values
    );
    if (!updated.rows.length) return res.status(404).json({ ok: false, msg: "المستخدم غير موجود" });

    invalidateSessionCache(email);
    await auditLog("admin_update_user", email, {
      email,
      fields: setParts.map((part) => part.split("=")[0]),
      ip: getClientIp(req)
    });
    broadcastEvent({ type: "users_updated" });
    if (typeof body.premiumExpiry !== "undefined") {
      broadcastEvent({ type: "subscription_updated", email, premiumExpiry: Number(body.premiumExpiry) || 0 });
    }
    res.json({ ok: true, user: formatUser(updated.rows[0]) });
  } catch (e) {
    console.error("admin user update error:", e.message);
    res.status(500).json({ ok: false, error: "server_error", msg: "خطأ في الخادم" });
  }
});
app.get("/api/users/list", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
    const all = await db.query(
      "SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC"
    );
    res.json(all.rows.map(formatUser));
  } catch { res.json([]); }
});

app.patch("/api/users/:email/ban", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
    const { banned } = req.body;
    const email = decodeURIComponent(req.params.email);
    await db.query("UPDATE users SET banned=$1 WHERE email=$2", [!!banned, email]);
    invalidateSessionCache(email);
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "server error" }); }
});

// رفع قفل Brute Force عن حساب (إدارة فقط)
app.patch("/api/users/:email/unlock", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
    const email = decodeURIComponent(req.params.email);
    await db.query(
      "UPDATE users SET login_attempts=0, locked_until=0 WHERE email=$1",
      [email]
    );
    invalidateSessionCache(email);
    console.log(`🔓 رُفع قفل الحساب: ${email}`);
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true, msg: "تم رفع القفل عن الحساب" });
  } catch { res.status(500).json({ error: "server error" }); }
});

app.patch("/api/users/:email/role", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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

// 📚 Study reward endpoint — تفعيل اشتراك 3 أشهر مجاناً عند إكمال 200 مهمة دراسية
// Secured: requires valid session token + one-time per user (study_rewarded flag)
app.post("/api/users/study-reward", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const user = await getSessionUser(token);
    if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });

    try { await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS study_rewarded BOOLEAN DEFAULT FALSE"); } catch {}

    const fresh = await db.query("SELECT premium_expiry, study_rewarded FROM users WHERE email=$1", [user.email]);
    const row = fresh.rows[0] || {};
    if (row.study_rewarded) {
      return res.status(409).json({ ok: false, error: "already_rewarded" });
    }

    const months3 = 3 * 30 * 24 * 60 * 60 * 1000;
    const base = Math.max(Date.now(), Number(row.premium_expiry) || 0);
    const newExpiry = base + months3;

    await db.query(
      "UPDATE users SET premium_expiry=$1, study_rewarded=TRUE WHERE email=$2",
      [newExpiry, user.email]
    );
    invalidateSessionCache(user.email);
    broadcastEvent({ type: "subscription_updated", email: user.email, premiumExpiry: newExpiry });
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true, premiumExpiry: newExpiry, daysLeft: 90 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 🎮 Game reward endpoint — تفعيل الاشتراك فوري عند الفوز باللعبة (بدون تدخل المدير)
// Secured: requires valid session token + one-time per user (game_rewarded flag)
app.post("/api/users/game-reward", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const user = await getSessionUser(token);
    if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });

    // Ensure column exists for tracking one-time game reward
    try { await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS game_rewarded BOOLEAN DEFAULT FALSE"); } catch {}

    const fresh = await db.query("SELECT premium_expiry, game_rewarded FROM users WHERE email=$1", [user.email]);
    const row = fresh.rows[0] || {};
    if (row.game_rewarded) {
      return res.status(409).json({ ok: false, error: "already_rewarded" });
    }

    const month1 = 30 * 24 * 60 * 60 * 1000;
    const base = Math.max(Date.now(), Number(row.premium_expiry) || 0);
    const newExpiry = base + month1;

    await db.query(
      "UPDATE users SET premium_expiry=$1, game_rewarded=TRUE WHERE email=$2",
      [newExpiry, user.email]
    );
    invalidateSessionCache(user.email);
    broadcastEvent({ type: "subscription_updated", email: user.email, premiumExpiry: newExpiry });
    broadcastEvent({ type: "users_updated" });
    res.json({ ok: true, premiumExpiry: newExpiry, daysLeft: 30 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.delete("/api/users/:email", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
    if (!(await isAdminRequest(req))) return res.status(403).json({ error: "forbidden" });
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
  const p1 = path.join(__dirname, "public", "index.html");
  const p2 = path.join(__dirname, "..", "public", "index.html");
  res.sendFile(p1, (err) => {
    /* لا تحاول إرسال ملف ثانٍ بعد بدء إرسال الملف الأول */
    if (err && !res.headersSent && !res.writableEnded) res.sendFile(p2);
  });
});

app.get("/download-reset-page", (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="reset-password.html"');
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const p1 = path.join(__dirname, "public", "reset-password.html");
  const p2 = path.join(__dirname, "..", "public", "reset-password.html");
  res.sendFile(p1, (err) => {
    if (err && !res.headersSent && !res.writableEnded) res.sendFile(p2);
  });
});

app.get("/download-server", (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="server.js"');
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "server.js"));
});

app.get("/download-pkg", (_req, res) => {
  res.sendFile(path.join(__dirname, "package.json"));
});

// ══════════════════════════════════════════════
// 17.5 OpenRouter AI Proxy — مفتاح API محمي خلف السيرفر
// ══════════════════════════════════════════════
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
// OpenRouter model IDs must include the provider prefix. Invalid/old environment
// values are ignored so the server does not fall back to an invalid model.
function safeOpenRouterModel(value, fallback) {
  const model = String(value || "").trim();
  if (
    !model
    || !model.includes("/")
    || model === "llama-3.3-70b-versatile"
    || model === "anthropic/claude-3.5-sonnet"
  ) {
    return fallback;
  }
  return model;
}
// نماذج OpenRouter المستخدمة بالترتيب:
// Gemini ثم GPT للمراجعة، وبعدها Claude وDeepSeek وQwen وLlama كبدائل.
// كل الطلبات تمر من OPENROUTER_API_KEY، ولا نحتاج مفاتيح منفصلة.
//
// Blackbox اختياري لأن اسم الموديل يتغير حسب ما هو متاح في OpenRouter.
// لتفعيله أضف AI_BLACKBOX_MODEL بالمعرّف الظاهر في OpenRouter.
const OPENROUTER_MODELS = [
  safeOpenRouterModel(process.env.AI_PRIMARY_MODEL, "google/gemini-2.5-pro"),
  safeOpenRouterModel(process.env.AI_REVIEW_MODEL, "openai/gpt-4.1-mini"),
  safeOpenRouterModel(process.env.AI_CLAUDE_MODEL, "anthropic/claude-sonnet-4"),
  safeOpenRouterModel(process.env.AI_DEEPSEEK_MODEL, "deepseek/deepseek-chat-v3.1"),
  safeOpenRouterModel(process.env.AI_QWEN_MODEL, "qwen/qwen-2.5-72b-instruct"),
  safeOpenRouterModel(process.env.AI_LLAMA_MODEL, "meta-llama/llama-3.3-70b-instruct"),
  safeOpenRouterModel(process.env.AI_FALLBACK_MODEL, "deepseek/deepseek-chat-v3.1"),
  ...(process.env.AI_BLACKBOX_MODEL
    ? [safeOpenRouterModel(process.env.AI_BLACKBOX_MODEL, "")]
    : [])
].filter((model, index, all) => model && all.indexOf(model) === index);
const ARABIC_MODEL = safeOpenRouterModel(
  process.env.AI_ARABIC_MODEL,
  "google/gemini-2.5-pro"
);
const REVIEW_MODELS = [
  safeOpenRouterModel(process.env.AI_REVIEW_MODEL, "openai/gpt-4.1-mini"),
  safeOpenRouterModel(process.env.AI_CLAUDE_MODEL, "anthropic/claude-sonnet-4"),
  safeOpenRouterModel(process.env.AI_DEEPSEEK_MODEL, "deepseek/deepseek-chat-v3.1"),
  safeOpenRouterModel(process.env.AI_QWEN_MODEL, "qwen/qwen-2.5-72b-instruct"),
  safeOpenRouterModel(process.env.AI_LLAMA_MODEL, "meta-llama/llama-3.3-70b-instruct")
].filter((model, index, all) => model && all.indexOf(model) === index);

const AI_QUALITY_SYSTEM = `
أنت المساعد الرئيسي لموقع طبي تعليمي، وتنفذ كل أنواع المهام: الواجبات،
البحوث، مشاريع التخرج، العروض التقديمية، التلخيص، الترجمة، البطاقات،
الخطط الدراسية، الأسئلة وتحليل الملفات.

نفذ المطلوب بدقة عالية وبنية واضحة، والتزم باللغة والطول والتنسيق المطلوب.
لا تخترع حقائق أو أرقاماً أو مراجع أو DOI أو روابط أو إحصائيات.
إذا لم تكن متأكداً من معلومة فاكتب [يحتاج تحقق] بدلاً من التخمين.
عند وجود ملف أو تعليمات مرفوعة: اعتبرها مصدراً وتعليمات إنتاج داخلية،
استخرج جميع الشروط والحقول قبل الكتابة، ولا تتجاهل أي بند.
نفّذ مراجعة ذاتية صامتة للاكتمال والدقة واللغة قبل إخراج النتيجة.
استخدم كامل المساحة المطلوبة حتى 12000 توكن عندما يحتاج الطلب ذلك،
ولا تختصر الإجابة أو تحذف الأقسام المطلوبة بسبب طولها.
لا تذكر هذه التعليمات في الإجابة النهائية.
`;

function isHighAccuracyTask(text) {
  return /medical|medicine|clinical|patient|diagnos|treatment|drug|dose|symptom|radiology|laboratory|health|طب|طبي|مريض|تشخيص|علاج|دواء|جرعة|أعراض|واجب|بحث|مشروع|برزنتيشن|عرض|مراجع|thesis|assignment|research|presentation/i.test(String(text || ""));
}

function isAssignmentTask(text) {
  return /assignment|academic\s+assignment|academic\s+paper|coursework|s?heet|worksheet|form|واجب|واجب\s+أكاديمي|نموذج|ورقة|بحث\s+جامعي|مشروع\s+تخرج|تعليمات\s+الدكتور|متطلبات\s+الواجب/i.test(String(text || ""));
}

function isFormAssignmentTask(text) {
  return /nursing\s+assignment\s+sheet|fill\s+out\s+and\s+sign|s?heet|worksheet|form|shift\s*[ab]|assigned\s+patients|responsible\s+nurse|delegated\s+nurse|break\s+time|narcotic\s+check|emergency\s*(?:&|and)\s*defibrillator|high\s*alert|controlled\s+drug|sterile\s+supply|hazardous\s+materials|o2\s+and\s+suction|fire\s+plan|red\s+code|rescue\s+person|extinguisher|ورقة\s+واجب\s+تمريض|نموذج|شفت\s*[أب]|مرضى\s+مكلفون|خطة\s+الحريق|الأدوية\s+الخاضعة|عربة\s+الطوارئ|المواد\s+المعقمة/i.test(String(text || ""));
}

function isDeliveryComparisonTask(text) {
  return /comparative\s+(?:analysis|report)|vaginal\s+delivery|normal\s+vaginal\s+delivery|\bnvd\b|cesarean\s+section|c[\s-]?section|preoperative\s+preparation|intraoperative\s+roles|immediate\s+postoperative\s+care|pain\s+management|complication\s+prevention/i.test(String(text || ""));
}

function requiresComparisonTable(text) {
  return /comparison\s+table|comparative\s+table|comparative\s+(?:analysis|report)|vaginal\s+delivery.*(?:cesarean|c[\s-]?section)|cesarean.*vaginal\s+delivery|include\s+(?:one\s+)?(?:clear\s+)?comparison|جدول\s+مقارنة|جدول\s+مقارن|مقارنة\s+واضحة/i.test(String(text || ""));
}

function containsMarkdownTable(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
  return lines.filter((line) => /^\|.+\|$/.test(line)).length >= 3
    && lines.some((line) => /^\|?\s*:?-{3,}/.test(line));
}

function assignmentWordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function extractAssignmentRequirementLabels(prompt) {
  const source = String(prompt || "");
  const blocks = [
    source.match(/Required visible labels, fields, headings, and rubric items:\s*([\s\S]*?)\nTreat the supplied text/i),
    source.match(/قائمة البنود\/العناوين\/الحقول التي يجب أن تظهر في الناتج:\s*([\s\S]*?)\nتعامل مع النص/i)
  ].filter(Boolean);
  if (!blocks.length) return [];
  return String(blocks[0][1] || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter((line) => line && !/^\[.*\]$/.test(line))
    .map((line) => line.replace(/[*_`|]/g, "").trim())
    .filter((line) => line.length >= 3 && line.length <= 100)
    .slice(0, 80);
}

function auditAssignmentQuality(text, prompt) {
  const output = String(text || "").trim();
  const source = String(prompt || "");
  const issues = [];
  const words = assignmentWordCount(output);
  const targetMatch = source.match(/(?:Word count|عدد الكلمات المطلوبة)\s*[:：]\s*~?\s*(\d{3,6})/i);
  const target = targetMatch ? Number(targetMatch[1]) : 0;

  if (!output || words < 200) issues.push("الناتج قصير أو فارغ");
  if (target && words < Math.floor(target * 0.88)) {
    issues.push(`عدد الكلمات أقل من المطلوب (${words}/${target})`);
  }
  if (/```|<script\b|<style\b|APPLUS_ACADEMIC_CONTRACT|A\+_ASSIGNMENT_FORMAT/i.test(output)) {
    issues.push("تسريب تعليمات أو كود داخل الواجب");
  }
  if (requiresComparisonTable(source) && !containsMarkdownTable(output)) {
    issues.push("جدول المقارنة المطلوب غير موجود");
  }

  const compact = output.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const missingLabels = extractAssignmentRequirementLabels(source).filter((label) => {
    const low = label.toLowerCase();
    const normalized = low.replace(/[^\p{L}\p{N}]+/gu, "");
    return !output.toLowerCase().includes(low) && !compact.includes(normalized);
  });
  if (missingLabels.length) issues.push(`بنود ناقصة: ${missingLabels.slice(0, 8).join("، ")}`);

  return {
    ok: issues.length === 0,
    score: issues.length === 0 ? 10 : Math.max(0, 10 - Math.min(issues.length, 10)),
    issues,
    words,
    target,
    missingLabels
  };
}

async function enforceAssignmentQualityGate(content, prompt, systemPrompt, model, maxTokens) {
  let current = String(content || "").trim();
  let audit = auditAssignmentQuality(current, prompt);
  for (let attempt = 0; !audit.ok && attempt < 4; attempt++) {
    const repairPrompt = `
هذه بوابة جودة إلزامية لواجب أكاديمي.
لا تُخرج النسخة الحالية كما هي. أصلح كل الملاحظات ثم أخرج الواجب كاملاً فقط.
يجب أن تصبح نتيجة الفحص الداخلي 10/10:
${audit.issues.map((issue) => `- ${issue}`).join("\n")}

تعليمات الدكتور والطلب الأصلي:
${String(prompt).slice(0, 60000)}

النسخة الحالية:
${current.slice(0, 60000)}

قواعد الإصلاح:
- لا تحذف أي قسم أو جدول أو حقل موجود.
- لا تضف مراجع أو DOI أو أرقاماً غير قابلة للتحقق.
- حافظ على لغة الواجب وتنسيقه المطلوبين.
- أخرج النص النهائي فقط، بلا شرح للفحص أو الإصلاح.
`;
    const repaired = await openRouterCompletion(
      model,
      [
        { role: "system", content: [AI_QUALITY_SYSTEM, systemPrompt].filter(Boolean).join("\n\n") },
        { role: "user", content: repairPrompt }
      ],
      maxTokens,
      0.05
    );
    if (!repaired.ok || !String(repaired.content || "").trim()) break;
    current = repaired.content.trim();
    audit = auditAssignmentQuality(current, prompt);
  }
  return { content: current, audit };
}

const FORM_ASSIGNMENT_RULES = `
هذا طلب تعبئة نموذج تمريضي، وليس مقالاً أو تقريراً نظرياً.
إذا كان الطلب يتضمن Nursing Assignment Sheet أو Shift A/B:
- أخرج ورقة النموذج فقط؛ لا تضف غلافاً أو مقدمة أو فهرساً أو خاتمة أو مراجع أو معلومات جامعة مكررة.
- لا تكرر Basic Info أو أي جدول أو Shift A أو Shift B؛ كل جزء يظهر مرة واحدة فقط.
- أخرج نموذجاً منظماً بعناوين واضحة للشفت A ثم الشفت B.
- إذا لم يزوّد المستخدم بيانات فعلية وكان المطلوب نموذجاً مكتملاً، أنشئ بيانات تدريبية افتراضية متسقة
  (أسماء غير حقيقية، مرضى بأرقام رمزية، أوقات منطقية، وعدد مرضى متوافق مع الجدول)،
  وضع في أعلى الناتج: "نموذج تدريبي — البيانات افتراضية".
- لا تنسب البيانات الافتراضية إلى مستشفى أو أشخاص حقيقيين، ولا تستخدم معلومات شخصية حقيقية.
- لا تترك خانات أساسية فارغة أو تكتب [يُستكمل] عندما يمكن إكمالها ببيانات تدريبية افتراضية.
- لا تختلق توقيعاً؛ اكتب "Student signature required" مرة واحدة في نهاية النموذج ليوقّعه الطالب يدوياً.
- استخدم N/A فقط عندما تكون الخانة غير منطبقة فعلاً، ولا تستخدم [Not provided] أو [غير متوفر] داخل النموذج.
- حافظ على جميع الحقول: Floor/Unit، Head Nurse، Total Patients، CPR Team، Date،
  Assigned Patients، Responsible Nurse، Delegated Nurse، Break Time،
  Narcotic Check، Emergency & Defibrillator، High Alert Cabinet & Refrigerator،
  Controlled Drug، Sterile Supply، Hazardous Materials، O2 and Suction،
  Rescue Person، Red Code، Activate Alarm، Extinguisher Use، Signature.
- لا تكتب مقدمة أو خاتمة أو مراجع أو شرحاً خارج النموذج.
- استخدم جداول Markdown منفصلة للشفت A وB حتى يمكن تحويلها إلى PDF لاحقاً.
`;

const DELIVERY_COMPARISON_RULES = `
هذا تقرير مقارن عن الولادة المهبلية الطبيعية (NVD) والقيصرية الاختيارية/الطارئة، وليس شرحاً عاماً عن الولادة.
- اكتب مقارنة مباشرة ومتوازنة بين NVD وC-Section، مع توضيح الفروق في كل محور مطلوب:
  التحضير قبل العملية، أدوار الفريق أثناء الإجراء، الرعاية الفورية بعد الولادة/العملية،
  تدبير الألم، واستراتيجيات منع المضاعفات.
- أضف جدول مقارنة واضحاً يضع NVD وC-Section في عمودين متقابلين، ثم ناقش كل محور في قسم مستقل.
- ميّز صراحة بين القيصرية الاختيارية والقيصرية الطارئة، ولا تخلط بين المخاطر أو الأولويات التمريضية.
- ركّز على مسؤوليات التمريض، المراقبة، السلامة، تثقيف المريضة، ومؤشرات التصعيد؛ لا تكتب وصفاً جراحياً غير مطلوب.
- لا تكرر الفكرة نفسها في أكثر من قسم، ولا تضف غلافاً أو فهرساً أو خاتمة أو مراجع إلا إذا طلبتها التعليمات الأصلية.
- لا تخترع إحصاءات أو مراجع أو أرقام صفحات. استخدم مصادر قابلة للتحقق فقط، واذكر بوضوح ما يحتاج تحققاً.
`;

async function openRouterCompletion(model, messages, maxTokens, temperature = 0.1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "HTTP-Referer": process.env.FRONTEND_URL || "https://aplus.blog",
        "X-Title": "A+ Medical"
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: 0.9,
        stream: false
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: String(data?.error?.message || "").slice(0, 240)
      };
    }
    const content = String(data?.choices?.[0]?.message?.content || "").trim();
    return content
      ? { ok: true, content, model }
      : { ok: false, status: 502, message: "empty_response" };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? 504 : 503,
      message: error?.name === "AbortError" ? "timeout" : (error?.message || "network")
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateAssignmentWithReview(prompt, systemPrompt, maxTokens, isArabicRequest) {
  const primaryModel = isArabicRequest ? ARABIC_MODEL : OPENROUTER_MODELS[0];
  const formTask = isFormAssignmentTask(`${systemPrompt || ""}\n${prompt || ""}`);
  const deliveryComparisonTask = isDeliveryComparisonTask(`${systemPrompt || ""}\n${prompt || ""}`);
  const effectiveSystemPrompt = [
    systemPrompt,
    formTask ? FORM_ASSIGNMENT_RULES : "",
    deliveryComparisonTask && !formTask ? DELIVERY_COMPARISON_RULES : ""
  ].filter(Boolean).join("\n\n");
  const draftMessages = [
    { role: "system", content: [AI_QUALITY_SYSTEM, effectiveSystemPrompt].filter(Boolean).join("\n\n") },
    { role: "user", content: String(prompt) }
  ];
  const draft = await openRouterCompletion(primaryModel, draftMessages, maxTokens, 0.1);
  if (!draft.ok) return draft;

  // مراجعة مستقلة نهائية: لا نستخدم الموديلات بالتوازي حتى لا تختلط أجزاء الواجب.
  const reviewModel = REVIEW_MODELS.find((model) => OPENROUTER_MODELS.includes(model))
    || primaryModel;
  const reviewPrompt = `
أنت محرر أكاديمي ومراجع جودة نهائي.
أعد كتابة المسودة التالية كنسخة نهائية جاهزة للتسليم، مع الالتزام الحرفي بطلب المستخدم وتعليمات الدكتور.
صحح البنية، اكتمال الأقسام، اللغة، التكرار، الترابط، والمعلومات غير الموثوقة.
 حافظ على كل قسم مطلوب وكل جدول وكل حقل موجود في المسودة؛ لا تختصر المحتوى ولا تحذف مطلباً لتقليل الطول.
لا تضف شرحاً عن المراجعة، ولا تذكر الذكاء الاصطناعي، ولا تضع قائمة تحقق.
لا تخترع مراجع أو DOI أو أرقاماً علمية. في نموذج التدريب فقط، استخدم أرقام مرضى وأوقاتاً
وبيانات طاقم افتراضية متسقة إذا لم يقدم المستخدم بيانات فعلية، مع إبقاء وسم "البيانات افتراضية".
أخرج نص الواجب النهائي فقط.
${formTask ? `\nهذه تعبئة نموذج وليست كتابة مقال:
${FORM_ASSIGNMENT_RULES}
تحقق أن الناتج يحتوي الشفت A وB وجميع الخانات المطلوبة، ولا يحول النموذج إلى تقرير نظري.` : ""}
${deliveryComparisonTask && !formTask ? `\nهذا تقرير مقارن عن NVD وC-Section:
${DELIVERY_COMPARISON_RULES}
تحقق أن المحاور الخمسة كلها موجودة وأن الجدول يقارن العمودين مباشرة.` : ""}

الطلب الأصلي وتعليمات الدكتور:
${String(prompt).slice(0, 60000)}

المسودة:
${String(draft.content).slice(0, 50000)}
`;
  const reviewed = await openRouterCompletion(
    reviewModel,
    [
      { role: "system", content: [AI_QUALITY_SYSTEM, effectiveSystemPrompt].filter(Boolean).join("\n\n") },
      { role: "user", content: reviewPrompt }
    ],
    maxTokens,
    0.1
  );
  if (!reviewed.ok) return draft;
  const draftWordCount = String(draft.content || "").trim().split(/\s+/).filter(Boolean).length;
  const reviewedWordCount = String(reviewed.content || "").trim().split(/\s+/).filter(Boolean).length;
  /* لا نستبدل مسودة كاملة بمراجعة قصّرت المحتوى بشكل واضح. */
  if (draftWordCount >= 500 && reviewedWordCount < Math.floor(draftWordCount * 0.72)) {
    return draft;
  }
  const gated = await enforceAssignmentQualityGate(
    reviewed.content,
    prompt,
    effectiveSystemPrompt,
    reviewModel,
    maxTokens
  );
  if (!gated.audit.ok) {
    return {
      ok: false,
      qualityGateFailed: true,
      status: 422,
      message: `assignment_quality_gate_failed:${gated.audit.issues.slice(0, 3).join("|")}`
    };
  }
  reviewed.content = gated.content;

  // إصلاح بنيوي أخير: إذا طلب الدكتور جدول مقارنة فلا نسمح بخروج الواجب بدونه.
  if (requiresComparisonTable(prompt) && !containsMarkdownTable(reviewed.content)) {
    const repaired = await openRouterCompletion(
      reviewModel,
      [
        {
          role: "system",
          content: [AI_QUALITY_SYSTEM, effectiveSystemPrompt].filter(Boolean).join("\n\n")
        },
        {
          role: "user",
          content: `أصلح هذه النسخة النهائية فقط.
الطلب الأصلي يشترط جدول مقارنة واضحاً، لكنه غير موجود.
أضف جدول Markdown حقيقياً متعدد الصفوف في القسم الأنسب، مع إبقاء بقية النص كما هو.
لا تحذف أي قسم، ولا تضف شرحاً عن التعديل، وأخرج الواجب كاملاً فقط.

الطلب:
${String(prompt).slice(0, 60000)}

النسخة الحالية:
${String(reviewed.content).slice(0, 60000)}`
        }
      ],
      maxTokens,
      0.05
    );
    return repaired.ok ? repaired : reviewed;
  }
  return reviewed;
}

// ══════════════════════════════════════════════
// OpenRouter — المسار الموحد باستخدام مفتاح المشروع
// لا يعتمد هذا المسار على GEMINI_API_KEY المباشر.
// ══════════════════════════════════════════════
app.post("/api/ai/call", async (req, res) => {
  const { provider = "gemini", prompt, systemPrompt = "", maxTokens } = req.body || {};
  if (provider !== "gemini") {
    res.status(400).json({ ok: false, error: "unsupported_ai_provider" });
    return;
  }
  if (!OPENROUTER_KEY) {
    console.error("[OpenRouter] OPENROUTER_API_KEY is not configured");
    res.status(503).json({ ok: false, error: "openrouter_key_not_configured" });
    return;
  }
  if (!prompt) {
    res.status(400).json({ ok: false, error: "prompt_required" });
    return;
  }
  if (String(prompt).length > AI_MAX_PROMPT_CHARS) {
    res.status(413).json({ ok: false, error: "prompt_too_large" });
    return;
  }
  const aiUser = await requireAiUser(req, res, maxTokens);
  if (!aiUser) return;

  const safeMaxTokens = Math.min(
    Math.max(Number(maxTokens) || 12000, 1000),
    AI_MAX_TOKENS_PER_REQUEST
  );

  const requestText = `${systemPrompt || ""}\n${prompt}`;
  const isArabicRequest = /[\u0600-\u06ff]/.test(requestText);
  const requestModels = isArabicRequest
    ? [ARABIC_MODEL, ...OPENROUTER_MODELS.filter((model) => model !== ARABIC_MODEL)]
    : OPENROUTER_MODELS;
  let lastError = null;

  try {
    if (isAssignmentTask(requestText)) {
      const qualityResult = await generateAssignmentWithReview(
        prompt,
        systemPrompt,
        safeMaxTokens,
        isArabicRequest
      );
      if (qualityResult.ok) {
        res.json({
          ok: true,
          content: qualityResult.content,
          provider: "openrouter-quality-pipeline",
          models: [isArabicRequest ? ARABIC_MODEL : OPENROUTER_MODELS[0], qualityResult.model]
        });
        return;
      }
      if (qualityResult.qualityGateFailed) {
        res.status(422).json({
          ok: false,
          error: "assignment_quality_gate_failed",
          detail: qualityResult.message
        });
        return;
      }
      lastError = qualityResult;
    }

    const messages = [
      { role: "system", content: [AI_QUALITY_SYSTEM, systemPrompt].filter(Boolean).join("\n\n") },
      { role: "user", content: String(prompt) }
    ];

    for (const model of requestModels) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_KEY}`,
            "HTTP-Referer": process.env.FRONTEND_URL || "https://aplus.blog",
            "X-Title": "A+ Medical"
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: safeMaxTokens,
            temperature: isHighAccuracyTask(requestText) ? 0.1 : 0.2,
            top_p: 0.9,
            stream: false
          }),
          signal: controller.signal
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          lastError = {
            status: response.status,
            message: String(data?.error?.message || "").slice(0, 240)
          };
          console.error("[OpenRouter] model failed", model, response.status, lastError.message);
          if (response.status === 401 || response.status === 403 || response.status === 402) break;
          continue;
        }
        const content = String(data?.choices?.[0]?.message?.content || "").trim();
        if (!content) {
          lastError = { status: 502, message: "empty_response" };
          continue;
        }
        res.json({ ok: true, content, provider: "openrouter", model });
        return;
      } catch (error) {
        lastError = {
          status: error?.name === "AbortError" ? 504 : 503,
          message: error?.name === "AbortError" ? "timeout" : (error?.message || "network")
        };
        console.error("[OpenRouter] model request failed", model, lastError.message);
        continue;
      } finally {
        clearTimeout(timeout);
      }
    }

    const retryable = lastError?.status >= 500 || lastError?.status === 429;
    res.status(retryable ? 503 : 502).json({
      ok: false,
      error: retryable ? "openrouter_temporarily_unavailable" : "openrouter_request_failed",
      detail: lastError?.message || undefined
    });
  } catch (error) {
    const message = error?.name === "AbortError" ? "timeout" : "network";
    console.error("[OpenRouter] request failed", message, error?.message || "");
    res.status(503).json({ ok: false, error: `openrouter_${message}` });
  }
});

// فحص آمن للسيرفر — لا يعرض المفتاح، لكنه يؤكد أن Render قرأه
app.get("/api/ai/status", (_req, res) => {
  res.json({
    ok: true,
    service: "openrouter",
    configured: Boolean(OPENROUTER_KEY),
    models: OPENROUTER_MODELS,
    route: "/api/ai/call"
  });
});

app.post("/api/openrouter/stream", async (req, res) => {
  if (!OPENROUTER_KEY) {
    console.error("[OpenRouter] OPENROUTER_API_KEY is not configured");
    res.status(503).json({ ok: false, error: "openrouter_key_not_configured" });
    return;
  }
  const { prompt, systemPrompt, maxTokens } = req.body || {};
  if (!prompt) {
    res.status(400).json({ ok: false, error: "prompt_required" });
    return;
  }
  if (String(prompt).length > AI_MAX_PROMPT_CHARS) {
    res.status(413).json({ ok: false, error: "prompt_too_large" });
    return;
  }
  const aiUser = await requireAiUser(req, res, maxTokens);
  if (!aiUser) return;
  const safeMaxTokens = Math.min(
    Math.max(Number(maxTokens) || 12000, 1000),
    AI_MAX_TOKENS_PER_REQUEST
  );

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const messages = [];
  const combinedSystem = [AI_QUALITY_SYSTEM, systemPrompt].filter(Boolean).join("\n\n");
  messages.push({ role: "system", content: combinedSystem });
  messages.push({ role: "user", content: prompt });

  let lastErr = null;
  let sentAny = false;
  const requestText = `${systemPrompt || ""}\n${prompt}`;
  const isArabicRequest = /[\u0600-\u06ff]/.test(requestText);
  const requestModels = isArabicRequest
    ? [ARABIC_MODEL, ...OPENROUTER_MODELS.filter((model) => model !== ARABIC_MODEL)]
    : OPENROUTER_MODELS;
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) clientGone = true;
  });
  console.log("[AI] stream request", {
    user: aiUser.email,
    promptChars: String(prompt).length,
    maxTokens: safeMaxTokens,
    models: requestModels
  });

  for (const model of requestModels) {
    if (clientGone) return;
    if (sentAny) break;
      /* لا نعيد الطلب نفسه مرتين لكل نموذج؛ ننتقل إلى النموذج الاحتياطي
         حتى لا تتراكم الطلبات وتظهر للمستخدم كأن الخدمة متقطعة. */
      for (let attempt = 0; attempt < 1; attempt++) {
      try {
        const ctrl = new AbortController();
        if (clientGone) return;
        const tm = setTimeout(() => ctrl.abort(), 90000);
        const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Authorization": `Bearer ${OPENROUTER_KEY}`,
            "HTTP-Referer": process.env.FRONTEND_URL || "https://aplus.blog",
            "X-Title": "A+ Medical"
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: safeMaxTokens,
            temperature: isHighAccuracyTask(`${systemPrompt}\n${prompt}`) ? 0.1 : 0.2,
            top_p: 0.9,
            stream: true
          }),
          signal: ctrl.signal
        });
        clearTimeout(tm);

        if (!upstream.ok) {
          const txt = await upstream.text().catch(() => "");
          lastErr = { status: upstream.status, body: txt };
          if (upstream.status === 401 || upstream.status === 403) break;
          if (upstream.status === 402) break;
          if (upstream.status === 429) { await sleep(1500); continue; }
          if (upstream.status >= 500) { await sleep(800); continue; }
          break;
        }

        if (!upstream.body) {
          lastErr = { status: 200, body: "empty_stream" };
          continue;
        }
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let attemptText = "";
        let upstreamError = null;
        while (true) {
          if (clientGone) {
            ctrl.abort();
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (let line of lines) {
            line = line.trim();
            if (!line || line === "data: [DONE]") continue;
            if (!line.startsWith("data: ")) continue;
            try {
              const d = JSON.parse(line.slice(6));
              if (d.error) {
                upstreamError = d.error;
                continue;
              }
              const c = d.choices?.[0]?.delta?.content;
              if (c) {
                attemptText += c;
                sentAny = true;
                res.write(`data: ${JSON.stringify({ text: c })}\n\n`);
              }
            } catch {}
          }
        }
        if (upstreamError && !attemptText.trim()) {
          lastErr = { status: 502, body: JSON.stringify(upstreamError) };
          continue;
        }
        if (!attemptText.trim()) {
          lastErr = { status: 200, body: "empty_stream" };
          continue;
        }
        res.write(`data: ${JSON.stringify({ msg: "done" })}\n\n`);
        res.end();
        return;
      } catch (e) {
        lastErr = e;
        const m = (e?.message || e?.name || String(e)).toLowerCase();
        if (m.includes("abort") || m.includes("timeout")) { await sleep(500); continue; }
        await sleep(500);
      }
    }
  }

  if (!sentAny) {
    let code = "network";
    if (lastErr && typeof lastErr === "object" && lastErr.status) {
      if (lastErr.status === 401 || lastErr.status === 403) code = "auth";
      else code = String(lastErr.status);
    } else {
      const m = (lastErr?.message || lastErr?.name || String(lastErr || "")).toLowerCase();
      if (m.includes("abort") || m.includes("timeout")) code = "timeout";
      else if (lastErr?.body === "empty_stream") code = "empty_response";
    }
    console.error("[OpenRouter] all models failed", {
      code,
      status: lastErr?.status || null,
      body: String(lastErr?.body || "").slice(0, 500),
      models: requestModels
    });
    res.write(`event: error\ndata: ${JSON.stringify({ error: code })}\n\n`);
    res.end();
  }
});

// Vision endpoint — تحليل الصور والملفات بموديلات Vision قوية
app.post("/api/openrouter/vision", async (req, res) => {
  if (!OPENROUTER_KEY) {
    console.error("[OpenRouter Vision] OPENROUTER_API_KEY is not configured");
    res.status(503).json({ ok: false, error: "openrouter_key_not_configured" });
    return;
  }
  const { imageBase64, prompt, maxTokens } = req.body || {};
  if (!imageBase64 || !prompt) {
    res.status(400).json({ ok: false, error: "missing_params" });
    return;
  }
  if (
    String(prompt).length > AI_MAX_PROMPT_CHARS ||
    String(imageBase64).length > AI_MAX_IMAGE_CHARS
  ) {
    res.status(413).json({ ok: false, error: "payload_too_large" });
    return;
  }
  const aiUser = await requireAiUser(req, res, maxTokens);
  if (!aiUser) return;
  const safeMaxTokens = Math.min(
    Math.max(Number(maxTokens) || 12000, 1000),
    AI_MAX_TOKENS_PER_REQUEST
  );
  console.log("[AI] vision request", {
    user: aiUser.email,
    promptChars: String(prompt).length,
    imageChars: String(imageBase64).length,
    maxTokens: safeMaxTokens
  });
  const VISION_MODELS = [
    safeOpenRouterModel(process.env.AI_VISION_MODEL, "google/gemini-2.5-pro"),
    "google/gemini-2.5-flash",
    "openai/gpt-4.1-mini",
    "qwen/qwen2.5-vl-72b-instruct"
  ].filter((model, index, all) => model && all.indexOf(model) === index);
  let lastErr = null;
  for (const model of VISION_MODELS) {
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 60000);
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer": process.env.FRONTEND_URL || "https://aplus.blog",
          "X-Title": "A+ Medical Vision"
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: `${AI_QUALITY_SYSTEM}
حلل الصورة بدقة. لا تخمن النصوص أو الأرقام غير الواضحة،
واذكر بوضوح أي جزء لم تستطع قراءته.`
            },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: imageBase64 } },
                { type: "text", text: prompt }
              ]
            }
          ],
          max_tokens: safeMaxTokens,
          temperature: 0.1,
          top_p: 0.9
        }),
        signal: ctrl.signal
      });
      clearTimeout(tm);
      if (upstream.ok) {
        const data = await upstream.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content) {
          res.json({ ok: true, content });
          return;
        }
      } else {
        const txt = await upstream.text().catch(() => "");
        lastErr = { status: upstream.status, body: txt };
        if (upstream.status === 401 || upstream.status === 403) break;
        if (upstream.status === 402) break;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  let code = "network";
  if (lastErr && typeof lastErr === "object" && lastErr.status) {
    if (lastErr.status === 401 || lastErr.status === 403) code = "auth";
    else code = String(lastErr.status);
  }
  res.status(502).json({ ok: false, error: code });
});

// Static files — يخدم من public/ داخل standalone أو من ../public
app.use(express.static(path.join(__dirname, "public"), { etag: true, lastModified: true }));
app.use(express.static(path.join(__dirname, "..", "public"), { etag: true, lastModified: true }));

// ══════════════════════════════════════════════
// Paylink Payment Gateway
// Required Secrets:
// PAYLINK_API_ID, PAYLINK_SECRET_KEY, PAYLINK_ENV=test|production
// FRONTEND_URL must be https://aplus.blog
// ══════════════════════════════════════════════
const PAYLINK_BASE = process.env.PAYLINK_ENV === "test"
  ? "https://restpilot.paylink.sa"
  : "https://restapi.paylink.sa";
let paylinkToken = "";
let paylinkTokenExpires = 0;

async function getPaylinkToken() {
  if (paylinkToken && Date.now() < paylinkTokenExpires) return paylinkToken;
  if (!process.env.PAYLINK_API_ID || !process.env.PAYLINK_SECRET_KEY) {
    throw new Error("Paylink secrets are not configured");
  }
  const r = await fetch(`${PAYLINK_BASE}/api/auth`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      apiId: process.env.PAYLINK_API_ID,
      secretKey: process.env.PAYLINK_SECRET_KEY,
      persistToken: false
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id_token) throw new Error(d.detail || "Paylink authentication failed");
  paylinkToken = d.id_token;
  paylinkTokenExpires = Date.now() + 25 * 60 * 1000;
  return paylinkToken;
}

async function paylinkFetch(endpoint, options = {}) {
  const r = await fetch(`${PAYLINK_BASE}${endpoint}`, {
    ...options,
    headers: {
      authorization: `Bearer ${await getPaylinkToken()}`,
      accept: "application/json",
      "content-type": "application/json"
    }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || d.title || "Paylink request failed");
  return d;
}

app.post("/api/payment/paylink/create", async (req, res) => {
  try {
    const { email, name, mobile } = req.body || {};
    const amount = Number(req.body?.amount);
    if (!email || !email.includes("@")) return res.status(400).json({ success: false, error: "email_required" });
    if (!Number.isFinite(amount) || amount < 5) return res.status(400).json({ success: false, error: "minimum_amount_is_5_sar" });
    const orderNumber = `APLUS-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const invoice = await paylinkFetch("/api/addInvoice", {
      method: "POST",
      body: JSON.stringify({
        amount: Number(amount.toFixed(2)),
        currency: "SAR",
        orderNumber,
        clientName: String(name || "A+ User").slice(0, 100),
        clientEmail: email,
        clientMobile: String(mobile || "0500000000"),
        callBackUrl: `${(process.env.FRONTEND_URL || "https://aplus.blog").replace(/\/$/, "")}/?payment=paylink`,
        note: "A+ Medical monthly subscription",
        products: [{
          title: "A+ Medical monthly subscription",
          price: Number(amount.toFixed(2)),
          qty: 1,
          isDigital: true
        }]
      })
    });
    if (!invoice.url || !invoice.transactionNo) throw new Error("Paylink returned an invalid invoice");
    res.json({ success: true, url: invoice.url, transactionNo: invoice.transactionNo, orderNumber });
  } catch (e) {
    console.error("PAYLINK_CREATE:", e.message);
    res.status(502).json({ success: false, error: "payment_invoice_failed" });
  }
});

app.get("/api/payment/paylink/status/:transactionNo", async (req, res) => {
  try {
    const d = await paylinkFetch(`/api/getInvoice/${encodeURIComponent(req.params.transactionNo)}`);
    const paid = String(d.orderStatus || "").toLowerCase() === "paid";
    res.json({ success: true, paid, orderStatus: d.orderStatus, amount: d.amount, transactionNo: d.transactionNo });
  } catch (e) {
    console.error("PAYLINK_STATUS:", e.message);
    res.status(502).json({ success: false, error: "payment_verification_failed" });
  }
});

app.post("/api/payment/paylink/confirm", async (req, res) => {
  try {
    const user = await getSessionUser(req.headers["x-session-token"]);
    if (!user) return res.status(401).json({ success: false, error: "login_required" });
    const transactionNo = String(req.body?.transactionNo || "").trim();
    if (!transactionNo) return res.status(400).json({ success: false, error: "transaction_required" });
    const invoice = await paylinkFetch(`/api/getInvoice/${encodeURIComponent(transactionNo)}`);
    const paid = String(invoice.orderStatus || "").toLowerCase() === "paid";
    if (!paid) return res.status(400).json({ success: false, error: "payment_not_paid" });
    const expiry = Math.max(Date.now(), Number(user.premium_expiry) || 0) + 30 * 24 * 60 * 60 * 1000;
    await db.query("UPDATE users SET premium_expiry=$1 WHERE email=$2", [expiry, user.email]);
    invalidateSessionCache(user.email);
    broadcastEvent({ type: "subscription_updated", email: user.email, premiumExpiry: expiry });
    res.json({ success: true, premiumExpiry: expiry });
  } catch (e) {
    console.error("PAYLINK_CONFIRM:", e.message);
    res.status(502).json({ success: false, error: "payment_confirmation_failed" });
  }
});

// ══════════════════════════════════════════════
// 18. المعلم الخصوصي الحقيقي
// الدفع يتم عبر رابط سلة، ثم ينشئ المدير كود التفعيل
// ══════════════════════════════════════════════
function privateTutorId() {
  return randomBytes(12).toString("hex");
}

function privateTutorCode() {
  return "TUTOR-" + randomBytes(5).toString("hex").toUpperCase();
}

function privateTutorUser(req) {
  const token = req.headers["x-session-token"] || req.query.token;
  return token ? getSessionUser(token) : null;
}

function formatPrivateTutor(row) {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio || "",
    subject: row.subject || "",
    imageUrl: row.image_url || "",
    videoUrl: row.video_url || "",
    lessonPrice: Number(row.lesson_price) || 0,
    monthlyPrice: Number(row.monthly_price) || 0,
    dailySallaUrl: row.daily_salla_url || row.salla_url || "",
    monthlySallaUrl: row.monthly_salla_url || row.salla_url || "",
    packageSallaUrl: row.package_salla_url || "",
    packageLessons: Math.max(1, Number(row.package_lessons) || 10),
    sallaUrl: row.salla_url || "",
    isFree: !!row.free_access,
    gender: row.gender || "",
    verified: row.active !== false,
    active: !!row.active,
    createdAt: Number(row.created_at) || 0
  };
}

async function ensurePrivateTutorAccount(email, password, fullName) {
  const normalized = String(email || "").trim().toLowerCase();
  const secret = String(password || "");
  if (!normalized && !secret) return;
  if (!normalized || secret.length < 6) {
    const error = new Error("إيميل المعلم وكلمة المرور (6 أحرف على الأقل) مطلوبان معاً");
    error.code = "TUTOR_ACCOUNT_INVALID";
    throw error;
  }
  const existing = await db.query(
    "SELECT email,is_admin,is_super_admin FROM users WHERE email=$1 LIMIT 1",
    [normalized]
  );
  if (existing.rows[0]?.is_admin || existing.rows[0]?.is_super_admin) {
    const error = new Error("لا يمكن استخدام إيميل المدير كحساب معلم");
    error.code = "TUTOR_ACCOUNT_ADMIN";
    throw error;
  }
  const name = String(fullName || normalized.split("@")[0]).trim().slice(0, 120);
  if (existing.rows.length) {
    await db.query(
      `UPDATE users SET full_name=$1,password_hash=$2,email_verified=TRUE,
       deleted_at=NULL,banned=FALSE,login_attempts=0,locked_until=0,last_seen=$3
       WHERE email=$4`,
      [name, hashPassword(secret), Date.now(), normalized]
    );
  } else {
    await db.query(
      `INSERT INTO users
       (email,full_name,password_hash,email_verified,created_at,last_seen)
       VALUES ($1,$2,$3,TRUE,$4,$4)`,
      [normalized, name, hashPassword(secret), Date.now()]
    );
  }
  invalidateSessionCache(normalized);
}

async function tutorEntitlement(tutorId, email) {
  const normalizedEmail = String(email || "").toLowerCase();
  const now = Date.now();
  const tutor = await db.query("SELECT free_access FROM private_tutors WHERE id=$1 LIMIT 1", [tutorId]);
  if (tutor.rows[0]?.free_access) {
    return {
      lessonsRemaining: 999999,
      monthExpiresAt: 0,
      legacyActive: true,
      active: true
    };
  }
  const paid = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN plan='lesson' AND lessons_remaining>0 THEN lessons_remaining ELSE 0 END),0) AS lessons_remaining,
       COALESCE(MAX(CASE WHEN plan='month' AND expires_at>$3 THEN expires_at ELSE 0 END),0) AS month_expires_at
     FROM private_tutor_payments
     WHERE tutor_id=$1 AND student_email=$2 AND status='paid'`,
    [tutorId, normalizedEmail, now]
  );
  const legacy = await db.query(
    `SELECT 1 FROM private_tutor_codes
     WHERE tutor_id=$1 AND student_email=$2 AND status='active'
     AND (plan='month' OR lessons_remaining>0 OR plan IS NULL)
     AND (expires_at IS NULL OR expires_at>$3) LIMIT 1`,
    [tutorId, normalizedEmail, now]
  );
  const lessonsRemaining = Number(paid.rows[0]?.lessons_remaining) || 0;
  const monthExpiresAt = Number(paid.rows[0]?.month_expires_at) || 0;
  return {
    lessonsRemaining,
    monthExpiresAt,
    legacyActive: legacy.rows.length > 0,
    active: legacy.rows.length > 0 || lessonsRemaining > 0 || monthExpiresAt > now
  };
}

async function tutorPaymentPlan(tutorId, email) {
  const ent = await tutorEntitlement(tutorId, email);
  return {
    ...ent,
    canBook: ent.active
  };
}

app.get("/api/private-tutors", async (_req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM private_tutors WHERE active=TRUE ORDER BY created_at DESC"
    );
    res.json({ ok: true, tutors: result.rows.map(formatPrivateTutor) });
  } catch (e) {
    console.error("private tutors list:", e.message);
    res.status(500).json({ ok: false, tutors: [] });
  }
});

app.get("/api/private-tutors/:id/profile", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const tutorResult = await db.query(
      "SELECT * FROM private_tutors WHERE id=$1 AND active=TRUE LIMIT 1",
      [id]
    );
    if (!tutorResult.rows.length) return res.status(404).json({ ok: false, msg: "المعلم غير موجود" });
    const user = privateTutorUser(req);
    const email = user ? String(user.email || "").toLowerCase() : "";
    const [reviews, likes, mine] = await Promise.all([
      db.query(
        `SELECT r.id,r.rating,r.comment,r.created_at,u.full_name
         FROM private_tutor_reviews r
         LEFT JOIN users u ON lower(u.email)=lower(r.student_email)
         WHERE r.tutor_id=$1 ORDER BY r.created_at DESC LIMIT 100`,
        [id]
      ),
      db.query("SELECT COUNT(*)::int AS count FROM private_tutor_likes WHERE tutor_id=$1", [id]),
      email
        ? db.query("SELECT 1 FROM private_tutor_likes WHERE tutor_id=$1 AND student_email=$2 LIMIT 1", [id, email])
        : Promise.resolve({ rows: [] })
    ]);
    const tutor = formatPrivateTutor(tutorResult.rows[0]);
    const reviewRows = reviews.rows.map((r) => ({
      id: r.id,
      rating: Number(r.rating) || 0,
      comment: r.comment || "",
      studentName: r.full_name || "طالب",
      createdAt: Number(r.created_at) || 0
    }));
    res.json({
      ok: true,
      tutor,
      stats: {
        likes: Number(likes.rows[0]?.count) || 0,
        reviews: reviewRows.length,
        rating: reviewRows.length
          ? Number((reviewRows.reduce((sum, r) => sum + r.rating, 0) / reviewRows.length).toFixed(1))
          : 0,
        liked: mine.rows.length > 0
      },
      reviews: reviewRows
    });
  } catch (e) {
    console.error("private tutor profile:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر تحميل ملف المعلم" });
  }
});

app.post("/api/private-tutors/:id/like", async (req, res) => {
  try {
    const user = privateTutorUser(req);
    if (!user) return res.status(401).json({ ok: false, msg: "سجل الدخول أولاً" });
    const tutorId = String(req.params.id || "");
    const email = String(user.email || "").toLowerCase();
    const existing = await db.query(
      "SELECT 1 FROM private_tutor_likes WHERE tutor_id=$1 AND student_email=$2 LIMIT 1",
      [tutorId, email]
    );
    if (existing.rows.length) {
      await db.query("DELETE FROM private_tutor_likes WHERE tutor_id=$1 AND student_email=$2", [tutorId, email]);
    } else {
      await db.query(
        "INSERT INTO private_tutor_likes (tutor_id,student_email,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [tutorId, email, Date.now()]
      );
    }
    const total = await db.query("SELECT COUNT(*)::int AS count FROM private_tutor_likes WHERE tutor_id=$1", [tutorId]);
    res.json({ ok: true, liked: !existing.rows.length, likes: Number(total.rows[0]?.count) || 0 });
  } catch (e) {
    console.error("private tutor like:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر تسجيل الإعجاب" });
  }
});

app.post("/api/private-tutors/:id/reviews", async (req, res) => {
  try {
    const user = privateTutorUser(req);
    if (!user) return res.status(401).json({ ok: false, msg: "سجل الدخول أولاً" });
    const tutorId = String(req.params.id || "");
    const rating = Math.max(1, Math.min(5, Number(req.body?.rating) || 0));
    const comment = String(req.body?.comment || "").trim().slice(0, 1000);
    if (!rating || !comment) return res.status(400).json({ ok: false, msg: "اكتب التقييم والتعليق" });
    const email = String(user.email || "").toLowerCase();
    await db.query(
      `INSERT INTO private_tutor_reviews (id,tutor_id,student_email,rating,comment,created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tutor_id,student_email)
       DO UPDATE SET rating=EXCLUDED.rating,comment=EXCLUDED.comment,created_at=EXCLUDED.created_at`,
      [privateTutorId(), tutorId, email, rating, comment, Date.now()]
    );
    res.status(201).json({ ok: true, msg: "تم حفظ تقييمك" });
  } catch (e) {
    console.error("private tutor review:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر حفظ التقييم" });
  }
});

app.get("/api/private-tutors/:id/payment-options", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM private_tutors WHERE id=$1 AND active=TRUE LIMIT 1",
      [String(req.params.id || "")]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, msg: "المعلم غير موجود" });
    const tutor = result.rows[0];
    res.json({
      ok: true,
      tutor: formatPrivateTutor(tutor),
      options: {
        lesson: Number(tutor.lesson_price) || 0,
        month: Number(tutor.monthly_price) || 0
      }
    });
  } catch (e) {
    console.error("private tutor payment options:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر تحميل خيارات الدفع" });
  }
});

app.post("/api/private-tutors/:id/payment/create", async (req, res) => {
  try {
    const user = await privateTutorUser(req);
    if (!user) return res.status(401).json({ ok: false, msg: "سجل الدخول أولاً" });
    const tutorResult = await db.query(
      "SELECT * FROM private_tutors WHERE id=$1 AND active=TRUE LIMIT 1",
      [String(req.params.id || "")]
    );
    if (!tutorResult.rows.length) return res.status(404).json({ ok: false, msg: "المعلم غير موجود" });
    const tutor = tutorResult.rows[0];
    const plan = req.body?.plan === "month" ? "month" : req.body?.plan === "lesson" ? "lesson" : "";
    const amount = plan === "lesson" ? Number(tutor.lesson_price) : Number(tutor.monthly_price);
    if (!plan || !Number.isFinite(amount) || amount < 5) {
      return res.status(400).json({ ok: false, msg: "خيار الدفع غير متاح لهذا المعلم" });
    }
    const orderNumber = `TUTOR-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const invoice = await paylinkFetch("/api/addInvoice", {
      method: "POST",
      body: JSON.stringify({
        amount: Number(amount.toFixed(2)),
        currency: "SAR",
        orderNumber,
        clientName: String(user.full_name || user.email || "A+ Student").slice(0, 100),
        clientEmail: user.email,
        clientMobile: String(req.body?.mobile || "0500000000"),
        callBackUrl: `${(process.env.FRONTEND_URL || "https://aplus.blog").replace(/\/$/, "")}/?payment=tutor`,
        note: `A+ Medical - ${tutor.name} - ${plan === "month" ? "اشتراك شهر" : "شرح واحد"}`,
        products: [{
          title: `${tutor.name} - ${plan === "month" ? "اشتراك شهر" : "شرح واحد"}`,
          price: Number(amount.toFixed(2)),
          qty: 1,
          isDigital: true
        }]
      })
    });
    if (!invoice.url || !invoice.transactionNo) throw new Error("Paylink returned an invalid invoice");
    await db.query(
      `INSERT INTO private_tutor_payments
       (id,transaction_no,order_number,tutor_id,student_email,plan,amount,status,lessons_remaining,expires_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0,0,$8)`,
      [privateTutorId(), String(invoice.transactionNo), orderNumber, tutor.id,
        String(user.email).toLowerCase(), plan, Number(amount.toFixed(2)), Date.now()]
    );
    res.json({
      ok: true,
      url: invoice.url,
      transactionNo: String(invoice.transactionNo),
      plan,
      amount: Number(amount.toFixed(2)),
      tutorName: tutor.name
    });
  } catch (e) {
    console.error("private tutor payment create:", e.message);
    res.status(502).json({ ok: false, msg: "تعذر إنشاء فاتورة الدفع" });
  }
});

app.post("/api/private-tutors/:id/payment/confirm", async (req, res) => {
  try {
    const user = await privateTutorUser(req);
    if (!user) return res.status(401).json({ ok: false, msg: "سجل الدخول أولاً" });
    const transactionNo = String(req.body?.transactionNo || "").trim();
    if (!transactionNo) return res.status(400).json({ ok: false, msg: "رقم العملية مطلوب" });
    const paymentResult = await db.query(
      `SELECT p.*, t.name AS tutor_name
       FROM private_tutor_payments p JOIN private_tutors t ON t.id=p.tutor_id
       WHERE p.transaction_no=$1 AND p.tutor_id=$2 AND p.student_email=$3 LIMIT 1`,
      [transactionNo, String(req.params.id || ""), String(user.email).toLowerCase()]
    );
    if (!paymentResult.rows.length) return res.status(404).json({ ok: false, msg: "عملية الدفع غير موجودة" });
    const payment = paymentResult.rows[0];
    if (payment.status === "paid") {
      const access = await tutorPaymentPlan(payment.tutor_id, user.email);
      return res.json({ ok: true, paid: true, access });
    }
    const invoice = await paylinkFetch(`/api/getInvoice/${encodeURIComponent(transactionNo)}`);
    const paid = String(invoice.orderStatus || "").toLowerCase() === "paid";
    if (!paid) return res.status(400).json({ ok: false, msg: "لم يتم تأكيد الدفع بعد" });
    const invoiceAmount = Number(invoice.amount);
    if (Number.isFinite(invoiceAmount) && Math.abs(invoiceAmount - Number(payment.amount)) > 0.01) {
      return res.status(400).json({ ok: false, msg: "قيمة الفاتورة لا تطابق سعر الخدمة" });
    }
    const now = Date.now();
    await withDbTransaction(async (client) => {
      const locked = await client.query(
        "SELECT * FROM private_tutor_payments WHERE id=$1 FOR UPDATE",
        [payment.id]
      );
      if (!locked.rows.length || locked.rows[0].status === "paid") return;
      if (payment.plan === "month") {
        const current = await client.query(
          `SELECT COALESCE(MAX(expires_at),0) AS expires_at
           FROM private_tutor_payments
           WHERE tutor_id=$1 AND student_email=$2 AND plan='month' AND status='paid'`,
          [payment.tutor_id, String(user.email).toLowerCase()]
        );
        const expiresAt = Math.max(now, Number(current.rows[0]?.expires_at) || 0) + 30 * 86_400_000;
        await client.query(
          `UPDATE private_tutor_payments
           SET status='paid',lessons_remaining=0,expires_at=$1,paid_at=$2
           WHERE id=$3`,
          [expiresAt, now, payment.id]
        );
      } else {
        await client.query(
          `UPDATE private_tutor_payments
           SET status='paid',lessons_remaining=1,expires_at=$1,paid_at=$2
           WHERE id=$3`,
          [now + 90 * 86_400_000, now, payment.id]
        );
      }
    });
    const access = await tutorPaymentPlan(payment.tutor_id, user.email);
    broadcastEvent({ type: "private_tutor_payment", tutorId: payment.tutor_id, email: user.email });
    res.json({ ok: true, paid: true, access });
  } catch (e) {
    console.error("private tutor payment confirm:", e.message);
    res.status(502).json({ ok: false, msg: "تعذر تأكيد الدفع" });
  }
});

app.get("/api/private-tutors/:id/subscription", async (req, res) => {
  try {
    const user = await privateTutorUser(req);
    if (!user) return res.json({ ok: true, active: false, canBook: false, lessonsRemaining: 0, expiresAt: 0 });
    const access = await tutorPaymentPlan(String(req.params.id || ""), user.email);
    res.json({
      ok: true,
      active: access.active,
      canBook: access.canBook,
      lessonsRemaining: access.lessonsRemaining,
      expiresAt: access.monthExpiresAt
    });
  } catch {
    res.status(500).json({ ok: false, active: false, canBook: false, lessonsRemaining: 0, expiresAt: 0 });
  }
});

app.get("/api/admin/teacher-applications", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) return res.status(403).json({ ok: false, error: "forbidden" });
    const result = await db.query(
      `SELECT a.*, u.email_verified
       FROM teacher_applications a
       LEFT JOIN users u ON lower(u.email)=lower(a.user_email)
       ORDER BY CASE WHEN a.status='pending' THEN 0 ELSE 1 END, a.created_at DESC`
    );
    res.json({
      ok: true,
      applications: result.rows.map((a) => ({
        id: a.id, email: a.user_email, fullName: a.full_name, subject: a.subject,
        bio: a.bio || "", gender: a.gender, imageData: a.image_data,
        status: a.status, rejectionReason: a.rejection_reason || "",
        emailVerified: !!a.email_verified, createdAt: Number(a.created_at) || 0,
        reviewedAt: Number(a.reviewed_at) || 0
      }))
    });
  } catch (e) {
    console.error("teacher applications list:", e.message);
    res.status(500).json({ ok: false, applications: [] });
  }
});

app.patch("/api/admin/teacher-applications/:id", async (req, res) => {
  try {
    const admin = await isAdminRequest(req);
    if (!admin) return res.status(403).json({ ok: false, error: "forbidden" });
    const action = String(req.body?.action || "").toLowerCase();
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ ok: false, msg: "قرار غير صحيح" });
    }
    const application = await db.query(
      "SELECT * FROM teacher_applications WHERE id=$1 LIMIT 1",
      [String(req.params.id || "")]
    );
    if (!application.rows.length) return res.status(404).json({ ok: false, msg: "الطلب غير موجود" });
    const a = application.rows[0];
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    if (action === "reject" && !reason) {
      return res.status(400).json({ ok: false, msg: "اكتب سبب الرفض" });
    }
    const now = Date.now();
    let tutor = null;
    await withDbTransaction(async (client) => {
      const locked = await client.query("SELECT * FROM teacher_applications WHERE id=$1 FOR UPDATE", [a.id]);
      if (!locked.rows.length) throw new Error("application-not-found");
      const current = locked.rows[0];
      if (current.status !== "pending") throw new Error("تم اتخاذ قرار على هذا الطلب مسبقاً");
      if (action === "approve") {
        await client.query(
          `UPDATE users SET account_type='teacher',teacher_status='approved',
           teacher_subject=$1,teacher_bio=$2,teacher_gender=$3,teacher_image_data=$4
           WHERE email=$5`,
          [a.subject, a.bio || "", a.gender, a.image_data, a.user_email]
        );
        const existing = await client.query(
          "SELECT * FROM private_tutors WHERE lower(tutor_email)=lower($1) LIMIT 1",
          [a.user_email]
        );
        if (existing.rows.length) {
          const updated = await client.query(
            `UPDATE private_tutors SET name=$1,bio=$2,subject=$3,tutor_email=$4,
             image_url=$5,gender=$6,application_id=$7,active=TRUE,free_access=TRUE
             WHERE id=$8 RETURNING *`,
            [a.full_name, a.bio || "", a.subject, a.user_email, a.image_data,
              a.gender, a.id, existing.rows[0].id]
          );
          tutor = updated.rows[0];
        } else {
          const created = await client.query(
            `INSERT INTO private_tutors
             (id,name,bio,subject,tutor_email,image_url,gender,application_id,
              free_access,active,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,TRUE,$9) RETURNING *`,
            [privateTutorId(), a.full_name, a.bio || "", a.subject, a.user_email,
              a.image_data, a.gender, a.id, now]
          );
          tutor = created.rows[0];
        }
      } else {
        await client.query(
          "UPDATE users SET teacher_status='rejected' WHERE email=$1",
          [a.user_email]
        );
      }
      await client.query(
        `UPDATE teacher_applications
         SET status=$1,rejection_reason=$2,reviewed_by=$3,reviewed_at=$4
         WHERE id=$5`,
        [action === "approve" ? "approved" : "rejected", action === "approve" ? "" : reason,
          admin.email || "admin", now, a.id]
      );
      await client.query(
        `INSERT INTO notifications (id,user_email,message,type,read,created_at)
         VALUES ($1,$2,$3,$4,FALSE,$5)`,
        [randomBytes(12).toString("hex"), a.user_email,
          action === "approve"
            ? "تمت الموافقة على طلبك كمعلم خصوصي وأصبح ملفك ظاهراً للطلاب."
            : `تم رفض طلب المعلم: ${reason}`,
          action === "approve" ? "success" : "warning", now]
      );
    });
    await auditLog("teacher_application_decision", admin.email || "admin", {
      applicationId: a.id, decision: action, applicant: a.user_email
    });
    await sendTeacherDecisionEmail(a.user_email, a.full_name, action === "approve", reason);
    broadcastEvent({ type: "teacher_applications_updated", applicationId: a.id });
    broadcastEvent({ type: "private_tutors_updated" });
    res.json({ ok: true, status: action === "approve" ? "approved" : "rejected", tutor: tutor ? formatPrivateTutor(tutor) : null });
  } catch (e) {
    console.error("teacher application decision:", e.message);
    res.status(e.message === "تم اتخاذ قرار على هذا الطلب مسبقاً" ? 409 : 500)
      .json({ ok: false, msg: e.message === "تم اتخاذ قرار على هذا الطلب مسبقاً" ? e.message : "تعذر حفظ قرار الطلب" });
  }
});

app.get("/api/admin/private-tutors", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const tutors = await db.query("SELECT * FROM private_tutors ORDER BY created_at DESC");
    const codes = await db.query("SELECT * FROM private_tutor_codes ORDER BY created_at DESC");
    const bookings = await db.query(
      `SELECT b.*, t.name AS tutor_name
       FROM private_tutor_bookings b
       JOIN private_tutors t ON t.id=b.tutor_id
       WHERE b.status='pending'
       ORDER BY b.created_at DESC`
    );
    const applications = await db.query(
      `SELECT a.*, u.email_verified
       FROM teacher_applications a
       LEFT JOIN users u ON lower(u.email)=lower(a.user_email)
       ORDER BY CASE WHEN a.status='pending' THEN 0 ELSE 1 END, a.created_at DESC`
    );
    res.json({
      ok: true,
      tutors: tutors.rows.map(formatPrivateTutor),
      codes: codes.rows.map((c) => ({
        id: c.id, tutorId: c.tutor_id, code: c.code,
        studentEmail: c.student_email || "", plan: c.plan || "month",
        lessonsRemaining: Number(c.lessons_remaining) || 0, status: c.status,
        expiresAt: Number(c.expires_at) || 0
      })),
      bookings: bookings.rows.map((b) => ({
        id: b.id, tutorId: b.tutor_id, tutorName: b.tutor_name,
        studentEmail: b.student_email, dayOfWeek: b.day_of_week,
        timeText: b.time_text, requestedDate: b.requested_date || "",
        requestedTime: b.requested_time || "", proposedDate: b.proposed_date || "",
        proposedTime: b.proposed_time || "", responseNote: b.response_note || "",
        notes: b.notes || "", status: b.status, createdAt: Number(b.created_at) || 0
      })),
      applications: applications.rows.map((a) => ({
        id: a.id, email: a.user_email, fullName: a.full_name, subject: a.subject,
        bio: a.bio || "", gender: a.gender, imageData: a.image_data,
        status: a.status, rejectionReason: a.rejection_reason || "",
        emailVerified: !!a.email_verified, createdAt: Number(a.created_at) || 0
      }))
    });
  } catch (e) {
    console.error("private tutors admin list:", e.message);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/private-tutors", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 120);
    const bio = String(body.bio || "").trim().slice(0, 2000);
    const subject = String(body.subject || "").trim().slice(0, 120);
    const tutorEmail = String(body.tutorEmail || "").trim().toLowerCase().slice(0, 255);
    const tutorPassword = String(body.tutorPassword || "");
    const imageUrl = String(body.imageUrl || "").trim().slice(0, 1000);
    const videoUrl = String(body.videoUrl || "").trim().slice(0, 12000000);
    const sallaUrl = String(body.sallaUrl || "").trim().slice(0, 1500);
    const lessonPrice = Math.max(0, Number(body.lessonPrice) || 0);
    const monthlyPrice = Math.max(0, Number(body.monthlyPrice) || 0);
    const dailySallaUrl = String(body.dailySallaUrl || "").trim().slice(0, 1500);
    const monthlySallaUrl = String(body.monthlySallaUrl || "").trim().slice(0, 1500);
    const packageSallaUrl = String(body.packageSallaUrl || "").trim().slice(0, 1500);
    const packageLessons = Math.min(100, Math.max(1, Number(body.packageLessons) || 10));
    const freeAccess = body.freeAccess === true || String(body.freeAccess).toLowerCase() === "true";
    if (!name || !subject || (!freeAccess && lessonPrice < 5 && monthlyPrice < 5)) {
      return res.status(400).json({ ok: false, msg: freeAccess ? "الاسم والتخصص مطلوبان" : "الاسم والتخصص وسعر شرح أو شهر مطلوبون" });
    }
    if ([sallaUrl, dailySallaUrl, monthlySallaUrl, packageSallaUrl].some((url) => url && !/^https?:\/\//i.test(url))) {
      return res.status(400).json({ ok: false, msg: "رابط سلة غير صحيح" });
    }
    const result = await db.query(
      `INSERT INTO private_tutors
       (id,name,bio,subject,tutor_email,image_url,video_url,lesson_price,monthly_price,
        daily_salla_url,monthly_salla_url,package_salla_url,package_lessons,salla_url,free_access,active,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,$16) RETURNING *`,
      [privateTutorId(), name, bio, subject, tutorEmail, imageUrl, videoUrl, lessonPrice, monthlyPrice,
        dailySallaUrl, monthlySallaUrl, packageSallaUrl, packageLessons, sallaUrl, freeAccess, Date.now()]
    );
    await ensurePrivateTutorAccount(tutorEmail, tutorPassword, name);
    broadcastEvent({ type: "private_tutors_updated" });
    res.status(201).json({ ok: true, tutor: formatPrivateTutor(result.rows[0]) });
  } catch (e) {
    console.error("private tutor create:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر حفظ المعلم" });
  }
});

app.patch("/api/admin/private-tutors/:id", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const id = String(req.params.id || "");
    const oldResult = await db.query("SELECT * FROM private_tutors WHERE id=$1", [id]);
    if (!oldResult.rows.length) {
      return res.status(404).json({ ok: false, msg: "المعلم غير موجود" });
    }
    const old = oldResult.rows[0], body = req.body || {};
    const name = String(body.name ?? old.name).trim().slice(0, 120);
    const bio = String(body.bio ?? old.bio ?? "").trim().slice(0, 2000);
    const subject = String(body.subject ?? old.subject ?? "").trim().slice(0, 120);
    const tutorEmail = String(body.tutorEmail ?? old.tutor_email ?? "").trim().toLowerCase().slice(0, 255);
    const tutorPassword = String(body.tutorPassword || "");
    const imageUrl = String(body.imageUrl ?? old.image_url ?? "").trim().slice(0, 1000);
    const videoUrl = String(body.videoUrl ?? old.video_url ?? "").trim().slice(0, 12000000);
    const sallaUrl = String(body.sallaUrl ?? old.salla_url).trim().slice(0, 1500);
    const lessonPrice = Math.max(0, Number(body.lessonPrice ?? old.lesson_price) || 0);
    const monthlyPrice = Math.max(0, Number(body.monthlyPrice ?? old.monthly_price) || 0);
    const dailySallaUrl = String(body.dailySallaUrl ?? old.daily_salla_url ?? old.salla_url ?? "").trim().slice(0, 1500);
    const monthlySallaUrl = String(body.monthlySallaUrl ?? old.monthly_salla_url ?? old.salla_url ?? "").trim().slice(0, 1500);
    const packageSallaUrl = String(body.packageSallaUrl ?? old.package_salla_url ?? "").trim().slice(0, 1500);
    const packageLessons = Math.min(100, Math.max(1, Number(body.packageLessons ?? old.package_lessons) || 10));
    const freeAccess = body.freeAccess === undefined
      ? !!old.free_access
      : body.freeAccess === true || String(body.freeAccess).toLowerCase() === "true";
    const active = body.active === undefined ? !!old.active : !!body.active;
    if (!name || !subject || (!freeAccess && lessonPrice < 5 && monthlyPrice < 5)) {
      return res.status(400).json({ ok: false, msg: freeAccess ? "الاسم والتخصص مطلوبان" : "الاسم والتخصص وسعر شرح أو شهر مطلوبون" });
    }
    if ([sallaUrl, dailySallaUrl, monthlySallaUrl, packageSallaUrl].some((url) => url && !/^https?:\/\//i.test(url))) {
      return res.status(400).json({ ok: false, msg: "رابط سلة غير صحيح" });
    }
    const result = await db.query(
      `UPDATE private_tutors SET name=$1,bio=$2,subject=$3,tutor_email=$4,image_url=$5,
       video_url=$6,lesson_price=$7,monthly_price=$8,daily_salla_url=$9,
       monthly_salla_url=$10,package_salla_url=$11,package_lessons=$12,
       salla_url=$13,free_access=$14,active=$15 WHERE id=$16 RETURNING *`,
      [name, bio, subject, tutorEmail, imageUrl, videoUrl, lessonPrice, monthlyPrice,
        dailySallaUrl, monthlySallaUrl, packageSallaUrl, packageLessons, sallaUrl, freeAccess, active, id]
    );
    await ensurePrivateTutorAccount(tutorEmail, tutorPassword, name);
    broadcastEvent({ type: "private_tutors_updated" });
    res.json({ ok: true, tutor: formatPrivateTutor(result.rows[0]) });
  } catch (e) {
    console.error("private tutor update:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر تعديل المعلم" });
  }
});

app.post("/api/admin/private-tutor-codes", async (req, res) => {
  try {
    if (!(await isAdminRequest(req))) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const tutorId = String(req.body?.tutorId || "");
    const studentEmail = String(req.body?.studentEmail || "").trim().toLowerCase();
    const plan = ["daily", "month", "package"].includes(String(req.body?.plan || ""))
      ? String(req.body.plan) : "month";
    const tutor = await db.query("SELECT * FROM private_tutors WHERE id=$1", [tutorId]);
    if (!tutor.rows.length) {
      return res.status(404).json({ ok: false, msg: "المعلم غير موجود" });
    }
    const defaultDays = plan === "daily" ? 1 : plan === "package" ? 90 : 30;
    const days = Math.min(366, Math.max(1, Number(req.body?.days) || defaultDays));
    const lessons = plan === "daily" ? 1 :
      plan === "package" ? Math.min(100, Math.max(1, Number(req.body?.lessons) || Number(tutor.rows[0].package_lessons) || 10)) : 0;
    let code = privateTutorCode();
    for (let i = 0; i < 5; i++) {
      const exists = await db.query("SELECT 1 FROM private_tutor_codes WHERE code=$1", [code]);
      if (!exists.rows.length) break;
      code = privateTutorCode();
    }
    const result = await db.query(
      `INSERT INTO private_tutor_codes
       (id,tutor_id,code,student_email,plan,lessons_remaining,status,expires_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'available',$7,$8) RETURNING *`,
      [privateTutorId(), tutorId, code, studentEmail || null,
        plan, lessons, Date.now() + days * 86_400_000, Date.now()]
    );
    res.status(201).json({
      ok: true,
      code: {
        id: result.rows[0].id, tutorId, code, studentEmail,
        plan, lessonsRemaining: lessons, expiresAt: Number(result.rows[0].expires_at)
      }
    });
  } catch (e) {
    console.error("private tutor code create:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر إنشاء كود الاشتراك" });
  }
});

app.post("/api/private-tutors/:id/activate", async (req, res) => {
  try {
    const user = await privateTutorUser(req);
    if (!user) return res.status(401).json({ ok: false, msg: "سجل الدخول أولاً" });
    const tutorId = String(req.params.id || "");
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, msg: "أدخل كود الاشتراك" });
    const found = await db.query(
      `SELECT * FROM private_tutor_codes
       WHERE tutor_id=$1 AND code=$2 AND status='available'
       AND (student_email IS NULL OR student_email=$3)
       AND (expires_at IS NULL OR expires_at>$4) LIMIT 1`,
      [tutorId, code, user.email.toLowerCase(), Date.now()]
    );
    if (!found.rows.length) {
      return res.status(400).json({ ok: false, msg: "الكود غير صحيح أو مستخدم أو منتهي" });
    }
    const result = await db.query(
      `UPDATE private_tutor_codes
       SET status='active',student_email=$1,activated_at=$2
       WHERE id=$3 RETURNING *`,
      [user.email.toLowerCase(), Date.now(), found.rows[0].id]
    );
    res.json({
      ok: true,
      subscription: {
        tutorId, code: result.rows[0].code,
        plan: result.rows[0].plan || "month",
        lessonsRemaining: Number(result.rows[0].lessons_remaining) || 0,
        expiresAt: Number(result.rows[0].expires_at) || 0
      }
    });
  } catch (e) {
    console.error("private tutor activate:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر تفعيل الاشتراك" });
  }
});

app.post("/api/private-tutors/:id/bookings", async (req, res) => {
  try {
    const user = await privateTutorUser(req);
    if (!user) return res.status(401).json({ ok: false, msg: "سجل الدخول أولاً" });
    const tutorId = String(req.params.id || "");
    const dayOfWeek = String(req.body?.dayOfWeek || "").trim().slice(0, 30);
    const timeText = String(req.body?.timeText || "").trim().slice(0, 30);
    const requestedDate = String(req.body?.date || req.body?.requestedDate || "").trim().slice(0, 20);
    const requestedTime = String(req.body?.time || req.body?.requestedTime || timeText).trim().slice(0, 30);
    const notes = String(req.body?.notes || "").trim().slice(0, 500);
    if ((!dayOfWeek && !requestedDate) || (!timeText && !requestedTime)) {
      return res.status(400).json({ ok: false, msg: "اختر اليوم والوقت" });
    }
    const studentEmail = String(user.email).toLowerCase();
    const result = await withDbTransaction(async (client) => {
      const now = Date.now();
      const month = await client.query(
        `SELECT id FROM private_tutor_payments
         WHERE tutor_id=$1 AND student_email=$2 AND plan='month' AND status='paid'
         AND expires_at>$3 ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
        [tutorId, studentEmail, now]
      );
      let paidPlan = month.rows.length ? "month" : "";
      if (!paidPlan) {
        const lesson = await client.query(
          `SELECT id FROM private_tutor_payments
           WHERE tutor_id=$1 AND student_email=$2 AND plan='lesson' AND status='paid'
           AND lessons_remaining>0 ORDER BY paid_at ASC LIMIT 1 FOR UPDATE`,
          [tutorId, studentEmail]
        );
        if (lesson.rows.length) {
          paidPlan = "lesson";
          await client.query(
            "UPDATE private_tutor_payments SET lessons_remaining=lessons_remaining-1 WHERE id=$1",
            [lesson.rows[0].id]
          );
        }
      }
      if (!paidPlan) {
        const legacy = await client.query(
          `SELECT id,plan,lessons_remaining FROM private_tutor_codes
           WHERE tutor_id=$1 AND student_email=$2 AND status='active'
           AND (plan='month' OR lessons_remaining>0 OR plan IS NULL)
           AND (expires_at IS NULL OR expires_at>$3)
           ORDER BY activated_at ASC LIMIT 1 FOR UPDATE`,
          [tutorId, studentEmail, now]
        );
        if (legacy.rows.length) {
          const codeRow = legacy.rows[0];
          paidPlan = codeRow.plan || "month";
          if (paidPlan !== "month") {
            const remaining = Math.max(0, Number(codeRow.lessons_remaining) - 1);
            await client.query(
              "UPDATE private_tutor_codes SET lessons_remaining=$1,status=$2 WHERE id=$3",
              [remaining, remaining > 0 ? "active" : "used", codeRow.id]
            );
          }
        }
      }
      if (!paidPlan) {
        const error = new Error("payment_required");
        error.code = "TUTOR_PAYMENT_REQUIRED";
        throw error;
      }
      await client.query(
        "UPDATE private_tutor_bookings SET status='replaced' WHERE tutor_id=$1 AND student_email=$2 AND status='pending'",
        [tutorId, studentEmail]
      );
      return client.query(
        `INSERT INTO private_tutor_bookings
         (id,tutor_id,student_email,day_of_week,time_text,requested_date,requested_time,notes,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING *`,
        [privateTutorId(), tutorId, studentEmail, dayOfWeek || requestedDate,
          timeText || requestedTime, requestedDate, requestedTime, notes, now]
      );
    });
    res.status(201).json({
      ok: true,
      booking: {
        id: result.rows[0].id, dayOfWeek, timeText, requestedDate, requestedTime,
        notes, status: "pending"
      },
      paidPlan: result.rows[0].paid_plan || null
    });
  } catch (e) {
    if (e.code === "TUTOR_PAYMENT_REQUIRED") {
      return res.status(403).json({ ok: false, msg: "ادفع قيمة شرح واحد أو اشترك شهرياً قبل الحجز" });
    }
    console.error("private tutor booking:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر حفظ الموعد" });
  }
});

app.get("/api/private-tutors/:id/bookings", async (req, res) => {
  try {
    const user = privateTutorUser(req);
    if (!user) return res.status(401).json({ ok: false, msg: "سجل الدخول أولاً" });
    const tutorId = String(req.params.id || "");
    const rows = await db.query(
      `SELECT id,day_of_week,time_text,requested_date,requested_time,
              proposed_date,proposed_time,response_note,notes,status,created_at
       FROM private_tutor_bookings
       WHERE tutor_id=$1 AND student_email=$2
       ORDER BY created_at DESC LIMIT 50`,
      [tutorId, String(user.email || "").toLowerCase()]
    );
    res.json({
      ok: true,
      bookings: rows.rows.map((b) => ({
        id: b.id, dayOfWeek: b.day_of_week, timeText: b.time_text,
        requestedDate: b.requested_date || "", requestedTime: b.requested_time || "",
        proposedDate: b.proposed_date || "", proposedTime: b.proposed_time || "",
        responseNote: b.response_note || "", notes: b.notes || "",
        status: b.status, createdAt: Number(b.created_at) || 0
      }))
    });
  } catch (e) {
    console.error("private tutor student bookings:", e.message);
    res.status(500).json({ ok: false, bookings: [] });
  }
});

async function updatePrivateTutorBooking(req, res) {
  try {
    const user = privateTutorUser(req);
    if (!user) return res.status(401).json({ ok: false, msg: "سجل الدخول أولاً" });
    const bookingId = String(req.params.bookingId || "");
    const found = await db.query(
      `SELECT b.*,t.tutor_email
       FROM private_tutor_bookings b
       JOIN private_tutors t ON t.id=b.tutor_id
       WHERE b.id=$1 LIMIT 1`,
      [bookingId]
    );
    if (!found.rows.length) return res.status(404).json({ ok: false, msg: "الحجز غير موجود" });
    const booking = found.rows[0];
    const admin = await isAdminRequest(req);
    const tutorEmail = String(booking.tutor_email || "").toLowerCase();
    if (!admin && tutorEmail !== String(user.email || "").toLowerCase()) {
      return res.status(403).json({ ok: false, msg: "غير مصرح" });
    }
    const action = String(req.body?.action || "").toLowerCase();
    const status = action === "approve" ? "confirmed" :
      action === "propose" ? "proposed" :
      action === "reject" ? "rejected" : "";
    if (!status) return res.status(400).json({ ok: false, msg: "الإجراء غير صحيح" });
    const proposedDate = String(req.body?.proposedDate || "").trim().slice(0, 20);
    const proposedTime = String(req.body?.proposedTime || "").trim().slice(0, 30);
    const responseNote = String(req.body?.responseNote || "").trim().slice(0, 500);
    if (status === "proposed" && (!proposedDate || !proposedTime)) {
      return res.status(400).json({ ok: false, msg: "اكتب التاريخ والوقت المقترح" });
    }
    const result = await db.query(
      `UPDATE private_tutor_bookings
       SET status=$1,proposed_date=$2,proposed_time=$3,response_note=$4,responded_at=$5
       WHERE id=$6 RETURNING *`,
      [status, proposedDate, proposedTime, responseNote, Date.now(), bookingId]
    );
    res.json({
      ok: true,
      booking: {
        id: result.rows[0].id, status: result.rows[0].status,
        proposedDate: result.rows[0].proposed_date || "",
        proposedTime: result.rows[0].proposed_time || "",
        responseNote: result.rows[0].response_note || ""
      }
    });
  } catch (e) {
    console.error("private tutor booking response:", e.message);
    res.status(500).json({ ok: false, msg: "تعذر تحديث الحجز" });
  }
}

app.patch("/api/admin/private-tutor-bookings/:bookingId", updatePrivateTutorBooking);
app.patch("/api/private-tutor-bookings/:bookingId", updatePrivateTutorBooking);



// ══════════════════════════════════════════════════════════════
// نظام الدروس المباشرة: WebRTC signaling + chat + recordings
// الفيديو ينتقل مباشرة بين الطرفين عبر WebRTC، والسيرفر يمرر الإشارات فقط.
// ══════════════════════════════════════════════════════════════
const tutorRoomClients=new Map();
const tutorRoomParticipants=new Map();
const tutorId=()=>"ROOM-"+randomBytes(12).toString("hex");
const tutorMsgId=()=>"MSG-"+randomBytes(12).toString("hex");
const tutorRecId=()=>"REC-"+randomBytes(12).toString("hex");
const participantId=()=>"P-"+randomBytes(10).toString("hex");
function tutorAdmin(u){return !!(u&&(u.is_admin||u.is_super_admin||u.is_moderator||u.email===process.env.ADMIN_EMAIL));}
function sseRoom(res,event,data){try{res.write("event: "+event+"\ndata: "+JSON.stringify(data)+"\n\n");return true;}catch{return false;}}
function emitRoom(room,event,data,except){const m=tutorRoomClients.get(room);if(!m)return;for(const [id,res] of m){if(id!==except&&!sseRoom(res,event,data))m.delete(id);}}
function roomView(r){return {id:r.id,tutorId:r.tutor_id,bookingId:r.booking_id||null,studentEmail:r.student_email,tutorEmail:r.tutor_email||"",status:r.status,startedAt:Number(r.started_at)||0,endedAt:Number(r.ended_at)||0,createdAt:Number(r.created_at)||0};}
async function tutorAccess(req,tutor){
  const user=await privateTutorUser(req);if(!user)return {user:null,role:null,tutor:null};
  const q=await db.query("SELECT * FROM private_tutors WHERE id=$1 AND active=TRUE LIMIT 1",[tutor]);const row=q.rows[0]||null;
  if(!row)return {user,role:null,tutor:null};
  if(tutorAdmin(user))return {user,role:"admin",tutor:row};
  if(row.tutor_email&&String(row.tutor_email).toLowerCase()===String(user.email).toLowerCase())return {user,role:"tutor",tutor:row};
  const access=await tutorPaymentPlan(tutor,String(user.email).toLowerCase());
  if(access.active)return {user,role:"student",tutor:row};
  const booking=await db.query(
    `SELECT 1 FROM private_tutor_bookings
     WHERE tutor_id=$1 AND student_email=$2 AND status IN ('pending','confirmed')
     ORDER BY created_at DESC LIMIT 1`,
    [tutor,String(user.email).toLowerCase()]
  );
  return {user,role:booking.rows.length?"student":null,tutor:row};
}
async function roomAccess(req,id){
  const q=await db.query("SELECT * FROM private_tutor_rooms WHERE id=$1 LIMIT 1",[id]);const room=q.rows[0]||null;
  if(!room)return {room:null,user:null,role:null,tutor:null};
  const a=await tutorAccess(req,room.tutor_id);return {...a,room};
}

app.post("/api/private-tutors/:id/rooms",async(req,res)=>{
  try{
    const a=await tutorAccess(req,String(req.params.id||""));
    if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    if(!a.role)return res.status(403).json({ok:false,msg:"فعّل اشتراك المعلم أولاً"});
    const student=a.role==="student"?String(a.user.email).toLowerCase():String(req.body?.studentEmail||"").toLowerCase().trim();
    if(!student||!student.includes("@"))return res.status(400).json({ok:false,msg:"studentEmail مطلوب"});
    const booking=req.body?.bookingId?String(req.body.bookingId).slice(0,120):null;
    if(booking){const b=await db.query("SELECT 1 FROM private_tutor_bookings WHERE id=$1 AND tutor_id=$2 LIMIT 1",[booking,a.tutor.id]);if(!b.rows.length)return res.status(404).json({ok:false,msg:"الحجز غير موجود"});}
    if(booking){
      const existing=await db.query("SELECT * FROM private_tutor_rooms WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 1",[booking]);
      if(existing.rows.length)return res.status(200).json({ok:true,room:roomView(existing.rows[0]),eventsUrl:"/api/private-tutor-rooms/"+existing.rows[0].id+"/events"});
    }
    const id=tutorId(),now=Date.now();
    const r=await db.query("INSERT INTO private_tutor_rooms (id,tutor_id,booking_id,student_email,tutor_email,status,created_at) VALUES ($1,$2,$3,$4,$5,'waiting',$6) RETURNING *",[id,a.tutor.id,booking,student,a.tutor.tutor_email||"",now]);
    res.status(201).json({ok:true,room:roomView(r.rows[0]),eventsUrl:"/api/private-tutor-rooms/"+id+"/events"});
  }catch(e){console.error("room create",e.message);res.status(500).json({ok:false,msg:"تعذر إنشاء الغرفة"});}
});

app.get("/api/private-tutors/:id/manage-bookings",async(req,res)=>{
  try{
    const a=await tutorAccess(req,String(req.params.id||""));
    if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    if(a.role!=="tutor"&&a.role!=="admin")return res.status(403).json({ok:false,msg:"هذه الصفحة للمعلم فقط"});
    const q=await db.query(
      `SELECT b.*,u.full_name, r.id AS room_id
       FROM private_tutor_bookings b
       LEFT JOIN users u ON lower(u.email)=lower(b.student_email)
       LEFT JOIN private_tutor_rooms r ON r.booking_id=b.id
       WHERE b.tutor_id=$1 AND b.status IN ('pending','confirmed','proposed')
       ORDER BY b.created_at DESC LIMIT 100`,
      [String(req.params.id||"")]
    );
    res.json({ok:true,bookings:q.rows.map(b=>({
      id:b.id,studentEmail:b.student_email,studentName:b.full_name||"طالب",
      requestedDate:b.requested_date||"",requestedTime:b.requested_time||"",
      dayOfWeek:b.day_of_week,timeText:b.time_text,proposedDate:b.proposed_date||"",
      proposedTime:b.proposed_time||"",responseNote:b.response_note||"",
      notes:b.notes||"",status:b.status,roomId:b.room_id||""
    }))});
  }catch(e){res.status(500).json({ok:false,msg:"تعذر تحميل حجوزات المعلم"});}
});

app.get("/api/private-tutor-rooms/:roomId",async(req,res)=>{try{const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room)return res.status(404).json({ok:false,msg:"الغرفة غير موجودة"});if(!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});res.json({ok:true,room:roomView(a.room)});}catch(e){res.status(500).json({ok:false,msg:"تعذر تحميل الغرفة"});}});

app.post("/api/private-tutor-rooms/:roomId/join",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id);if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room)return res.status(404).json({ok:false,msg:"الغرفة غير موجودة"});if(!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  const p=participantId();if(!tutorRoomParticipants.has(id))tutorRoomParticipants.set(id,new Map());const ps=tutorRoomParticipants.get(id);ps.set(p,{email:a.user.email,role:a.role,joinedAt:Date.now()});
  await db.query("UPDATE private_tutor_rooms SET status='active',started_at=COALESCE(started_at,$1) WHERE id=$2",[Date.now(),id]);
  emitRoom(id,"participant-joined",{participantId:p,role:a.role,email:a.user.email});
  res.json({ok:true,roomId:id,participantId:p,role:a.role,participants:[...ps].map(([participantId,v])=>({participantId,role:v.role,email:v.email}))});
}catch(e){res.status(500).json({ok:false,msg:"تعذر دخول الغرفة"});}});

app.get("/api/private-tutor-rooms/:roomId/events",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),p=String(req.query.participantId||"");if(!a.user)return res.status(401).end();if(!a.room)return res.status(404).end();if(!a.role)return res.status(403).end();
  const part=tutorRoomParticipants.get(id)?.get(p);if(!part||part.email!==a.user.email)return res.status(403).end();
  res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no","Access-Control-Allow-Origin":"*"});
  if(!tutorRoomClients.has(id))tutorRoomClients.set(id,new Map());const clients=tutorRoomClients.get(id);clients.set(p,res);sseRoom(res,"connected",{roomId:id,participantId:p,role:a.role});
  emitRoom(id,"presence",{participants:[...(tutorRoomParticipants.get(id)||[])].map(([participantId,v])=>({participantId,role:v.role,email:v.email}))});
  const close=()=>{clients.delete(p);tutorRoomParticipants.get(id)?.delete(p);emitRoom(id,"participant-left",{participantId:p});};req.on("close",close);req.on("error",close);
}catch(e){if(!res.headersSent)res.status(500).end();}});

app.post("/api/private-tutor-rooms/:roomId/signal",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),from=String(req.body?.from||""),to=String(req.body?.to||""),type=String(req.body?.type||"");if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  const p=tutorRoomParticipants.get(id)?.get(from);if(!p||p.email!==a.user.email)return res.status(403).json({ok:false,msg:"مشارك غير صالح"});if(!["offer","answer","ice-candidate","renegotiate"].includes(type))return res.status(400).json({ok:false,msg:"إشارة غير صالحة"});
  const data={from,to,type,data:req.body?.data||null},clients=tutorRoomClients.get(id)||new Map();if(to&&clients.has(to))sseRoom(clients.get(to),"webrtc-signal",data);else emitRoom(id,"webrtc-signal",data,from);res.json({ok:true});
}catch(e){res.status(500).json({ok:false,msg:"تعذر تمرير الاتصال"});}});

app.post("/api/private-tutor-rooms/:roomId/messages",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),text=String(req.body?.message||"").trim().slice(0,4000);if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});if(!text)return res.status(400).json({ok:false,msg:"الرسالة فارغة"});
  const r=await db.query("INSERT INTO private_tutor_messages (id,room_id,sender_email,sender_role,message,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",[tutorMsgId(),id,a.user.email,a.role,text,Date.now()]);const x=r.rows[0],msg={id:x.id,roomId:x.room_id,senderEmail:x.sender_email,senderRole:x.sender_role,message:x.message,createdAt:Number(x.created_at)};emitRoom(id,"chat-message",msg);res.status(201).json({ok:true,message:msg});
}catch(e){res.status(500).json({ok:false,msg:"تعذر إرسال الرسالة"});}});
app.get("/api/private-tutor-rooms/:roomId/messages",async(req,res)=>{try{const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});const r=await db.query("SELECT * FROM private_tutor_messages WHERE room_id=$1 ORDER BY created_at ASC LIMIT 500",[a.room.id]);res.json({ok:true,messages:r.rows.map(x=>({id:x.id,roomId:x.room_id,senderEmail:x.sender_email,senderRole:x.sender_role,message:x.message,createdAt:Number(x.created_at)}))});}catch(e){res.status(500).json({ok:false,messages:[]});}});

app.post("/api/private-tutor-rooms/:roomId/recordings",async(req,res)=>{try{
  const a=await roomAccess(req,String(req.params.roomId)),url=String(req.body?.recordingUrl||"").trim();if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});if(!/^https?:\/\//i.test(url))return res.status(400).json({ok:false,msg:"رابط التسجيل غير صالح"});
  const duration=Math.max(0,Math.min(86400,Number(req.body?.durationSec)||0)),size=Math.max(0,Number(req.body?.fileSize)||0),mime=String(req.body?.mimeType||"video/webm").slice(0,100);const r=await db.query("INSERT INTO private_tutor_recordings (id,room_id,uploaded_by,recording_url,duration_sec,mime_type,file_size,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[tutorRecId(),a.room.id,a.user.email,url,duration,mime,size,Date.now()]);const rec={id:r.rows[0].id,roomId:a.room.id,recordingUrl:url,durationSec:duration,mimeType:mime,fileSize:size,createdAt:Number(r.rows[0].created_at)};emitRoom(a.room.id,"recording-ready",rec);res.status(201).json({ok:true,recording:rec});
}catch(e){res.status(500).json({ok:false,msg:"تعذر حفظ التسجيل"});}});
app.post("/api/private-tutor-rooms/:roomId/recordings/upload",async(req,res)=>{try{
  const roomId=String(req.params.roomId),a=await roomAccess(req,roomId),raw=String(req.body?.recordingData||"");
  if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
  if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  const match=/^data:([^;]+);base64,([\s\S]+)$/.exec(raw);
  if(!match)return res.status(400).json({ok:false,msg:"ملف التسجيل غير صالح"});
  const buffer=Buffer.from(match[2],"base64");
  if(!buffer.length||buffer.length>80*1024*1024)return res.status(413).json({ok:false,msg:"حجم التسجيل أكبر من 80MB"});
  const id=tutorRecId(),mime=String(match[1]||"video/webm").slice(0,100),root=path.join(__dirname,"private-tutor-recordings");
  await fs.mkdir(root,{recursive:true});
  const filePath=path.join(root,id+".webm");
  await fs.writeFile(filePath,buffer);
  const url="/api/private-tutor-rooms/"+roomId+"/recordings/"+id+"/file";
  const r=await db.query(
    "INSERT INTO private_tutor_recordings (id,room_id,uploaded_by,recording_url,duration_sec,mime_type,file_size,file_path,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
    [id,roomId,a.user.email,url,Math.max(0,Math.min(86400,Number(req.body?.durationSec)||0)),mime,buffer.length,filePath,Date.now()]
  );
  const rec={id:r.rows[0].id,roomId,recordingUrl:url,durationSec:Number(r.rows[0].duration_sec)||0,mimeType:mime,fileSize:buffer.length,createdAt:Number(r.rows[0].created_at)};
  emitRoom(roomId,"recording-ready",rec);res.status(201).json({ok:true,recording:rec});
}catch(e){console.error("recording upload",e.message);res.status(500).json({ok:false,msg:"تعذر رفع التسجيل"});}});
app.get("/api/private-tutor-rooms/:roomId/recordings/:recordingId/file",async(req,res)=>{try{
  const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).end();if(!a.room||!a.role)return res.status(403).end();
  const q=await db.query("SELECT file_path,mime_type FROM private_tutor_recordings WHERE id=$1 AND room_id=$2 LIMIT 1",[String(req.params.recordingId),a.room.id]);
  if(!q.rows.length||!q.rows[0].file_path)return res.status(404).end();
  res.type(q.rows[0].mime_type||"video/webm").sendFile(q.rows[0].file_path);
}catch(e){res.status(500).end();}});
app.get("/api/private-tutor-rooms/:roomId/recordings",async(req,res)=>{try{const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});const r=await db.query("SELECT * FROM private_tutor_recordings WHERE room_id=$1 ORDER BY created_at DESC",[a.room.id]);res.json({ok:true,recordings:r.rows.map(x=>({id:x.id,roomId:x.room_id,recordingUrl:x.recording_url,durationSec:Number(x.duration_sec)||0,mimeType:x.mime_type,fileSize:Number(x.file_size)||0,createdAt:Number(x.created_at)}))});}catch(e){res.status(500).json({ok:false,recordings:[]});}});

app.post("/api/private-tutor-rooms/:roomId/end",async(req,res)=>{try{const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});if(a.role!=="tutor"&&a.role!=="admin")return res.status(403).json({ok:false,msg:"المعلم فقط ينهي الدرس"});const t=Date.now(),r=await db.query("UPDATE private_tutor_rooms SET status='ended',ended_at=$1 WHERE id=$2 RETURNING *",[t,a.room.id]);emitRoom(a.room.id,"room-ended",{roomId:a.room.id,endedAt:t});res.json({ok:true,room:roomView(r.rows[0])});}catch(e){res.status(500).json({ok:false,msg:"تعذر إنهاء الدرس"});}});


// API 404 — طلبات /api غير الموجودة تعيد JSON وليس HTML
app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: "endpoint not found" });
});

// Global error handler — يمنع انهيار السيرفر
app.use((err, _req, res, next) => {
  console.error("❌ خطأ غير متوقع:", err?.message || err);
  if (res.headersSent || res.writableEnded) return next(err);
  res.status(500).json({ ok: false, error: "server error" });
});

// SPA fallback — للصفحات الأمامية فقط
app.use((_req, res) => {
  const htmlPath  = path.join(__dirname, "public", "index.html");
  const htmlPath2 = path.join(__dirname, "..", "public", "index.html");
  res.sendFile(htmlPath, (err) => {
    if (!err) return;
    if (res.headersSent || res.writableEnded) return;
    res.sendFile(htmlPath2, (err2) => {
      if (res.headersSent || res.writableEnded) return;
      if (err2) res.status(200).send("<h1>A+ Medical Platform</h1>");
    });
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

// افتح المنفذ أولاً حتى يستجيب Render للفحص، ثم جهّز قاعدة البيانات
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 A+ Medical Server v5.0 يعمل على المنفذ ${PORT}`);
  console.log(`🔴 بث مباشر SSE مفعّل`);
  startAntiSleep();
  startCleanup();
});

// Keep-alive للـ HTTP server
server.keepAliveTimeout = 120_000;
server.headersTimeout   = 125_000;

dbInitPromise = initDB()
  .then(() => {
    dbReady = true;
    console.log(`💎 قاعدة البيانات متصلة`);
  })
  .catch((err) => {
    console.error("❌ فشل تشغيل قاعدة البيانات:", err?.message || err);
    dbInitError = err;
  });

// إغلاق نظيف
process.on("SIGTERM", () => {
  console.log("⏹ إغلاق نظيف...");
  server.close(() => pool.end());
});
process.on("SIGINT", () => {
  server.close(() => pool.end());
});
