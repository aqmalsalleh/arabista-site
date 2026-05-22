# 📘 ARABISTA FRONTEND & RETAIL ALTERATION — MASTER BLUEPRINT

**Version:** 4.4 | **Aligned to codebase:** May 22, 2026  
**Canonical detail:** Operational depth, API names, column maps, and DevOps live in `Arabista_Retail_Master_Doc.md`. This blueprint is the **product-level story** for the static retail frontend: page archetypes, the dual JavaScript engine, and strict parity rules between staging and production file pairs.

**v4.4 (22 May):** **Global favicon standard (Google Search).** Every tracked `.html` page (root and `checkout/`) now includes `favicon-192x192.png` in the `<head>` icon cluster, immediately after the existing `favicon.ico`, `apple-touch-icon`, `32×32`, and `16×16` links. Root pages use `href="images/favicon-192x192.png"`; `checkout/*` uses `href="../images/favicon-192x192.png"`. The 192×192 PNG satisfies Google’s “multiple of 48px” favicon guidance and is required on **both** staging and production pairs (same relative path; not an environment-specific delta).

**v4.3 (20 May):** **Portal Page architecture.** New top-of-funnel surfaces `products.html` / `products-staging.html` (`pageType: "portal"`) sit above the catalog grid. Portal pages use a **Cinematic Crossfade** hero card, a **master category nav** (anchor links, not filter buttons), and **no product grid**. `arabista-core.js` hydrates the full inventory matrix in the background via `fetchCatalogForPortal()` so the shared cart drawer behaves identically to grid and PDP pages. `arabista-catalog.js` is still loaded on portal pages but **no-ops** immediately when `pageType !== 'catalog'`. Environmental config is centralized in `window.ARABISTA_CONTEXT` (replacing legacy `RETAIL_API_URL` / inline cart key constants). Staging cart keys are now `arabista_cart_stg` and `arabista_checkout_draft_stg`.

**v3.3 (10 May):** Tri-platform analytics in `arabista-core.js` (`gtagSafe`, `fbqSafe`, `ttqSafe`); `AddToCart` fan-out inside `Cart.addItem`; `begin_checkout` / `InitiateCheckout` in `doCheckout` before `reserve_stock`.

**v3.2 (06 May):** Premium PDP layout pack — see **Section 10**.

---

## 1. Why this exists (project genesis)

* **Problem:** Alteration (`ALT-…`) and direct retail (`ORD-…`) must share one public domain and payment channels without one system’s webhooks or sheets corrupting the other.
* **Answer:** A **Master Webhook Router** (`Webhook_Router_STAGING.gs` / `Webhook_Router.gs`) is the only public ingress for Meta and SenangPay. Frontend pages are static HTML; all live inventory and checkout logic flows through the Retail Apps Script web app (`get_config`, `calc_shipping`, `reserve_stock`).

---

## 2. Isolation map (files you actually touch)

| Layer | Staging · production artifact | Role |
|--------|-------------------------------|------|
| **Portal** | `products-staging.html` · `products.html` | Top-of-funnel category hub; cinematic card → abaya grid. `pageType: "portal"`. Core-only fetch; catalog.js no-op. |
| **Catalog grid** | `abaya-staging.html` · `abaya.html` | Collection grid, hero, category tabs, filter drawer, live pricing. `pageType: "catalog"`. Core + catalog.js. |
| **Product PDP** | `product-{sku}-staging.html` · `product-{sku}.html` | SKU-specific copy, gallery, size chart, alterations, reviews. No `pageType` (defaults to PDP). Core only. |
| SenangPay return | `checkout/success-router-staging.html` · `checkout/success-router.html` | Reads `order_id`; routes `ORD-…` / `STGORD-…` to retail success. |
| Success / CRM kickoff | `checkout/retail-success-staging.html` · `checkout/retail-success.html` | Post-payment screen. |
| Shared engines | `arabista-core.js` · `arabista-catalog.js` | Cart, checkout, PDP logic (core); grid filters + pricing UI (catalog). |
| Retail API | `Retail_STAGING.gs` · `Retail.gs` | Inventory, SenangPay, J&T after pay. |

**Customer journey (Abaya):** `products*.html` → `abaya*.html` → `product-*.html` → cart → SenangPay.

---

## 3. Three page archetypes

All retail HTML pages share the same **fixed header**, **glass cart drawer** (IDs: `nav-cart-btn`, `cart-drawer`, `cart-name`, `btn-checkout`, etc.), and Tailwind design tokens (`brand`, `luxe`, `ink`). They diverge by `window.ARABISTA_CONTEXT.pageType` and body layout.

| Archetype | Files | `pageType` | Scripts loaded |
|-----------|-------|------------|----------------|
| **Portal** | `products-staging.html`, `products.html` | `"portal"` | `arabista-core.js` + `arabista-catalog.js` (catalog exits immediately) |
| **Grid** | `abaya-staging.html`, `abaya.html` | `"catalog"` | `arabista-core.js` + `arabista-catalog.js` |
| **PDP** | `product-*-staging.html`, `product-*.html` | *(omitted)* | `arabista-core.js` only |

### 3.1 Portal (`products*.html`)

* **No** full-width hero section (removed during V4.3 migration from the abaya template).
* **Master category nav:** Sticky bar below the header (`top-14 sm:top-16`). Uses **anchor links** to the portal URL (e.g. `products-staging.html` with active “Abaya” tab), not `.nav-btn` filter buttons.
* **Cinematic card:** Single `<main>` entry — a linked card (`aspect-[4/5] sm:aspect-[16/9]`) pointing to `abaya-staging.html` or `abaya.html`.
* **Preload:** `images/d01-1-hero.webp` in `<head>`.
* **Reveal:** `.reveal` elements animated by `bindRevealObserver()` in core (portal init path).

### 3.2 Grid (`abaya*.html`)

* **Hero section:** Full-bleed `hero-poster.webp` with collection title.
* **Category nav:** Sticky bar with `.nav-btn` buttons (`data-target`: `all`, `dahlia`, `zahra`, `maraya`) — filters `#product-grid` via `arabista-catalog.js`.
* **Filter drawer:** `#filter-drawer`, `#filter-overlay`, size chips, sort radios (`low-high` / `high-low`), search (`#search-input`). Filter button disabled until `get_config` returns.
* **Product grid:** `#product-grid` with `article.product-card[data-sku][data-category]`; price skeletons replaced live by catalog.js.
* **Reveal:** Handled inside `arabista-catalog.js` `bindUI()`.

### 3.3 PDP (`product-*.html`)

* Full premium chrome: breadcrumb (Products → Series → SKU), gallery, buy column, size chart modal, reviews, cross-sell, footer.
* **`ARABISTA_CONTEXT.baseItem`** required (e.g. `"Z01"`). Rich per-SKU fields: `gallery`, `sizeChart`, `alterationServices`, `bmiThresholds`, `heightLengthBuckets`, `reviews`, `tiktokUrl`.
* **Single `get_config` fetch** in core hydrates PDP matrix slice + cross-sell from one response.
* Breadcrumb “Products” links to `products-staging.html` or `products.html` (not directly to abaya).

---

## 4. Dual JavaScript engine

### 4.1 `arabista-core.js` (always active when `apiUrl` is set)

Product-agnostic **cart**, **checkout**, **shipping**, **draft persistence**, and **PDP** modules.

**Boot guard:**

```javascript
if (!API_URL) return;
if (pageType !== 'catalog' && pageType !== 'portal' && !baseItem) return;
```

**`init()` branches:**

| `pageType` | Behaviour |
|------------|-----------|
| *(all)* | `bindCartUi()`, `bindDraftPersistence()`, `loadDraft()`, `updateCartCount()` |
| `"portal"` | Footer year, `bindRevealObserver()`, `fetchCatalogForPortal()` → sets `window.ARABISTA_APP_CONFIG`, `window.ARABISTA_MATRIX`, fires `arabista:config_ready` |
| `"catalog"` | Stops after global cart modules; grid pricing/filters delegated to catalog.js |
| PDP (default) | Gallery, size grid, reviews, `view_item`, one `get_config` fetch, pricing, cross-sell |

**Portal background fetch (`fetchCatalogForPortal`):** Same `?action=get_config` as the grid, with `cb` + truncated `ua`. Ensures cart line items can resolve SKUs for OOS rollback, weight, and promo-aware shipping — without a visible product grid.

**Catalog shipping seam:** On grid pages, if the user opens the cart before catalog.js finishes, `calcShipping()` paints a skeleton and returns until `arabista:config_ready` (listener: `handleConfigReady`). Portal and PDP populate config via core’s own fetch paths.

**Analytics (centralised — do not duplicate in HTML):**

* `Cart.addItem` → GA4 `add_to_cart`, Meta `AddToCart`, TikTok `AddToCart`
* PDP load → `view_item`
* `selectSize` → `select_item`
* Alteration toggle → `view_alteration_options`
* `doCheckout` (before `reserve_stock`) → `begin_checkout`, Meta/TikTok `InitiateCheckout`

Helpers: `gtagSafe`, `fbqSafe`, `ttqSafe` — no-op if the global tag is missing.

### 4.2 `arabista-catalog.js` (grid only)

```javascript
if (!ctx || ctx.pageType !== 'catalog') return;
```

**Responsibilities:**

1. Category tabs + mobile drawer category sync (`applyCategory`)
2. Search, size filter, sort (`runFilters`, `applySorting`)
3. `fetchCatalogData()` → `updateCatalogUI(matrix)` — prices, sold-out badges, `data-sizes`, `data-price`
4. Dispatches `arabista:config_ready` with `{ config }` for core’s promo/shipping hand-off

Portal pages include this script tag for **parity with abaya markup** and future shared bundles; it performs zero DOM work on portal load.

---

## 5. Portal page — Cinematic Crossfade CSS

Defined inline in `products-staging.html` / `products.html` `<style>`:

```css
.crossfade-img {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; opacity: 0;
  animation: cinematic-fade 15s infinite ease-in-out;
}
.crossfade-img:nth-child(1) { animation-delay: 0s; }
.crossfade-img:nth-child(2) { animation-delay: 5s; }
.crossfade-img:nth-child(3) { animation-delay: 10s; }

@keyframes cinematic-fade {
  0%   { opacity: 0; transform: scale(1); }
  10%  { opacity: 1; transform: scale(1.02); }
  33%  { opacity: 1; transform: scale(1.04); }
  43%  { opacity: 0; transform: scale(1.05); }
  100% { opacity: 0; transform: scale(1.05); }
}
```

Three stacked images inside the card: `d01-1-hero.webp`, `z01-1-hero.webp`, `m01-1-hero.webp` (Dahlia / Zahra / Maraya). Gradient overlay + glass CTA panel (“Explore Collection”).

---

## 6. Catalog grid — filters & live data (unchanged behaviour)

Reference implementation: **`abaya-staging.html`**.

| Feature | Implementation |
|---------|------------------|
| Category filter | `.nav-btn[data-target]` + drawer `.drawer-filter-option` → `activeCategory` |
| Search | `#search-input` / `#search-trigger-btn` — matches card `innerText` |
| Size filter | `appliedSizes[]` vs `article.dataset.sizes` (comma-separated, synced from API) |
| Sort | `input[name="sort"]` — reorders DOM by `dataset.price` |
| Live pricing | `get_config` → per-`baseItem` promo/retail, sold-out badge, disables card |
| Filter lock | `#filter-btn` disabled until fetch succeeds |

Grid card links: staging → `product-{sku}-staging.html`; production → `product-{sku}.html`.

---

## 7. PDP — `ARABISTA_CONTEXT` injection

Each PDP ends with an inline script **before** `arabista-core.js`:

```javascript
window.ARABISTA_CONTEXT = {
  baseItem: "Z01",
  apiUrl: "https://script.google.com/macros/s/…/exec",
  seriesName: "Zahra Series",
  heroImage: "images/z01-1-hero.webp",
  cartStorageKey: "arabista_cart_stg",      // or arabista_cart (production)
  draftStorageKey: "arabista_checkout_draft_stg",
  gallery: [ /* { type: "img"|"vid", src, thumb? } */ ],
  sizeChart: { /* size → { length, sleeve, shoulder, bust } */ },
  sizeOrder: ["XS", "S", …],
  alterationServices: [ /* { id, key, label, bmName } */ ],
  bmiThresholds: [ /* { max, size } */ ],
  heightLengthBuckets: [ /* { max, length } */ ],
  tiktokUrl: "…",
  reviews: [ /* { username, size, rating, original } */ ]
};
```

**Reference:** `product-z01-staging.html` (richest SKU; use for new PDPs per Rule 4).

Grid and portal use a **minimal** context (no `baseItem`):

```javascript
window.ARABISTA_CONTEXT = {
  pageType: "catalog", // or "portal"
  apiUrl: "…",
  cartStorageKey: "…",
  draftStorageKey: "…"
};
```

---

## 8. Analytics & pixels by surface

| Surface | Staging `<head>` | Production `<head>` |
|---------|------------------|---------------------|
| Portal `products*` | Mock GA4 `G-0000000000`, Meta `000…0000` | Same mock IDs (intentionally quiet) |
| Grid `abaya-staging` | Mock GA4 / Meta | — |
| Grid `abaya` | — | Live GA4 `G-Q6KYKNKZW6`, Meta `815939587846892` |
| PDP `*-staging` | Mock GA4 / Meta | — |
| PDP production | — | Live GA4 `G-Q6KYKNKZW6`, Meta `815939587846892` |

**E-commerce events** fire from `arabista-core.js` only. Do not re-add inline `gtag('event', 'add_to_cart')` or `fbq('track', …)` in HTML bodies.

TikTok (`ttq`) is invoked via `ttqSafe` when `window.ttq.track` exists; production PDP heads may or may not include the TikTok base snippet — events are safe no-ops without it.

---

## 9. Strict frontend parity (CRITICAL AI INSTRUCTIONS)

When syncing **staging ↔ production pairs of the same archetype and SKU**, follow these rules.

**Anchors:** `product-z01-staging.html` ↔ `product-z01.html` (PDP); `abaya-staging.html` ↔ `abaya.html` (grid); `products-staging.html` ↔ `products.html` (portal).

**Do not** expect portal HTML to match abaya HTML — they are different archetypes. **Do** keep staging/production portal bodies structurally identical aside from Rule 2 deltas.

### Rule 1: Mock pixel strategy (staging & quiet production surfaces)

Staging files (and portal production) load the **full** gtag/fbq loader with **zero / placeholder IDs** so the script shape matches production without sending real data:

* GA4: `G-0000000000`
* Meta: `fbq('init', '0000000000000000')`

Production **abaya** and **PDP** files use live IDs in `<head>`. Because analytics live in `arabista-core.js`, identical `gtagSafe` / `fbqSafe` calls work on both mock and live heads.

### Rule 2: Allowed differences (staging vs production, same file pair)

When diffing `*-staging.html` against its production sibling, **only** these deltas are permitted:

1. **`<title>`** — staging may include context in title; production omits `(STAGING)` where applicable.
2. **Robots** — staging: `<meta name="robots" content="noindex">`. Production portal/grid/PDP: omit unless deliberately blocking indexing.
3. **Nav / footer / breadcrumb hrefs** — `index-staging.html` vs `index.html`; `products-staging.html` vs `products.html`; `abaya-staging.html` vs `abaya.html`; `product-*-staging.html` vs `product-*.html`.
4. **`ARABISTA_CONTEXT.apiUrl`**
   * Staging: `…HxRmQg/exec`
   * Production: `…sb92c-Q/exec`
5. **`cartStorageKey`**
   * Staging: `arabista_cart_stg`
   * Production: `arabista_cart`
6. **`draftStorageKey`**
   * Staging: `arabista_checkout_draft_stg`
   * Production: `arabista_checkout_draft`
7. **`<head>` analytics IDs** — per Section 8 (mock vs live).

**Removed (legacy — do not reintroduce):** `const RETAIL_API_URL`, `key: 'arabista_staging_cart'`, duplicate analytics in `<body>`.

### Rule 3: GA4 / Meta / TikTok event map

Implemented in `arabista-core.js` (not inline HTML):

| Trigger | Events |
|---------|--------|
| PDP load (after context valid) | `view_item` |
| Size selected | `select_item` |
| Alteration panel opened | `view_alteration_options` |
| Line added to cart | `add_to_cart` / `AddToCart` / TikTok `AddToCart` via `Cart.addItem` |
| Checkout clicked | `begin_checkout` / `InitiateCheckout` (before API) |

### Rule 4: Cloning Z01 layout to a new SKU

Copy **`product-z01-staging.html`**, then update **product-specific** layers:

1. `<title>`, hero copy, **`og:title`** (must mirror `<title>`)
2. `ARABISTA_CONTEXT.baseItem`, `seriesName`, `heroImage`
3. `gallery`, `sizeChart`, `sizeOrder`, `alterationServices`, `bmiThresholds`, `heightLengthBuckets`, `reviews`, `tiktokUrl`
4. Accordion copy (description, features, included)
5. Breadcrumb last crumb (SKU code)
6. Staging/production href suffixes in static links (or rely on cross-sell `linkSuffix` in core)

Do **not** fork cart/checkout logic into the HTML file.

### Rule 5: Cross-sell `linkSuffix` (PDP)

`renderCrossSell()` in core sets:

```javascript
const linkSuffix = isStaging
  ? (window.location.href.includes('-staging') ? '-staging.html' : '-v4.html')
  : '.html';
```

Prefer `-staging.html` / `.html` pairs in the fleet; `product-z01-v4.html` is a legacy filename still recognised by this fallback.

---

## 10. Premium PDP chrome (v3.2) — checklist

When adding or refreshing a product page, include:

| Area | What to include |
|------|-----------------|
| `<head>` | After `<title>`, Open Graph + Twitter cards. `og:image`: `images/social-preview.jpg` (or SKU-specific asset). **Favicon cluster:** `favicon.ico`, `apple-touch-icon`, `32×32`, `16×16`, **`192×192`** (`images/favicon-192x192.png`; `../images/` in `checkout/`). |
| Layout | `<main>`: sticky breadcrumb → product grid → size chart → `#pdp-review-section` → `#cross-sell-section` → one `</main>`. |
| Mobile | `#mobile-scroll-chevron-container`, `#product-info-start` with `scroll-mt-28`. |
| Footer | Below `</main>`; Home → `index-staging.html` or `index.html`. |
| Cross-sell | `#cross-sell-loading` row; core removes after fetch; hides on failure. Excludes current `baseItem`; respects stock. |
| Cart | Glass “Shipping Details” fieldset; standard IDs unchanged. |

---

## 11. Tracked HTML inventory (v4.3)

| Group | Files |
|-------|-------|
| **Portal** | `products-staging.html`, `products.html` |
| **Grid** | `abaya-staging.html`, `abaya.html` |
| **Zahra** | `product-z01-staging.html`, `product-z01.html` |
| **Dahlia** | `product-d01`, `d02`, `d04`, `d06` (staging + production pairs) |
| **Maraya** | `product-m01`, `m02` (staging + production pairs) |
| **Legacy** | `product-z01-v4.html` — not part of the 14-file premium fleet; keep for reference only |

**Premium PDP pack (14 files):** all `product-*` rows above except `product-z01-v4.html`.

New SKUs: bring to parity using **`product-z01-staging.html`** as reference, then mirror to production.

---

## 12. Shared cart drawer contract

All archetypes expose the same drawer markup so `arabista-core.js` can bind once:

* Overlay: `#cart-overlay`
* Drawer: `#cart-drawer`, `#cart-items-container`, `#cart-scroll-area`
* Fields: `#cart-name`, `#cart-phone`, `#cart-email`, `#cart-address`, `#cart-postcode`, `#cart-state`
* Totals: `#cart-subtotal`, `#cart-discount-row`, `#cart-shipping`, `#cart-total`
* Actions: `#nav-cart-btn`, `#nav-cart-badge`, `#close-cart-btn`, `#btn-checkout`

Checkout posts to `apiUrl` with actions documented in `Arabista_Retail_Master_Doc.md`.
