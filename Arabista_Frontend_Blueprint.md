# 📘 ARABISTA FRONTEND & RETAIL ALTERATION — MASTER BLUEPRINT

**Version:** 2.9 | **Aligned to codebase:** May 4, 2026 
**Canonical detail:** Operational depth, API names, column maps, and DevOps live in `Arabista_Retail_Master_Doc.md` (when maintained alongside this repo). This blueprint is the **product-level story** from project inception: how retail stays isolated, how inventory and checkout behave, and the strict parity rules between Staging and Production frontend files.

**v2.9 (04 May):** **Strict Frontend Parity & Mock Pixel Strategy.** Established strict rules for maintaining identical `<body>` logic between `-staging.html` and production `.html` files. Implemented the "Mock Pixel" in staging `<head>` to allow identical `fbq()` calls in the body without polluting live Meta Ads data.

**v2.8 (26 Apr):** **Production** static pages `product-z01.html`, `product-d01.html`, `product-d02.html`, `product-d04.html`, `product-d06.html`, `product-m01.html`, `product-m02.html`, and `abaya.html` were aligned for go-live: each sets **`RETAIL_API_URL`** to the **current production** Retail web app `…/exec` URL; product PDP **`<title>`** strings no longer include **` (STAGING)`** (abaya was already a production-style title). 

**v2.7 (25 Apr):** **`product-d01-staging.html`** (Dahlia D01) is maintained as a **Z01-template sibling**: same client patterns. **`product-z01-staging.html`**, **`product-d01-staging.html`**, and **`abaya-staging.html`** now use **relative** links to **`index-staging.html`**, **`products-staging.html`**, and **`abaya-staging.html`** in nav chrome.

**v2.6 (23 Apr):** **Centralized WhatsApp inbox.** The **Master Webhook Router** now sends **all** inbound **Meta / WhatsApp** payloads to **`SUPPORT_URL`** (Support backend). Retail **`/exec`** receives **non‑Meta** traffic only.

**v2.5 (20 Apr):** **Retail courier standard = J&T Express.** Staging (`Retail_STAGING.gs`) is the reference implementation. 

**v2.4 (20 Apr, PM):** **Dual-environment retail routing + `STGORD-` staging IDs.** The **Master Webhook Router** now carries **production** and **staging** retail endpoints (`PROD_RETAIL_URL` / `STG_RETAIL_URL`).

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

## 11. Strict Frontend Parity & The Mock Pixel Strategy (CRITICAL AI INSTRUCTIONS)

When an AI agent (like Cursor) is asked to update, modify, or sync Product Detail Pages (PDPs), it **MUST** adhere to the following strict parity rules between Staging (`*-staging.html`) and Production (`*.html`) files.

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

### Rule 2: The 5 Allowed Differences
When comparing or syncing a Staging file to a Production file, the **only** allowed differences are:
1.  **Title Tag:** `<title>... (STAGING)</title>` vs `<title>...</title>`
2.  **Robots Meta:** Staging requires `<meta name="robots" content="noindex">`. Production does not.
3.  **Nav Links:** Staging uses `href="index-staging.html"`. Production uses `href="index.html"`.
4.  **API URL Constant:** 
    *   Staging: `const RETAIL_API_URL = "...HxRmQg/exec";`
    *   Production: `const RETAIL_API_URL = "...sb92c-Q/exec";`
5.  **Cart LocalStorage Key:**
    *   Staging: `key: 'arabista_staging_cart',`
    *   Production: `key: 'arabista_cart',`

**If you are asked to apply a new feature to all product cards, apply it to the `<body>` identically across both environments, respecting the 5 allowed differences above.**