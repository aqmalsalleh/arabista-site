/* ============================================================
 * ARABISTA CORE — Phase 3 Frontend Engine
 * ============================================================
 * Product-agnostic checkout/cart/gallery engine.
 *
 *  - Reads everything from window.ARABISTA_CONTEXT (baseItem,
 *    apiUrl, sizeChart, alterationServices, gallery, reviews, …)
 *  - IIFE'd + 'use strict' so nothing leaks to global scope
 *  - Single init() fetch shared between PDP + cross-sell
 *  - Optimistic UI: gallery / reviews / accordions render instantly,
 *    only the Add-to-Cart button is gently shimmered until catalog
 *    arrives (no jarring "CONNECTING…" overlay)
 *  - 600ms-debounced postcode → shipping calc with strict 5-digit
 *    Malaysian range validation (01000–98859)
 *  - sessionShippingFee invalidated automatically whenever cart
 *    weight changes (qty +/- or removal)
 *  - Form-state persistence into localStorage (arabista_checkout_draft)
 *    on every input event
 *  - Strict alteration bounds:  0 < val ≤ sizeChart[size][key]
 *  - Payload sanitization: name/address truncated to 300 chars
 *  - iOS keyboard fix: scroll active input into view when focused
 *  - Graceful OOS: NEVER reload — remove the failed line, refresh
 *    subtotal, show inline alert
 * ============================================================ */
(function () {
    'use strict';

    // -----------------------------------------------------------
    // Context & constants
    // -----------------------------------------------------------
    const CTX = window.ARABISTA_CONTEXT || {};
    const BASE_ITEM = CTX.baseItem;
    const API_URL = CTX.apiUrl || '';
    const SERIES_NAME = CTX.seriesName || (BASE_ITEM + ' Series');
    const HERO_IMAGE = CTX.heroImage || '';
    const CART_KEY = CTX.cartStorageKey || 'arabista_cart';
    const DRAFT_KEY = CTX.draftStorageKey || 'arabista_checkout_draft';
    const GALLERY = Array.isArray(CTX.gallery) ? CTX.gallery : [];
    const SIZE_CHART = CTX.sizeChart || {};
    const SIZE_ORDER = Array.isArray(CTX.sizeOrder) ? CTX.sizeOrder : Object.keys(SIZE_CHART);
    const ALTERATION_SERVICES = Array.isArray(CTX.alterationServices) ? CTX.alterationServices : [];
    const BMI_THRESHOLDS = Array.isArray(CTX.bmiThresholds) ? CTX.bmiThresholds : [];
    const HEIGHT_LENGTH_BUCKETS = Array.isArray(CTX.heightLengthBuckets) ? CTX.heightLengthBuckets : [];
    const TIKTOK_URL = CTX.tiktokUrl || '';
    const REVIEWS = Array.isArray(CTX.reviews) ? CTX.reviews : [];

    if (!API_URL) {
        console.warn('[Arabista] Missing ARABISTA_CONTEXT.apiUrl — engine inert.');
        return;
    }
    if (CTX.pageType !== 'catalog' && !BASE_ITEM) {
        console.warn('[Arabista] Missing ARABISTA_CONTEXT.baseItem for PDP — engine inert.');
        return;
    }

    // -----------------------------------------------------------
    // Mutable state (closure-private)
    // -----------------------------------------------------------
    let appConfig = {};
    let inventoryMatrix = {};
    let activeWeightKg = 1.0;
    let activeRetailPrice = 0;
    let activePromoPrice = null;
    let selectedSize = null;
    let altEnabled = false;
    let sessionShippingFee = 0;
    let sessionPostcode = '';
    let sessionShippingDirty = false; // forces recalc when cart weight changes

    // -----------------------------------------------------------
    // Tiny utilities
    // -----------------------------------------------------------
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);
    const byId = (id) => document.getElementById(id);

    function debounce(fn, ms) {
        let t;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), ms);
        };
    }

    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function gtagSafe() {
        if (typeof window.gtag === 'function') {
            try { window.gtag.apply(null, arguments); } catch (_) {}
        }
    }
    function fbqSafe() {
        if (typeof window.fbq === 'function') {
            try { window.fbq.apply(null, arguments); } catch (_) {}
        }
    }
    function ttqSafe(event, name, payload) { if (typeof window.ttq === 'object' && typeof window.ttq.track === 'function') { try { window.ttq.track(name, payload); } catch (e) { } } }

    function truncateField(v, max) {
        if (v == null) return '';
        const s = String(v).trim();
        return s.length > max ? s.substring(0, max) : s;
    }

    function sanitizeMyPhone(raw) {
        let p = String(raw || '').trim().replace(/\D/g, '');
        if (p.startsWith('1')) p = '60' + p;
        else if (p.startsWith('0')) p = '6' + p;
        return p;
    }

    function isValidMyPostcode(pc) {
        // Strict: exactly 5 digits, integer range 01000 – 98859 (Malaysian assigned codes).
        if (!/^\d{5}$/.test(String(pc))) return false;
        const code = parseInt(pc, 10);
        return code >= 1000 && code <= 98859;
    }

    function getStateFromPostcode(pc) {
        const code = parseInt(pc, 10);
        if (isNaN(code)) return '';
        if (code >= 1000  && code <= 2999)  return 'Perlis';
        if (code >= 5000  && code <= 9999)  return 'Kedah';
        if (code >= 10000 && code <= 14999) return 'Pulau Pinang';
        if (code >= 15000 && code <= 18999) return 'Kelantan';
        if (code >= 20000 && code <= 28999) return 'Pahang';
        if (code >= 30000 && code <= 36999) return 'Perak';
        if (code >= 39000 && code <= 39999) return 'Pahang';
        if (code >= 40000 && code <= 48999) return 'Selangor';
        if (code >= 50000 && code <= 59999) return 'W.P. Kuala Lumpur';
        if (code >= 60000 && code <= 68999) return 'Selangor';
        if (code >= 69000 && code <= 73999) return 'Negeri Sembilan';
        if (code >= 75000 && code <= 78999) return 'Melaka';
        if (code >= 79000 && code <= 86999) return 'Johor';
        if (code >= 87000 && code <= 87999) return 'W.P. Labuan';
        if (code >= 88000 && code <= 91999) return 'Sabah';
        if (code >= 93000 && code <= 98999) return 'Sarawak';
        return '';
    }

    // -----------------------------------------------------------
    // Cart Manager (localStorage)
    // -----------------------------------------------------------
    const Cart = {
        getItems() {
            try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
            catch (_) { return []; }
        },
        setItems(items) {
            localStorage.setItem(CART_KEY, JSON.stringify(items));
        },
        addItem(item) {
            const items = this.getItems();
            items.push(item);
            this.setItems(items);
            this.afterMutation();

            // Analytics: AddToCart fan-out (GA4 + Meta + TikTok). Centralised here
            // so EVERY mutation that adds a line is tracked exactly once.
            const _id   = item && item.model ? String(item.model) : '';
            const _name = item && item.series ? String(item.series) : _id;
            const _qty  = parseInt(item && item.qty, 10) || 1;
            const _price = Number(item && item.price) || 0;
            const _value = +(_price * _qty).toFixed(2);

            gtagSafe('event', 'add_to_cart', {
                currency: 'MYR',
                value: _value,
                items: [{
                    item_id:   _id,
                    item_name: _name,
                    price:     _price,
                    quantity:  _qty
                }]
            });
            fbqSafe('track', 'AddToCart', {
                content_name: _name,
                content_ids:  [_id],
                content_type: 'product',
                value:        _value,
                currency:     'MYR'
            });
            ttqSafe('track', 'AddToCart', {
                content_type: 'product',
                content_id:   _id,
                description:  _name,
                value:        _value,
                currency:     'MYR',
                quantity:     _qty
            });
        },
        removeItem(id) {
            const items = this.getItems().filter(i => i.id !== id);
            this.setItems(items);
            this.afterMutation();
        },
        updateQty(id, delta) {
            const items = this.getItems();
            const item = items.find(i => i.id === id);
            if (!item) return;
            item.qty += delta;
            if (item.qty <= 0) {
                this.setItems(items.filter(i => i.id !== id));
            } else {
                this.setItems(items);
            }
            this.afterMutation();
        },
        clear() {
            localStorage.removeItem(CART_KEY);
            this.afterMutation();
        },
        afterMutation() {
            // Whenever cart contents change, total weight may have changed
            // → shipping must be recomputed before checkout. Mark dirty.
            sessionShippingDirty = true;
            updateCartCount();
            renderCart();
            invalidateShippingIfWeightChanged();
        },
        totalQty() {
            return this.getItems().reduce((t, i) => t + (parseInt(i.qty, 10) || 0), 0);
        },
        totalWeightKg() {
            return this.getItems().reduce((t, i) => t + (parseFloat(i.unitWeight) || 1) * (parseInt(i.qty, 10) || 0), 0);
        }
    };

    function updateCartCount() {
        const count = Cart.totalQty();
        const badge = byId('nav-cart-badge');
        if (!badge) return;
        badge.textContent = count;
        if (count > 0) {
            badge.classList.remove('opacity-0', 'scale-0');
            badge.classList.add('opacity-100', 'scale-100');
            badge.classList.add('scale-110');
            setTimeout(() => badge.classList.remove('scale-110'), 150);
        } else {
            badge.classList.remove('opacity-100', 'scale-100', 'scale-110');
            badge.classList.add('opacity-0', 'scale-0');
        }
    }

    // -----------------------------------------------------------
    // Form state persistence (localStorage draft)
    // -----------------------------------------------------------
    const DRAFT_FIELDS = ['cart-name', 'cart-phone', 'cart-email', 'cart-address', 'cart-postcode', 'cart-state'];

    function loadDraft() {
        let draft = {};
        try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch (_) { draft = {}; }
        DRAFT_FIELDS.forEach(id => {
            const el = byId(id);
            if (el && draft[id] != null) el.value = draft[id];
        });

        // setting .value programmatically does NOT fire 'input', so the
        // debounced shipping calculator never wakes up after a refresh.
        // Manually re-fire it so a previously-saved postcode immediately
        // pulls a fresh quote on page load.
        const pcInput = byId('cart-postcode');
        if (pcInput && /^\d{5}$/.test(String(pcInput.value || '').trim())) {
            pcInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    function saveDraft() {
        const draft = {};
        DRAFT_FIELDS.forEach(id => {
            const el = byId(id);
            if (el) draft[id] = el.value;
        });
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (_) {}
    }

    function bindDraftPersistence() {
        DRAFT_FIELDS.forEach(id => {
            const el = byId(id);
            if (!el) return;
            const evt = el.tagName === 'SELECT' ? 'change' : 'input';
            el.addEventListener(evt, saveDraft);
        });
    }

    // -----------------------------------------------------------
    // Gallery — render at boot, no fetch dependency (optimistic UI)
    // -----------------------------------------------------------
    function renderGallery() {
        const main = $('.arabista-gallery-main');
        const thumbs = byId('gallery-thumbs');
        if (!main || !thumbs) return;

        GALLERY.forEach((m, i) => {
            let mediaEl;
            if (m.type === 'vid') {
                mediaEl = document.createElement('video');
                mediaEl.loop = true;
                mediaEl.muted = true;
                mediaEl.playsInline = true;
            } else {
                mediaEl = document.createElement('img');
                mediaEl.alt = BASE_ITEM + ' product image';
            }
            mediaEl.className = 'arabista-gallery-img';
            mediaEl.src = m.src;
            if (i === 0) mediaEl.id = 'main-image';
            main.appendChild(mediaEl);

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'arabista-thumb-btn w-16 h-20 shrink-0 rounded-lg overflow-hidden border-2 border-transparent opacity-50 hover:opacity-100';
            if (m.type === 'img') {
                btn.innerHTML = `<img src="${escHtml(m.src)}" class="w-full h-full object-cover" alt="">`;
            } else {
                btn.innerHTML = `<div class="relative w-full h-full"><img src="${escHtml(m.thumb || '')}" class="w-full h-full object-cover" alt=""><div class="absolute inset-0 bg-black/40 flex items-center justify-center"><svg class="w-6 h-6 text-white pl-1" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4l12 6-12 6V4z"/></svg></div></div>`;
            }
            thumbs.appendChild(btn);
        });
    }

    // -----------------------------------------------------------
    // Single fetch initializer — services PDP and cross-sell from
    // ONE API call. No double-fetch penalty.
    // -----------------------------------------------------------
    async function init() {
        // 1. Global Modules (Runs on ALL pages)
        // Bind UI listeners (cart drawer, address intelligence) BEFORE
        // loading the saved draft. loadDraft() dispatches a synthetic
        // 'input' event on the postcode field to wake the debounced
        // shipping calculator — that handler must already be attached.
        bindCartUi();
        bindDraftPersistence();
        loadDraft();
        updateCartCount();

        // 2. PDP-Specific Modules (Runs ONLY on Product Pages)
        if (CTX.pageType !== 'catalog') {
            renderGallery();
            renderSizeGrid();
            renderReviews();
            bindStaticUi();

            // Fire view_item analytics regardless of API state.
            gtagSafe('event', 'view_item', { item_id: BASE_ITEM, item_name: SERIES_NAME });

            // Single API hit — pulls full catalog so we can hydrate
            // both this PDP and cross-sell from the same payload.
            let json;
            try {
                const ua = encodeURIComponent(String(navigator.userAgent || '').substring(0, 100));
                const cb = Date.now().toString(36);
                const res = await fetch(`${API_URL}?action=get_config&cb=${cb}&ua=${ua}`, { credentials: 'omit' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                json = await res.json();
            } catch (err) {
                console.warn('[Arabista] Catalog fetch failed:', err);
                renderCrossSell({}, true);
                return;
            }

            if (!json || json.status !== 'success' || !json.data) {
                console.warn('[Arabista] Catalog responded non-success.');
                renderCrossSell({}, true);
                return;
            }

            const matrix = json.data.matrix || {};
            const config = json.data.config || {};
            appConfig = config;

            // Distribute: this PDP gets only its own SKUs, cross-sell gets all others.
            const pdpMatrix = {};
            Object.keys(matrix).forEach(sku => {
                const row = matrix[sku];
                if (row && row.baseItem === BASE_ITEM) pdpMatrix[sku] = row;
            });
            inventoryMatrix = pdpMatrix;

            // Adopt model weight if API surfaces one for this base item.
            if (typeof json.data.modelWeight === 'number' && json.data.modelWeight > 0) {
                activeWeightKg = json.data.modelWeight;
            } else {
                // Fallback: take the first weight from the PDP matrix.
                const firstRow = pdpMatrix[Object.keys(pdpMatrix)[0]];
                if (firstRow && firstRow.weightKg) activeWeightKg = firstRow.weightKg;
            }

            initializeDefaultPricing();
            applyOOSStyling();
            renderAlterationFields();

            // Enable Add to Cart UI now that we have data.
            const atc = byId('add-to-cart-btn');
            if (atc) {
                atc.classList.remove('btn-shimmer');
            }
            validateAlterations();

            // Hydrate cross-sell from the SAME response.
            renderCrossSell(matrix, false);
        }
    }

    // -----------------------------------------------------------
    // Pricing engine
    // -----------------------------------------------------------
    function initializeDefaultPricing() {
        let defaultRetail = 0;
        let defaultPromo = null;

        for (const sku in inventoryMatrix) {
            const row = inventoryMatrix[sku];
            if (row.retailPrice > defaultRetail) defaultRetail = row.retailPrice;
            if (row.promoPrice !== null && row.promoPrice !== undefined) {
                if (defaultPromo === null || row.promoPrice < defaultPromo) {
                    defaultPromo = row.promoPrice;
                }
            }
        }

        if (defaultRetail === 0) defaultRetail = 0; // explicit: do not fabricate a price

        activeRetailPrice = defaultRetail;
        activePromoPrice = defaultPromo;

        renderPriceRow(null);
    }

    function renderPriceRow(forSize) {
        const priceRow = byId('pdp-price-row');
        const stickyPriceDisplay = byId('sticky-price-display');
        if (!priceRow) return;

        const hasPromo = activePromoPrice !== null && activePromoPrice < activeRetailPrice;
        let priceHtml;

        if (activeRetailPrice <= 0) {
            priceHtml = '<span class="text-white/40 text-base">Pricing pending…</span>';
        } else if (hasPromo) {
            priceHtml = `<del class="text-gray-500 text-lg mr-2">RM ${activeRetailPrice.toFixed(2)}</del><span class="text-luxe">RM ${activePromoPrice.toFixed(2)}</span>`;
        } else {
            priceHtml = `<span class="text-luxe">RM ${activeRetailPrice.toFixed(2)}</span>`;
        }
        priceRow.innerHTML = priceHtml;

        if (stickyPriceDisplay) {
            const inlinePrice = hasPromo
                ? `<del class="text-gray-500 mr-2 text-[13px]">RM ${activeRetailPrice.toFixed(2)}</del><span class="text-luxe">RM ${activePromoPrice.toFixed(2)}</span>`
                : (activeRetailPrice > 0
                    ? `<span class="text-white">RM ${activeRetailPrice.toFixed(2)}</span>`
                    : '<span class="text-white/40">Pricing pending…</span>');
            const prefix = forSize
                ? `<span class="text-white/50 mr-2 text-[12px]">Size ${escHtml(forSize)} &middot;</span> `
                : `<span class="text-white/50 mr-2 text-[12px]">Base &middot;</span> `;
            stickyPriceDisplay.innerHTML = prefix + inlinePrice;
        }

        const stickyBtn = byId('sticky-btn');
        if (stickyBtn) {
            if (forSize) {
                stickyBtn.textContent = 'ADD TO CART';
                stickyBtn.className = 'px-6 py-2.5 rounded-lg text-[10px] font-medium uppercase tracking-widest transition-all duration-300 tap-none bg-luxe text-ink shadow-[0_0_15px_rgba(192,160,98,0.2)]';
            } else {
                stickyBtn.textContent = 'Select Size';
                stickyBtn.className = 'px-6 py-2.5 rounded-lg text-[10px] font-medium uppercase tracking-widest transition-all duration-300 tap-none bg-white/10 text-white hover:bg-white/20';
            }
        }
    }

    // -----------------------------------------------------------
    // Size grid
    // -----------------------------------------------------------
    function renderSizeGrid() {
        const grid = byId('size-grid');
        if (!grid) return;
        grid.innerHTML = '';
        SIZE_ORDER.forEach(size => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'size-btn py-3 border border-white/15 bg-transparent text-white rounded-lg font-medium hover:border-white/40 transition-colors focus:outline-none tap-none animate-pulse pointer-events-none opacity-40';
            btn.textContent = size;
            btn.dataset.size = size;
            btn.addEventListener('click', () => selectSize(size, btn));
            grid.appendChild(btn);
        });
    }

    function applyOOSStyling() {
        const btns = $$('.size-btn');
        btns.forEach(btn => {
            btn.classList.remove('animate-pulse', 'pointer-events-none', 'opacity-40');
            const size = btn.dataset.size;
            const sku = `${BASE_ITEM}-${size}`;
            const item = inventoryMatrix[sku];
            const stockLevel = item ? (item.Available_To_Sell ?? item.stock ?? item.qty ?? 0) : 0;
            const isOos = !item || stockLevel <= 0 || stockLevel === '';
            btn.disabled = !!isOos;
            if (isOos && selectedSize === size) {
                btn.classList.remove('ring-2', 'ring-white/60');
                selectedSize = null;
                const chosen = byId('sizeChosen');
                if (chosen) chosen.textContent = 'Size: —';
                renderPriceRow(null);
            }
        });
        validateAlterations();
    }

    function selectSize(size, btnEl) {
        selectedSize = size;
        gtagSafe('event', 'select_item', { item_list_name: 'Size Selection', item_name: size });
        const chosen = byId('sizeChosen');
        if (chosen) chosen.textContent = 'Size: ' + size;

        $$('.size-btn').forEach(b => {
            b.className = 'size-btn py-3 border border-white/15 bg-transparent text-white rounded-lg font-medium hover:border-white/40 transition-colors focus:outline-none tap-none' + (b.disabled ? '' : '');
        });
        btnEl.className = 'size-btn py-3 border border-luxe bg-luxe text-ink rounded-lg font-medium shadow-[0_0_15px_rgba(192,160,98,0.3)] transition-colors focus:outline-none tap-none';

        // Re-disable any OOS buttons after restyling
        applyOOSStyling();
        // Restyling clobbered the active selection — re-apply.
        const newBtn = Array.from($$('.size-btn')).find(b => b.dataset.size === size);
        if (newBtn) newBtn.className = 'size-btn py-3 border border-luxe bg-luxe text-ink rounded-lg font-medium shadow-[0_0_15px_rgba(192,160,98,0.3)] transition-colors focus:outline-none tap-none';

        // Honor matrix's requiresAlteration flag.
        const sku = `${BASE_ITEM}-${size}`;
        const matrixRow = inventoryMatrix[sku];
        const reqAlt = (matrixRow && matrixRow.requiresAlteration !== undefined) ? matrixRow.requiresAlteration : true;
        const altBtn = byId('toggle-alt-btn');
        if (altBtn) {
            if (reqAlt === false) {
                altBtn.classList.add('opacity-40', 'pointer-events-none');
                if (altEnabled) toggleAlteration(false);
            } else {
                altBtn.classList.remove('opacity-40', 'pointer-events-none');
            }
        }

        updateMatrixPricingFromSize(size);
        renderAlterationFields();
        validateAlterations();
    }

    function updateMatrixPricingFromSize(size) {
        if (!size) {
            initializeDefaultPricing();
            return;
        }
        const sku = `${BASE_ITEM}-${size}`;
        const row = inventoryMatrix[sku];
        if (row) {
            activeRetailPrice = row.retailPrice;
            activePromoPrice = row.promoPrice;
        }
        renderPriceRow(size);
    }

    // -----------------------------------------------------------
    // Size calculator (uses CTX.sizeChart, no hardcoded measurements)
    // -----------------------------------------------------------
    function calculateSize() {
        const h = parseFloat((byId('calc-height') || {}).value);
        const w = parseFloat((byId('calc-weight') || {}).value);
        const res = byId('calc-result');
        if (!res) return;

        if (!h || !w) {
            res.innerHTML = 'Please enter both values.';
            res.className = 'mt-3 text-sm text-red-400 font-medium reveal show';
            res.classList.remove('hidden');
            return;
        }

        // BMI with petite-frame adjustment.
        const heightM = h / 100;
        const adjustedWeight = (h <= 155) ? (w - 3) : w;
        const bmi = adjustedWeight / (heightM * heightM);

        // Pick true (width) size from configurable BMI ladder.
        let trueSize = null;
        for (const t of BMI_THRESHOLDS) {
            if (bmi <= t.max) { trueSize = t.size; break; }
        }
        if (!trueSize) {
            res.innerHTML = 'Size Not Available for these measurements.';
            res.className = 'mt-3 text-sm text-red-400 font-medium reveal show';
            res.classList.remove('hidden');
            return;
        }

        // Pick ideal length from configurable height ladder.
        let idealLength = HEIGHT_LENGTH_BUCKETS.length
            ? HEIGHT_LENGTH_BUCKETS[HEIGHT_LENGTH_BUCKETS.length - 1].length
            : (SIZE_CHART[trueSize] && SIZE_CHART[trueSize].length) || 0;
        for (const b of HEIGHT_LENGTH_BUCKETS) {
            if (h <= b.max) { idealLength = b.length; break; }
        }

        // Size-up safety: never add fabric, only step up to reach ideal length.
        let finalSize = trueSize;
        let idx = SIZE_ORDER.indexOf(finalSize);
        const baseLengthOf = (sz) => (SIZE_CHART[sz] && typeof SIZE_CHART[sz].length === 'number') ? SIZE_CHART[sz].length : 0;
        while (idx >= 0 && idx < SIZE_ORDER.length - 1 && baseLengthOf(finalSize) < idealLength) {
            idx++;
            finalSize = SIZE_ORDER[idx];
        }

        const finalChart = SIZE_CHART[finalSize] || {};
        const trueChart = SIZE_CHART[trueSize] || {};
        const needsLengthAlt = (typeof finalChart.length === 'number') && finalChart.length > idealLength;
        const needsShoulderAlt = (finalSize !== trueSize) && (typeof trueChart.shoulder === 'number');

        let alterText = '';
        if (needsLengthAlt && needsShoulderAlt) {
            alterText = `<br><span class="text-gray-400 text-[0.875rem] font-normal">Alter Length: ${idealLength}", Shoulder: ${trueChart.shoulder}"</span>`;
        } else if (needsLengthAlt) {
            alterText = `<br><span class="text-gray-400 text-[0.875rem] font-normal">Alter Length: ${idealLength}"</span>`;
        } else if (needsShoulderAlt) {
            alterText = `<br><span class="text-gray-400 text-[0.875rem] font-normal">Alter Shoulder: ${trueChart.shoulder}"</span>`;
        }

        res.innerHTML = `<span class="text-luxe font-medium">Recommended Size: ${finalSize}</span>${alterText}`;
        res.className = 'mt-3 text-sm reveal show';
        res.classList.remove('hidden');

        $$('.size-btn').forEach(btn => {
            if (btn.textContent === finalSize && !btn.disabled) btn.click();
        });
    }

    // -----------------------------------------------------------
    // Alteration drawer
    // -----------------------------------------------------------
    function toggleAlteration(forceState) {
        const knob = byId('alt-knob');
        const sw = byId('alt-switch');
        const drawer = byId('alt-drawer');
        if (!knob || !sw || !drawer) return;

        altEnabled = (typeof forceState === 'boolean') ? forceState : !altEnabled;
        if (altEnabled) {
            gtagSafe('event', 'view_alteration_options', { item_id: BASE_ITEM });
            knob.classList.add('translate-x-4');
            sw.classList.add('bg-luxe'); sw.classList.remove('bg-white/10');
            drawer.classList.remove('hidden'); drawer.classList.add('flex');
        } else {
            knob.classList.remove('translate-x-4');
            sw.classList.remove('bg-luxe'); sw.classList.add('bg-white/10');
            drawer.classList.add('hidden'); drawer.classList.remove('flex');
        }
    }

    function renderAlterationFields() {
        const container = byId('alt-fields-container');
        const loading = byId('alt-loading');
        if (!container) return;

        if (Object.keys(appConfig).length === 0) return;

        if (loading) loading.classList.add('hidden');
        container.classList.remove('hidden');
        container.innerHTML = '';

        ALTERATION_SERVICES.forEach(svc => {
            const conf = appConfig[svc.id];
            if (!conf || !conf.isActive) return;

            let priceHtml;
            const stdPrice = conf.standardPrice || 0;
            const promo = conf.promoPrice;
            if (promo !== null && promo !== undefined && promo < stdPrice) {
                const badgeText = promo === 0 ? 'FREE' : `PROMO RM ${promo.toFixed(2)}`;
                priceHtml = `<span class="line-through text-gray-500 mr-2">RM ${stdPrice.toFixed(2)}</span><span class="text-green-400 font-bold">${badgeText}</span>`;
            } else {
                priceHtml = `<span class="text-gray-400">RM ${stdPrice.toFixed(2)}</span>`;
            }

            const baseLimit = (selectedSize && SIZE_CHART[selectedSize]) ? SIZE_CHART[selectedSize][svc.key] : null;
            const limitHtml = (selectedSize && baseLimit != null) ? `<span class="text-luxe font-mono text-[10px] ml-2">(Max: ${baseLimit}")</span>` : '';
            const placeholderTxt = (selectedSize && baseLimit != null) ? ('\u2264 ' + baseLimit) : 'Select size first';

            const block = document.createElement('div');
            block.innerHTML = `
                <div class="flex justify-between items-end mb-2">
                    <label class="text-[10px] uppercase text-gray-400 tracking-wider flex items-center">${escHtml(svc.label)} ${limitHtml}</label>
                    <div class="text-[10px] uppercase tracking-widest">${priceHtml}</div>
                </div>
                <input type="number" step="0.5" min="0" id="alt-input-${svc.key}" data-key="${svc.key}" data-service-id="${escHtml(svc.id)}" ${selectedSize ? '' : 'disabled'} class="alt-input w-full bg-black/50 border border-white/20 rounded-lg p-3 text-[16px] text-white focus:border-luxe outline-none transition-colors" placeholder="${escHtml(placeholderTxt)}">
                <p id="alt-err-${svc.key}" class="text-xs text-red-400 mt-2 hidden"></p>
            `;
            container.appendChild(block);
        });
        $$('.alt-input').forEach(inp => inp.addEventListener('input', validateAlterations));
    }

    function validateAlterations() {
        const atc = byId('add-to-cart-btn');
        if (!atc) return;

        if (!selectedSize) {
            atc.disabled = true;
            return;
        }

        let isValid = true;
        const base = SIZE_CHART[selectedSize] || {};
        $$('.alt-input').forEach(inp => {
            const key = inp.getAttribute('data-key');
            const errEl = byId(`alt-err-${key}`);
            const raw = inp.value;
            if (raw === '' || raw === null || raw === undefined) {
                if (errEl) errEl.classList.add('hidden');
                inp.classList.remove('border-red-400');
                return;
            }
            const val = parseFloat(raw);
            const limit = (typeof base[key] === 'number') ? base[key] : Infinity;

            // STRICT: 0 < val ≤ base[key]. No negatives, no zero.
            if (isNaN(val) || val <= 0) {
                if (errEl) { errEl.textContent = `Enter a positive number (≤ ${isFinite(limit) ? limit + '"' : 'limit'}).`; errEl.classList.remove('hidden'); }
                inp.classList.add('border-red-400');
                isValid = false;
            } else if (val > limit) {
                if (errEl) { errEl.textContent = `Cannot exceed base size (${limit}").`; errEl.classList.remove('hidden'); }
                inp.classList.add('border-red-400');
                isValid = false;
            } else {
                if (errEl) errEl.classList.add('hidden');
                inp.classList.remove('border-red-400');
            }
        });
        atc.disabled = !isValid;
    }

    function getSelectedAlterationsForCart() {
        const out = {};
        if (!altEnabled) return out;
        $$('.alt-input').forEach(inp => {
            const val = parseFloat(inp.value);
            if (!val || val <= 0) return;
            const key = inp.getAttribute('data-key');
            const serviceId = inp.getAttribute('data-service-id');
            const svc = ALTERATION_SERVICES.find(s => s.key === key);
            const conf = appConfig[serviceId];
            if (!conf) return;
            const stdPrice = conf.standardPrice || 0;
            const isPromo = conf.promoPrice !== null && conf.promoPrice !== undefined && conf.promoPrice < stdPrice;
            const charged = isPromo ? conf.promoPrice : stdPrice;
            out[key] = {
                name: (svc && svc.bmName) || key.charAt(0).toUpperCase() + key.slice(1),
                val: val + '"',
                price: charged,
                standardPrice: stdPrice,
                isPromo: isPromo,
                service_id: serviceId
            };
        });
        return out;
    }

    function addCurrentToCart() {
        if (!selectedSize) {
            showInlineCartAlert('Please select a size before adding to cart.');
            return;
        }
        const currentPrice = (activePromoPrice !== null && activePromoPrice < activeRetailPrice) ? activePromoPrice : activeRetailPrice;
        const cartItem = {
            id: `${BASE_ITEM}-${Date.now()}`,
            model: BASE_ITEM,
            series: SERIES_NAME,
            size: selectedSize,
            retailPrice: activeRetailPrice,
            price: currentPrice,
            unitWeight: activeWeightKg,
            alterations: getSelectedAlterationsForCart(),
            image: HERO_IMAGE,
            qty: 1
        };
        // Cart.addItem now owns AddToCart analytics fan-out (GA4 + Meta + TikTok).
        Cart.addItem(cartItem);
        toggleCartDrawer(true);
    }

    // -----------------------------------------------------------
    // Cart drawer & rendering
    // -----------------------------------------------------------
    function toggleCartDrawer(show) {
        const overlay = byId('cart-overlay');
        const drawer = byId('cart-drawer');
        if (!overlay || !drawer) return;
        if (show) {
            renderCart();
            document.body.style.overflow = 'hidden';
            overlay.classList.remove('hidden');
            setTimeout(() => overlay.classList.remove('opacity-0'), 10);
            drawer.classList.remove('translate-x-full');
        } else {
            document.body.style.overflow = '';
            overlay.classList.add('opacity-0');
            setTimeout(() => overlay.classList.add('hidden'), 300);
            drawer.classList.add('translate-x-full');
        }
    }

    function showInlineCartAlert(msg) {
        const box = byId('cart-inline-alert');
        if (box) {
            box.textContent = msg;
            box.classList.remove('hidden');
            clearTimeout(showInlineCartAlert._t);
            showInlineCartAlert._t = setTimeout(() => box.classList.add('hidden'), 6000);
        } else {
            // Last-resort fallback if drawer is closed.
            console.warn('[Arabista]', msg);
        }
    }

    function renderCart() {
        const container = byId('cart-items-container');
        const subtotalEl = byId('cart-subtotal');
        if (!container || !subtotalEl) return;

        const items = Cart.getItems();
        let visualSubtotal = 0;
        let totalDiscount = 0;

        if (items.length === 0) {
            container.innerHTML = `<div class="text-center text-white/40 py-10 text-sm">Your cart is currently empty.</div>`;
            subtotalEl.textContent = `RM 0.00`;
            const discRow = byId('cart-discount-row');
            if (discRow) { discRow.classList.add('hidden'); discRow.classList.remove('flex'); }
            updateGrandTotal();
            return;
        }

        const trashSvg = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>`;

        let html = '';
        items.forEach(item => {
            let altHtml = '';
            let altCost = 0;
            if (item.alterations && Object.keys(item.alterations).length > 0) {
                altHtml = '<div class="text-white/40 text-[11px] mt-1.5 leading-relaxed space-y-0.5">';
                for (const k of Object.keys(item.alterations)) {
                    const v = item.alterations[k];
                    const priceDisplay = v.isPromo
                        ? `<del class="text-white/30">RM ${v.standardPrice.toFixed(2)}</del> <span class="text-luxe font-bold ml-1">${v.price === 0 ? 'FREE' : `RM ${v.price.toFixed(2)}`}</span>`
                        : `+RM ${v.price.toFixed(2)}`;
                    altHtml += `<div>${escHtml(v.name)}: ${escHtml(v.val)} <span class="text-white/20 mx-1">|</span> ${priceDisplay}</div>`;
                    altCost += (v.price || 0);
                }
                altHtml += '</div>';
            }

            const itemRetail = item.retailPrice || item.price;
            const itemDiscount = Math.max(0, itemRetail - item.price);
            const lineTotal = (item.price + altCost) * item.qty;
            const retailLineTotal = (itemRetail + altCost) * item.qty;

            visualSubtotal += retailLineTotal;
            totalDiscount += itemDiscount * item.qty;

            const priceOrOOS = `
                <div class="mt-0.5">
                    ${itemDiscount > 0
                        ? `<del class="text-white/30 mr-1.5 text-xs">RM ${retailLineTotal.toFixed(2)}</del><span class="text-luxe font-bold text-sm">RM ${lineTotal.toFixed(2)}</span>`
                        : `<span class="text-luxe font-medium text-sm">RM ${lineTotal.toFixed(2)}</span>`}
                </div>
                ${altHtml}
            `;

            html += `
            <div class="flex gap-4 pb-5 border-b border-white/10 relative group last:border-0 last:pb-0 transition-all duration-300" data-cart-item="${escHtml(item.id)}">
                <img src="${escHtml(item.image || '')}" class="w-20 h-24 object-cover rounded-lg border border-white/10 transition-all duration-300" alt="${escHtml(item.model)}">
                <div class="flex-1 flex flex-col justify-between">
                    <div>
                        <div class="flex justify-between items-start">
                            <div class="text-white font-medium text-[14px] transition-colors">${escHtml(item.model)} ${escHtml(item.series)} <span class="text-white/50 text-xs ml-1 font-normal">(Size ${escHtml(item.size)})</span></div>
                            <button type="button" data-cart-action="remove" data-id="${escHtml(item.id)}" class="text-white/30 hover:text-red-400 transition-colors p-1 -mr-2 -mt-1 tap-none" title="Remove item">
                                ${trashSvg}
                            </button>
                        </div>
                        ${priceOrOOS}
                    </div>
                    <div class="flex items-center mt-3">
                        <div class="flex items-center rounded-md border border-white/15 bg-white/[0.02]">
                            <button type="button" data-cart-action="dec" data-id="${escHtml(item.id)}" class="px-3 py-1 text-white/50 hover:text-white tap-none">&minus;</button>
                            <span class="w-6 text-center text-xs font-medium">${item.qty}</span>
                            <button type="button" data-cart-action="inc" data-id="${escHtml(item.id)}" class="px-3 py-1 text-white/50 hover:text-white tap-none">&plus;</button>
                        </div>
                    </div>
                </div>
            </div>
            `;
        });

        html += `
        <div class="mt-4 pt-4 border-t border-white/10">
            <button type="button" data-cart-action="close" class="w-full py-2.5 border border-dashed border-white/20 rounded-xl text-white/60 text-[10px] uppercase tracking-widest hover:border-luxe hover:text-luxe transition-colors tap-none flex items-center justify-center gap-2">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                Add Another Piece
            </button>
        </div>`;

        container.innerHTML = html;
        subtotalEl.textContent = `RM ${visualSubtotal.toFixed(2)}`;

        const discRow = byId('cart-discount-row');
        if (discRow) {
            if (totalDiscount > 0) {
                byId('cart-discount-label').textContent = 'Total Discount';
                byId('cart-discount-amount').textContent = `-RM ${totalDiscount.toFixed(2)}`;
                discRow.classList.remove('hidden'); discRow.classList.add('flex');
            } else {
                discRow.classList.add('hidden'); discRow.classList.remove('flex');
            }
        }
        updateGrandTotal();
    }

    function updateGrandTotal() {
        const totalEl = byId('cart-total');
        if (!totalEl) return;
        const items = Cart.getItems();
        if (items.length === 0) { totalEl.textContent = 'RM 0.00'; return; }
        let baseTotal = 0;
        items.forEach(item => {
            let altCost = 0;
            if (item.alterations) Object.values(item.alterations).forEach(a => altCost += (a.price || 0));
            baseTotal += (item.price + altCost) * item.qty;
        });
        const grand = baseTotal + sessionShippingFee;
        totalEl.textContent = `RM ${grand.toFixed(2)}`;
    }

    // Whenever total cart weight has changed but a previously-quoted
    // shipping rate is still showing, blank it out and force the user
    // to pull a fresh quote so we never charge 1-piece shipping for
    // a 5-piece order.
    function invalidateShippingIfWeightChanged() {
        if (!sessionShippingDirty) return;
        const shipEl = byId('cart-shipping');
        sessionShippingFee = 0;
        sessionPostcode = '';
        if (shipEl) shipEl.textContent = 'Pending';
        updateGrandTotal();
        // Try a silent recalculation if we have all inputs.
        const pcEl = byId('cart-postcode');
        if (pcEl && isValidMyPostcode(pcEl.value.trim()) && Cart.getItems().length > 0) {
            calcShipping();
        }
    }

    // -----------------------------------------------------------
    // Shipping calculation (debounced)
    // -----------------------------------------------------------
    async function calcShipping() {
        const items = Cart.getItems();
        const pcEl = byId('cart-postcode');
        if (!pcEl) return;
        const pc = pcEl.value.trim();

        if (!isValidMyPostcode(pc)) {
            pcEl.classList.add('border-red-500');
            return;
        } else {
            pcEl.classList.remove('border-red-500');
        }
        if (items.length === 0) return;

        const totalWeight = Cart.totalWeightKg() || (activeWeightKg * (Cart.totalQty() || 1));
        const shipEl = byId('cart-shipping');
        if (shipEl) shipEl.textContent = '...';

        try {
            const res = await fetch(`${API_URL}?action=calc_shipping&postcode=${encodeURIComponent(pc)}&weight=${totalWeight.toFixed(3)}`, { credentials: 'omit' });
            const json = await res.json();
            if (json && json.status === 'success') {
                sessionPostcode = pc;
                sessionShippingDirty = false;
                const activeConfig = window.ARABISTA_APP_CONFIG || appConfig || {};
                const freeShipPromo = activeConfig['PROMO_FREE_SHIPPING'];
                if (freeShipPromo && freeShipPromo.isActive) {
                    sessionShippingFee = 0;
                    if (shipEl) shipEl.innerHTML = `<span class="line-through text-gray-500 mr-2">RM ${json.rate.toFixed(2)}</span><span class="text-luxe font-bold">FREE</span>`;
                } else {
                    sessionShippingFee = json.rate;
                    if (shipEl) shipEl.textContent = `RM ${json.rate.toFixed(2)} (J&T Express)`;
                }
                updateGrandTotal();
            } else {
                if (shipEl) shipEl.textContent = 'Unavailable';
            }
        } catch (_) {
            if (shipEl) shipEl.textContent = 'Unavailable';
            showInlineCartAlert('Shipping calculation failed. Please try again.');
        }
    }

    const debouncedCalcShipping = debounce(calcShipping, 600);

    // -----------------------------------------------------------
    // Event-driven cache invalidation — listens for the catalog engine
    // ('arabista-catalog.js') signalling that the live promo config has
    // finished downloading. Because calcShipping() reads PROMO_FREE_SHIPPING
    // at quote-time, any rate quoted *before* the config landed is stale.
    // We invalidate that cache and silently re-quote — no DOM trickery,
    // no setTimeout, no synthetic events.
    // -----------------------------------------------------------
    function handleConfigReady(e) {
        const incoming = (e && e.detail && e.detail.config) || window.ARABISTA_APP_CONFIG || {};

        // Adopt the new config into the closure-private cache so calcShipping's
        // fallback (`activeConfig = window.ARABISTA_APP_CONFIG || appConfig`)
        // is consistent even if the global is later cleared.
        appConfig = Object.assign({}, appConfig, incoming);

        // Hard-invalidate any previously-cached shipping quote. Setting both
        // the dirty flag and clearing the cached postcode ensures:
        //   • the next checkout will not pass the freshness guard
        //   • a silent re-quote below cannot accidentally short-circuit
        sessionShippingDirty = true;
        sessionPostcode = '';

        // Re-render any alteration fields that were waiting on appConfig
        // (no-ops on the catalog page — there's no container).
        renderAlterationFields();

        // If the user already has a valid postcode and a non-empty cart,
        // transparently pull a fresh quote so the UI reflects the promo.
        const pcEl = byId('cart-postcode');
        if (pcEl && isValidMyPostcode(pcEl.value.trim()) && Cart.getItems().length > 0) {
            calcShipping();
        }
    }

    // Registered synchronously (outside init) so the listener is attached
    // before DOMContentLoaded — we cannot miss the event regardless of
    // whether catalog.js dispatches it before or after core.js init runs.
    window.addEventListener('arabista:config_ready', handleConfigReady);

    // -----------------------------------------------------------
    // Checkout
    // -----------------------------------------------------------
    async function doCheckout() {
        const items = Cart.getItems();
        if (items.length === 0) return;

        const name = truncateField(byId('cart-name').value, 300);
        const phoneRaw = byId('cart-phone').value;
        const phone = sanitizeMyPhone(phoneRaw);
        const email = truncateField(byId('cart-email') ? byId('cart-email').value : '', 200);
        const address = truncateField(byId('cart-address').value, 300);
        const state = byId('cart-state').value;
        const postcode = byId('cart-postcode').value.trim();

        if (!name || !phone || !address || !state || !postcode) {
            showInlineCartAlert('Please fill in all shipping details.');
            return;
        }
        if (!isValidMyPostcode(postcode)) {
            showInlineCartAlert('Postcode must be a valid 5-digit Malaysian code.');
            return;
        }
        if (sessionShippingDirty || postcode !== sessionPostcode || sessionShippingFee < 0) {
            // Force a fresh shipping quote because the cart weight or postcode changed.
            await calcShipping();
            if (sessionShippingDirty || postcode !== sessionPostcode) {
                showInlineCartAlert('Please verify the shipping fee — it has been updated for your current cart.');
                return;
            }
        }

        const btn = byId('btn-checkout');
        btn.textContent = 'Securing Order...'; btn.disabled = true;
        const gateway = byId('gateway-overlay');
        if (gateway) gateway.classList.remove('opacity-0', 'pointer-events-none');

        // Build payload (backend recalculates authoritative totals; this is
        // mostly metadata for the audit trail).
        let payloadBase = 0, payloadAlt = 0, payloadWeight = 0, payloadQty = 0;
        const formatted = items.map(item => {
            let unitAlt = 0;
            if (item.alterations) Object.values(item.alterations).forEach(a => unitAlt += (a.price || 0));
            payloadBase += item.price * item.qty;
            payloadAlt += unitAlt * item.qty;
            payloadWeight += (item.unitWeight || 1) * item.qty;
            payloadQty += item.qty;
            return {
                signature: `${item.model}-${item.size}|${JSON.stringify(item.alterations || {})}`,
                sku: `${item.model}-${item.size}`,
                size: item.size,
                qty: item.qty,
                unitRetailPrice: item.retailPrice || item.price,
                unitEffectivePrice: item.price,
                unitAltCost: unitAlt,
                unitDiscount: Math.max(0, (item.retailPrice || item.price) - item.price),
                unitWeight: item.unitWeight || 1,
                alterations: item.alterations || {}
            };
        });

        const grand = payloadBase + payloadAlt + sessionShippingFee;

        const payload = {
            items: formatted,
            basePrice: payloadBase,
            altCost: payloadAlt,
            weightKg: payloadWeight,
            totalWeight: payloadWeight,
            totalQty: payloadQty,
            shippingFee: sessionShippingFee,
            discount: 0,
            totalPaid: grand,
            name: name,
            phone: phone,
            email: email,
            address: address,
            state: state,
            postcode: postcode
        };

        // Analytics: InitiateCheckout fan-out (GA4 + Meta + TikTok). Fired BEFORE the
        // network call so the funnel is captured even if reserve_stock rejects (e.g. OOS).
        const _ckGa4Items = items.map(it => ({
            item_id:   it.model,
            item_name: it.series || it.model,
            price:     Number(it.price) || 0,
            quantity:  parseInt(it.qty, 10) || 1
        }));
        const _ckIds      = items.map(it => it.model);
        const _ckContents = items.map(it => ({
            content_id:   it.model,
            content_name: it.series || it.model,
            price:        Number(it.price) || 0,
            quantity:     parseInt(it.qty, 10) || 1
        }));
        const _grandRounded = +Number(grand).toFixed(2);

        gtagSafe('event', 'begin_checkout', {
            currency: 'MYR',
            value:    _grandRounded,
            items:    _ckGa4Items
        });
        fbqSafe('track', 'InitiateCheckout', {
            value:        _grandRounded,
            currency:     'MYR',
            num_items:    payloadQty,
            content_type: 'product',
            content_ids:  _ckIds
        });
        ttqSafe('track', 'InitiateCheckout', {
            content_type: 'product',
            contents:     _ckContents,
            value:        _grandRounded,
            currency:     'MYR'
        });

        try {
            const res = await fetch(`${API_URL}?action=reserve_stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'payload=' + encodeURIComponent(JSON.stringify(payload)),
                credentials: 'omit'
            });
            const json = await res.json();

            if (json && json.status === 'success') {
                Cart.clear();
                // Keep the draft form values (customer might re-checkout if redirect bounces)
                window.location.href = json.paymentUrl;
                return;
            }

            // Graceful failure handling — do NOT reload.
            if (gateway) gateway.classList.add('opacity-0', 'pointer-events-none');
            btn.textContent = 'Proceed to Payment'; btn.disabled = false;

            if (json && json.reason === 'out_of_stock' && json.failedSignature) {
                handleOosResponse(json.failedSignature, json.message);
            } else {
                showInlineCartAlert('Checkout error: ' + ((json && json.message) || 'Please try again.'));
            }
        } catch (e) {
            if (gateway) gateway.classList.add('opacity-0', 'pointer-events-none');
            btn.textContent = 'Proceed to Payment'; btn.disabled = false;
            showInlineCartAlert('System error: ' + (e && e.message ? e.message : 'network failure'));
        }
    }

    /**
     * Backend says one specific line item is sold out.
     * Surgically remove ONLY that line, refresh totals, alert the user,
     * and revalidate availability — never call window.location.reload().
     */
    function handleOosResponse(failedSignature, msgFromServer) {
        const items = Cart.getItems();
        const remaining = [];
        let removed = null;
        items.forEach(item => {
            const sig = `${item.model}-${item.size}|${JSON.stringify(item.alterations || {})}`;
            if (sig === failedSignature && !removed) {
                removed = item;
            } else {
                remaining.push(item);
            }
        });
        if (!removed) {
            showInlineCartAlert(msgFromServer || 'An item in your cart is unavailable.');
            return;
        }
        Cart.setItems(remaining);
        Cart.afterMutation();
        const human = `${removed.model} ${removed.series} (Size ${removed.size})`;
        showInlineCartAlert(`Sorry, ${human} just sold out.`);

        // Mark that SKU OOS in the local matrix and re-style buttons so the user can pick another.
        const sku = `${removed.model}-${removed.size}`;
        if (inventoryMatrix[sku]) inventoryMatrix[sku].Available_To_Sell = 0;
        applyOOSStyling();
    }

    // -----------------------------------------------------------
    // Smart address: 5-digit postcode auto-extraction + state pick
    // -----------------------------------------------------------
    function bindAddressIntelligence() {
        const addressInput = byId('cart-address');
        const postcodeInput = byId('cart-postcode');
        const stateSelect = byId('cart-state');
        if (!addressInput || !postcodeInput || !stateSelect) return;

        // Address-paste triggers postcode extraction.
        addressInput.addEventListener('input', () => {
            const match = addressInput.value.match(/\b\d{5}\b/);
            if (match) {
                const pc = match[0];
                if (postcodeInput.value !== pc) {
                    postcodeInput.value = pc;
                    const st = getStateFromPostcode(pc);
                    if (st) stateSelect.value = st;
                    saveDraft();
                    debouncedCalcShipping();
                }
            }
        });

        postcodeInput.addEventListener('input', () => {
            const pc = postcodeInput.value.trim();
            if (pc.length === 5 && /^\d{5}$/.test(pc)) {
                const st = getStateFromPostcode(pc);
                if (st) stateSelect.value = st;
            }
            // Always run through debounced validator so we don't spam the API.
            debouncedCalcShipping();
        });
    }

    // -----------------------------------------------------------
    // iOS keyboard fix: scroll active input into view on focus
    // -----------------------------------------------------------
    function bindIosKeyboardFix() {
        const drawer = byId('cart-drawer');
        if (!drawer) return;
        const FOCUSABLE = 'input,textarea,select';
        drawer.addEventListener('focusin', (e) => {
            const t = e.target;
            if (!t || !t.matches || !t.matches(FOCUSABLE)) return;
            // Wait for the iOS keyboard layout to settle, then center the input.
            setTimeout(() => {
                try { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
            }, 280);
        });
    }

    // -----------------------------------------------------------
    // Reviews renderer
    // -----------------------------------------------------------
    function renderReviews() {
        const list = byId('reviewList');
        const prevBtn = byId('prevBtn');
        const nextBtn = byId('nextBtn');
        const pageNum = byId('pageNum');
        const pageTotal = byId('pageTotal');
        const tiktokPreview = byId('tiktokPreview');
        const reviewsSection = byId('pdp-review-section');
        if (!list || !prevBtn || !nextBtn) return;

        const PER_PAGE = 5;
        const star = (n) => '★'.repeat(n || 5);
        const dot = '<span class="mx-2 text-white/30">•</span>';

        function reviewCard(r) {
            const longOrig = (r.original || '').length > 160;
            const id = Math.random().toString(36).slice(2, 8);
            return `
            <article class="p-4 sm:p-5">
              <div class="text-xs text-white/60 mb-2">
                <strong class="text-white/80">${escHtml(r.username)}</strong>${dot}
                Size: ${escHtml(r.size || '—')}${dot}
                <span aria-label="rating" class="text-luxe">${star(r.rating)}</span>
              </div>
              <div class="text-sm leading-relaxed">
                <p class="review-text ${longOrig ? 'clamp' : ''}" id="o-${id}">${escHtml(r.original || '')}</p>
                ${longOrig ? '<button type="button" class="readmore text-xs underline decoration-white/30 hover:text-luxe mt-1 tap-none" data-target="o-' + id + '">Read more</button>' : ''}
              </div>
            </article>`;
        }

        let current = 1;
        function renderPage(p) {
            const totalPages = Math.max(1, Math.ceil(REVIEWS.length / PER_PAGE));
            const clamped = Math.min(Math.max(1, p), totalPages);
            const start = (clamped - 1) * PER_PAGE;
            const slice = REVIEWS.slice(start, start + PER_PAGE);
            list.innerHTML = slice.map(reviewCard).join('');
            if (pageNum) pageNum.textContent = clamped;
            if (pageTotal) pageTotal.textContent = totalPages;
            prevBtn.disabled = clamped === 1;
            nextBtn.disabled = clamped === totalPages;
            if (tiktokPreview) tiktokPreview.classList.toggle('hidden', clamped !== totalPages);
            current = clamped;
        }

        list.addEventListener('click', (e) => {
            const b = e.target.closest('.readmore');
            if (!b) return;
            const id = b.getAttribute('data-target');
            const p = byId(id);
            if (!p) return;
            p.classList.toggle('clamp');
            b.textContent = p.classList.contains('clamp') ? 'Read more' : 'Show less';
        });

        function scrollTop() {
            if (reviewsSection) reviewsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        prevBtn.addEventListener('click', () => { if (current > 1) { renderPage(current - 1); scrollTop(); } });
        nextBtn.addEventListener('click', () => { renderPage(current + 1); scrollTop(); });

        renderPage(current);
    }

    // -----------------------------------------------------------
    // Cross-sell renderer — fed from the same get_config response
    // -----------------------------------------------------------
    function renderCrossSell(matrix, failed) {
        const section = byId('cross-sell-section');
        const container = byId('cross-sell-container');
        if (!section || !container) return;

        if (failed) { section.classList.add('hidden'); return; }

        const models = {};
        for (const sku in matrix) {
            const row = matrix[sku];
            const base = row.baseItem;
            if (!base || base === BASE_ITEM) continue;
            const stock = parseInt(row.Available_To_Sell ?? row.stock ?? row.qty ?? 0, 10);
            if (!stock || stock <= 0) continue;
            if (!models[base]) {
                let seriesName = base + ' Series';
                if (base.startsWith('D')) seriesName = 'Dahlia Series';
                else if (base.startsWith('Z')) seriesName = 'Zahra Series';
                else if (base.startsWith('M')) seriesName = 'Maraya Series';
                models[base] = { retail: row.retailPrice, promo: row.promoPrice, title: seriesName };
            } else {
                if (row.retailPrice > 0 && (models[base].retail === 0 || row.retailPrice < models[base].retail)) {
                    models[base].retail = row.retailPrice;
                }
                if (row.promoPrice !== null && row.promoPrice !== undefined &&
                    (models[base].promo === null || row.promoPrice < models[base].promo)) {
                    models[base].promo = row.promoPrice;
                }
            }
        }

        const keys = Object.keys(models).slice(0, 5);
        if (keys.length === 0) { section.classList.add('hidden'); return; }

        const loader = byId('cross-sell-loading');
        if (loader) loader.remove();

        const isStaging = window.location.href.includes('-staging') || window.location.href.includes('-v4');
        const linkSuffix = isStaging ? (window.location.href.includes('-staging') ? '-staging.html' : '-v4.html') : '.html';

        let html = '';
        keys.forEach(base => {
            const d = models[base];
            const priceHtml = (d.promo !== null && d.promo !== undefined && d.promo < d.retail)
                ? `<del class="text-white/40 text-xs mr-1.5">RM ${d.retail.toFixed(0)}</del><span class="text-luxe font-medium text-sm">RM ${d.promo.toFixed(0)}</span>`
                : `<span class="text-white font-medium text-sm">RM ${(d.retail || 0).toFixed(0)}</span>`;
            html += `
            <article class="relative block tap-none aspect-[3/4] w-[45vw] sm:w-56 shrink-0 snap-start rounded-2xl overflow-hidden bg-white/5 group border border-white/5 hover:border-white/20 transition-all duration-300">
                <a href="product-${base.toLowerCase()}${linkSuffix}" class="block w-full h-full">
                    <img src="images/${base.toLowerCase()}-1-hero.webp" alt="${escHtml(base)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out" loading="lazy">
                    <div class="absolute inset-0 bg-gradient-to-t from-[#111213] via-[#111213]/20 to-transparent opacity-80 group-hover:opacity-100 transition-opacity duration-300"></div>
                    <div class="absolute bottom-0 inset-x-0 p-4 sm:p-5 flex flex-col justify-end translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                        <h3 class="text-white font-display text-lg sm:text-xl leading-tight mb-1">${escHtml(base)} <span class="block text-[10px] uppercase tracking-widest text-white/50 font-sans mt-0.5">${escHtml(d.title)}</span></h3>
                        <div>${priceHtml}</div>
                    </div>
                </a>
            </article>`;
        });

        html += `
        <article class="relative block tap-none aspect-[3/4] w-[45vw] sm:w-56 shrink-0 snap-start rounded-2xl overflow-hidden bg-black/40 border border-white/10 group hover:bg-black/60 hover:border-luxe/30 transition-all duration-300">
            <a href="abaya${linkSuffix}" class="flex flex-col items-center justify-center w-full h-full p-4 text-center">
                <div class="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center text-luxe mb-4 group-hover:scale-110 group-hover:bg-luxe/10 transition-all duration-300">
                    <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                </div>
                <span class="text-xs uppercase tracking-widest text-white/70 group-hover:text-white transition-colors">Discover All<br>Collections</span>
            </a>
        </article>`;

        container.innerHTML = html;
    }

    // -----------------------------------------------------------
    // Premium gallery engine + lightbox + sticky bar + chevron
    // -----------------------------------------------------------
    function bindGalleryEngine() {
        const main = $('.arabista-gallery-main');
        const thumbContainer = $('.arabista-gallery-thumbs');
        if (!main || !thumbContainer) return;

        const mainImages = Array.from(main.querySelectorAll('.arabista-gallery-img'));
        const thumbnails = Array.from(thumbContainer.querySelectorAll('.arabista-thumb-btn'));
        if (mainImages.length === 0 || thumbnails.length === 0) return;

        let isDown = false, startX = 0, scrollLeft = 0, activeIndex = 0, isDraggingImage = false;

        main.addEventListener('mousedown', (e) => {
            isDown = true;
            isDraggingImage = false;
            main.classList.add('is-dragging');
            startX = e.pageX - main.offsetLeft;
            scrollLeft = main.scrollLeft;
        });
        const stopDrag = () => { if (!isDown) return; isDown = false; main.classList.remove('is-dragging'); };
        main.addEventListener('mouseleave', stopDrag);
        main.addEventListener('mouseup', stopDrag);
        main.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            e.preventDefault();
            isDraggingImage = true;
            const x = e.pageX - main.offsetLeft;
            const walk = (x - startX) * 1.5;
            main.scrollLeft = scrollLeft - walk;
        });

        const syncThumbnails = (idx) => {
            thumbnails.forEach((thumb, i) => {
                if (i === idx) {
                    thumb.style.opacity = '1';
                    thumb.style.border = '1px solid #D4AF37';
                } else {
                    thumb.style.opacity = '0.4';
                    thumb.style.border = 'none';
                }
            });
            const activeThumb = thumbnails[idx];
            if (activeThumb) {
                const target = activeThumb.offsetLeft - (thumbContainer.clientWidth / 2) + (activeThumb.clientWidth / 2);
                thumbContainer.scrollTo({ left: target, behavior: 'smooth' });
            }
        };

        thumbnails.forEach((thumb, idx) => {
            thumb.style.cursor = 'pointer';
            thumb.style.transition = 'opacity 0.3s ease';
            thumb.addEventListener('click', () => {
                const targetImg = mainImages[idx];
                if (!targetImg) return;
                const target = targetImg.offsetLeft - (main.clientWidth / 2) + (targetImg.clientWidth / 2);
                main.scrollTo({ left: target, behavior: 'smooth' });
            });
        });

        const renderLoop = () => {
            const containerCenter = main.scrollLeft + (main.clientWidth / 2);
            let closest = 0;
            let minDist = Infinity;
            mainImages.forEach((img, idx) => {
                const c = img.offsetLeft + (img.clientWidth / 2);
                const dist = Math.abs(containerCenter - c);
                if (dist < minDist) { minDist = dist; closest = idx; }
                const range = img.clientWidth * 0.8;
                let progress = dist / range;
                if (progress > 1) progress = 1;
                const scale = 1 - 0.08 * progress;
                const opacity = 1 - 0.6 * progress;
                img.style.transform = `translate3d(0,0,0) scale(${scale})`;
                img.style.opacity = opacity;
            });
            if (closest !== activeIndex) {
                activeIndex = closest;
                syncThumbnails(activeIndex);
                mainImages.forEach((media, i) => {
                    if (media.tagName.toLowerCase() === 'video') {
                        if (i === activeIndex) media.play().catch(() => {});
                        else media.pause();
                    }
                });
            }
            requestAnimationFrame(renderLoop);
        };

        syncThumbnails(0);
        requestAnimationFrame(renderLoop);

        // Lightbox setup
        const lightbox = byId('arabista-lightbox');
        const lbTrack = byId('lightbox-track');
        const lbClose = byId('lightbox-close');
        const lbNext = byId('lightbox-next');
        const lbPrev = byId('lightbox-prev');
        if (!lightbox || !lbTrack) return;

        const lbItems = [];
        GALLERY.forEach((m) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'lb-item shrink-0 w-full h-full snap-center flex items-center justify-center relative';
            let media;
            if (m.type === 'vid') {
                media = document.createElement('video');
                media.src = m.src; media.loop = true; media.playsInline = true; media.muted = true;
            } else {
                media = document.createElement('img');
                media.src = m.src;
            }
            media.className = 'lb-media';
            wrapper.appendChild(media);
            lbTrack.appendChild(wrapper);
            lbItems.push(media);
        });

        main.addEventListener('click', () => {
            if (isDraggingImage) return;
            lbTrack.scrollTo({ left: activeIndex * lbTrack.clientWidth, behavior: 'instant' });
            lightbox.classList.add('is-open');
            document.body.style.overflow = 'hidden';
            const cur = lbItems[activeIndex];
            if (cur && cur.tagName.toLowerCase() === 'video') cur.play().catch(() => {});
        });

        const closeLightbox = () => {
            lightbox.classList.remove('is-open');
            document.body.style.overflow = '';
            const lbIndex = Math.round(lbTrack.scrollLeft / lbTrack.clientWidth);
            lbItems.forEach(el => { if (el.tagName.toLowerCase() === 'video') el.pause(); });
            if (lbIndex !== activeIndex && mainImages[lbIndex]) {
                const targetImg = mainImages[lbIndex];
                const target = targetImg.offsetLeft - (main.clientWidth / 2) + (targetImg.clientWidth / 2);
                main.scrollTo({ left: target, behavior: 'instant' });
            }
        };

        if (lbNext) lbNext.addEventListener('click', () => lbTrack.scrollBy({ left: lbTrack.clientWidth, behavior: 'smooth' }));
        if (lbPrev) lbPrev.addEventListener('click', () => lbTrack.scrollBy({ left: -lbTrack.clientWidth, behavior: 'smooth' }));
        if (lbClose) lbClose.addEventListener('click', closeLightbox);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
        lightbox.addEventListener('click', (e) => {
            if (e.target === lightbox || e.target.classList.contains('lb-item')) closeLightbox();
        });
        lbTrack.addEventListener('scroll', () => {
            if (!lightbox.classList.contains('is-open')) return;
            const idx = Math.round(lbTrack.scrollLeft / lbTrack.clientWidth);
            lbItems.forEach((el, i) => {
                if (el.tagName.toLowerCase() === 'video') {
                    if (i === idx) el.play().catch(() => {});
                    else el.pause();
                }
            });
        }, { passive: true });
    }

    function bindStickyBar() {
        const mainCartBtn = byId('add-to-cart-btn');
        const stickyBar = byId('sticky-buy-bar');
        const stickyBtn = byId('sticky-btn');
        if (!mainCartBtn || !stickyBar || !stickyBtn) return;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting && entry.boundingClientRect.top < 0) {
                    stickyBar.classList.remove('translate-y-full');
                } else {
                    stickyBar.classList.add('translate-y-full');
                }
            });
        }, { threshold: 0 });
        observer.observe(mainCartBtn);

        const sizeCalc = byId('size-calculator-section');
        stickyBtn.addEventListener('click', () => {
            if (!selectedSize) {
                if (sizeCalc) sizeCalc.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                addCurrentToCart();
            }
        });
    }

    function bindMobileChevron() {
        const chevron = byId('mobile-scroll-chevron');
        const chevronContainer = byId('mobile-scroll-chevron-container');
        const infoStart = byId('product-info-start');
        if (!chevron || !chevronContainer || !infoStart) return;
        let dismissed = false;
        chevron.addEventListener('click', () => {
            dismissed = true;
            chevronContainer.classList.add('opacity-0', 'pointer-events-none');
            infoStart.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        window.addEventListener('scroll', () => {
            if (dismissed) return;
            if (window.scrollY > 150) chevronContainer.classList.add('opacity-0', 'pointer-events-none');
            else chevronContainer.classList.remove('opacity-0', 'pointer-events-none');
        }, { passive: true });
    }

    function bindRevealObserver() {
        $$('.reveal').forEach(el => {
            const io = new IntersectionObserver((entries, obs) => {
                entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('show'); obs.unobserve(en.target); } });
            }, { threshold: 0.1 });
            io.observe(el);
        });
    }

    // -----------------------------------------------------------
    // Static UI bindings (no fetch dependency)
    // -----------------------------------------------------------
    function bindStaticUi() {
        const yEl = byId('y');
        if (yEl) yEl.textContent = new Date().getFullYear();

        // Accordions
        $$('.accordion-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const content = btn.nextElementSibling;
                const icon = btn.querySelector('.icon-arrow');
                if (content) content.classList.toggle('hidden');
                if (icon) icon.classList.toggle('rotate-180');
            });
        });

        // Size guide modal
        const sizeBtn = byId('btn-size-guide');
        const sizeModal = byId('size-modal');
        const sizeClose = byId('size-modal-close');
        if (sizeBtn && sizeModal) {
            sizeBtn.addEventListener('click', () => {
                sizeModal.style.display = 'flex';
                setTimeout(() => sizeModal.classList.add('show'), 10);
            });
        }
        if (sizeClose && sizeModal) {
            sizeClose.addEventListener('click', () => {
                sizeModal.classList.remove('show');
                setTimeout(() => { sizeModal.style.display = 'none'; }, 300);
            });
        }

        // Size calculator
        const calcBtn = byId('btn-calc-size');
        if (calcBtn) calcBtn.addEventListener('click', calculateSize);

        // Alteration toggle
        const altBtn = byId('toggle-alt-btn');
        if (altBtn) altBtn.addEventListener('click', () => toggleAlteration());

        // Add to cart
        const atc = byId('add-to-cart-btn');
        if (atc) atc.addEventListener('click', addCurrentToCart);

        bindGalleryEngine();
        bindStickyBar();
        bindMobileChevron();
        bindRevealObserver();
        bindIosKeyboardFix();
    }

    function bindCartUi() {
        const navCart = byId('nav-cart-btn');
        const closeCart = byId('close-cart-btn');
        const overlay = byId('cart-overlay');
        const checkoutBtn = byId('btn-checkout');
        const itemsContainer = byId('cart-items-container');

        if (navCart) navCart.addEventListener('click', () => toggleCartDrawer(true));
        if (closeCart) closeCart.addEventListener('click', () => toggleCartDrawer(false));
        if (overlay) overlay.addEventListener('click', () => toggleCartDrawer(false));
        if (checkoutBtn) checkoutBtn.addEventListener('click', doCheckout);

        // Delegated cart line actions
        if (itemsContainer) {
            itemsContainer.addEventListener('click', (e) => {
                const t = e.target.closest('[data-cart-action]');
                if (!t) return;
                const action = t.getAttribute('data-cart-action');
                const id = t.getAttribute('data-id');
                if (action === 'remove' && id) Cart.removeItem(id);
                else if (action === 'inc' && id) Cart.updateQty(id, 1);
                else if (action === 'dec' && id) Cart.updateQty(id, -1);
                else if (action === 'close') toggleCartDrawer(false);
            });
        }

        bindAddressIntelligence();
    }

    // -----------------------------------------------------------
    // Boot
    // -----------------------------------------------------------
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
