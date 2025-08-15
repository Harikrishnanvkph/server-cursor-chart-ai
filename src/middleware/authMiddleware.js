import { supabaseUserClient } from '../supabase/client.js'

export async function requireAuth(req, res, next) {
  try {
    const accessToken = req.cookies?.access_token
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { data, error } = await supabaseUserClient.auth.getUser(accessToken)
    if (error) throw error
    const user = data.user

    req.user = user
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}


