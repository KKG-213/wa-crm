import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // These exact endpoints authenticate signed raw bodies, not browser cookies.
  // Each handler verifies its own signature before creating a service client.
  if (['/api/webhook', '/api/hermes/outbound'].includes(request.nextUrl.pathname)) return NextResponse.next();
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthPage = request.nextUrl.pathname.startsWith('/auth');
  const isDashboard = request.nextUrl.pathname.startsWith('/dashboard');
  const isRoot = request.nextUrl.pathname === '/';

  if (!user && request.nextUrl.pathname.startsWith('/api/')) {
    const response = NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    return response;
  }

  if (!user && isDashboard) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/login';
    return NextResponse.redirect(url);
  }

  if (user && (isAuthPage || isRoot)) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
