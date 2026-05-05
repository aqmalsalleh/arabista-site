# 📘 ARABISTA FRONTEND & RETAIL ALTERATION — MASTER BLUEPRINT

**Version:** 3.1 | **Aligned to codebase:** May 5, 2026 
**Canonical detail:** Operational depth, API names, column maps, and DevOps live in `Arabista_Retail_Master_Doc.md` (when maintained alongside this repo). This blueprint is the **product-level story** from project inception: how retail stays isolated, how inventory and checkout behave, and the strict parity rules between Staging and Production frontend files.

**v3.1 (05 May):** **GA4 Event Tracking Migration.** Replaced custom journey logger with standard Google Analytics 4 (GA4) e-commerce events (`view_item`, `add_to_cart`, `begin_checkout`) to prevent Apps Script concurrent execution limits during high-traffic sessions.

**v3.0 (05 May):** **Smart Journey Logger Integration & Cross-Product Syncing.** Added tracking architecture to HTML files to log customer drop-off points. Established Rule 4 for adapting the Master Layout (Z01) to other product SKUs.

**v2.9 (04 May):** **Strict Frontend Parity & Mock Pixel Strategy.** Established strict rules for maintaining identical `<body>` logic between `-staging.html` and production `.html` files. Implemented the "Mock Pixel" in staging `<head>` to allow identical `fbq()` calls in the body without polluting live Meta Ads data.

**v2.8 (26 Apr):** **Production** static pages `product-z01.html`, `product-d01.html`, `product-d02.html`, `product-d04.html`, `product-d06.html`, `product-m01.html`, `product-m02.html`, and `abaya.html` were aligned for go-live: each sets **`RETAIL_API_URL`** to the **current production** Retail web app `…/exec` URL; product PDP **`<title>`** strings no longer include **` (STAGING)`** (abaya was already a production-style title). 

**v2.7 (25 Apr):** **`product-d01-staging.html`** (Dahlia D01) is maintained as a **Z01-template sibling**: same client patterns. **`product-z01-staging.html`**, **`product-d01-staging.html`**, and **`abaya-staging.html`** now use **relative** links to **`index-staging.html`**, **`products-staging.html`**, and **`abaya-staging.html`** in nav chrome.

---

## 1. Why this exists (project genesis)

* **Problem:** Alteration (`ALT-…`) and direct retail (`ORD-…`) must share one public domain and payment channels without one system’s webhooks or sheets corrupting the other.
* **Answer:** A **Master Webhook Router** (`Webhook_Router_STAGING.gs` / `Webhook_Router.gs`) is the only public ingress for Meta and SenangPay. 

---

## 2. Isolation map (files you actually touch)

| Layer | Staging / production artifact | Role |
|--------|------------------|------|
| Product PDP | `product-z01-staging.html` · `product-z01.html` (and `product-d01` … `d06`, `m01`–`m02` staging + non-staging pairs) | `get_config` → cart → `calc_shipping` → `reserve_stock`; optional pre-sale alteration fields. **Non-staging** HTML uses **production** `RETAIL_API_URL` (v2.8). |
| Abaya grid | `abaya-staging.html` · `abaya.html` | Collection landing; **non-staging** shares the same production `RETAIL_API_URL`. |
| SenangPay return | `checkout/success-router-staging.html` | Reads `order_id`; sends **`ORD-…`** or **`STGORD-…`** to retail success. |
| Success / CRM kickoff | `checkout/retail-success-staging.html` | Post-payment screen: order reference, luxury-branded layout, courier-agnostic copy, **Activate Order Updates** CTA. |
| Retail API | `Retail_STAGING.gs` | Inventory lock, SenangPay hash, **J&T Express (sandbox)** AWB/label after pay. |
| Ingress | `Webhook_Router_STAGING.gs` / `Webhook_Router.gs` | Webhook verification; **Meta → Support** (centralized inbox); **non‑Meta** dual retail routing. |

---

## 11. Strict Frontend Parity & Synchronization (CRITICAL AI INSTRUCTIONS)

When an AI agent (like Cursor) is asked to update, modify, or sync Product Detail Pages (PDPs), it **MUST** adhere to the following strict parity rules. 

**Production (`product-z01.html`) is the Master Template.** Updates are applied to Production first, and then synced to Staging and other products. 

The core philosophy is: **The `<body>` and `script` logic must be 100% identical. All environmental differences are isolated to the `<head>` and a few top-level constants.**

### Rule 1: The "Mock Pixel" Strategy
Production files contain live Meta Pixel tracking scripts in the `<head>`. Staging files **must not** send data to Meta, but their body logic must remain identical. 
*   **Production:** Gets the full, real `<!-- Meta Pixel Code -->` in the `<head>`.
*   **Staging:** Gets the following "Mock Pixel" in the `<head>` instead:
    ```html
    <script>
      // STAGING MOCK PIXEL - Prevents fake data from going to Meta
      function fbq() { console.log('[STAGING PIXEL FIRED]:', arguments); }
    </script>
    ```
*   **Result:** You may freely write `fbq('track', 'AddToCart', {...})` anywhere in the `<body>` logic of both files. Do **not** try to remove `fbq()` calls from staging files.

### Rule 2: The 5 Allowed Differences (Staging vs. Production)
When comparing or syncing a Staging file to a Production file of the same SKU, the **only** allowed differences are:
1.  **Title Tag:** `<title>... (STAGING)</title>` vs `<title>...</title>`
2.  **Robots Meta:** Staging requires `<meta name="robots" content="noindex">` in the `<head>`. Production does not.
3.  **Nav Links:** Staging uses `href="index-staging.html"`. Production uses standard `href="index.html"`.
4.  **API URL Constant:** 
    *   Staging: `const RETAIL_API_URL = "...HxRmQg/exec";`
    *   Production: `const RETAIL_API_URL = "...sb92c-Q/exec";`
5.  **Cart LocalStorage Key:**
    *   Staging: `key: 'arabista_staging_cart',`
    *   Production: `key: 'arabista_cart',`

### Rule 3: GA4 Event Tracking
All product pages must implement standard Google Analytics 4 (GA4) event tracking using the global `gtag()` function. The funnel is tracked using these five exact triggers:
1.  **Page Load:** `gtag('event', 'view_item', { item_id: currentModel, item_name: 'Zahra Series' });` (Fires after `fetchConfig()`)
2.  **Size Click:** `gtag('event', 'select_item', { item_list_name: 'Size Selection', item_name: size });` (Fires inside `selectSize`)
3.  **Alteration Menu Opened:** `gtag('event', 'view_alteration_options', { item_id: currentModel });` (Fires inside the toggle onclick if `altEnabled` is true)
4.  **Cart Opened:** `gtag('event', 'add_to_cart', { currency: 'MYR', value: currentPrice, items: [{ item_id: currentModel, item_variant: selectedSize }] });` (Fires inside `addZ01ToLocalCartAndOpenDrawer`)
5.  **Initiate Checkout:** `gtag('event', 'begin_checkout', { currency: 'MYR', value: grandTotal });` (Fires inside checkout click, *after* `grandTotal` is calculated).

### Rule 4: Cross-Product Variable Syncing (Z01 -> D01)
If you are instructed to use the Z01 Master Layout to update or create a new product card (e.g., `product-d01.html`), you must copy the entire Z01 HTML, but carefully update the following **Product-Specific Variables** to match the new SKU:
1.  **The Title & Hero Text:** (e.g., `<title>D01 Dahlia Series...`, `<h1>ARABISTA | ...`)
2.  **The Javascript Constant:** `const currentModel = 'D01';`
3.  **The Gallery Media:** Update the `mediaFiles` array to point to the correct folder (e.g., `images/d01-1-hero.webp`).
4.  **GA4 Event Parameters:** Update hardcoded text in the GA4 triggers (e.g., change `item_name: 'Zahra Series'` to `'Dahlia Series'`).
5.  **Accordion Details:** Update the Description, Features, and Included in Box HTML text to match the new garment specifications.
