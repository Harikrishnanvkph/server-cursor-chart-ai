import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

// Enhanced environment variable validation
if (!supabaseUrl) {
  console.error('❌ SUPABASE_URL is not set. Supabase client will not work properly.');
}
if (!supabaseAnonKey) {
  console.error('❌ SUPABASE_ANON_KEY is not set. Supabase client will not work properly.');
}
export const supabaseUserClient = createClient(supabaseUrl || '', supabaseAnonKey || '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Create admin client — fail fast if service role key is missing (required for OAuth, sessions, etc.)
if (!supabaseServiceRoleKey) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY is not set. Server cannot start without it.');
  process.exit(1);
}

export const supabaseAdminClient = createClient(supabaseUrl || '', supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

export const getSupabaseAuthUrls = () => {
  if (!supabaseUrl) throw new Error('SUPABASE_URL is not configured')
  return {
    authorize: `${supabaseUrl}/auth/v1/authorize`,
    token: `${supabaseUrl}/auth/v1/token`,
    user: `${supabaseUrl}/auth/v1/user`,
  }
}


