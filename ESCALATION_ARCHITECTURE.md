# Escalation Intelligence — Architecture Analysis

## The reframe that changes everything

This is no longer a summarizer. It is a **ticketing / SLA system whose data
source happens to be WhatsApp**. Every requirement maps cleanly onto helpdesk
concepts:

| Your requirement | Helpdesk equivalent |
|---|---|
| Escalation by seller | Ticket |
| Category / subcategory (shipping, finance…) | Ticket type / tag |
| Responded vs not | Ticket status |
| Response time | First-response SLA |
| 3+ follow-ups = high panic | SLA breach / reopen count |
| Zero response in 2-3h = critical | SLA breach (response) |
| Carry-over of unclosed from last night | Open tickets aging across days |
| Abusive / legal language | Priority escalation flag |
| POC doing real closure vs fake | Resolution-quality audit |

Design the data model as tickets and the rest follows. The LLM's job is narrow
and well-defined: **turn unstructured chat into structured ticket records.** It
is an extractor, not a summarizer and not a search index.

---

## The three architectures, compared honestly

### Option A — "Analyse → structured extraction → SQL" (the spine)
LLM reads raw messages for a window, emits structured escalation records, you
store them in a relational table, and reports are plain SQL.

**Pros**
- Metrics are deterministic and trustworthy (counts, rates, aging = SQL).
- State persists and is queryable: "open escalations older than 3h" is one query.
- Cheap: one extraction call per group per analyse (cents — see cost section).
- Date-range reports are trivial once data is structured.
- Auditable: every number traces back to a stored row.

**Cons**
- Needs entity resolution (don't double-count the same escalation) — the real
  engineering work.
- Extraction quality depends on prompt + schema design.
- Doesn't answer open-ended "tell me everything about seller X over 3 weeks"
  as fluidly as semantic search.

### Option B — RAG / Google File Search (semantic retrieval)
Upload message batches as files; File Search chunks, embeds, indexes; you query
with natural language and Gemini retrieves relevant chunks.

**Pros**
- Zero embedding/infra work — fully managed.
- Excellent for free-form investigation: "what did sellers complain about most
  last week," "find messages mentioning legal action."
- Scales to large history without you managing a vector DB.

**Cons (disqualifying for the metrics spine)**
- **Cannot aggregate reliably.** Counts, response rates, and SLA math come out
  fuzzy or fabricated. Retrieval ≠ arithmetic.
- No notion of state or lifecycle — it can't "track" an escalation across days.
- Freshness overhead: you'd constantly re-upload/re-index new message batches.
- You lose structured filtering (`WHERE status='unresponded'`).

### Option C — Recommended hybrid
**SQL-backed structured extraction is the spine. File Search is a bolt-on for
ad-hoc questions.** Metrics, flags, and reports come from the relational store;
the RAG layer is there only when a human wants to ask the corpus a fuzzy
question. Build the spine first; add RAG later only if the team actually wants
free-form search.

**Verdict:** Option A is mandatory. Option B is a nice-to-have second layer.
Building B as the primary would give you a dashboard of numbers nobody can
trust.

---

## Recommended architecture

```
                         REAL-TIME (per message, instant, no LLM)
WhatsApp ─► whatsapp.js ─► store raw message ─► keyword scan (abuse / legal)
                                                      │ hit?
                                                      ▼
                                              flags table + alert

                         MEDIA (per media message)
            image / voice / pdf ─► downloadMedia() ─► Gemini multimodal
                                          ▼
                          store extracted text on the message row

                         ON-DEMAND  ("Analyse" button, per group, per window)
   raw messages in window  +  currently-open escalations (carry-over + dedup)
                                          │
                                          ▼
                          Gemini structured extraction (JSON schema)
                                          │
                                          ▼
                     entity resolution (match by AWB / shipment id)
                                          │
                                   ┌──────┴───────┐
                                update          insert
                                          ▼
                                  escalations table  ◄── the ticket store
                                          │
                         REPORT  (button → SQL → metrics + optional narrative)
                                          ▼
                 deterministic numbers  +  Gemini writes the prose wrapper
```

Three timing tiers, deliberately separated:

1. **Real-time, no LLM:** raw storage + abuse/legal keyword flagging. This is the
   only thing that must be instant, and it's cheap because it's regex/keyword
   matching, not a model call. Your requirement #9 ("real time") is satisfied
   here without burning tokens.
2. **Per-media LLM:** only when a message has an attachment. Voice notes and
   images in this domain are evidence (weight-dispute photos, damaged-product
   pictures, Hindi voice complaints), so extraction is core, not optional.
3. **On-demand extraction:** the Analyse button. Batched, idempotent, cheap.
   Skip the hourly scheduler for now exactly as you said — on-demand does the
   same work in one pass and avoids the dedup-across-hours complexity.

---

## The hard problem: entity resolution (don't skip this)

The single thing that will make or break this system is **not double-counting**.
The same escalation appears many times: the seller posts it, reposts, a POC
replies, the seller follows up. Naive extraction turns one escalation into five.

Two strategies, use both:

1. **Natural key (preferred):** logistics escalations almost always reference an
   **AWB / shipment / order ID**. Extract it and key the escalation on
   `(seller, awb, category)`. Deterministic, reliable, language-independent. When
   an AWB is present, this alone solves dedup.
2. **LLM fallback:** when no AWB is present, pass the currently-open escalations
   for that group into the extraction prompt and instruct the model to *update an
   existing escalation if it matches, else create new*. Less reliable, but only
   needed for the minority of AWB-less messages.

This is also exactly how carry-over works: loading open escalations as context
means last night's unclosed items are visible to today's analyse and get aged
forward and re-flagged.

---

## Proposed schema (SQLite now, Postgres at scale)

```sql
-- the ticket store
escalations(
  id, group_id, group_name,
  seller_name, seller_phone,
  awb, shipment_id,                       -- natural dedup key (nullable)
  category, subcategory,                  -- from your taxonomy
  status,                                 -- open|responded|closed|unresponded
  severity,                               -- normal|high_panic|critical|abusive_legal
  language,                               -- hi|en|mixed
  opened_at, first_response_at,
  response_time_seconds,                  -- computed
  follow_up_count,
  last_activity_at, closed_at,
  response_meaningful,                    -- bool, LLM-judged
  flags_json,                             -- {abusive:true, legal:false, ...}
  raw_excerpt,
  created_at, updated_at
)

-- audit trail: which messages belong to which escalation
escalation_events(
  id, escalation_id, message_id,
  type,                                   -- open|follow_up|response|closure
  actor, timestamp, text
)

-- instant flags (real-time, no LLM)
flags(
  id, group_id, message_id,
  type,                                   -- abusive|legal
  keyword, timestamp, text, reviewed
)

messages(...)                             -- raw, already exists
groups(group_id, name, active, deleted_at)-- for the delete-group feature
users(id, username, password_hash, role)  -- for dashboard login
```

Reports are now pure SQL:
- "50 in, 40 responded, 10 missed" → `GROUP BY status`.
- panic list → `WHERE follow_up_count >= 3`.
- critical → `WHERE status='unresponded' AND (now - opened_at) > 3h`.
- carry-over → `WHERE status IN ('open','unresponded') AND opened_at < window_start`.
- category breakdown → `GROUP BY category, subcategory`.

No hallucinated numbers, ever, because the LLM never produces the counts.

---

## Honest limits you must plan around

**History before the bot existed is mostly unavailable.** whatsapp-web.js only
captures messages while connected. `chat.fetchMessages({limit})` can pull *some*
recent history from the linked phone's local store, but it's capped and
unreliable for older ranges. So "report from 1–10 June" works only if the bot
was running and storing across that whole window. Set expectations: history
starts the day the bot goes live. Date-range reports over *stored* data are
trivial; backfilling the past is not.

**The category taxonomy must be finalized by your team first.** The screenshots
give the current dropdown lists (shipping, pickup, weight, finance, insurance +
their subtypes). Lock that list, hand it to the extractor as the allowed label
set, and classification becomes reliable. An open-ended "classify however"
prompt produces inconsistent labels.

**"Response meaningful or not" is a judgment call** the LLM will get wrong
sometimes (especially Hindi). Treat it as a hint with a human-review flag, not
ground truth.

---

## Cost (so the token worry is settled)

Per-group Analyse over 24h of a busy group (~400 messages ≈ 60k input tokens) on
Gemini 3.1 Flash-Lite ($0.25/1M in, $1.50/1M out) with structured JSON output:
roughly **3–5 cents per analyse**. Across all your groups once a day: a few
rupees. Even hourly would be cheap — the reason to prefer on-demand is dedup
cleanliness, not money. Media calls are the bigger variable; gate image analysis
to evidence categories (weight, insurance) rather than every photo.

---

## Staged build plan

**Stage 1 — Ingestion + flagging + delete + auth**
- Real-time abuse/legal keyword flagging (instant, no LLM)
- Media download + Gemini multimodal extraction (voice/image/pdf → text)
- Dashboard login + delete-group
- Date-range plumbing over stored data

**Stage 2 — Extraction + ticket store (the brain)**
- `escalations` schema + entity resolution (AWB key + LLM fallback)
- "Analyse" button: window → structured records → store
- Carry-over of open escalations

**Stage 3 — Reporting**
- SQL metrics dashboard (in/responded/missed, category breakdown, aging)
- Panic + critical flag views
- Gemini narrative wrapper around the hard numbers
- Default last-24h report with previous-night carry-over

**Stage 4 (optional) — RAG layer**
- Google File Search over stored messages for free-form investigation only

Recommended: build Stage 1 + 2 together, since the extractor needs the media
text and the schema. Stage 3 is fast once the data is structured.
