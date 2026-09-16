// app.js
// Backend now reads everything from PostgreSQL instead of hardcoded data.
// Response shapes (field names) are kept identical to what the frontend
// already expects — only the source of the data changed from static
// JS objects/arrays to real SQL queries.

require("dotenv").config();
const rateLimit = require("express-rate-limit");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");

const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 5000;
app.set("trust proxy", true);

/* ---------------- Health / security middleware ---------------- */
app.use(helmet());

// CORS — must allow the exact frontend origin(s) AND set credentials: true.
// origin: "*" cannot be combined with credentialed (cookie-bearing) requests —
// the browser will silently block them, which is why the Google login route
// never received requests before.
const ALLOWED_ORIGINS = [
  "https://rishabh-azure.vercel.app", // production frontend (Vercel)
  "http://localhost:5173",            // local Vite dev server
  "http://localhost:3000",            // in case you also run something on 3000
  // "https://your-custom-domain.com", // add more as needed
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("[CORS] Blocked request from origin:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser()); // required so req.cookies is populated for the session check

const pool = require("./db/pool");
app.use("/api", require("./routes/aiChat"));
app.use("/api", require("./routes/googleAuthLog"));

// Mail transporter — credentials come from .env, never hardcoded here.
// Add to .env:
//   MAIL_USER=rishabhgarai7@gmail.com
//   MAIL_PASS=your_app_password_here
const transporter = nodemailer.createTransport({
  service: "gmail",
  secure: true,
  port: 465,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

// Small helper: groups a flat "items" array under their parent category,
// in the same order the categories came back in (already ORDER BY position).
function groupByCategory(categories, items) {
  return categories.map((cat) => ({
    id: cat.id,
    label: cat.label,
    ...itemsKeyFor(cat, items),
  }));
}

// Each section names its items array differently (projects / experiences /
// educations / certificates / achievements / skills), so this just picks
// the right key name and filters items belonging to that category.
function itemsKeyFor(cat, items) {
  return { [items.key]: items.rows.filter((i) => i.category_id === cat.id) };
}

/* ---------------- Profile image ---------------- */
// Random photo from the `photos` table (same behavior as the old
// hardcoded IMAGE_POOL — one row picked at random on every request).

app.get("/api/profile-image", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT url FROM photos ORDER BY random() LIMIT 1;`
    );
    if (rows.length === 0) return res.status(404).json({ error: "No photos found" });
    res.json({ url: rows[0].url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch profile image" });
  }
});

/* ---------------- Header info ---------------- */
function firstNameOnly(fullName) {
    if (!fullName) return fullName;
    return fullName.trim().split(/\s+/)[0];
  }

app.get("/api/header-info", async (req, res) => {
  try {
    const profileResult = await pool.query(
      `SELECT name, tagline, work_company, work_role, work_logo_url
       FROM profile LIMIT 1;`
    );
    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: "Profile not set up" });
    }
    const profile = profileResult.rows[0];

    const rolesResult = await pool.query(
      `SELECT role_text FROM roles ORDER BY position ASC;`
    );

    const socialsResult = await pool.query(
      `SELECT platform AS id, url FROM socials ORDER BY position ASC;`
    );

    const response = {
       name: firstNameOnly(profile.name),
      roles: rolesResult.rows.map((r) => r.role_text),
      tagline: profile.tagline,
      socials: socialsResult.rows,
    };

    // Only attach "work" if company or role is actually set —
    // matches the old behavior of omitting `work` to hide the card.
    if (profile.work_company || profile.work_role) {
      response.work = {
        company: profile.work_company,
        role: profile.work_role,
        logo: profile.work_logo_url,
      };
    }

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch header info" });
  }
});

/* ---------------- About ---------------- */

app.get("/api/about-summary", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT about_summary FROM profile LIMIT 1;`);
    res.json({ summary: rows[0]?.about_summary ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch about summary" });
  }
});

app.get("/api/extracurricular", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT title, description FROM extracurricular ORDER BY position ASC;`
    );
    res.json({ activities: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch extracurricular activities" });
  }
});
app.get("/api/about", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT about_work_role_label, about_work_role_value,
              about_work_pref_label, about_work_pref_value,
              about_location_label, about_location_value,
              about_availability_label, about_availability_value,
              about_is_open
       FROM profile LIMIT 1;`
    );
    if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });
    const p = rows[0];

    res.json({
      workRole: { label: p.about_work_role_label, value: p.about_work_role_value },
      workPreference: { label: p.about_work_pref_label, value: p.about_work_pref_value },
      location: { label: p.about_location_label, value: p.about_location_value },
      availability: {
        label: p.about_availability_label,
        value: p.about_availability_value,
        isOpen: p.about_is_open,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch about info" });
  }
});

/* ---------------- Projects ---------------- */

app.get("/api/projects", async (req, res) => {
  try {
    const categoriesResult = await pool.query(
      `SELECT id, label FROM project_categories ORDER BY position ASC;`
    );

    const projectsResult = await pool.query(
      `SELECT id, category_id, name, image_url AS image,
              short_description AS "shortDescription", description,
              tech_stack AS "techStack", why,
              live_url AS "liveUrl", github_url AS "githubUrl"
       FROM projects ORDER BY position ASC;`
    );

    const categories = groupByCategory(categoriesResult.rows, {
      key: "projects",
      rows: projectsResult.rows,
    });

    res.json({ categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

/* ---------------- Experience ---------------- */
app.get("/api/experience", async (req, res) => {
  try {
    const categoriesResult = await pool.query(
      `SELECT id, label FROM experience_categories ORDER BY position ASC;`
    );

    const experiencesResult = await pool.query(
      `SELECT id, category_id, company_name AS "companyName", role,
              image_url AS image, description, duration,
              start_date AS "startDate", end_date AS "endDate",
              tech_stack AS "techStack", certificate_url AS "certificateUrl"
      FROM experiences ORDER BY position ASC;`
    );

    const categories = categoriesResult.rows.map((cat) => ({
      id: cat.id,
      label: cat.label,
      experiences: experiencesResult.rows.filter((e) => e.category_id === cat.id),
    }));

    res.json({ categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch experience" });
  }
});
/* ---------------- Education ---------------- */

app.get("/api/education", async (req, res) => {
  try {
    const categoriesResult = await pool.query(
      `SELECT id, label FROM education_categories ORDER BY position ASC;`
    );

    const educationsResult = await pool.query(
      `SELECT id, category_id, institution_name AS "institutionName",
              qualification, image_url AS image, subjects, score,
              start_date AS "startDate", end_date AS "endDate",
              score_card_url AS "scoreCardUrl"
       FROM educations ORDER BY position ASC;`
    );

    const categories = groupByCategory(categoriesResult.rows, {
      key: "educations",
      rows: educationsResult.rows,
    });

    res.json({ categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch education" });
  }
});

/* ---------------- Certificates ---------------- */

app.get("/api/certificates", async (req, res) => {
  try {
    const categoriesResult = await pool.query(
      `SELECT id, label FROM certificate_categories ORDER BY position ASC;`
    );

    const certificatesResult = await pool.query(
      `SELECT id, category_id, certificate_name AS "certificateName",
              organization, image_url AS image, description,
              issued_date AS "issuedDate", skills,
              certificate_url AS "certificateUrl"
       FROM certificates ORDER BY position ASC;`
    );

    const categories = groupByCategory(categoriesResult.rows, {
      key: "certificates",
      rows: certificatesResult.rows,
    });

    res.json({ categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch certificates" });
  }
});

/* ---------------- Achievements ---------------- */

app.get("/api/achievements", async (req, res) => {
  try {
    const categoriesResult = await pool.query(
      `SELECT id, label FROM achievement_categories ORDER BY position ASC;`
    );

    const achievementsResult = await pool.query(
      `SELECT id, category_id, title, description, link
       FROM achievements ORDER BY position ASC;`
    );

    const categories = groupByCategory(categoriesResult.rows, {
      key: "achievements",
      rows: achievementsResult.rows,
    });

    res.json({ categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch achievements" });
  }
});

/* ---------------- Skills ---------------- */

app.get("/api/skills", async (req, res) => {
  try {
    const categoriesResult = await pool.query(
      `SELECT id, label FROM skill_categories ORDER BY position ASC;`
    );

    const skillsResult = await pool.query(
      `SELECT id, category_id, name FROM skills ORDER BY position ASC;`
    );

    // Skills only need plain name strings in the response (matches the old
    // hardcoded skills: ["React", "PostgreSQL", ...] shape used for the
    // click-through matching against techStack / subjects arrays).
    const categories = categoriesResult.rows.map((cat) => ({
      id: cat.id,
      label: cat.label,
      skills: skillsResult.rows
        .filter((s) => s.category_id === cat.id)
        .map((s) => s.name),
    }));

    res.json({ categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch skills" });
  }
});

/* ---------------- Contact info ---------------- */

app.get("/api/contact-info", async (req, res) => {
  try {
    const profileResult = await pool.query(
      `SELECT name, phone, email, whatsapp_number, extra_phone, extra_email
       FROM profile LIMIT 1;`
    );
    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: "Profile not set up" });
    }
    const p = profileResult.rows[0];

    // Reuses the same random photo pool as the header — no separate
    // "contact photo" table, since it's the same person's photo either way.
    const photoResult = await pool.query(
      `SELECT url FROM photos ORDER BY random() LIMIT 1;`
    );

    res.json({
      name: p.name,
      photo: photoResult.rows[0]?.url ?? null,
      phone: p.phone,
      email: p.email,
      whatsapp: p.whatsapp_number,
      additionalPhone: p.extra_phone,
      additionalEmail: p.extra_email,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contact info" });
  }
});

/* ---------------- Resumes ---------------- */

app.get("/api/resume", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, description, file_name AS "fileName",
              download_url AS "downloadUrl"
       FROM resumes ORDER BY position ASC;`
    );
    res.json({ resumes: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch resumes" });
  }
});

/* ---------------- Contact form submission ---------------- */
// Sends the submission straight to your inbox via nodemailer.
// Table-free for now — if you also want these saved in the DB,
// add a table back and INSERT here alongside the sendMail call.

const contactLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, 
  max: 10, 
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "Too many messages sent. Please try again after 1 day.",
  },
});

app.post("/api/contact", contactLimiter, async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, error: "name, email, and message are required" });
  }

  try {
    // Get the destination email from the profile table (not hardcoded MAIL_USER)
    const profileResult = await pool.query(
      `SELECT email FROM profile LIMIT 1;`
    );

    if (profileResult.rows.length === 0 || !profileResult.rows[0].email) {
      return res.status(500).json({ ok: false, error: "Recipient email not configured" });
    }

    const recipientEmail = profileResult.rows[0].email;

    const mailOptions = {
      from: `"Portfolio Contact Form" <${process.env.MAIL_USER}>`, // must be your authenticated Gmail account
      to: recipientEmail,          // pulled from the profile table
      replyTo: email,              // so hitting "Reply" goes to the visitor
      subject: `New portfolio message from ${name}`,
      text: `You received a new message via your portfolio contact form.

Name: ${name}
Email: ${email}

Message:
${message}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #2563eb;">New Portfolio Contact Submission</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
          <p><strong>Message:</strong></p>
          <p style="background:#f5f5f5; padding:12px; border-radius:6px; white-space:pre-wrap;">${message}</p>
          <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
          <p style="font-size:12px; color:#888;">Sent from your portfolio contact form.</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Mail sent: " + info.response);

    res.json({ ok: true, message: "Your message was sent successfully!" });
  } catch (err) {
    console.error("Failed to send mail:", err);
    res.status(500).json({
      ok: false,
      error: "We couldn't send your message right now. Please try again in a moment.",
    });
  }
});

app.get("/api/profile", async (req, res) => {
  try {
    const profileResult = await pool.query(
      `SELECT name FROM profile LIMIT 1;`
    );
    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: "Profile not set up" });
    }
    const profile = profileResult.rows[0];

    res.json({ name: firstNameOnly(profile.name) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

/* ---------------- Emoji reaction jar ---------------- */
// The five reaction types the jar supports. Kept in one place so the
// GET response always reports every type, even ones with zero count.
const REACTION_TYPES = ["wow", "happy", "meh", "pleading", "sad"];

async function initReactionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reactions (
      type TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Make sure every known reaction type has a row, so GET can always
  // return a complete count map without extra logic on the client.
  for (const type of REACTION_TYPES) {
    await pool.query(
      `INSERT INTO reactions (type, count)
       VALUES ($1, 0)
       ON CONFLICT (type) DO NOTHING;`,
      [type]
    );
  }
}

// GET /api/reactions: return how many of each emoji are in the jar
app.get("/api/reactions", async (req, res) => {
  try {
    const result = await pool.query("SELECT type, count FROM reactions;");
    const counts = {};
    for (const row of result.rows) {
      counts[row.type] = row.count;
    }
    res.json(counts);
  } catch (err) {
    console.error("Failed to fetch reactions:", err);
    res.status(500).json({ error: "Could not load reactions." });
  }
});

// POST /api/reactions: add one reaction of the given type
app.post("/api/reactions", async (req, res) => {
  const { type } = req.body || {};

  if (!REACTION_TYPES.includes(type)) {
    return res.status(400).json({
      error: `Invalid reaction type. Must be one of: ${REACTION_TYPES.join(", ")}`,
    });
  }

  try {
    const result = await pool.query(
      `UPDATE reactions SET count = count + 1 WHERE type = $1 RETURNING type, count;`,
      [type]
    );
    res.json({ type: result.rows[0].type, count: result.rows[0].count });
  } catch (err) {
    console.error("Failed to save reaction:", err);
    res.status(500).json({ error: "Could not save reaction." });
  }
});

/* ---------------- Health ---------------- */
app.get("/api/health", (req, res) => res.json({ ok: true }));

/* ---------------- Startup ---------------- */
// 1. Wait for the DB to be reachable (retries forever with backoff — never
//    exits the process, so a slow/cold Neon instance or a temporary outage
//    doesn't kill your server).
// 2. Make sure the reactions table exists (and is seeded).
// 3. Start listening.
async function start() {
  await pool.connectWithRetry();
  await initReactionsTable();

  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);

    // ---------------- Self-ping (keep Render awake) ----------------
    const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL;
    const SELF_PING_INTERVAL_MS = Number(process.env.SELF_PING_INTERVAL_MS) || 10 * 60 * 1000;

    if (SELF_PING_URL) {
      setInterval(() => {
        fetch(`${SELF_PING_URL}/api/health`)
          .then((res) => console.log(`[self-ping] OK (${res.status})`))
          .catch((err) => console.warn("[self-ping] Failed:", err.message));
      }, SELF_PING_INTERVAL_MS);

      console.log(
        `[self-ping] Enabled — pinging ${SELF_PING_URL}/api/health every ${SELF_PING_INTERVAL_MS / 60000} minute(s).`
      );
    } else {
      console.warn(
        "[self-ping] Disabled — no RENDER_EXTERNAL_URL or SELF_PING_URL found."
      );
    }
  });
}

start().catch((err) => {
  // connectWithRetry never rejects (it loops forever), so this only fires
  // for a genuine bug elsewhere in startup — e.g. initReactionsTable
  // hitting bad SQL. That's a real problem worth stopping for.
  console.error("Fatal startup error (not a DB connectivity issue):", err);
  process.exit(1);
});