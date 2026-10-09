// public/js/dataVersion.js — the build tag of the page this module belongs to, and the data URLs that follow it.
//
// WHY: /data/*.json is fetched with `cache: 'no-cache'` — the data is rewritten in place by deploys, so a blind
// cache would be wrong — which means every load asks again. That is 74 MiB of this host's uplink in 4.85 days
// (7.7% of everything it sends; docs/上行带宽最大化压缩.md), on top of the module graph moduleVersion.js handles.
//
// The served modules already carry `?v=<buildTag>` (server/http/moduleVersion.js), so this module reads the tag
// out of its OWN url — `import.meta.url` — and puts it on the data it fetches. A versioned URL answers
// IMMUTABLE_CACHE (server/http/files.js): the browser and the CDN edge keep it, a deploy (a new tag) is a new
// URL, and nothing has to be invalidated. The tag hashes the served runtime including `data/`, so art and data
// deploys bump it too.
//
// Nowhere is this a requirement: with no tag (a Node test, a host that serves the tree unversioned, the APK's
// own copy) every caller keeps the exact request it made before — same URL, `no-cache`.

/** The build tag of the served runtime, read from this module's own URL (`/js/dataVersion.js?v=<tag>`). */
export const BUILD_TAG = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || null; } catch { return null; }
})();

/** An absolute URL is another host's content with its own caching rules: never versioned here. */
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A static data request of this page's own build: the URL with `?v=<tag>` when there is a tag to add, and the
 * cache mode that belongs to it (`default` reuses the immutable response; `no-cache` is the old revalidate).
 * @param {string} url
 * @param {string|null} [tag] the page's build tag (defaults to this module's own); a test passes one directly
 * @returns {{ url: string, cache: 'default' | 'no-cache' }}
 */
export function dataRequest(url, tag = BUILD_TAG) {
  if (!tag || typeof url !== 'string' || !url) return { url, cache: 'no-cache' };
  if (ABSOLUTE.test(url) || url.startsWith('//')) return { url, cache: 'no-cache' };
  if (/[?&]v=/.test(url)) return { url, cache: 'default' };
  return { url: `${url}${url.includes('?') ? '&' : '?'}v=${tag}`, cache: 'default' };
}
