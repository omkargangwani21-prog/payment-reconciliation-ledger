import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = "https://oxeukllwezkudyqnsilq.supabase.co"
const SUPABASE_ANON_KEY = "sb_publishable_Stq9Qj2PuKNVGqyBl4RYmQ_eFDeg-0Q"

let client: ReturnType<typeof createClient> | undefined

export function getSupabaseClient() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  }

  return client
}
