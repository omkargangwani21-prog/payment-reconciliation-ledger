'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import { ChevronDown, CircleAlert, CircleX, Clock3, FileUp, Loader2, RefreshCw, Search, ShieldCheck, Sparkles } from 'lucide-react'
import { getSupabaseClient } from '@/lib/supabase/client'

type MatchResult = {
  id: string
  status: string
  payment_id?: string | null
  utr?: string | null
  settled_paisa?: number | string | null
  expected_net_paisa?: number | string | null
  currency?: string | null
  ai_reasoning?: string | null
  ai_confidence?: number | null
  human_approved?: boolean | null
  [key: string]: unknown
}

type UploadKind = 'ledger' | 'settlement'

const uploadColumns: Record<UploadKind, string[]> = {
  ledger: ['payment_id', 'order_id', 'amount_paisa', 'fee_paisa', 'tax_on_fee_paisa', 'status', 'created_at', 'currency'],
  settlement: ['utr', 'settlement_id', 'payment_id', 'settled_amount_paisa', 'settlement_date', 'batch_id'],
}

const SUPABASE_URL = "https://oxeukllwezkudyqnsilq.supabase.co"
const SUPABASE_ANON_KEY = "sb_publishable_Stq9Qj2PuKNVGqyBl4RYmQ_eFDeg-0Q"
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/reconcile`

function formatAmount(value: number | string | null | undefined, currency = 'INR') {
  const number = typeof value === 'string' ? Number(value) : value ?? 0
  const amount = Number.isFinite(number) ? number / 100 : 0
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
}

function isAuto(record: MatchResult) {
  return record.status === 'AUTO_RECONCILED_EXACT' || record.status === 'AUTO_RECONCILED_TOLERANCE' || (record.status === 'AI_REVIEW_QUEUE' && !!record.human_approved)
}
function isPendingReview(record: MatchResult) {
  return record.status === 'AI_REVIEW_QUEUE' && !record.human_approved
}
function isException(record: MatchResult) {
  return record.status.startsWith('EXCEPTION_')
}

function amountValue(record: MatchResult) {
  const raw = record.settled_paisa ?? record.expected_net_paisa ?? 0
  const n = typeof raw === 'string' ? Number(raw) : raw
  return Number.isFinite(n) ? Number(n) : 0
}

function byPaymentId(a: MatchResult, b: MatchResult) {
  return String(a.payment_id ?? '').localeCompare(String(b.payment_id ?? ''))
}

function byAmountDescending(a: MatchResult, b: MatchResult) {
  return amountValue(b) - amountValue(a)
}

async function callReconcile(body: Record<string, unknown>) {
  const response = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Reconciliation action failed (${response.status})`)
  return response.json().catch(() => ({}))
}

export function ReconciliationDashboard() {
  const [records, setRecords] = useState<MatchResult[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [rerunning, setRerunning] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')
  const [triaging, setTriaging] = useState<string | null>(null)
  const [approving, setApproving] = useState<string | null>(null)
  const [reviewer, setReviewer] = useState('')
  const [today, setToday] = useState<string | null>(null)
  const [uploads, setUploads] = useState<Record<UploadKind, { file?: string; message?: string; loading: boolean }>>({ ledger: { loading: false }, settlement: { loading: false } })
  const uploadedKinds = useRef<Record<UploadKind, boolean>>({ ledger: false, settlement: false })
  const [open, setOpen] = useState({ auto: true, ai: true, exceptions: true })

  const loadRecords = useCallback(async () => {
    const supabase = getSupabaseClient()
    const { data, error: queryError } = await supabase.from('match_results').select('*')
    if (queryError) throw queryError
    setRecords(Array.isArray(data) ? (data as MatchResult[]) : [])
  }, [])

  const runMatching = useCallback(async () => {
    setRerunning(true); setError('')
    try {
      await callReconcile({ action: 'run_matching' })
      await loadRecords()
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to refresh reconciliation') }
    finally { setRerunning(false); setLoading(false) }
  }, [loadRecords])

  const clearAllData = useCallback(async () => {
    if (!window.confirm('This will permanently delete all ledger, settlement, and match records. This cannot be undone. Continue?')) return
    setClearing(true); setError('')
    try {
      await callReconcile({ action: 'clear_all', approvedBy: reviewer.trim() || 'unknown' })
      await loadRecords()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to clear reconciliation data')
    } finally {
      setClearing(false)
      setLoading(false)
    }
  }, [loadRecords, reviewer])

  useEffect(() => {
    setToday(new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase())
    void runMatching()
  }, [runMatching])

  const filtered = useMemo(() => records.filter((record) => {
    const value = query.toLowerCase()
    return String(record.payment_id ?? '').toLowerCase().includes(value) || String(record.utr ?? '').toLowerCase().includes(value)
  }), [records, query])
  const groups = {
    auto: filtered.filter(isAuto).slice().sort(byPaymentId),
    ai: filtered.filter(isPendingReview).slice().sort(byAmountDescending),
    exceptions: filtered.filter(isException).slice().sort(byPaymentId),
  }
  const autoCount = records.filter(isAuto).length
  const aiCount = records.filter(isPendingReview).length
  const exceptionCount = records.filter(isException).length
  const matchRate = records.length ? Math.round((autoCount / records.length) * 1000) / 10 : 0

  async function uploadCsv(kind: UploadKind, file: File) {
    setUploads((current) => ({ ...current, [kind]: { file: file.name, loading: true } }))
    setError('')
    try {
      const result = await new Promise<Papa.ParseResult<Record<string, string>>>((resolve, reject) => {
        Papa.parse<Record<string, string>>(file, { header: true, skipEmptyLines: true, complete: resolve, error: reject })
      })
      if (result.errors.length) throw new Error(`Could not parse ${file.name}: ${result.errors[0].message}`)
      const rows = result.data.filter((row) => Object.values(row).some(Boolean))
      const expected = uploadColumns[kind]
      const missing = expected.filter((column) => !result.meta.fields?.includes(column))
      if (missing.length) throw new Error(`${file.name} is missing columns: ${missing.join(', ')}`)
      if (!rows.length) throw new Error(`${file.name} contains no rows.`)
      const table = kind === 'ledger' ? 'internal_ledger' : 'settlements'
      const conflictTarget = kind === 'ledger' ? 'payment_id' : 'utr'
      const { error: insertError } = await getSupabaseClient().from(table).upsert(rows, { onConflict: conflictTarget })
      if (insertError) throw insertError
      uploadedKinds.current[kind] = true
      setUploads((current) => ({ ...current, [kind]: { file: file.name, loading: false, message: `${rows.length} ${kind === 'ledger' ? 'ledger' : 'settlement'} rows uploaded` } }))

      if (uploadedKinds.current.ledger && uploadedKinds.current.settlement) {
        await runMatching()
      }
    } catch (err) {
      setUploads((current) => ({ ...current, [kind]: { file: file.name, loading: false } }))
      setError(err instanceof Error ? err.message : `Unable to upload ${kind} CSV`)
    }
  }

  async function triage(id: string) {
    setTriaging(id); setError('')
    try {
      await callReconcile({ action: 'ai_triage', matchResultId: id })
      await loadRecords()
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to run AI triage') }
    finally { setTriaging(null) }
  }

  async function approve(record: MatchResult) {
    if (!reviewer.trim()) { alert('Please enter a reviewer name at the top of the AI Review Queue before approving or rejecting.'); return }
    setApproving(record.id); setError('')
    try {
      await callReconcile({ action: 'approve', matchResultId: record.id, approvedBy: reviewer.trim() })
      await loadRecords()
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to approve record') }
    finally { setApproving(null) }
  }

  async function reject(record: MatchResult) {
    if (!reviewer.trim()) { alert('Please enter a reviewer name at the top of the AI Review Queue before approving or rejecting.'); return }
    setApproving(record.id); setError('')
    try {
      await callReconcile({ action: 'reject', matchResultId: record.id, approvedBy: reviewer.trim() })
      await loadRecords()
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to reject record') }
    finally { setApproving(null) }
  }

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between px-6 py-5 lg:px-10">
        <div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center border border-foreground bg-foreground text-background font-mono text-xs font-bold">R/</div><div><p className="font-serif text-lg leading-none">Reconcile</p><p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Settlement register</p></div></div>
        <div className="flex items-center gap-3"><span className="hidden font-mono text-[11px] text-muted-foreground sm:block">LIVE / {today ?? '—'}</span><button onClick={() => void runMatching()} disabled={rerunning || clearing} className="inline-flex items-center gap-2 border border-foreground px-3 py-2 font-mono text-[11px] uppercase tracking-wide transition-colors hover:bg-foreground hover:text-background disabled:opacity-50"><RefreshCw className={rerunning ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Re-run matching</button><button onClick={() => void clearAllData()} disabled={rerunning || clearing} className="inline-flex items-center gap-2 border border-rust px-3 py-2 font-mono text-[11px] uppercase tracking-wide text-rust transition-colors hover:bg-rust hover:text-background disabled:opacity-50">{clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleAlert className="h-3.5 w-3.5" />} Clear all data</button></div>
      </div>
    </header>

    <div className="mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-12">
      <section className="mb-10 border-b border-border pb-8">
        <div className="mb-4 flex items-baseline justify-between gap-4"><div><p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Input register</p><h2 className="mt-2 font-serif text-3xl">Upload New Batch</h2></div><p className="hidden font-mono text-[10px] uppercase tracking-wider text-muted-foreground sm:block">CSV / source files</p></div>
        <div className="grid gap-4 md:grid-cols-2"><UploadDropZone kind="ledger" label="Ledger CSV" upload={uploadCsv} state={uploads.ledger} /><UploadDropZone kind="settlement" label="Settlement CSV" upload={uploadCsv} state={uploads.settlement} /></div>
      </section>
      <section className="grid gap-8 border-b border-border pb-10 lg:grid-cols-[1.15fr_2fr] lg:gap-16">
        <div><p className="mb-5 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Daily settlement / audit view</p><h1 className="max-w-xl font-serif text-5xl leading-[0.95] tracking-tight sm:text-7xl">Payment matching,<br /><em className="text-muted-foreground">made legible.</em></h1></div>
        <div className="flex flex-col justify-end"><div className="flex items-end gap-8"><div><p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Match rate</p><p className="font-mono text-7xl leading-none tracking-[-0.08em] sm:text-8xl">{matchRate}<span className="text-4xl text-muted-foreground">%</span></p></div><div className="mb-1 h-16 w-px bg-border" /><div className="grid grid-cols-2 gap-x-8 gap-y-3 pb-1 sm:grid-cols-4"><Stat label="Total records" value={records.length} /><Stat label="Auto-reconciled" value={autoCount} accent="green" /><Stat label="AI review queue" value={aiCount} accent="amber" /><Stat label="Exceptions" value={exceptionCount} accent="rust" /></div></div></div>
      </section>

      <div className="flex flex-col gap-4 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-sm flex-1"><Search className="absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search payment ID or UTR" className="w-full border-b border-border bg-transparent py-2 pl-7 font-mono text-sm outline-none placeholder:text-muted-foreground focus:border-foreground" /></div><p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{filtered.length} of {records.length} records shown</p></div>
      {error && <div className="my-5 flex items-center gap-2 border border-rust/40 bg-rust/5 px-4 py-3 font-mono text-xs text-rust"><CircleAlert className="h-4 w-4" /> {error}</div>}
      {loading ? <div className="flex items-center gap-3 py-16 font-mono text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading settlement records…</div> : <div className="space-y-10 pt-8">
        <Section title="Auto-Reconciled" count={groups.auto.length} tone="green" open={open.auto} onToggle={() => setOpen((state) => ({ ...state, auto: !state.auto }))}><Table records={groups.auto} /></Section>
        <Section title="AI Review Queue" count={groups.ai.length} tone="amber" open={open.ai} onToggle={() => setOpen((state) => ({ ...state, ai: !state.ai }))}>
          <div className="flex items-center justify-end gap-2 border-b border-border pb-3 mb-1"><Clock3 className="h-3.5 w-3.5 text-muted-foreground" /><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Reviewer name for approval / rejection" className="border-b border-border bg-transparent px-1 py-1 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-foreground" /></div>
          <Table records={groups.ai} ai triaging={triaging} onTriage={triage} approving={approving} onApprove={approve} onReject={reject} />
        </Section>
        <Section title="Exceptions" count={groups.exceptions.length} tone="rust" open={open.exceptions} onToggle={() => setOpen((state) => ({ ...state, exceptions: !state.exceptions }))}><Table records={groups.exceptions} /></Section>
      </div>}
    </div>
  </main>
}

function UploadDropZone({ kind, label, upload, state }: { kind: UploadKind; label: string; upload: (kind: UploadKind, file: File) => void; state: { file?: string; message?: string; loading: boolean } }) {
  return <label className="flex min-h-32 cursor-pointer flex-col justify-between border border-dashed border-muted-foreground/50 px-4 py-4 transition-colors hover:border-foreground" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) upload(kind, file) }}>
    <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload(kind, file); event.currentTarget.value = '' }} />
    <span className="flex items-center justify-between"><span className="font-mono text-[11px] uppercase tracking-wider">{label}</span><FileUp className="h-4 w-4 text-muted-foreground" /></span>
    <span className="mt-6 space-y-1"><span className="block truncate font-mono text-xs text-muted-foreground">{state.loading ? 'Uploading…' : state.file ?? 'Drop CSV or choose file'}</span>{state.message && <span className="block font-mono text-[11px] text-green">{state.message}</span>}</span>
  </label>
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) { return <div><p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p><p className={`mt-1 font-mono text-xl ${accent ? `text-${accent}` : ''}`}>{value}</p></div> }
function Section({ title, count, tone, open, onToggle, children }: { title: string; count: number; tone: string; open: boolean; onToggle: () => void; children: React.ReactNode }) { return <section><button onClick={onToggle} className="flex w-full items-center justify-between border-b border-foreground pb-3 text-left"><span className="flex items-center gap-3"><span className={`h-2 w-2 bg-${tone}`} /><h2 className="font-serif text-2xl">{title}</h2><span className="font-mono text-xs text-muted-foreground">[{String(count).padStart(2, '0')}]</span></span><ChevronDown className={`h-4 w-4 transition-transform ${open ? '' : '-rotate-90'}`} /></button>{open && children}</section> }
function Table({ records, ai, triaging, onTriage, approving, onApprove, onReject }: { records: MatchResult[]; ai?: boolean; triaging?: string | null; onTriage?: (id: string) => void; approving?: string | null; onApprove?: (record: MatchResult) => void; onReject?: (record: MatchResult) => void }) { if (!records.length) return <div className="border-b border-border py-6 font-mono text-xs text-muted-foreground">No records in this section.</div>; return <div className="overflow-x-auto"><div className="min-w-[760px]"><div className="grid grid-cols-[1.2fr_1.2fr_0.7fr_0.8fr_1.5fr] gap-4 py-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"><span>Payment ID</span><span>UTR</span><span>Status</span><span className="text-right">Amount</span><span className="text-right">Action / reasoning</span></div>{records.map((record) => <div key={record.id} className="grid grid-cols-[1.2fr_1.2fr_0.7fr_0.8fr_1.5fr] items-start gap-4 border-t border-border py-4 font-mono text-xs"><span className="truncate">{record.payment_id ?? '—'}</span><span className="truncate text-muted-foreground">{record.utr ?? '—'}</span><span className="text-muted-foreground">{record.status.replaceAll('_', ' ').toLowerCase()}</span><span className="text-right">{formatAmount(record.settled_paisa ?? record.expected_net_paisa, record.currency ?? 'INR')}</span><div className="text-right">{ai && !record.ai_reasoning ? <button onClick={() => onTriage?.(record.id)} disabled={triaging === record.id} className="inline-flex items-center gap-1.5 border border-amber px-2 py-1 text-[10px] uppercase text-amber hover:bg-amber hover:text-background disabled:opacity-50">{triaging === record.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Run AI triage</button> : ai ? <div className="space-y-2 text-left"><p className="leading-relaxed text-foreground">{record.ai_reasoning}</p><p className="text-[10px] text-amber">Confidence: {record.ai_confidence != null ? `${Math.round(record.ai_confidence * 100)}%` : '—'}</p><div className="flex items-center justify-end gap-3"><button onClick={() => onApprove?.(record)} disabled={approving === record.id} className="inline-flex items-center gap-1 border border-green px-2 py-1 text-[10px] uppercase text-green hover:bg-green hover:text-background disabled:opacity-50"><ShieldCheck className="h-3 w-3" /> Approve</button><button onClick={() => onReject?.(record)} disabled={approving === record.id} className="inline-flex items-center gap-1 border border-rust px-2 py-1 text-[10px] uppercase text-rust hover:bg-rust hover:text-background disabled:opacity-50"><CircleX className="h-3 w-3" /> Reject</button></div></div> : <span className="inline-flex items-center gap-1 text-[10px] uppercase text-green"><ShieldCheck className="h-3.5 w-3.5" /> Rule matched</span>}{approving === record.id && <span className="ml-2 text-[10px] text-muted-foreground">Saving…</span>}</div></div>)}</div></div> }
