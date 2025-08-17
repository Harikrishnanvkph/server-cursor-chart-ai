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
if (!supabaseServiceRoleKey) {
  console.warn('⚠️ SUPABASE_SERVICE_ROLE_KEY is not set. OAuth functionality will not work properly.');
}

export const supabaseUserClient = createClient(supabaseUrl || '', supabaseAnonKey || '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Create admin client only if the service role key is provided
export const supabaseAdminClient = supabaseServiceRoleKey
  ? createClient(supabaseUrl || '', supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null

export const getSupabaseAuthUrls = () => {
  if (!supabaseUrl) throw new Error('SUPABASE_URL is not configured')
  return {
    authorize: `${supabaseUrl}/auth/v1/authorize`,
    token: `${supabaseUrl}/auth/v1/token`,
    user: `${supabaseUrl}/auth/v1/user`,
  }
}


