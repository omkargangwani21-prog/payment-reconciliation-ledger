# Reconcile — Settlement Reconciliation Engine

**Razorpay AI Buildathon Submission — Track 04: AI Finance Controller**

Live site: https://reconcile-settlement.vercel.app

---

## Overview

Reconcile is an AI-assisted reconciliation system that matches a merchant's internal payment ledger against a bank/PG settlement file, auto-resolving the majority of records deterministically and routing only genuinely ambiguous mismatches to an LLM for triage — with every AI decision gated behind explicit human approval or rejection before it counts as resolved.

## Problem

Every payment gateway settles funds to merchants in batches that rarely match transaction-level records perfectly — fees, partial refunds, rounding drift, timing delays, and duplicate settlement entries all cause discrepancies. Finance-ops teams currently reconcile this manually, which is slow, error-prone, and creates real cash-flow blind spots. This system automates the majority of records that follow predictable patterns, surfaces the remainder with AI-assisted reasoning instead of silent guesswork, and produces an auditable trail for every decision.

## Architecture

| Layer | Technology | Role |
|---|---|---|
| Database + Backend logic | Supabase (Postgres + Edge Functions) | Stores ledger/settlement/results tables; runs the matching engine server-side |
| AI reasoning | Groq API (`openai/gpt-oss-120b`) | Classifies ambiguous mismatches with confidence + reasoning |
| Frontend | Next.js / React | Upload interface, live results dashboard, approval workflow |
| Hosting | Vercel | Public deployment, linked to GitHub |

**Data model:** `internal_ledger` (source-of-truth transactions, integer paisa — never floats), `settlements` (bank/PG settlement records, no FK constraint to allow orphan detection), `match_results` (output of the matching engine, with human-approval fields), `audit_log` (immutable trail of every system and human action).

**Matching architecture — deterministic-first, AI as last resort:**
Layer 1 → Exact match (payment_id + net amount) → AUTO_RECONCILED_EXACT
Layer 2 → Match within ±2 paisa tolerance (rounding drift) → AUTO_RECONCILED_TOLERANCE
Layer 3 → Amount mismatch beyond tolerance, cause unclear → AI_REVIEW_QUEUE (Groq triage)
Layer 4 → Missing / duplicate / orphan record → EXCEPTION_* (deterministic, no AI needed)

## How It Works

1. **Ingest:** Merchant uploads ledger and settlement CSVs. Uses `upsert` on `payment_id`/`utr`, so re-uploads correct existing records instead of duplicating or failing.
2. **Deterministic pass:** Edge Function computes `expected_net = amount − fee − tax_on_fee`, classifies each record into exact match, tolerance match, AI-review, or exception.
3. **Exception detection:** Duplicate UTRs, unsettled payments, and orphan settlements are flagged without AI, since they're structurally unambiguous.
4. **AI triage:** For each `AI_REVIEW_QUEUE` record, the system calls Groq with the expected/settled/delta figures and asks it to classify the discrepancy with a confidence score and reasoning.
5. **Human decision:** Each AI-triaged record requires a named reviewer to explicitly **Approve** (moves to Auto-Reconciled) or **Reject** (moves to Exceptions as `EXCEPTION_AI_REJECTED`) — enforced at the schema level.
6. **Reporting:** The dashboard renders a live audit register — match rate, per-status counts, and every record with its resolution path.

## Repository Structure
app/ # Next.js app router pages
components/
reconciliation-dashboard.tsx # Main frontend component - upload, matching, triage, approve/reject
lib/
supabase/client.ts # Supabase client initialization
supabase/
functions/reconcile/index.ts # Edge Function - full matching engine, AI triage, approve/reject/clear_all logic
schema.sql # Database schema, grants, and RLS policies
README.md

## Local Setup

1. Clone the repo: `git clone https://github.com/omkargangwani21-prog/payment-reconciliation-ledger`
2. Install dependencies: `pnpm install`
3. Supabase URL and publishable (anon) key are hardcoded in `lib/supabase/client.ts` for this demo — both are safe-to-expose values by design, protected by Row Level Security rather than secrecy (see Design Decisions below)
4. To run against your own Supabase project instead: create a new project, run `supabase/schema.sql` in the SQL Editor, deploy `supabase/functions/reconcile/index.ts` as an Edge Function, add your `GROQ_API_KEY` as an Edge Function secret, then update the constants in `lib/supabase/client.ts`
5. Run locally: `pnpm dev`

## Metrics

On an 80–125 record test batch: **~71–82% match rate**, with the remainder split between AI review and exceptions, each with a specific, visible reason. The exception list is never hidden — every unresolved record is shown with its root cause, because a system that only demonstrates its clean cases proves nothing about production readiness.

## Design Decisions

- **Integer paisa, never floats** — precision in money handling is non-negotiable.
- **Rules-first, AI-fallback** — AI only touches genuinely ambiguous records (~5–15% typically), keeping the system fast and cost-efficient.
- **AI never auto-decides** — approve/reject requires a named human, enforced by a database constraint, not just the UI.
- **Tight tolerance (±2 paisa)**, chosen deliberately strict rather than loose, so real discrepancies are never silently absorbed.
- **Cumulative data via upsert**, not wiped on each upload — mirrors real merchant usage where daily exports overlap. A manual "Clear All Data" action exists as an explicit reset.
- **Open RLS policies** (single-tenant demo scope) — in production, every table would include a `merchant_id` column with RLS scoped to `auth.uid() = merchant_id`, restricting each merchant to their own data. The schema is structured to support this without redesign.
- **No automated test suite** — given the buildathon time window, correctness was verified through direct database queries and live end-to-end testing rather than a written test suite. A documented tradeoff, not an oversight.

## Issues Faced & How They Were Solved

- **Deprecated AI model:** The initial Groq model (`llama-3.3-70b-versatile`) was deprecated mid-build. Fixed by switching to the current supported model (`openai/gpt-oss-120b`).
- **CORS misconfiguration:** The Edge Function's CORS headers didn't allow headers the Supabase client sends by default, blocking all frontend-to-backend calls. Fixed by explicitly whitelisting `accept-profile, content-profile, prefer`.
- **Silent permission gaps:** RLS was enabled correctly, but the `anon` role was never granted table-level `UPDATE` privileges, so AI triage results and approvals were silently failing to persist even though API calls returned success. Diagnosed by directly querying record counts in SQL rather than trusting UI state, then fixed with explicit `GRANT` statements.
- **Environment variable fragility:** Using `NEXT_PUBLIC_*` environment variables for Supabase credentials caused repeated, hard-to-diagnose failures across build/deploy cycles. Resolved by hardcoding the public Supabase URL and publishable key directly in client code — both are safe-to-expose values by design, protected by RLS rather than secrecy.
- **Response shape mismatch:** The AI triage UI appeared to do nothing on first click, only updating after a page reload. Traced to the frontend reading response fields that didn't match the Edge Function's actual response shape. Fixed by re-fetching the record from the database after each action, rather than trusting the response payload structure.

Each of these was caught and resolved by inspecting actual server responses, database state, and browser network traffic directly — not by assuming a fix worked without verifying it.

## Tech Stack (all free tier)

Supabase (database + Edge Functions) · Groq (AI inference) · Next.js/React (frontend) · Vercel (hosting) · GitHub (source control)
