import { createClient } from '@supabase/supabase-js';
export const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
export const publicUrl = (path) => path ? sb.storage.from('friends').getPublicUrl(path).data.publicUrl : null;
