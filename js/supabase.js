// Supabase Client Configuration
// Include this file in all pages that need Supabase access

const SUPABASE_URL = 'https://angsimeqepjksecoqrnj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFuZ3NpbWVxZXBqa3NlY29xcm5qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0MjU5MTgsImV4cCI6MjA4MTAwMTkxOH0.6qPJxE7YeC5xg7aD8qftcjo9Bj3lfzRkCDEctEw46_w';

// Initialize Supabase client
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
