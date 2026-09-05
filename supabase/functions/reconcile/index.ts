import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const groqApiKey = Deno.env.get("GROQ_API_KEY")!;
const supabase = createClient(supabaseUrl, serviceKey);

const TOLERANCE_PAISA = 2;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept-profile, content-profile, prefer",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { action, matchResultId, approvedBy } = await req.json().catch(() => ({ action: "run_matching" }));

    if (action === "approve") {
      const { data: record, error: fetchErr } = await supabase
        .from("match_results")
        .select("ai_reasoning")
        .eq("id", matchResultId)
        .single();
      if (fetchErr || !record?.ai_reasoning) {
        return json({ error: "Cannot approve a record with no AI reasoning yet." }, 400);
      }
      const { error } = await supabase
        .from("match_results")
        .update({ human_approved: true, approved_by: approvedBy || "unknown", approved_at: new Date().toISOString() })
        .eq("id", matchResultId);
      if (error) return json({ error: error.message }, 500);

      await supabase.from("audit_log").insert({
        match_result_id: matchResultId,
        action: "HUMAN_APPROVED",
        actor: approvedBy || "unknown",
      });
      return json({ success: true });
    }

    if (action === "reject") {
      const { data: record, error: fetchErr } = await supabase
        .from("match_results")
        .select("ai_reasoning, reason")
        .eq("id", matchResultId)
        .single();
      if (fetchErr || !record?.ai_reasoning) {
        return json({ error: "Cannot reject a record with no AI reasoning yet." }, 400);
      }
      const { error } = await supabase
        .from("match_results")
        .update({
          status: "EXCEPTION_AI_REJECTED",
          human_approved: false,
          approved_by: approvedBy || "unknown",
          approved_at: new Date().toISOString(),
          reason: `AI suggestion rejected by reviewer. Original AI reasoning: ${record.ai_reasoning}`,
        })
        .eq("id", matchResultId);
      if (error) return json({ error: error.message }, 500);

      await supabase.from("audit_log").insert({
        match_result_id: matchResultId,
        action: "HUMAN_REJECTED_AI_SUGGESTION",
        actor: approvedBy || "unknown",
      });
      return json({ success: true });
    }

    if (action === "clear_all") {
      const { error: auditErr } = await supabase.from("audit_log").delete().neq("id", 0);
      if (auditErr) return json({ error: auditErr.message }, 500);

      const { error: matchErr } = await supabase.from("match_results").delete().neq("id", 0);
      if (matchErr) return json({ error: matchErr.message }, 500);

      const { error: settlementErr } = await supabase.from("settlements").delete().neq("id", 0);
      if (settlementErr) return json({ error: settlementErr.message }, 500);

      const { error: ledgerErr } = await supabase.from("internal_ledger").delete().neq("id", 0);
      if (ledgerErr) return json({ error: ledgerErr.message }, 500);

      await supabase.from("audit_log").insert({
        action: "CLEAR_ALL_DATA",
        actor: approvedBy || "unknown",
      });

      return json({ success: true, message: "All data cleared." });
    }

    if (action === "ai_triage") {
      const { data: record, error: fetchErr } = await supabase
        .from("match_results")
        .select("*")
        .eq("id", matchResultId)
        .single();
      if (fetchErr || !record) return json({ error: "Record not found" }, 404);

      try {
        const aiResult = await callGroq(record.expected_net_paisa, record.settled_paisa, record.delta_paisa);
        const { error } = await supabase
          .from("match_results")
          .update({
            ai_reasoning: `[${aiResult.category}] ${aiResult.reasoning}`,
            ai_confidence: aiResult.confidence,
          })
          .eq("id", matchResultId);
        if (error) return json({ error: error.message }, 500);

        await supabase.from("audit_log").insert({
          match_result_id: matchResultId,
          action: "AI_TRIAGE_COMPLETED",
          actor: "system",
          details: aiResult,
        });
        return json({ success: true, aiResult });
      } catch (e) {
        await supabase
          .from("match_results")
          .update({ ai_reasoning: `AI triage failed: ${e.message}. Requires manual review.` })
          .eq("id", matchResultId);
        return json({ success: false, escalated: true, error: e.message });
      }
    }

    // Default action: run_matching
    const ledgerResult = await supabase.from("internal_ledger").select("*");
    const settlementResult = await supabase.from("settlements").select("*");
    if (ledgerResult.error || settlementResult.error) {
      return json({
        ledgerError: ledgerResult.error,
        settlementError: settlementResult.error
      }, 400);
    }
    const ledgerRows = ledgerResult.data;
    const settlementRows = settlementResult.data;

    await supabase.from("match_results").delete().neq("id", 0);

    const settlementIndex: Record<string, any[]> = {};
    for (const row of settlementRows) {
      (settlementIndex[row.payment_id] ??= []).push(row);
    }
    const ledgerIds = new Set(ledgerRows.map((r) => r.payment_id));

    const results: any[] = [];

    for (const ledgerRow of ledgerRows) {
      const expectedNet = ledgerRow.amount_paisa - ledgerRow.fee_paisa - ledgerRow.tax_on_fee_paisa;
      const matches = settlementIndex[ledgerRow.payment_id] || [];

      if (matches.length === 0) {
        results.push({
          payment_id: ledgerRow.payment_id, status: "EXCEPTION_UNSETTLED",
          expected_net_paisa: expectedNet,
          reason: "No settlement record found for this payment.",
        });
        continue;
      }
      if (matches.length > 1) {
        results.push({
          payment_id: ledgerRow.payment_id, status: "EXCEPTION_DUPLICATE_UTR",
          expected_net_paisa: expectedNet,
          utr: matches.map((m) => m.utr).join(", "),
          reason: `Payment matched to ${matches.length} settlement rows. Possible duplicate.`,
        });
        continue;
      }
      const settled = matches[0].settled_amount_paisa;
      const delta = settled - expectedNet;

      if (delta === 0) {
        results.push({
          payment_id: ledgerRow.payment_id, status: "AUTO_RECONCILED_EXACT",
          expected_net_paisa: expectedNet, settled_paisa: settled, delta_paisa: delta,
          utr: matches[0].utr, reason: "Exact match.",
        });
      } else if (Math.abs(delta) <= TOLERANCE_PAISA) {
        results.push({
          payment_id: ledgerRow.payment_id, status: "AUTO_RECONCILED_TOLERANCE",
          expected_net_paisa: expectedNet, settled_paisa: settled, delta_paisa: delta,
          utr: matches[0].utr, reason: `Within tolerance (${delta} paisa).`,
        });
      } else {
        results.push({
          payment_id: ledgerRow.payment_id, status: "AI_REVIEW_QUEUE",
          expected_net_paisa: expectedNet, settled_paisa: settled, delta_paisa: delta,
          utr: matches[0].utr, reason: `Mismatch of ${delta} paisa exceeds tolerance.`,
        });
      }
    }

    for (const s of settlementRows) {
      if (!ledgerIds.has(s.payment_id)) {
        results.push({
          payment_id: s.payment_id, status: "EXCEPTION_ORPHAN_SETTLEMENT",
          settled_paisa: s.settled_amount_paisa, utr: s.utr,
          reason: "Settlement with no matching ledger entry.",
        });
      }
    }

    const { error: insertErr } = await supabase.from("match_results").insert(results);
    if (insertErr) return json({ error: insertErr.message }, 500);

    await supabase.from("audit_log").insert({
      action: "MATCHING_RUN_COMPLETED",
      actor: "system",
      details: { total: results.length },
    });

    return json({ success: true, total: results.length });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
});

async function callGroq(expected: number, settled: number, delta: number) {
  const systemPrompt = `You are a payments reconciliation analyst. Given a settlement mismatch, classify it into exactly one category: PARTIAL_REFUND_NETTED, FEE_MISCALCULATION, DATA_ENTRY_ERROR, or REQUIRES_MANUAL_INVESTIGATION. Respond ONLY with strict JSON: {"category": "...", "confidence": 0.0-1.0, "reasoning": "one or two sentences"}`;
  const userPrompt = `Expected net: ${expected} paisa. Actual settled: ${settled} paisa. Delta: ${delta} paisa. Classify this discrepancy.`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqApiKey}` },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.2,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.choices) {
    throw new Error(`Groq API error: ${JSON.stringify(data)}`);
  }
  const text = data.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
