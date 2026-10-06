import { createClient } from '@supabase/supabase-js';

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`Missing environment variable ${k}`); return v; };
let pub, admin;

// Anon key: the same access any visitor has, so row-level security decides what it can read
// (prefectures + published Friends). Used for everything public-facing.
export const sbPublic = () => (pub ||= createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), opts));

// Service-role key: bypasses RLS. Server only — submissions, approvals, Airtable sync.
export const sbAdmin = () => (admin ||= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), opts));

// friend_images.path is either a key in the public `friends` bucket or a site path like `assets/friends/…` (bundled photos).
export const publicUrl = (path) => {
  if (!path) return null;
  if (/^(https?:)?\/\//.test(path) || path.startsWith('assets/') || path.startsWith('/')) return path;
  return `${env('SUPABASE_URL')}/storage/v1/object/public/friends/${path.split('/').map(encodeURIComponent).join('/')}`;
};

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Signed-in staff only: verifies the Supabase access token and checks the `admins` table. Returns the email or null.
export async function adminFrom(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await sbAdmin().auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) return null;
  const { data: row } = await sbAdmin().from('admins').select('email').eq('email', email).maybeSingle();
  return row ? email : null;
}
