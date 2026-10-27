# Arabista FYP: post-payment + My Order implementation brief

## Design authority

`arabista-postpayment-design-reference.html` is the approved, standalone HTML/CSS/JS **visual source of truth**. It includes seven interactive states: FYP entry, coin-flip secure handoff, verifying, payment pending, payment not completed, payment confirmed, and My Order (identity entry, code verification, list, detail). Its code is a self-contained UI demonstration: **it makes no real network calls, contains a fixed sample order and a deliberately fake demo code, and cannot be deployed as a live authentication/payment implementation**.

Preserve its visual composition, copy, spacing, colours, icons, restrained transitions, responsive sizing, and animations unless an existing FYP element must be retained. Use it as source, not as an invitation to invent a new design. In the actual application, replace all simulated statuses, timers, the hardcoded sample order and fake OTP behaviour with backend-authoritative data and safely managed async state.

Palette: charcoal `#252420`, deep CTA `#282623`, champagne `#ad8957`, sand `#f7f3ed`, warm white `#fdfcf9`, muted text `#85817a`. Display serif is *Cormorant Garamond*; UI sans is *DM Sans*. `prefers-reduced-motion` must stop coin rotation and fly-in animation. At 320/390/440px, keep actions visible, account for iPhone safe areas and keyboards, and use 16px editable inputs.

## Current implementation facts (Retail_STAGING(7).gs)

- Spreadsheet tabs: `Orders`, `Inventory_Master`, `System_Logs`, `App_Config`.
- `Orders` has 22 columns, including ID index 0, timestamp 1, name 2, phone 3, email 4, item summary 8, subtotal 9, shipping 10, paid total 11, payment status 13, order phase 14, logistics 15, tracking 16, waybill 17, payload 19. Keep the existing schema if possible.
- `doGet` currently supports `get_config` and `calc_shipping`; `doPost` accepts `reserve_stock` and webhook payloads. Do not change old semantics.
- `createDokuCheckout()` calls DOKU **Malaysia** Global API `POST /v3/checkouts`, supplying `id`, `order.invoice_number`, `amount`, `currency`, `expired_at`, customer identity. **It currently supplies no browser return URL**.
- Existing `dokuCheckStatus`, `reconcileDokuPayments`, and `finalizeDokuSuccess` are authoritative. Payment finalization also adjusts inventory, creates J&T shipment, and notifies Telegram. Avoid extra finalization side effects from public status polling.
- `fyp-staging.html` is the mobile-first FYP shell. Second bottom nav item currently is an inert `Discover` action. Reuse that position exactly for My Order. Existing page already has a coin/basket transition (`basket-prepare`); reuse its logo and adapt the reference flip treatment.
- DOKU payment host remains exact HTTPS `staging.doku.com` on the sandbox allowlist.

## End-to-end experience and state machine

1. User taps `Proceed to Secure Payment`. Existing validation, idempotent stock reservation, server-recalculated legacy shipping and DOKU session creation run **once**. Immediately show the approved full-bleed translucent, blurred, flipping-Arabista-logo handoff. Set accessible status text to `Preparing your secure payment page...`. Do **not** show success yet.
2. On reservation success, persist only `orderId`, a backend-issued **opaque signed order-status capability**, expiry and optional return path in `sessionStorage` (not raw customer PII, not the tokenized checkout URL). Use trusted verified `paymentUrl`; let `window.location.assign(paymentUrl)` navigate. If reservation fails/ambiguous, remove spinner and use existing safe recovery; no duplicate reservation.
3. On returning to FYP staging, show `Checking your payment`. Fetch a **read-only** server view of the specific order using the signed capability. A browser return or URL query parameter alone must **never** imply payment success. The server returns a sanitized projection of the corresponding Orders row. Avoid invoking payment finalization from a public-facing lookup endpoint.
4. Map `PAID` → beautiful verified receipt; map `UNPAID` (and within unsettled states) → verification/pending; map confirmed `EXPIRED`/`FAILED`/`CANCELLED` → payment not completed. Do not call expired failed before authoritative confirmation. Poll gently (example 2.5s, 4s, 6s, 10s, then every 12s) for up to about 60–90s, stop on page hide, and show a durable pending page thereafter. No infinite spinner or retry-payment suggestion for an ambiguous payment.
5. Verified success entry triggers the one-shot champagne seal/check animation, then the receipt. Populate ID, items, size, quantity, total, stage from the trusted server projection. Only show J&T tracking when the database actually provides it. `Paid` must be server-confirmed; tracking/AWB creation is not actual parcel dispatch.
6. Primary `Return to Arabista` animates receipt to the **second bottom tab, My Order** (max ~800ms with reduced-motion fallback). Briefly reveal the FYP shell, activate My Order with one gold arrival pulse and display the **just-purchased order** from the same signed capability. Do not expose full account history on the basis of that one capability. Secondary `Continue exploring` returns to home/FYP without pushing My Order.
7. Second bottom FYP nav item becomes `My Order` (receipt icon); Shop remains centered, others unchanged. Direct access opens My Order sign-in by email or phone. After verification it shows **only** orders tied to that verified identity, latest first, with order ID, date, product items, paid total, payment and fulfillment stage, and tracking when available. Detail uses actual backend data, not hardcoded texts. Profile stays unchanged for future registration.
8. On browser Back/Forward, reload after DOKU, or manually visiting the FYP page, resume a pending checkout if a valid capability is still in sessionStorage, but never present stale confirmation. If lost, show My Order verification flow. Preserve regular FYP video scroll, playback and all existing commerce overlays.

## Backend APIs (names can be adapted consistently)

Recommended form-encoded POST `action=` handlers on the same Retail STAGING Apps Script deployment, with `jsonResponse` and the existing CORS/redirect access pattern (test real GitHub Pages → GAS access):

- `order_status`: body includes `orderId` plus **server-signed, unguessable, expiring capability** (HMAC validated using an independent Script Property secret; not merely ID/email/phone). Reads a sanitized single-order projection; no side effects. Verification scope: that one order only. Reject expired, malformed and mismatched capabilities; no PII leakage. For transient statuses, return `PENDING`/`UNPAID` safely.
- `order_history_request_code`: identifier is normalized email or E.164 Malaysian phone. **Never return orders merely because a caller knows an identifier.** Return a non-enumerating generic response whether or not the account exists. For email, send a one-time code to its verified inbox using `MailApp` where enabled. For a phone-based lookup, use an actually configured phone/WhatsApp OTP provider, or send to the email *already on the matching order*, with a generic message that discloses no address or match status. Do not pretend an OTP was delivered when delivery is not available; show a safe email-first option. Rate-limit by identifier hash, IP if safely available, and global quotas; Apps Script does not reliably expose caller IP. Avoid logging OTP or phone/email.
- `order_history_verify_code`: check a salted HMAC/hashed 6-digit challenge and 10-minute expiry, with at most 5 guesses and cooldown, then issue a short-lived, random opaque session capability that can only fetch this verified customer's orders. Do not keep plaintext OTPs, and don't use the demo code from the prototype. Use Script Properties for the HMAC key, not in frontend.
- `order_history_list`: require valid verified session capability. Return limited, paginated, newest-first sanitized orders matching the canonical identity in the backend. Keep `order_id`, date, line items from sanitized stored payload, total, payment and fulfillment status, courier and tracking (if confirmed). Avoid returning customer's entire address or personal contact details. Explicitly handle no orders, throttled, backend unavailable and expired verification.

Implement the smallest secure backend solution compatible with Apps Script; avoid large new databases unless needed. Keep existing 22 Orders columns and Apps Script trigger/reconciliation semantics. Never expose full Orders table via public unauthenticated GET. Never log full result payloads, PII, OTP or bearer capabilities.

### Return-to-merchant compatibility is an open item

Do **not** copy `order.callback_url` or `order.auto_redirect` blindly from the **Indonesia `/checkout/v1/payment`** documentation. This integration is **Malaysia `POST /v3/checkouts`** with a different response contract. Investigate supported merchant return URL fields/settings in the actual MY Checkout v3 documentation / DOKU Malaysia support or dashboard before changing `createDokuCheckout`. If verified, configure a fixed absolute HTTPS staging return URL from a trusted Script Property and validate its destination, not any user-supplied URL. If not confirmed, implement manual return from DOKU and seamless resume from `sessionStorage` whenever the customer revisits the FYP staging page. Explicitly report that automatic return awaits confirmed provider configuration.

### Status consistency / payment truth

Current `reconcileDokuPayments` uses the DOKU authenticated status API and updates the Orders sheet to PAID before J&T. The new public status endpoint should read that row. It should never call `finalizeDokuSuccess` solely because a browser claims payment, and it should never mark PAID locally. The newly created J&T label may appear only after confirmation; do not claim parcel shipped until the actual stage changes. Protect against multiple tabs, payment retries, back navigation and expired status sessions.

## Required frontend code ownership

- Create a new staging-only static page, e.g. `fyp-payment-return.html`, **only if the approved MY flow requires a distinct return page**; otherwise embed return, checking and receipt in `fyp-staging.html`. Reuse the existing `.app` shell and screenshot-approved styling.
- The exact UI HTML/CSS/keyframes/JavaScript choreography from `arabista-postpayment-design-reference.html` must be transplanted into the real page, separating demo logic from real adapters. No alternative design. Use existing `images/logo.webp` or the previously approved Arabista coin face in place of the CSS `A` monogram where appropriate.
- The demo '123456' must never appear in a live verification flow. Replace all `STGORD-DEMO-...`, price and product details with backend data. Keep data escaping: use `textContent`, not HTML interpolation of untrusted fields.
- Within FYP bottom nav, replace Discover button with accessible `<button id="nav-my-order">` and SVG receipt icon from the prototype. Keep nav position and 5-column layout.
- Existing Checkout button shows coin flip immediately, even before the reservation response. Handoff spinner must be torn down on errors, navigation or timeout. Do not show “paid” until the backend returns PAID.
- Use API adapters behind the view components; the styles and DOM are not coupled to actual GAS endpoint naming.
- Readouts preserve cents / MYR (`Intl.NumberFormat('en-MY',{style:'currency',currency:'MYR'})`), correct mobile and address privacy, screen-reader progress labels.

## Exact testing/acceptance

Run `npm test` and `node tests/fyp-catalog-browser.js` with exact results, and extend test coverage. Browser sizes 320, 390, 440; reduced-motion; virtual keyboard; iPhone Safari limitation explicitly reported if unavailable.

1. Normal FYP, gallery, product, basket, size calculator, checkout, current DOKU sandbox allowlist, legacy shipping and J&T code unchanged except intentional integration.
2. Payment button immediately opens blur + flipping logo; prevents duplicate reservation; failing API exits spinner and leaves basket intact.
3. Reload and return from payment provider restores pending order via same-origin sessionStorage; unsupported callback URL stays unmodified.
4. `PENDING` does not show success, even if URL contains `success=true`; DOKU status `PAID` but sheet `UNPAID` stays pending until reconciled; finally PAID switches exactly once to success.
5. Successful payment receipt uses live order facts only; no double-polling/fulfillment; receipt shows accurate shipping and J&T stage.
6. Primary success CTA animates to FYP My Order tab and shows just the purchased order. Secondary returns to Home. No surprise auto-navigation on page load.
7. Unauthenticated phone/email lookup NEVER reveals another person's orders. OTP sending, checking, expiry, guessing lockout, request throttling and session expiry are tested. Demonstrate generic no-account responses.
8. Phone-only OTP not claimed functional without an actually configured delivery provider.
9. My Order verified query returns only matching user's order history, no addresses/PII, predictable empty/pending/error states, safe detail view, and no stale cross-account history when identity changes.
10. No production mutation or automatic deployment; all changes remain in staging until explicitly approved. No actual sandbox payment creation as part of unit/browser tests.

## Visual animation contract

- Handoff: satin ivory / blurred gold background; 93px double-sided Arabista coin, `rotateY(360deg)` over ~2.15s, subtle orbital outline. The actual page can use the existing logo artwork.
- Checking: 88px thin double-ring spinner in champagne, accessible current status copy; no alarming red while pending.
- Success: 75px matte gold seal within two pale gold rings, `sealIn` 0.8s once; quiet diamond sparkle, serif ~42px `Thank you.`, compact ticket-edge white receipt with dashed divider and paid chip.
- Return: 42×57px abstract receipt tile flies from success toward left second nav slot in ~0.8s. End on `My Order` nav with a single pulse, then order card enters ~0.48s. Respect reduced motion and logical focus.
- My Order: white top header, soft warm-grey content field, raised crisp card, discreet status chips and vertical status timeline; no neon gradients, giant confetti, excessive glassmorphism or distracting looping motion.
