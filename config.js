// FiTrack runtime configuration.
// The anon/publishable key is safe to expose in the browser — every table is
// protected by Postgres Row-Level Security, so the key alone grants no access
// to anyone's data without a valid signed-in session.
window.FITRACK_CONFIG = {
  SUPABASE_URL: "https://zmllzvvlumsaolbnfknt.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InptbGx6dnZsdW1zYW9sYm5ma250Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NzgyNTEsImV4cCI6MjA5MjU1NDI1MX0.jGhsMQoq3sIFTEuvQ0s9672E2GkbKq8Xnbtv0HmUba4",
  SCHEMA: "fitrack",
};
