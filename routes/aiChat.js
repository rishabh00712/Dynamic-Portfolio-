// routes/aiChat.js
//
// Single route: POST /api/chat
// Mount this in app.js with: app.use("/api", require("./routes/aiChat"));

const express = require("express");
const rateLimit = require("express-rate-limit");
const { GoogleGenAI, Type } = require("@google/genai");
const { BrevoClient } = require("@getbrevo/brevo");

const pool = require("../db/pool");

const router = express.Router();

/* =========================================================
   Notification channel — email is required for the lead flow
   to be useful. (WhatsApp notifications have been removed —
   this route only ever emails.)

   Sends via Brevo's HTTPS API rather than SMTP — Render's free
   tier blocks outbound SMTP ports (25/465/587), so Gmail SMTP
   doesn't work here. Brevo sends over HTTPS (443), which is
   never blocked. Unlike Resend's testing mode, a verified
   Brevo sender can send to any recipient, not just your own
   signup email.
   ========================================================= */
const brevoClient = process.env.BREVO_API_KEY
  ? new BrevoClient({ apiKey: process.env.BREVO_API_KEY })
  : null;

if (!brevoClient) {
  console.warn(
    "[aiChat] BREVO_API_KEY is not set — recruiter interest will be saved to the DB, but no email notifications (candidate or recruiter) will be sent until this is configured."
  );
}

// Sender address for outbound notifications — must match a verified
// sender in your Brevo account (Settings -> Senders, domains, IPs).
const MAIL_FROM = { name: "Portfolio Assistant", email: process.env.BREVO_SENDER_EMAIL };

/* =========================================================
   Self-healing schema — the recruiter-interest flow depends on
   a `gender` column on profile and a `leads` table (now with a
   `phone` column alongside email). Rather than relying on a
   manual migration that's easy to forget, make sure both exist
   the moment this route module loads. All statements are
   idempotent (IF NOT EXISTS), so this is safe to run on every
   server start.
   ========================================================= */
async function bootstrapSchema() {
  try {
    await pool.query(`ALTER TABLE profile ADD COLUMN IF NOT EXISTS gender TEXT;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id         BIGSERIAL PRIMARY KEY,
        email      TEXT,
        phone      TEXT,
        message    TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone TEXT;`);
    await pool.query(`ALTER TABLE leads ALTER COLUMN email DROP NOT NULL;`);
    console.log("[aiChat] Schema check OK: profile.gender and leads (email/phone) table are present.");
  } catch (err) {
    console.error("[aiChat] Failed to auto-create required schema (gender column / leads table):", err);
  }
}
bootstrapSchema();

async function notifyCandidateByEmail({ candidateEmail, recruiterEmail, recruiterPhone, message }) {
  if (!brevoClient || !candidateEmail) return;
  try {
    const contactLines = [
      recruiterPhone ? `Their phone: ${recruiterPhone}` : null,
      recruiterEmail ? `Their email: ${recruiterEmail}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await brevoClient.transactionalEmails.sendTransacEmail({
      sender: MAIL_FROM,
      to: [{ email: candidateEmail }],
      subject: "Someone is interested in reaching out to you",
      textContent: `A visitor on your portfolio left their contact for you.\n\n${contactLines}\n\nContext: ${
        message || "(no additional context given)"
      }`,
    });
  } catch (err) {
    console.error("Failed to email candidate about new lead:", err?.response?.body || err);
    throw err;
  }
}

// Native Gemini client — reads GEMINI_API_KEY directly, no OpenAI compat layer.
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

/* =========================================================
   Rate limiting — protects API quota and the DB.
   Caps message *frequency* (bursts). The daily mail cap below
   is a separate, independent limit on outbound emails.
   ========================================================= */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // 15 messages per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many messages. Please wait a moment and try again.",
  },
});

/* =========================================================
   IP-keyed conversation memory (in-memory, resets on restart).
   Stored in Gemini "contents" shape: [{ role: "user"|"model", parts:[{text}] }]
   ========================================================= */
const conversationHistory = new Map(); // ip -> { history, lastUsed }
const MAX_HISTORY_MESSAGES = 12; // ~6 user/model pairs kept per IP
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // forget anyone inactive for 1 day

function getHistory(ip) {
  return conversationHistory.get(ip)?.history || [];
}

function saveHistory(ip, history) {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  conversationHistory.set(ip, { history: trimmed, lastUsed: Date.now() });
}

// Sweeps out anyone inactive for 24+ hours, once an hour, so this Map
// doesn't grow forever while the server stays up.
setInterval(() => {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  for (const [ip, entry] of conversationHistory) {
    if (entry.lastUsed < cutoff) conversationHistory.delete(ip);
  }
}, 60 * 60 * 1000);

/* =========================================================
   Per-IP daily mail cap for record_recruiter_interest.
   express-rate-limit can't wrap this because it isn't a route —
   it's a tool invoked from inside the Gemini tool-calling loop.
   So we track it ourselves, same pattern as conversationHistory
   above (in-memory Map + hourly sweep), to avoid an unbounded
   memory leak from one entry per IP accumulating forever.

   The lead is ALWAYS saved to the DB regardless of this cap —
   only the outbound notification email is limited.
   ========================================================= */
const MAIL_DAILY_LIMIT = 10;
const mailSendTracker = new Map(); // ip -> { count, dayKey }

function todayKey() {
  return new Date().toISOString().slice(0, 10); // e.g. "2026-09-16"
}

function canSendRecruiterMail(ip) {
  const key = todayKey();
  const entry = mailSendTracker.get(ip);

  if (!entry || entry.dayKey !== key) {
    // First send today (or first ever) for this IP.
    mailSendTracker.set(ip, { count: 1, dayKey: key });
    return true;
  }

  if (entry.count >= MAIL_DAILY_LIMIT) {
    return false;
  }

  entry.count += 1;
  return true;
}

// Sweep stale (not-today) entries once an hour so this Map can't
// grow unbounded — this is the fix for the potential memory leak.
setInterval(() => {
  const key = todayKey();
  for (const [ip, entry] of mailSendTracker) {
    if (entry.dayKey !== key) mailSendTracker.delete(ip);
  }
}, 60 * 60 * 1000);

/* =========================================================
   Tool schemas — Gemini functionDeclarations format
   ========================================================= */
const tools = [
  {
    name: "get_profile_summary",
    description:
      "Get the candidate's real name, gender, tagline, bio, current role/company, availability, location, work preference, and contact details (email, phone). ALWAYS call this at least once at the start of a conversation, on any greeting, or whenever you need to refer to the candidate by name or pronoun — never say 'the candidate', always use his/her actual first name and the correct pronoun from this data.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_skills",
    description:
      "Get the candidate's skills, grouped by category. Optionally filter by a category or technology keyword (e.g. 'React', 'backend', 'DevOps').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          description: "Optional keyword to filter skill categories or names by.",
        },
      },
    },
  },
  {
    name: "get_projects",
    description:
      "Get the candidate's projects, including tech stack, description, live URL and GitHub URL. Optionally filter by a technology, project category, or project name keyword.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tech: {
          type: Type.STRING,
          description: "Optional keyword to filter by tech stack, category, or project name.",
        },
      },
    },
  },
  {
    name: "get_experience",
    description:
      "Get the candidate's work experience, including company, role, duration, tech stack, and description. Optionally filter by company name, role, domain/category, or technology.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        domain: {
          type: Type.STRING,
          description:
            "Optional keyword to filter by company name, role, category label, or tech stack.",
        },
      },
    },
  },
  {
    name: "get_education",
    description: "Get the candidate's full education history, including major/field of study.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_achievements",
    description: "Get the candidate's achievements/awards list.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_extracurricular",
    description: "Get the candidate's extracurricular activities, including title and description.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_certificates",
    description:
      "Get the candidate's certifications. Optionally filter by category or a related skill keyword.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          description: "Optional keyword to filter by category label or associated skill.",
        },
      },
    },
  },
  {
    name: "get_resume_link",
    description: "Get the candidate's resume(s) with title, description, and download URL.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "record_recruiter_interest",
    description:
      "Save a visitor's contact details and context, and directly notify the candidate about it by email. Call this once you have at least a phone number OR an email from a recruiter/visitor expressing interest in hiring, contacting, or reaching out (e.g. 'I'd like to hire him, here's my number...', 'contact me at x@y.com about the backend role'). Prefer collecting a phone number first since it lets the candidate call directly — but an email alone is fine if that's all they're willing to share. If someone seems like a recruiter but hasn't shared either yet, ask for their phone number (and email as a backup) before calling this. Returns the candidate's own direct contact details so you can also share them as a faster alternative.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone: {
          type: Type.STRING,
          description: "The visitor's phone number, exactly as given, for direct calling.",
        },
        email: {
          type: Type.STRING,
          description: "The visitor's email address, exactly as given.",
        },
        message: {
          type: Type.STRING,
          description:
            "Short context for the interest — company, role, or why they're reaching out, summarized from the conversation.",
        },
      },
    },
  },
];

/* =========================================================
   Tool implementations — SQL Database Queries
   ========================================================= */
async function get_profile_summary() {
  const profileRes = await pool.query(
    `SELECT name, gender, tagline, about_summary, work_company, work_role,
            about_location_label, about_location_value,
            about_work_pref_label, about_work_pref_value,
            about_availability_label, about_availability_value,
            about_is_open,
            phone, email, extra_phone, extra_email
     FROM profile LIMIT 1;`
  );
  const socialsRes = await pool.query(
    `SELECT platform, url FROM socials ORDER BY position ASC;`
  );
  return { profile: profileRes.rows[0] || null, socials: socialsRes.rows };
}

async function get_skills({ category } = {}) {
  const categoriesRes = await pool.query(
    `SELECT id, label FROM skill_categories
     WHERE ($1::text IS NULL OR label ILIKE '%' || $1 || '%')
     ORDER BY position ASC;`,
    [category || null]
  );
  const categoryIds = categoriesRes.rows.map((c) => c.id);

  const skillsRes = await pool.query(
    `SELECT category_id, name FROM skills
     WHERE (category_id = ANY($1::bigint[]) OR $2::text IS NULL AND true)
        AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR category_id = ANY($1::bigint[]))
     ORDER BY position ASC;`,
    [categoryIds.length ? categoryIds : [-1], category || null]
  );

  return categoriesRes.rows.map((cat) => ({
    label: cat.label,
    skills: skillsRes.rows.filter((s) => s.category_id === cat.id).map((s) => s.name),
  }));
}

async function get_projects({ tech } = {}) {
  const { rows } = await pool.query(
    `SELECT p.name, p.short_description AS "shortDescription", p.description,
            p.tech_stack AS "techStack", p.why,
            p.live_url AS "liveUrl", p.github_url AS "githubUrl",
            pc.label AS category
     FROM projects p
     JOIN project_categories pc ON pc.id = p.category_id
     WHERE $1::text IS NULL
        OR pc.label ILIKE '%' || $1 || '%'
        OR p.name ILIKE '%' || $1 || '%'
        OR EXISTS (SELECT 1 FROM unnest(p.tech_stack) t WHERE t ILIKE '%' || $1 || '%')
     ORDER BY p.position ASC;`,
    [tech || null]
  );
  return rows;
}

async function get_experience({ domain } = {}) {
  const { rows } = await pool.query(
    `SELECT e.company_name AS "companyName", e.role, e.description, e.duration, e.start_date, e.end_date,
            e.tech_stack AS "techStack", e.certificate_url AS "certificateUrl",
            ec.label AS category
     FROM experiences e
     JOIN experience_categories ec ON ec.id = e.category_id
     WHERE $1::text IS NULL
        OR ec.label ILIKE '%' || $1 || '%'
        OR e.company_name ILIKE '%' || $1 || '%'
        OR e.role ILIKE '%' || $1 || '%'
        OR EXISTS (SELECT 1 FROM unnest(e.tech_stack) t WHERE t ILIKE '%' || $1 || '%')
     ORDER BY e.position ASC;`,
    [domain || null]
  );
  return rows;
}

async function get_education() {
  const { rows } = await pool.query(
    `SELECT ed.institution_name AS "institutionName", ed.qualification,
            ed.subjects, ed.score, ed.start_date AS "startDate", ed.end_date AS "endDate",
            ed.score_card_url AS "scoreCardUrl",
            edc.label AS category
     FROM educations ed
     JOIN education_categories edc ON edc.id = ed.category_id
     ORDER BY ed.position ASC;`
  );
  return rows;
}

async function get_achievements() {
  const { rows } = await pool.query(
    `SELECT a.title, a.description, a.link, ac.label AS category
     FROM achievements a
     JOIN achievement_categories ac ON ac.id = a.category_id
     ORDER BY a.position ASC;`
  );
  return rows;
}

async function get_extracurricular() {
  const { rows } = await pool.query(
    `SELECT title, description FROM extracurricular ORDER BY position ASC;`
  );
  return rows;
}

async function get_certificates({ category } = {}) {
  const { rows } = await pool.query(
    `SELECT c.certificate_name AS "certificateName", c.organization, c.description,
            c.issued_date AS "issuedDate", c.skills, c.certificate_url AS "certificateUrl",
            cc.label AS category
     FROM certificates c
     JOIN certificate_categories cc ON cc.id = c.category_id
     WHERE $1::text IS NULL
        OR cc.label ILIKE '%' || $1 || '%'
        OR EXISTS (SELECT 1 FROM unnest(c.skills) s WHERE s ILIKE '%' || $1 || '%')
     ORDER BY c.position ASC;`,
    [category || null]
  );
  return rows;
}

async function get_resume_link() {
  const { rows } = await pool.query(
    `SELECT title, description, download_url AS "downloadUrl"
     FROM resumes ORDER BY position ASC;`
  );
  return rows;
}

async function record_recruiter_interest({ phone, email, message } = {}, ip) {
  const cleanPhone = phone ? String(phone).trim() : null;
  const cleanEmail = email && typeof email === "string" ? email.trim() : null;

  if (!cleanPhone && !cleanEmail) {
    return { error: "A phone number or an email is required to record interest." };
  }

  const cleanMessage = message ? String(message).trim() : null;

  // Lead is always saved to the DB regardless of the daily mail cap —
  // we never want to silently drop a recruiter's contact info.
  await pool.query(`INSERT INTO leads (email, phone, message) VALUES ($1, $2, $3);`, [
    cleanEmail,
    cleanPhone,
    cleanMessage,
  ]);

  const profileRes = await pool.query(`SELECT name, email, phone FROM profile LIMIT 1;`);
  const candidate = profileRes.rows[0] || null;

  if (!brevoClient || !candidate?.email) {
    // No Brevo key configured — lead is saved either way.
    return { saved: true, notified: false, contact: candidate };
  }

  if (!canSendRecruiterMail(ip)) {
    console.warn(`[aiChat] Daily mail limit (${MAIL_DAILY_LIMIT}) hit for IP ${ip} — lead saved, no email sent.`);
    return {
      saved: true,
      notified: false,
      mailLimitReached: true,
      contact: candidate,
    };
  }

  try {
    await notifyCandidateByEmail({
      candidateEmail: candidate?.email,
      recruiterEmail: cleanEmail,
      recruiterPhone: cleanPhone,
      message: cleanMessage,
    });
    return { saved: true, notified: true, contact: candidate };
  } catch (err) {
    return { saved: true, notified: false, contact: candidate };
  }
}

const toolImplementations = {
  get_profile_summary,
  get_skills,
  get_projects,
  get_experience,
  get_education,
  get_achievements,
  get_extracurricular,
  get_certificates,
  get_resume_link,
  record_recruiter_interest,
};

/* =========================================================
   System prompt — guidelines and rules
   (Gemini takes this as config.systemInstruction, not a message)
   ========================================================= */
const SYSTEM_PROMPT = `
You are XA, a warm, sharp personal assistant who works for one specific person — the candidate whose portfolio this is. You are talking to recruiters, hiring managers, and visitors on his/her behalf. You are not a database read-out — you speak like a confident human assistant who knows this person well and genuinely wants to help them get noticed.

IDENTITY & PRONOUNS
- Always call get_profile_summary at least once early in a conversation (definitely on any greeting) so you know the candidate's real first name and gender.
- Never refer to him/her as "the candidate" or say things like "the profile shows..." — speak naturally using the actual first name, e.g. "Here are that person's top projects and the skills behind them" rather than "Here is what the profile shows regarding...". Use the correct pronoun (he/him or she/her) from the "gender" field; if it's missing, favor the name over a guessed pronoun.
- When the user just says hi/hello/hey/how are you, reply warmly using the candidate's real name (e.g. "Hi! I'm XA, [Name]'s assistant — ask me anything about his/her skills, projects, or experience.") and don't call any other tool.

ROUTING — WHAT TO FETCH BASED ON THE QUESTION
- If the user gives a company name and/or a specific role (e.g. "is he a fit for a Backend Engineer role at Google"), treat this as a hiring-fit check: call get_profile_summary, get_skills, get_projects, get_experience, get_education, and get_certificates. Build the answer around whatever is most relevant, and close with the call-to-action described below.
- If the user asks a broad question with no named role/company/category (e.g. "tell me about him", "why should I hire him"), call all the relevant tools and use your own judgment on what to lead with — highlight whatever would genuinely impress a recruiter rather than listing everything with equal weight.
- If the user asks about ONE specific category only (just skills, just projects, just certificates, just experience, just education, just achievements, just extracurricular activities, just resume), call only that tool and answer with only that category.
- If a question spans multiple explicit topics, call all the relevant tools together and combine the results.
- If a tool returns nothing relevant, say so plainly rather than inventing something.

HIRING-FIT VERDICTS — POSITIVE AND HONEST, NEVER A FLAT "NO"
- Your default posture is optimistic and encouraging — you're on his/her side. Lead with genuine strengths and real overlaps with the role before mentioning any gap.
- If a specific tool/language is missing but the broader domain matches (e.g. role wants Java but he's strong in Node.js/JavaScript backend, cloud, and microservices), frame it as a small, learnable gap, not a disqualifier: name what does match clearly, then add something like "any gap there isn't a concern — he picks up new stacks fast, and this is well worth a conversation."
- Never use blunt negative phrasing like "not a good fit," "weak match," or "poor alignment." Even when a role isn't a strong match, phrase it constructively — e.g. "this specific role leans a bit outside his core focus, but his strength in [X] makes him a great fit for [adjacent kind of role], and he's someone worth talking to."
- Only give a clear, respectful decline when the role or company is in a genuinely unrelated field with no technical overlap at all — e.g. a civil engineering, purely mechanical, or non-technical sales-only role, or a company with no technical hiring relevance. Even then, stay respectful and pivot to what he/she actually specializes in — don't just shut the door.
- Weigh his stated preferences as context, never as an automatic rejection: remote work style, being based in India, and "open to work" availability should be mentioned only if genuinely relevant (e.g. visa/location logistics), and never used to decline a recruiter. If his current stated work-role preference indicates he's specifically looking for internships, and the role in question is full-time, mention that gently as a preference note (e.g. "worth flagging he's currently focused on internship opportunities") rather than declining the recruiter outright.

CLOSING CALL TO ACTION — end every hiring-fit / "why hire him" style answer with one of these
- If things line up reasonably well (which should be the common case): invite them to reach out directly, and give his email address (and phone number, if he has one listed) from get_profile_summary.
- If the visitor would rather have him reach out to them instead: ask for their phone number so he can call them directly — mention that email works too if they'd rather not share a number — plus a short context (company + role), and let them know you'll pass it straight along.
- Either way, also ask if there's a specific open role or a particular team/section they're hiring for, and invite them to share it so it can be forwarded to him.

RECRUITER CONTACT CAPTURE
- If the conversation suggests the visitor is a recruiter or hiring manager (mentions hiring, a company, a role, "we're looking for...") and they haven't given you a phone number or email yet, proactively ask for their **phone number** so he can call them directly, along with a quick note on the company/role — don't wait for them to volunteer it. Mention email as a fine alternative if they'd rather share that instead of a number.
- As soon as you have a phone number and/or an email, call record_recruiter_interest with whichever of phone/email you have plus a short summary of the context. This saves it and notifies him directly by email — after calling it, tell the visitor warmly that you've passed it along and he may reach out to them (call or email) soon, and still offer his direct contact details as a faster alternative if they'd rather not wait.
- If the user just asks how to contact him/her without offering their own info, simply share his contact details from get_profile_summary — no need to call record_recruiter_interest for that.
- If record_recruiter_interest returns mailLimitReached: true, their info was still saved successfully — just tell the visitor warmly that it's been noted, and proactively share his direct contact details (email/phone from get_profile_summary) right away so they can reach him directly instead of waiting on a notification. Never mention the word "limit" or any technical reason — just move straight to offering the direct contact info.

FORMATTING
- Use **double asterisks** around anything that should render bold: names, company names, tech stack items, section labels.
- NEVER write a link as markdown syntax like [text](url) or [click here](url) — the chat interface already turns any raw URL into a clickable link automatically (and shows a GitHub icon automatically for github.com links). Just place the bare URL on its own line, nothing wrapping it. Writing your own [label](url) will render as broken literal brackets.
- Keep every item short — 1-2 lines of actual description max per project/role/entry. Don't restate the tech stack in prose if you're already listing it separately. No filler, no "the data shows" phrasing.
- PROJECTS — for each project, use exactly this shape, one project after another with a blank line between:
  **{Project Name}**
  {liveUrl if present, bare, own line}
  {githubUrl if present, bare, own line}
  Tech: {comma-separated stack, only if present}
  {one short sentence — what it does and/or why it was built, combined}
- EXPERIENCE — for each entry:
  **{Role} — {Company}** ({duration if present, else compute "MMM YYYY – MMM YYYY" from startDate/endDate, or "MMM YYYY – Present" if endDate is missing/null; omit the parentheses entirely if none of duration/startDate/endDate are present})
  Tech: {comma-separated stack, only if present}
  {one short sentence on impact/what was done}
- EDUCATION — for each entry:
  **{Institution}**
  {scoreCardUrl if present, bare, own line}
  {qualification}{, score if present}
  {startDate and endDate if present, formatted as "MMM YYYY – MMM YYYY", or "MMM YYYY – Present" if endDate is missing/null; omit this line entirely if both startDate and endDate are missing}
  {subjects, only if present and short}
- CERTIFICATES — for each entry:
  **{certificateName} — {organization}**
  {certificateUrl if present, bare, own line}
  {issuedDate if present, formatted as "MMM YYYY"}
- ACHIEVEMENTS — for each entry:
  **{title}**
  {link if present, bare, own line}
  {description, one short sentence}
- EXTRACURRICULAR — for each entry:
  **{title}**
  {description, one short sentence}
- DATE FORMATTING — any date/timestamp field returned by a tool (startDate, endDate, issuedDate, etc.) may arrive as a raw ISO string (e.g. "2021-08-01T00:00:00.000Z") or a Date-like value. Always convert it to a clean human format like "Aug 2021" before showing it — never show a raw ISO string, timestamp, or ".000Z" to the user.
- Never invent a URL, score, or date that wasn't returned by a tool — just omit that line if the field is empty.

OFF-TOPIC
- If the user asks about something unrelated to this portfolio — writing code for them, general trivia, unrelated tasks, anything not about this candidate — reply with exactly this and nothing else: "pls ask anything related to that"
`.trim();

/* =========================================================
   Retry helper — Gemini's 503 UNAVAILABLE is almost always a
   transient capacity blip, not a real failure, so retry a
   couple of times with backoff before giving up. Other error
   codes (401/403/404/400) are not retried — they won't fix
   themselves.
   ========================================================= */
async function generateContentWithRetry(params, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      const isRetryable =
        err?.status === 503 ||
        err?.code === "ECONNRESET" ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "ENOTFOUND" ||
        err?.code === "EAI_AGAIN";
      if (!isRetryable || attempt === maxRetries) throw err;
      const delayMs = 500 * 2 ** attempt; // 500ms, 1s, 2s
      console.warn(`Gemini call failed (${err?.status || err?.code}), retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

/* =========================================================
   Tool-calling loop (Gemini shape)
   `ip` is threaded through so record_recruiter_interest can
   apply the per-IP daily mail cap. Other tools simply ignore
   the extra argument since their signatures don't declare it.
   ========================================================= */
async function runToolCallingLoop(contents, ip) {
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await generateContentWithRetry({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: tools }],
      },
    });

    const functionCalls = response.functionCalls;

    // No tool calls -> return the final text response
    if (!functionCalls || functionCalls.length === 0) {
      return response.text;
    }

    // Push the model's turn (containing the function call parts) into history
    contents.push(response.candidates[0].content);

    // Execute each requested function and collect the response parts
    const responseParts = [];
    for (const call of functionCalls) {
      const fn = toolImplementations[call.name];
      let resultPayload;

      if (!fn) {
        resultPayload = { error: `Unknown tool: ${call.name}` };
      } else {
        try {
          resultPayload = await fn(call.args || {}, ip);
        } catch (err) {
          console.error(`Tool "${call.name}" failed:`, err);
          resultPayload = { error: "Failed to fetch that information." };
        }
      }

      responseParts.push({
        functionResponse: {
          name: call.name,
          response: { result: resultPayload },
        },
      });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  return "Sorry, I couldn't put that answer together right now — could you rephrase?";
}

/* =========================================================
   POST /api/chat
   ========================================================= */
router.post("/chat", chatLimiter, async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "A non-empty 'message' string is required." });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: "Message is too long." });
  }

  const ip = req.ip;
  const history = getHistory(ip);

  const userTurn = { role: "user", parts: [{ text: message.trim() }] };
  const contents = [...history, userTurn];

  try {
    const reply = await runToolCallingLoop(contents, ip);

    saveHistory(ip, [
      ...history,
      userTurn,
      { role: "model", parts: [{ text: reply }] },
    ]);

    return res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);

    if (err?.status === 401 || err?.status === 403 || err?.status === 429) {
      return res.status(502).json({ error: "AI service is temporarily unavailable. Please try again shortly." });
    }
    if (err?.status === 503) {
      return res.status(503).json({ error: "The AI is under heavy load right now — please try again in a few seconds." });
    }
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

module.exports = router;