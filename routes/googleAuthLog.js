const express = require("express");
const path = require("path");
const { OAuth2Client } = require("google-auth-library");
const { google } = require("googleapis");

const router = express.Router();

const oauthClient = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);

const LOGIN_SHEET_FOLDER_NAME = process.env.GOOGLE_LOGIN_SHEET_FOLDER_NAME || "Portfolio Visitor Logins";
const LOGIN_SHEET_NAME = process.env.GOOGLE_LOGIN_SHEET_NAME || "Google Logins";

/* =========================================================
   Cookie config — "never ask again" session.
   Value is a JSON blob {name, email} so an anonymous page load
   can tell "this browser has signed in before" without hitting
   Google again.
   ========================================================= */
const SESSION_COOKIE_NAME = "portfolio_visitor";
const SESSION_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years

const ANONYMOUS_LABEL = "Anonymous";

/* =========================================================
   Date/time formatting for the sheet — split into two columns
   instead of one raw ISO timestamp: "15 September 2026" and
   "9.30 pm" (Asia/Kolkata).
   ========================================================= */
function formatLoginDateTime(date) {
  const dateStr = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

  const timeStr = date
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    })
    .replace(":", ".") // "9:30 PM" -> "9.30 PM"
    .replace(/AM|PM/i, (m) => m.toLowerCase()); // "9.30 PM" -> "9.30 pm"

  return { dateStr, timeStr };
}

/* =========================================================
   Google API credentials
   ========================================================= */
let googleAuthClient = null;
let cachedSpreadsheetId = null;
let sheetSetupPromise = null;
function getGoogleAuth() {
  if (!googleAuthClient) {
    googleAuthClient = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
      ],
    });
  }
  return googleAuthClient;
}

async function findOrCreateFolder(drive, folderName) {
  const existing = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (existing.data.files?.length) {
    return existing.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: { name: folderName, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  });

  return created.data.id;
}

async function findOrCreateSpreadsheet(drive, sheets, spreadsheetName, folderId) {
  const existing = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.spreadsheet' and name='${spreadsheetName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (existing.data.files?.length) {
    return existing.data.files[0].id;
  }

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: spreadsheetName },
      sheets: [
        {
          properties: { title: "Sheet1" },
          data: [
            {
              startRow: 0,
              startColumn: 0,
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: "Date" } },
                    { userEnteredValue: { stringValue: "Time" } },
                    { userEnteredValue: { stringValue: "Name" } },
                    { userEnteredValue: { stringValue: "Email" } },
                    { userEnteredValue: { stringValue: "IP Address" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const spreadsheetId = created.data.spreadsheetId;

  await drive.files.update({ fileId: spreadsheetId, addParents: folderId, fields: "id, parents" });

  return spreadsheetId;
}

async function ensureSheetReady() {
  if (cachedSpreadsheetId) return cachedSpreadsheetId;
  if (sheetSetupPromise) return sheetSetupPromise;

  sheetSetupPromise = (async () => {
    try {
      const auth = getGoogleAuth();
      const drive = google.drive({ version: "v3", auth });
      const sheets = google.sheets({ version: "v4", auth });

      const folderId = await findOrCreateFolder(drive, LOGIN_SHEET_FOLDER_NAME);
      const spreadsheetId = await findOrCreateSpreadsheet(drive, sheets, LOGIN_SHEET_NAME, folderId);

      cachedSpreadsheetId = spreadsheetId;
      return spreadsheetId;
    } catch (err) {
      console.error("[googleAuthLog] ERROR during ensureSheetReady():", err?.response?.data || err);
      throw err;
    }
  })();

  try {
    return await sheetSetupPromise;
  } finally {
    sheetSetupPromise = null;
  }
}

/* =========================================================
   Always appends a new row — no lookup, no update, no dedup.
   Simple and race-free: every call is just one write to the
   bottom of the sheet.
   ========================================================= */
async function appendVisitRow({ name, email, ip, visitTime }) {
  try {
    const spreadsheetId = await ensureSheetReady();
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const { dateStr, timeStr } = formatLoginDateTime(visitTime);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet1!A:E",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[dateStr, timeStr, name || "", email || "", ip || ""]] },
    });
  } catch (err) {
    console.error("[googleAuthLog] ERROR in appendVisitRow():", err?.response?.data || err);
    throw err;
  }
}

function setSessionCookie(res, { name, email }) {
  const isProduction = process.env.NODE_ENV === "production";
  const value = encodeURIComponent(JSON.stringify({ name, email }));
  res.cookie(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: isProduction ? "none" : "lax",
    secure: isProduction,
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
}

function readSessionCookie(req) {
  const raw = req.cookies?.[SESSION_COOKIE_NAME];
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

// req.ip respects Express's "trust proxy" setting. If you're behind a
// reverse proxy / hosting platform (Render, Vercel, Nginx, etc.), make
// sure `app.set("trust proxy", true)` is set in app.js, or this will
// report the proxy's IP instead of the visitor's.
function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || "";
}

/* =========================================================
   POST /api/track-visit — fire on every page load.
   - Cookie present (they've signed in before, any time) -> log
     their name + email from the cookie.
   - No cookie -> log "Anonymous" + their IP address.
   Always just appends a new row at the bottom. No matching, no
   updating, no per-visitor tracking — every call is independent.
   ========================================================= */
router.post("/track-visit", async (req, res) => {
  try {
    const identity = readSessionCookie(req);

    await appendVisitRow({
      name: identity?.name || ANONYMOUS_LABEL,
      email: identity?.email || "",
      ip: identity ? "" : getClientIp(req),
      visitTime: new Date(),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("[googleAuthLog] Failed to log visit:", err?.response?.data || err);
    // Never block the page over a logging failure.
    return res.status(200).json({ success: false });
  }
});

/* =========================================================
   POST /api/google-login — verify token, append a row, set cookie
   ========================================================= */
router.post("/google-login", async (req, res) => {
  const { credential } = req.body;
  if (!credential || typeof credential !== "string") {
    return res.status(400).json({ error: "Missing Google credential." });
  }

  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload?.email_verified) {
      return res.status(400).json({ error: "Email not verified by Google." });
    }

    const name = payload.name || "(no name)";
    const email = payload.email;

    await appendVisitRow({ name, email, ip: getClientIp(req), visitTime: new Date() });

    setSessionCookie(res, { name, email });

    return res.json({ success: true });
  } catch (err) {
    console.error("[googleAuthLog] Failed to verify/log Google login:", err?.response?.data || err);
    return res.status(401).json({ error: "Invalid Google credential." });
  }
});

/* =========================================================
   GET /api/google-login/session
   ========================================================= */
router.get("/google-login/session", (req, res) => {
  const identity = readSessionCookie(req);

  if (identity) {
    return res.json({ loggedIn: true, name: identity.name, email: identity.email });
  }
  return res.json({ loggedIn: false });
});

module.exports = router;