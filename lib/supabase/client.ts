import { createClient } from '@supabase/supabase-js'

let client: ReturnType<typeof createClient> | undefined

export function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('Supabase connection is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.')
  }

  if (!client) {
    client = createClient(url, anonKey)
  }

  return client
}
