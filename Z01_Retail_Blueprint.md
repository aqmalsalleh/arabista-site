# 📘 ARABISTA Z01 RETAIL & PRE-SALE ALTERATION — MASTER BLUEPRINT

**Version:** 2.2 | **Aligned to codebase:** April 19, 2026  
**Canonical detail:** Operational depth, API names, column maps, and DevOps live in `Arabista_Retail_Master_Doc.md` (when maintained alongside this repo). This blueprint is the **product-level story** from project inception: how Z01 retail stays isolated, how inventory and checkout behave, and how money, logistics, and CRM connect.

**v2.2 (19 Apr):** On **`product-z01-staging.html`**, **Proceed to Payment** raises a full-screen **gateway overlay** (ink blur, luxe spinner ring, Cormorant *Securing your selection…*) until `reserve_stock` returns. A standalone demo is **`gateway-test.html`**. If the API responds with **`out_of_stock`** and **`failedSignature`**, the cart **soft-rejects** that line, shows the top **cart notification** rail, re-renders, then runs **`fetchConfig()`** so **size buttons** on the PDP match fresh matrix stock without a reload. Cart line items for pre-sale alterations display short **BM** labels (**Labuh**, **Lengan**, **Bahu**) for readability.

**v2.1 (18 Apr):** Retail order success (`retail-success-staging.html`) uses the luxury UI stack (Cormorant Garamond display type, gold **luxe** accents, pulsing halo + check). Customer-facing copy and CTAs are **courier-agnostic** (no carrier name in the success narrative). In **`Retail_STAGING.gs`**, **`tp1Msg`** (after activation) embeds multiline **Item_Details** from **`Orders` column K** and uses generic “tracking information” wording. Logistics (AWB, zone rates, cart shipping line) may still name **Pos Laju** where the integration requires it.

---

## 1. Why this exists (project genesis)

* **Problem:** Alteration (`ALT-…`) and direct retail (`ORD-…`) must share one public domain and payment channels without one system’s webhooks or sheets corrupting the other.
* **Answer:** A **Master Webhook Router** (`Webhook_Router_STAGING.gs`) is the only public ingress for Meta and SenangPay. It routes by order-id prefix (`ORD-` → retail, `ALT-` → alteration) and forwards the **raw** body. Retail logic lives only in **`Retail_STAGING.gs`** bound to **`DB_Website_Orders_STAGING`**.
* **Z01 scope:** The first retail SKU is the **Z01** abaya line, exercised on **`product-z01-staging.html`** (staging) against the same staging backend and sheet.

---

## 2. Isolation map (files you actually touch)

| Layer | Staging artifact | Role |
|--------|------------------|------|
| Product PDP | `product-z01-staging.html` | `get_config` → cart → `calc_shipping` → `reserve_stock`; optional pre-sale alteration fields; premium gallery / lightbox / sticky bar; checkout **gateway overlay**; OOS soft-reject + **live matrix refresh** (see §6). |
| SenangPay return | `checkout/success-router-staging.html` | Reads `order_id`; sends `ORD-…` to retail success, `ALT-…` to alteration tracker. |
| Success / CRM kickoff | `checkout/retail-success-staging.html` | Post-payment screen: order reference, luxury-branded layout, courier-agnostic copy, **Activate Order Updates** CTA (script fills a hidden `#wa-link` and programmatic click opens WhatsApp with the activation message). |
| Retail API | `Retail_STAGING.gs` | Inventory lock, SenangPay hash, Pos Laju AWB, Telegram ↔ WhatsApp CRM, sweeper; activation auto-reply includes **column K** line-item receipt and carrier-neutral customer wording where applicable. |
| Ingress | `Webhook_Router_STAGING.gs` | Webhook verification, routing, Command Center (`?view=dashboard`). |

Production mirrors the same pattern with non-staging filenames when promoted; staging is the **authoritative development surface** until cutover.

---

## 3. Dual-layer inventory (`DB_Website_Orders_STAGING`)

Retail treats stock as **two linked views**:

1. **`Inventory_Physical`** — truth for units: `Base_Item`, `Size`, `Total_Manufactured`, `Reserved_Stock`, `Sold_Stock`, `Available_To_Sell`. Checkout moves **Available → Reserved → Sold** (or back to Available on expiry / failure).
2. **`Inventory_Matrix`** — sellable SKUs, prices, weights. Rows drive the PDP matrix; `getAppInitData()` reads SKU from column A, merges **`Available_To_Sell`** from physical into each SKU for the frontend.

**`App_Config`** holds service toggles and alteration price knobs the PDP merges into `get_config`. **`Orders`** is the retail order ledger; **`Logs`** captures checkout and webhook traces.

---

## 4. Slide-out cart, shipping, and pricing

* **Drawer:** Opening checkout reveals line items (Z01 size, alterations if any), subtotals, and delivery fields.
* **Postcode gate:** Customer enters Malaysian postcode (and state where required for Pos Laju); frontend calls **`doGet?action=calc_shipping&postcode=&weight=`** so **`Retail_STAGING.gs`** returns a zone-based rate (staging implementation uses banded postcode ranges + SST-style rounding).
* **Grand total:** Item total (matrix retail / promo + alteration surcharges from config) + shipping. Weights come from **`Inventory_Matrix`** per SKU for the shipping call.

---

## 5. Fifteen-minute soft lock and payment handoff

1. **Reserve:** `doPost` with **`action=reserve_stock`** runs under **`LockService`** (10s try). One unit moves **Available → Reserved**; an **`Orders`** row is appended with **`UNPAID`** payment status and **`NEW`** phase.
2. **SenangPay:** Backend returns a hosted URL built with **HMAC-SHA256** over `secret + detail + amount + order_id`. Detail string matches live convention, e.g. `Arabista Retail Order: ORD-Z01-XXXX`.
3. **Sweeper (`sweepExpiredReservations`):** Business rule — release **`UNPAID`** rows whose **timestamp is older than 15 minutes**: mark payment side **`EXPIRED`**, decrement **Reserved**, increment **Available**. The in-code trigger note expects a **time-driven trigger every ~5 minutes** so expiries are noticed quickly; the **TTL** is always **15 minutes**, not 5.

*(Earlier blueprint drafts said “sweeper every 5 minutes” without separating TTL from cadence; v2.0 corrects that.)*

---

## 6. Z01 product page (staging) — experience stack

From project start through April 2026 staging, the PDP is not “static HTML”: it is a **small retail client** for `Retail_STAGING.gs`.

* **Config boot:** On load, **`get_config`** hydrates matrix, promo flags, alteration service prices, and per-SKU availability.
* **Out of stock:** Sizes with zero availability are disabled with a clear **OOS** treatment; if stock drops while browsing, selection can be cleared after refresh from server data.
* **Merchandising:** Horizontal **gallery** (snap + drag), **thumbnails**, **lightbox** (images + video), hero **video** + **WebP poster**, **reviews** block with readable excerpts.
* **Commerce chrome:** **Context-aware sticky bar** (prompt vs price vs add-to-cart), **size calculator** section, cart **state** so drawer fields survive open/close within the session.
* **Checkout hygiene:** **Phone sanitization** in the browser (strip non-digits; normalize Malaysian `0…` / `1…` → `60…`) before **`reserve_stock`**, matching backend expectations and reducing Pos Laju / Meta validation issues.
* **Payment moment UX:** **Proceed to Payment** shows **`#gateway-overlay`** until the reserve call completes (success → redirect to SenangPay; failure → overlay dismissed). On **`out_of_stock`** + **`failedSignature`**, the matching cart line becomes **sold out** in the UI, the **notification** strip appears, and **`fetchConfig()`** updates PDP size availability from the server.
* **Cart copy for alterations:** Pre-sale dims show as **Labuh / Lengan / Bahu** with inch values and promo strikethroughs where applicable (internal keys remain `length` / `sleeve` / `shoulder`).

Static assets live under **`images/z01-*`** (WebP stills, MP4 flow, poster); after image renames or swaps, invalidate CDN/browser caches if you front the site with a cache layer.

---

## 7. After SenangPay — router and success

* User returns to **`checkout/success-router-staging.html`** with `order_id`.
* **`ORD-…`** → **`checkout/retail-success-staging.html`**: shows **Order Successful** (display serif + gold accent system), **Order Reference** from the URL (or a verified fallback label), courier-agnostic body copy about tailoring queue and tracking, and the WhatsApp CTA described in the isolation map.
* SenangPay **server-to-server** hits the **Router**, not Retail directly; Router forwards to **`Retail_STAGING.gs`**, which idempotently marks **`PAID`**, moves **Reserved → Sold**, calls **Pos Laju v2.1** for AWB, and persists tracking + PDF link to the sheet.

---

## 8. WhatsApp ↔ Telegram fulfillment (quota-conscious)

* Customer activates CRM from the success page; Meta delivers to Router → Retail.
* On successful activation, Retail sends **`tp1Msg`** to the customer: header **ORDER CONFIRMED**, order id, ***Item Details:*** block filled from **`Orders` column K** (`Item_Details`, multiline / line-broken in the sheet), then payment-received / packing copy and a promise of a follow-up with **tracking information** (no named carrier in that template).
* Retail opens a **forum topic** per order, binds **`Telegram_Topic_ID`**, and bridges messages.
* Operators reply with **`/c`** (customer-bound); media can flow **Telegram ↔ WhatsApp** via the vault pipeline described in the master doc.
* **Inline callback** (e.g. ship action) marks dispatch, edits the Telegram card, and sends a **tracking** touchpoint on WhatsApp (separate templates may still name the live courier or tracking URLs used in ops).

---

## 9. Design rules that survived “since day one”

* **Never** point Meta/SenangPay webhooks at `Retail_STAGING.gs` URLs in normal operation — only at the **Router** deployment.
* **Never** create a **new** Apps Script deployment for Retail/Router when fixing bugs — use **Manage deployments → New version** on the **same** deployment so public URLs stay stable.
* **Router UI** stays **single-file** (`getDashboardUI()` string HTML), not sibling `.html` files in Apps Script, to avoid GAS merge/cache ghosts.
* **Sheets + phones:** Backend already normalizes leading-zero quirks; the Z01 staging page now **mirrors** that normalization **before** reserve.

---

## 10. Where to go deeper

* **Full lifecycle, column maps, API actions, CRM templates, DevOps:** `Arabista_Retail_Master_Doc.md` (keep in sync when altering `Retail_STAGING.gs` or sheets).
* **Alteration-only booking** (maps, Lalamove, `ALT-` flows) vs **Z01 pre-sale** add-ons: `Arabista_Alteration_Master_Doc.md`.
* **Gateway overlay click-through demo:** `gateway-test.html`.

This blueprint is intentionally **stable narrative + file map**; when behavior changes, update **this file’s sections** and the **version line**, then fold precise mechanics into the retail master doc.
