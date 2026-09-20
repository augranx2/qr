// ===========================================================================
// LOGIN LEWAT PORTAL REMS (SSO) — pemeriksa tiket login di sisi server
// ---------------------------------------------------------------------------
// Tidak memakai library tambahan: tanda tangan tiket (JWT HS256) diperiksa
// dengan modul crypto bawaan Node, dan sesi portal dicek lewat REST Upstash.
//
// Environment Variables yang dibaca:
//   SSO_AKTIF            "true" untuk menyalakan. Selain itu = login lama.
//   SSO_SECRET           sama persis dengan SSO_SECRET di project portal
//   PORTAL_URL           mis. https://portal.myrama.id
//   PORTAL_REDIS_URL     = UPSTASH_REDIS_REST_URL milik project portal
//   PORTAL_REDIS_TOKEN   = UPSTASH_REDIS_REST_TOKEN milik project portal
//   SESSION_IDLE_MINUTES (opsional) sama dengan portal, bawaan 60
//   COOKIE_DOMAIN        (opsional) bawaan .myrama.id
// ===========================================================================
const crypto = require("crypto");

const COOKIE = "myrama_sso";

function ssoAktif() {
  return String(process.env.SSO_AKTIF || "").trim().toLowerCase() === "true";
}

function portalUrl() {
  return String(process.env.PORTAL_URL || "https://portal.myrama.id").trim().replace(/\/+$/, "");
}

function b64url(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function readCookie(req, name = COOKIE) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Memeriksa tanda tangan & masa berlaku tiket. Mengembalikan isi tiket atau null. */
function verifyTicket(token) {
  const secret = process.env.SSO_SECRET || "";
  if (secret.length < 32) throw new Error("SSO_SECRET belum diisi atau kurang dari 32 karakter");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header, payload;
  try {
    header = JSON.parse(b64url(h).toString("utf8"));
    payload = JSON.parse(b64url(p).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const given = b64url(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== "portal.myrama" || !aud.includes("myrama")) return null;
  return payload;
}

async function redisCall(path) {
  const url = String(process.env.PORTAL_REDIS_URL || "").replace(/\/+$/, "");
  const token = process.env.PORTAL_REDIS_TOKEN || "";
  if (!url || !token) throw new Error("PORTAL_REDIS_URL / PORTAL_REDIS_TOKEN belum diisi");
  const r = await fetch(`${url}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Gagal menghubungi database sesi portal (HTTP ${r.status})`);
  return (await r.json()).result;
}

/**
 * Sesi dianggap sah bila kuncinya masih ada di Redis portal. Sekaligus
 * memperpanjang batas diam, supaya orang yang terus bekerja di aplikasi ini
 * tidak ikut terputus walau tidak membuka portal.
 */
async function perpanjangSesi(payload) {
  const idle = Math.max(5, Number(process.env.SESSION_IDLE_MINUTES || 60)) * 60;
  const sisa = payload.exp - Math.floor(Date.now() / 1000);
  const ttl = Math.max(1, Math.min(idle, sisa));
  const hasil = await redisCall(`expire/${encodeURIComponent(`portal:sess:${payload.sid}`)}/${ttl}`);
  return Number(hasil) === 1;
}

/**
 * Hasil:
 *   { status: "ok", user: { username, nama, role, departemen }, sid }
 *   { status: "login" }           belum login / sesi berakhir
 *   { status: "ganti-password" }  masih memakai password awal
 *   { status: "akses" }           login, tapi tidak punya akses ke app ini
 */
async function periksaSso(req, appKey) {
  const token = readCookie(req);
  if (!token) return { status: "login" };
  const p = verifyTicket(token);
  if (!p || !p.sid || !p.sub) return { status: "login" };
  if (!(await perpanjangSesi(p))) return { status: "login" };
  if (p.wgp) return { status: "ganti-password" };
  const akses = p.apps && p.apps[appKey];
  if (!akses || !akses.role) return { status: "akses" };
  return {
    status: "ok",
    sid: p.sid,
    user: {
      username: String(p.sub),
      nama: String(p.nama || p.sub),
      role: String(akses.role),
      departemen: String(akses.departemen || ""),
    },
  };
}

/** Logout global: menghapus sesi portal dan cookie tiket login. */
async function akhiriSesiPortal(req, res) {
  const token = readCookie(req);
  let p = null;
  try {
    p = token ? verifyTicket(token) : null;
  } catch {
    p = null;
  }
  if (p && p.sid) {
    try {
      await redisCall(`del/${encodeURIComponent(`portal:sess:${p.sid}`)}`);
    } catch {
      /* sesi tetap dianggap berakhir karena cookie dihapus */
    }
  }
  const domain = String(process.env.COOKIE_DOMAIN || ".myrama.id").trim();
  const cookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0${domain ? `; Domain=${domain}` : ""}`;
  const prev = res.getHeader("Set-Cookie");
  const list = prev ? (Array.isArray(prev) ? prev : [String(prev)]) : [];
  res.setHeader("Set-Cookie", [...list, cookie]);
}

function loginUrl(kembaliKe) {
  return `${portalUrl()}/login?next=${encodeURIComponent(kembaliKe)}`;
}

module.exports = { ssoAktif, portalUrl, readCookie, verifyTicket, periksaSso, akhiriSesiPortal, loginUrl };
