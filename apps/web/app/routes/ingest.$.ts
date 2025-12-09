import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

const API_HOST = process.env.VITE_POSTHOG_URL || 'https://us.i.posthog.com';
const ASSET_HOST =
  process.env.VITE_POSTHOG_ASSETS_URL || 'https://us-assets.i.posthog.com';

const posthogProxy = async (request: Request, splat?: string) => {
  const url = new URL(request.url);
  const targetHost = url.pathname.startsWith('/qwery/static/')
    ? ASSET_HOST
    : API_HOST;

  const newUrl = new URL(url);
  newUrl.protocol = 'https';
  newUrl.hostname = new URL(targetHost).hostname;
  newUrl.port = '443';

  // Use splat parameter if available, otherwise extract from pathname
  if (splat) {
    newUrl.pathname = `/${splat}`;
  } else {
    newUrl.pathname = newUrl.pathname.replace(/^\/qwery/, '');
  }

  const headers = new Headers(request.headers);
  headers.set('host', new URL(targetHost).hostname);

  const fetchOptions: RequestInit = {
    method: request.method,
    headers,
    body: request.body,
  };

  // This is required when passing a streaming body (like request.body) to fetch.
  if (request.body) {
    (fetchOptions as { duplex?: string }).duplex = 'half';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  fetchOptions.signal = controller.signal;

  try {
    const response = await fetch(newUrl, fetchOptions);
    clearTimeout(timeoutId);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    // Always clear timeout to prevent memory leaks
    clearTimeout(timeoutId);

    // Extract error code from various error types (AggregateError, Error, etc.)
    const errorCode =
      (error as { code?: string }).code ||
      (error as { cause?: { code?: string } }).cause?.code;

    // Check if it's a timeout/abort error
    const isTimeout =
      (error instanceof Error && error.name === 'AbortError') ||
      errorCode === 'ETIMEDOUT';

    // Check if it's a network error (TypeError for fetch failures, ETIMEDOUT, etc.)
    const isNetworkError =
      error instanceof TypeError ||
      errorCode === 'ETIMEDOUT' ||
      (error instanceof Error && error.message.includes('fetch failed'));

    // Silently handle analytics failures - they're not critical
    if (isTimeout || isNetworkError) {
      // Return empty 200 response for analytics to prevent client retries
      // Only log in development for debugging
      if (process.env.NODE_ENV === 'development') {
        console.debug(
          `[PostHog Proxy] ${isTimeout ? 'Timeout' : 'Network error'} (silent):`,
          newUrl.pathname,
        );
      }
      return new Response('', { status: 200 });
    }

    // Only log unexpected errors in development
    if (process.env.NODE_ENV === 'development') {
      console.error('[PostHog Proxy] Unexpected error:', error);
    }
    return new Response('', { status: 200 });
  }
};

export const loader = async ({ request, params }: LoaderFunctionArgs) =>
  posthogProxy(request, params['*']);

export const action = async ({ request, params }: ActionFunctionArgs) =>
  posthogProxy(request, params['*']);
