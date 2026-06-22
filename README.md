# Escalation Analyst (v3)

A prompt-driven WhatsApp escalation auditor for Bigship seller-support groups.
The bot stores group messages (and understands images, voice notes, and
documents), and on demand a Gemini model reads the conversation and produces an
operations report: who raised what, who actually worked vs did formality, what
was missed, panic/critical flags, abuse/legal flags, and carry-over.

> No structured DB extraction, no RAG. All the analytical logic lives in one
> editable system prompt: `prompts/escalation-analyst.md`.

> **Deploying to a server (domain + HTTPS)?** See [`DEPLOY.md`](DEPLOY.md) for the full
> Linux VM runbook (nginx, PM2, Let's Encrypt, updates without losing messages).

## Important: what the numbers mean
The counts in the report ("50 in, 40 responded, 10 missed") are the **model's
best reading of a noisy chat, not audited figures.** They're reliable enough for
qualitative judgment ("who's working, what's slipping") but should not be used as
KPI-grade metrics in performance reviews. To get verified counts you'd need the
structured-extraction layer described in ESCALATION_ARCHITECTURE.md.

## Requirements
- Node.js 20+
- Gemini API key
- A secondary WhatsApp number
- Linux: Chromium system libs

## Quickstart
```bash
npm install
cp .env.example .env     # set GEMINI_API_KEY, DASH_USER, DASH_PASS, RECIPIENT_NUMBER
npm start                # scan the QR with the bot number
```
Open the dashboard at http://localhost:8080 and sign in with DASH_USER / DASH_PASS.

## The system prompt is the product
Everything the agent knows about escalation flow, the category taxonomy, response
quality, panic/critical thresholds, abuse/legal flagging, Hindi+English handling,
and the report format lives in **`prompts/escalation-analyst.md`**. Edit that file
to change behaviour — it's reloaded on every run, no restart of logic needed.
Media understanding is governed by `prompts/media-extract.md`.

## Model + thinking
Set in `.env`, change anytime:
```
GEMINI_MODEL=gemini-3.5-flash
GEMINI_THINKING=high          # minimal | low | medium | high
```

## How media works
When an image, voice note, or document arrives, the bot downloads it and asks
Gemini to convert it to one line of text (transcribe voice, OCR/describe images,
extract document facts). That text is folded into the stored transcript, tagged
like `[voice note] ...`. So the analyst "reads" all media — as text — and the
analyse call stays a single cheap text request instead of juggling large files.

## Three ways to get a report
1. **Dashboard** — pick a group, choose "last 24h" or a date range, click
   **Analyse escalations**. Optionally tick "send to WhatsApp".
2. **Command** — type `!analyse` in a tracked group (owner-only); result goes to
   your DM.
3. **CLI test** — `node src/index.js --analyse "Group Name"`.

## Dashboard features
- Login (set credentials in `.env`)
- Group list with today/total counts; filter box
- Delete a group's stored data (× on each group)
- Date-range or last-24h analysis
- Past reports per group, stored permanently (open any report any time)
- Send one or more previous reports as context to a new analysis (cross-day memory / carry-over)
- Recent messages view (shows media as extracted text)

## Memory & context (read this)
The agent has **no automatic memory.** Each analysis is a fresh, stateless call:
the model sees only the system prompt plus the transcript of the window you pick.
It does not remember earlier sessions or earlier reports on its own.

To give it cross-day memory, **attach previous reports as context.** When you run
an analysis, tick any past reports under "Send previous reports as context." Those
report texts are passed into the prompt, so a 2 June run can see what the 1 June
report said was still open and carry those escalations forward instead of missing
them. This is the controlled, owner-driven way to do carry-over without a separate
extraction database.

Reports are stored **permanently** (`retention.purgeReportsAfterDays: 0`). Raw
messages still purge after 30 days, but the report — the durable artifact — stays.
A report always reflects the window it was run over (e.g. "last 24h" or
"2026-06-01 to 2026-06-10"), shown on each saved report.

## Honest limits
- **History before the bot ran is unavailable.** It only stores messages while
  connected; a 1–10 June report needs the bot to have been running across those
  days. Date-range works over *stored* data only.
- **Carry-over** of unresolved escalations works only within the analysed window
  — widen the date range to include prior days if you need older open items.
- Counts are estimates (see above).

## Files
```
prompts/escalation-analyst.md   the brain — edit this
prompts/media-extract.md        media-to-text instructions
config.js                       model, window, media, dashboard settings
src/whatsapp.js                 listener + media enrichment + !analyse
src/media.js                    per-media multimodal understanding
src/analyzer.js                 prompt-driven analysis (thinking high)
src/reportEngine.js             window resolution + generate/store report
src/db.js                       messages + reports (SQLite)
src/server.js                   dashboard API + login + delete
public/                         dashboard UI
```
