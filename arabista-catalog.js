/* ============================================================
 * ARABISTA CATALOG ENGINE — Phase 4.1 (Full Omnichannel)
 * ============================================================
 * High-performance catalog logic decoupled from the core cart.
 * Handles:
 * 1. Data-driven filtering (Nav Tabs, Search, Size, Sort)
 * 2. Mobile filter drawer UX
 * 3. Fetching live pricing/stock from GAS
 * 4. Graceful skeleton replacement & Anti-Race Condition Polling
 * ============================================================ */
(function () {
    'use strict';

    const ctx = window.ARABISTA_CONTEXT;
    if (!ctx || ctx.pageType !== 'catalog') return;

    // --- DOM ELEMENTS ---
    const navBtns = document.querySelectorAll('.nav-btn');
    const productCards = document.querySelectorAll('article[data-sku]');
    const productGrid = document.getElementById('product-grid');

    const filterBtn = document.getElementById('filter-btn');
    const closeFilterBtn = document.getElementById('close-filter-btn');
    const filterDrawer = document.getElementById('filter-drawer');
    const filterOverlay = document.getElementById('filter-overlay');
    const applyFiltersBtn = document.getElementById('apply-filters-btn');

    const searchInput = document.getElementById('search-input');
    const searchTriggerBtn = document.getElementById('search-trigger-btn');

    // --- STATE ---
    let activeCategory = 'all';
    let appliedSizes = [];

    // --- CORE FILTER ENGINE ---
    function runFilters() {
        const searchTerm = (searchInput ? searchInput.value.toLowerCase().trim() : '');

        productCards.forEach(card => {
            const cardCat = card.getAttribute('data-category') || '';
            const matchCategory = (activeCategory === 'all' || cardCat === activeCategory);
            const matchSearch = (searchTerm === '' || card.innerText.toLowerCase().includes(searchTerm));

            const sizeList = card.dataset.sizes ? card.dataset.sizes.split(',') : [];
            const matchSize = appliedSizes.length === 0 || appliedSizes.some(s => sizeList.includes(s));

            if (matchCategory && matchSearch && matchSize) {
                card.style.display = 'block';
                card.classList.remove('show');
                setTimeout(() => card.classList.add('show'), 20);
            } else {
                card.style.display = 'none';
                card.classList.remove('show');
            }
        });
    }

    function applyCategory(category) {
        activeCategory = category;
        navBtns.forEach(btn => {
            if (btn.getAttribute('data-target') === category) {
                btn.classList.add('text-luxe', 'border-b-2', 'border-luxe');
                btn.classList.remove('text-white/50');
            } else {
                btn.classList.add('text-white/50');
                btn.classList.remove('text-luxe', 'border-b-2', 'border-luxe');
            }
        });
        runFilters();
    }

    function applySorting() {
        const sortOption = document.querySelector('input[name="sort"]:checked')?.value;
        if (!sortOption || !productGrid) return;

        const articles = Array.from(productCards);
        articles.sort((a, b) => {
            const priceA = parseFloat(a.dataset.price) || 9999;
            const priceB = parseFloat(b.dataset.price) || 9999;
            return sortOption === 'low-high' ? priceA - priceB : priceB - priceA;
        });
        articles.forEach(article => productGrid.appendChild(article));
    }

    function toggleFilterPanel(show) {
        if (!filterDrawer || !filterOverlay) return;
        if (show) {
            document.body.style.overflow = 'hidden';
            filterOverlay.classList.remove('opacity-0', 'pointer-events-none');
            filterOverlay.classList.add('opacity-100');
            filterDrawer.classList.remove('translate-x-full');
        } else {
            document.body.style.overflow = '';
            filterOverlay.classList.remove('opacity-100');
            filterOverlay.classList.add('opacity-0', 'pointer-events-none');
            filterDrawer.classList.add('translate-x-full');
        }
    }

    // --- UI BINDINGS ---
    function bindUI() {
        // Reveal Animation
        const io = new IntersectionObserver((entries) => {
            entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('show'); });
        }, { threshold: 0.1 });
        productCards.forEach(card => io.observe(card));

        // Navigation Tabs
        navBtns.forEach(btn => {
            btn.addEventListener('click', (e) => applyCategory(e.currentTarget.getAttribute('data-target')));
        });

        // Mobile Drawer
        if (filterBtn) filterBtn.addEventListener('click', () => toggleFilterPanel(true));
        if (closeFilterBtn) closeFilterBtn.addEventListener('click', () => toggleFilterPanel(false));
        if (filterOverlay) filterOverlay.addEventListener('click', () => toggleFilterPanel(false));

        // Drawer Apply
        if (applyFiltersBtn) {
            applyFiltersBtn.addEventListener('click', () => {
                appliedSizes = Array.from(document.querySelectorAll('input[name="size"]:checked')).map(cb => cb.value);
                applySorting();
                runFilters();
                toggleFilterPanel(false);
            });
        }

        // Search
        function executeSearch() {
            runFilters();
            toggleFilterPanel(false);
        }
        if (searchTriggerBtn) searchTriggerBtn.addEventListener('click', executeSearch);
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    executeSearch();
                }
            });
        }
    }

    // --- API & DATA MAPPING ---
    async function fetchCatalogData() {
        try {
            const deviceInfo = encodeURIComponent(navigator.userAgent.substring(0, 100));
            const url = `${ctx.apiUrl}?action=get_config&nocache=true&cb=${Date.now().toString(36)}&ua=${deviceInfo}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error('Network response was not ok');
            const json = await response.json();
            
            if (json.status !== 'success' || !json.data || !json.data.matrix) throw new Error('Invalid API response');

            window.ARABISTA_APP_CONFIG = json.data.config || {};
            updateCatalogUI(json.data.matrix);

            // Race-Condition Safety Protocol for Cart Auto-Calc
            const calcBtn = document.getElementById('btn-calc-ship');
            const postcode = document.getElementById('cart-postcode');
            if (calcBtn && postcode && postcode.value.length === 5 && !isNaN(postcode.value)) {
                let attempts = 0;
                const triggerShipping = setInterval(() => {
                    attempts++;
                    // Only click if the button isn't disabled by arabista-core.js
                    if (!calcBtn.disabled) {
                        clearInterval(triggerShipping);
                        calcBtn.click();
                    } else if (attempts >= 10) {
                        clearInterval(triggerShipping); // Fallback timeout
                    }
                }, 500);
            }

        } catch (error) {
            console.error("Failed to fetch catalog pricing:", error);
            productCards.forEach(card => {
                const priceContainer = card.querySelector('.price-container');
                if (priceContainer) priceContainer.innerHTML = `<span class="text-white/40 text-sm">RM --</span>`;
            });
        }
    }

    function updateCatalogUI(matrix) {
        const baseItemsData = {};
        for (const sku in matrix) {
            const item = matrix[sku];
            const base = item.baseItem;
            if (!baseItemsData[base]) {
                baseItemsData[base] = {
                    retailPrice: item.retailPrice,
                    promoPrice: item.promoPrice,
                    totalAvailable: 0,
                    availableSizes: []
                };
            }
            const stock = parseInt(item.Available_To_Sell || 0);
            baseItemsData[base].totalAvailable += stock;

            if (stock > 0 && sku.startsWith(base + '-')) {
                const size = sku.replace(base + '-', '');
                if (!baseItemsData[base].availableSizes.includes(size)) {
                    baseItemsData[base].availableSizes.push(size);
                }
            }
        }

        productCards.forEach(card => {
            const sku = card.getAttribute('data-sku');
            const priceContainer = card.querySelector('.price-container');
            if (!priceContainer) return;

            const data = baseItemsData[sku];

            if (!data) {
                priceContainer.innerHTML = `<span class="text-white/40 text-[11px] uppercase tracking-widest">Unavailable</span>`;
                card.style.opacity = '0.4';
                card.style.pointerEvents = 'none';
                return;
            }

            // Sync dynamic sizes into DOM for the Size Filter
            if (data.availableSizes.length > 0) {
                card.dataset.sizes = data.availableSizes.join(',');
            } else {
                card.removeAttribute('data-sizes');
            }

            // Sync effective price into DOM for the Sort Filter
            const effectivePrice = (data.promoPrice && data.promoPrice < data.retailPrice) ? data.promoPrice : data.retailPrice;
            card.dataset.price = effectivePrice;

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
            
            priceContainer.style.opacity = '0';
            setTimeout(() => {
                priceContainer.style.transition = 'opacity 0.4s ease';
                priceContainer.style.opacity = '1';
            }, 50);
        });
    }

    function init() {
        bindUI();
        applyCategory('all'); 
        fetchCatalogData();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
