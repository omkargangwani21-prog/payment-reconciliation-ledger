-- Reconcile — Settlement Reconciliation Engine
-- Database schema, grants, and RLS policies

-- ============================================
-- TABLES
-- ============================================

-- Internal ledger: source-of-truth transaction records
create table internal_ledger (
  id bigint generated always as identity primary key,
  payment_id text unique not null,
  order_id text not null,
  amount_paisa bigint not null,
  fee_paisa bigint not null,
  tax_on_fee_paisa bigint not null,
  status text not null default 'captured',
  created_at timestamptz not null default now(),
  currency text not null default 'INR'
);
create index idx_ledger_payment_id on internal_ledger(payment_id);

-- Settlements: what the bank/PG says was actually settled
-- No FK constraint to internal_ledger deliberately - orphan settlements
-- (settlement with no matching ledger entry) are a valid case to detect
create table settlements (
  id bigint generated always as identity primary key,
  utr text not null,
  settlement_id text not null,
  payment_id text not null,
  settled_amount_paisa bigint not null,
  settlement_date date not null,
  batch_id text not null
);
create index idx_settlement_payment_id on settlements(payment_id);
create index idx_settlement_utr on settlements(utr);
alter table settlements add constraint settlements_utr_unique unique (utr);

-- Match results: output of the reconciliation engine
create table match_results (
  id bigint generated always as identity primary key,
  payment_id text not null,
  status text not null check (status in (
    'AUTO_RECONCILED_EXACT',
    'AUTO_RECONCILED_TOLERANCE',
    'AI_REVIEW_QUEUE',
    'EXCEPTION_UNSETTLED',
    'EXCEPTION_ORPHAN_SETTLEMENT',
    'EXCEPTION_DUPLICATE_UTR',
    'EXCEPTION_AI_REJECTED'
  )),
  expected_net_paisa bigint,
  settled_paisa bigint,
  delta_paisa bigint,
  utr text,
  reason text,
  ai_reasoning text,
  ai_confidence numeric,
  human_approved boolean not null default false,
  approved_by text,
  approved_at timestamptz,
  resolved_at timestamptz not null default now(),
  -- can't approve something that was never AI-triaged
  constraint approval_requires_ai_reasoning
    check (human_approved = false or ai_reasoning is not null)
);
create index idx_match_payment_id on match_results(payment_id);
create index idx_match_status on match_results(status);

-- Audit log: every action taken, for traceability
create table audit_log (
  id bigint generated always as identity primary key,
  match_result_id bigint references match_results(id),
  action text not null,
  actor text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
-- Enabled by default. Policies below grant full access to the anon role
-- for this single-tenant demo. In production, every table would include
-- a merchant_id column and policies would scope to auth.uid() = merchant_id.

alter table internal_ledger enable row level security;
alter table settlements enable row level security;
alter table match_results enable row level security;
alter table audit_log enable row level security;

create policy "allow anon full access ledger" on internal_ledger for all to anon using (true) with check (true);
create policy "allow anon full access settlements" on settlements for all to anon using (true) with check (true);
create policy "allow anon full access match_results" on match_results for all to anon using (true) with check (true);

-- ============================================
-- GRANTS
-- ============================================
-- RLS controls row-level access; these grants provide the underlying
-- table-level privileges the anon and service_role roles need.

grant select, insert, update, delete on internal_ledger to anon, service_role;
grant select, insert, update, delete on settlements to anon, service_role;
grant select, insert, update, delete on match_results to anon, service_role;
grant select, insert, update, delete on audit_log to service_role;
grant usage, select on all sequences in schema public to anon, service_role;
