import test from 'node:test';
import assert from 'node:assert/strict';

const envModule = await import('../src/lib/supabase/env.ts');

test('throws a clear error when Supabase public config is missing', () => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  try {
    assert.throws(
      () => envModule.getSupabaseConfig(),
      /NEXT_PUBLIC_SUPABASE_URL.*NEXT_PUBLIC_SUPABASE_ANON_KEY/i,
    );
  } finally {
    if (previousUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousAnon) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousAnon;
  }
});
