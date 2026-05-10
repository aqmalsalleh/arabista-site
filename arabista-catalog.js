/* ============================================================
 * ARABISTA CATALOG ENGINE — Phase 4
 * ============================================================
 * High-performance catalog logic decoupled from the core cart.
 * Handles:
 * 1. Data-driven filtering (Category Tabs)
 * 2. Mobile filter drawer UX
 * 3. Fetching live pricing/stock from GAS
 * 4. Graceful skeleton replacement (Optimistic UI)
 * ============================================================ */
(function () {
    'use strict';

    const ctx = window.ARABISTA_CONTEXT;
    if (!ctx || ctx.pageType !== 'catalog') return;

    // --- DOM ELEMENTS ---
    const filterBtns = document.querySelectorAll('.filter-btn');
    const productCards = document.querySelectorAll('article[data-sku]');
    const mobileFilterBtn = document.getElementById('mobile-filter-btn');
    const filterDrawer = document.getElementById('filter-drawer');
    const filterOverlay = document.getElementById('filter-overlay');
    const applyFilterBtn = document.getElementById('apply-filters-btn');

    // --- FILTER LOGIC (Data-Driven CSS) ---
    function applyFilter(category) {
        // Update Desktop/Tablet Buttons
        filterBtns.forEach(btn => {
            const btnCat = btn.getAttribute('data-filter');
            if (btnCat === category) {
                btn.classList.add('text-white', 'border-white/30', 'bg-white/5');
                btn.classList.remove('text-white/50', 'border-transparent', 'hover:text-white', 'hover:border-white/20');
            } else {
                btn.classList.remove('text-white', 'border-white/30', 'bg-white/5');
                btn.classList.add('text-white/50', 'border-transparent', 'hover:text-white', 'hover:border-white/20');
            }
        });

        // Instantly filter cards using CSS display and trigger reveal
        productCards.forEach(card => {
            const cardCat = card.getAttribute('data-category');
            if (category === 'all' || cardCat === category) {
                card.style.display = 'block';
                card.classList.remove('show');
                setTimeout(() => card.classList.add('show'), 20);
            } else {
                card.style.display = 'none';
                card.classList.remove('show');
            }
        });
    }

    // --- UI EVENT BINDINGS ---
    function bindUI() {
        // Scroll Reveal Animation
        const io = new IntersectionObserver((entries) => {
            entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('show'); });
        }, { threshold: 0.1 });
        productCards.forEach(card => io.observe(card));

        // Desktop Filter Clicks
        filterBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                applyFilter(e.currentTarget.getAttribute('data-filter'));
            });
        });

        // Mobile Filter Drawer UX
        function toggleMobileFilter(show) {
            if (!filterOverlay || !filterDrawer) return;
            if (show) {
                filterOverlay.classList.remove('hidden');
                filterDrawer.classList.remove('translate-y-full');
                setTimeout(() => filterOverlay.classList.remove('opacity-0'), 10);
            } else {
                filterOverlay.classList.add('opacity-0');
                filterDrawer.classList.add('translate-y-full');
                setTimeout(() => filterOverlay.classList.add('hidden'), 300);
            }
        }

        if (mobileFilterBtn) mobileFilterBtn.addEventListener('click', () => toggleMobileFilter(true));
        if (filterOverlay) filterOverlay.addEventListener('click', () => toggleMobileFilter(false));
        if (applyFilterBtn) applyFilterBtn.addEventListener('click', () => toggleMobileFilter(false));
        
        // Mobile Drawer Option Clicks
        const drawerOptions = document.querySelectorAll('.drawer-filter-option');
        drawerOptions.forEach(opt => {
            opt.addEventListener('click', (e) => {
                drawerOptions.forEach(o => o.classList.remove('border-luxe', 'text-luxe'));
                drawerOptions.forEach(o => o.classList.add('border-white/10', 'text-white'));
                e.currentTarget.classList.remove('border-white/10', 'text-white');
                e.currentTarget.classList.add('border-luxe', 'text-luxe');
                
                applyFilter(e.currentTarget.getAttribute('data-filter'));
            });
        });
    }

    // --- API & DYNAMIC PRICING ---
    async function fetchCatalogData() {
        try {
            // Fetch live config from the staging URL mapped in Context
            const deviceInfo = encodeURIComponent(navigator.userAgent.substring(0, 100));
            const url = `${ctx.apiUrl}?action=get_config&nocache=true&cb=${Date.now().toString(36)}&ua=${deviceInfo}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error('Network response was not ok');
            const json = await response.json();
            
            if (json.status !== 'success' || !json.data || !json.data.matrix) {
                throw new Error('Invalid API response');
            }

            updateCatalogUI(json.data.matrix);

        } catch (error) {
            console.error("Failed to fetch catalog pricing:", error);
            // Fallback: Drop skeletons to "RM --" so they don't pulse forever
            productCards.forEach(card => {
                const priceContainer = card.querySelector('.price-container');
                if (priceContainer) priceContainer.innerHTML = `<span class="text-white/40 text-sm">RM --</span>`;
            });
        }
    }

    function updateCatalogUI(matrix) {
        // Group raw SKU matrix (e.g., D01-S, D01-M) by their baseItem (e.g., D01)
        const baseItemsData = {};
        for (const sku in matrix) {
            const item = matrix[sku];
            const base = item.baseItem;
            if (!baseItemsData[base]) {
                baseItemsData[base] = {
                    retailPrice: item.retailPrice,
                    promoPrice: item.promoPrice,
                    totalAvailable: 0
                };
            }
            // Aggregate total stock across all sizes for the Sold Out check
            baseItemsData[base].totalAvailable += (item.Available_To_Sell || 0);
        }

        // Map live data onto the HTML cards
        productCards.forEach(card => {
            const sku = card.getAttribute('data-sku');
            const priceContainer = card.querySelector('.price-container');
            if (!priceContainer) return;

            const data = baseItemsData[sku];

            if (!data) {
                // If the product doesn't exist in the DB, hide pricing and dim
                priceContainer.innerHTML = `<span class="text-white/40 text-[11px] uppercase tracking-widest">Unavailable</span>`;
                card.style.opacity = '0.4';
                card.style.pointerEvents = 'none';
                return;
            }

            // OOS Check: If all sizes total zero stock
            if (data.totalAvailable <= 0) {
                const imgWrapper = card.querySelector('.group');
                if (imgWrapper && !card.querySelector('.sold-out-badge')) {
                    const badge = document.createElement('div');
                    badge.className = 'sold-out-badge absolute top-3 right-3 bg-red-500/90 backdrop-blur text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full z-10 shadow-lg';
                    badge.textContent = 'Sold Out';
                    imgWrapper.appendChild(badge);
                }
                card.style.opacity = '0.6';
                card.style.pointerEvents = 'none';
            }

            // Render Pricing: Gracefully swap the skeleton loader
            if (data.promoPrice && data.promoPrice < data.retailPrice) {
                priceContainer.innerHTML = `
                    <div class="flex items-center gap-2">
                        <del class="text-white/40 text-xs">RM ${data.retailPrice.toFixed(0)}</del>
                        <span class="text-luxe font-medium text-sm">RM ${data.promoPrice.toFixed(0)}</span>
                    </div>
                `;
            } else {
                priceContainer.innerHTML = `<span class="text-white font-medium text-sm">RM ${(data.retailPrice || 0).toFixed(0)}</span>`;
            }
            
            // Subtle fade-in for the price text
            priceContainer.style.opacity = '0';
            setTimeout(() => {
                priceContainer.style.transition = 'opacity 0.4s ease';
                priceContainer.style.opacity = '1';
            }, 50);
        });
    }

    // --- BOOTSTRAP ---
    function init() {
        bindUI();
        applyFilter('all'); 
        fetchCatalogData();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();