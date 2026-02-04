# SSR SEO Guide

This guide covers practical SEO patterns for Fict SSR apps.

## 1) Core Rule: Ship SEO-Critical HTML in the First Response

Search bots may not execute deferred JS patches. Put these in the initial HTML:

- `<title>`
- `<meta name="description">`
- canonical URL
- Open Graph/Twitter tags
- primary heading and core content

Do not rely on streamed patch chunks to provide SEO-critical text.

## 2) Per-Route Metadata

Generate metadata on the server per route, then render SSR HTML with those values.

```ts
type SeoMeta = {
  title: string
  description: string
  canonical: string
  ogImage?: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderDocument(appHtml: string, seo: SeoMeta): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(seo.title)}</title>
    <meta name="description" content="${escapeHtml(seo.description)}" />
    <link rel="canonical" href="${escapeHtml(seo.canonical)}" />
    <meta property="og:title" content="${escapeHtml(seo.title)}" />
    <meta property="og:description" content="${escapeHtml(seo.description)}" />
    ${seo.ogImage ? `<meta property="og:image" content="${escapeHtml(seo.ogImage)}" />` : ''}
  </head>
  <body>${appHtml}</body>
</html>`
}
```

## 3) Status Codes Matter

Use proper HTTP status codes from the server layer:

- `200` for valid pages
- `301/308` for permanent redirects
- `404` for missing pages
- `410` for removed pages

Bots treat status codes as ranking/indexing signals.

## 4) Structured Data (JSON-LD)

If your page benefits from rich results (article/product/faq), inject JSON-LD server-side.

```html
<script type="application/ld+json">
  { "@context": "https://schema.org", "@type": "Article", "headline": "..." }
</script>
```

## 5) Streaming-Specific Guidance

- In `mode: 'shell'`, keep meaningful fallback content (not empty placeholders).
- Put SEO-relevant content in shell HTML, not only in Suspense resolved chunks.
- Avoid title/description changes that depend on client-only execution.

## 6) Robots + Sitemap

Always provide:

- `/robots.txt`
- `/sitemap.xml` (or sitemap index for large sites)

Regenerate sitemap when route inventory changes.

## 7) Canonical Consistency

Avoid duplicate URLs with inconsistent canonical tags:

- normalize trailing slash policy
- normalize query params for canonical links
- ensure one canonical URL per content page

## 8) Quick Checklist

- Route renders with correct title/description in view-source.
- Correct status code for every route class (normal/not-found/redirect).
- Canonical tag is absolute and stable.
- JSON-LD validates in Rich Results Test.
- Shell HTML is meaningful without running JS.
