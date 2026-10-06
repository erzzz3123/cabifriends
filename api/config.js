// GET /api/config → public Supabase settings for the /admin sign-in page.
// The anon key is designed to be public: row-level security is what protects the data.
export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600');
  res.status(200).send('window.CF_SUPABASE=' + JSON.stringify({ url: process.env.SUPABASE_URL || '', anonKey: process.env.SUPABASE_ANON_KEY || '' }) + ';');
}
