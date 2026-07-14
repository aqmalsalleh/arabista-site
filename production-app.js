(function () {
    'use strict';

    const ctx = window.ARABISTA_ADMIN_CONTEXT;
    if (!ctx || !ctx.apiUrl) {
        console.error("Missing ARABISTA_ADMIN_CONTEXT.apiUrl");
        return;
    }

    // DOM Elements
    const overlay = document.getElementById('admin-login-overlay');
    const dashboard = document.getElementById('dashboard-container');
    const pinInput = document.getElementById('pin-input');
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    const loginError = document.getElementById('login-error');
    
    const procurementList = document.getElementById('plan-procurement-list') || document.getElementById('procurement-list');
    const metricRevenue = document.getElementById('metric-revenue');
    const metricCogs = document.getElementById('metric-cogs');
    const metricProfit = document.getElementById('metric-profit');
    const metricMargin = document.getElementById('metric-margin');
    const monthInput = document.getElementById('plan-month-input');

    const globalLoader = document.getElementById('global-loader');
    const globalLoaderText = document.getElementById('global-loader-text');

    function showLoader(text = 'Syncing Database...') {
        if (globalLoaderText) globalLoaderText.textContent = text;
        globalLoader.classList.remove('hidden');
        globalLoader.classList.add('flex');
        setTimeout(() => globalLoader.classList.remove('opacity-0'), 10);
    }

    function hideLoader() {
        globalLoader.classList.add('opacity-0');
        setTimeout(() => {
            globalLoader.classList.add('hidden');
            globalLoader.classList.remove('flex');
        }, 300);
    }
    
    const tabPlans = document.getElementById('tab-plans');
    const tabLedger = document.getElementById('tab-ledger');
    const panelPlans = document.getElementById('panel-plans');
    const panelLedger = document.getElementById('panel-ledger');

    const btnOpenPlanner = document.getElementById('btn-open-planner');
    const btnModifyPlans = document.getElementById('btn-modify-plans');
    const plannerHeroCard = document.getElementById('planner-hero-card');
    const plannerActiveState = document.getElementById('planner-active-state');
    const activeCountDisplay = document.getElementById('active-designs-count');
    
    const plannerOverlay = document.getElementById('planner-overlay');
    const plannerDrawer = document.getElementById('planner-drawer');
    const closePlannerBtn = document.getElementById('close-planner-btn');
    const savePlannerBtn = document.getElementById('save-planner-btn');
    const plannerListContainer = document.getElementById('planner-list-container');
    const plannerSearch = document.getElementById('planner-search');

    // --- 3-PILLAR TAB NAVIGATION ---
    const tabPlan = document.getElementById('tab-nav-plan');
    const tabActual = document.getElementById('tab-nav-actual');
    const tabAnalysis = document.getElementById('tab-nav-analysis');
    const pillarPlan = document.getElementById('pillar-plan');
    const pillarActual = document.getElementById('pillar-actual');
    const pillarAnalysis = document.getElementById('pillar-analysis');

    function switchPillar(targetTab, targetPillar) {
        [tabPlan, tabActual, tabAnalysis].forEach(t => {
            if (!t) return;
            t.classList.remove('font-bold', 'text-luxe', 'border-luxe');
            t.classList.add('font-medium', 'text-white/40', 'border-transparent');
        });
        targetTab.classList.remove('font-medium', 'text-white/40', 'border-transparent');
        targetTab.classList.add('font-bold', 'text-luxe', 'border-luxe');

        [pillarPlan, pillarActual, pillarAnalysis].forEach(p => { if (p) p.classList.add('hidden'); });
        targetPillar.classList.remove('hidden');
        
        if (targetPillar === pillarAnalysis) renderAnalysisPillar(); // Lazy render temporal math
    }

    tabPlan?.addEventListener('click', () => switchPillar(tabPlan, pillarPlan));
    tabActual?.addEventListener('click', () => switchPillar(tabActual, pillarActual));
    tabAnalysis?.addEventListener('click', () => switchPillar(tabAnalysis, pillarAnalysis));

    // Planner Drawer Logic
    function openPlanner() {
        document.body.style.overflow = 'hidden';
        plannerOverlay.classList.remove('hidden');
        setTimeout(() => plannerOverlay.classList.remove('opacity-0'), 10);
        plannerDrawer.classList.remove('translate-x-full');
    }

    function closePlanner() {
        document.body.style.overflow = '';
        plannerOverlay.classList.add('opacity-0');
        setTimeout(() => plannerOverlay.classList.add('hidden'), 300);
        plannerDrawer.classList.add('translate-x-full');
    }

    closePlannerBtn.addEventListener('click', closePlanner);
    plannerOverlay.addEventListener('click', closePlanner);
    savePlannerBtn.addEventListener('click', () => {
        const cbs = plannerListContainer.querySelectorAll('.design-checkbox');
        cbs.forEach(cb => {
            const design = cb.dataset.design;
            const card = cb.closest('.glass-panel');
            const qtyInp = card.querySelector('.planner-qty');
            const priceInp = card.querySelector('.planner-price');
            
            const plan = db.plans.find(p => p.Design_Code === design);
            if (plan) {
                plan.Planned_Qty = cb.checked ? (parseInt(qtyInp.value) || 0) : 0;
                plan.Target_Selling_Price = parseFloat(priceInp.value) || 0;
            }
        });
        
        calculateEngine();
        closePlanner();
    });

    // State
    let sessionPin = '';
    let db = { config: {}, configRaw: [], materials: {}, bom: {}, plans: [], allHistoricalPlans: [], basePrices: {}, snapshots: [], actualsMicro: [], actualsMacro: [], actualsCosting: [], extraCosts: [], currentExtraCosts: [], aiThinking: [], lastReqs: {}, currentMacroSnapshot: null };
    let currentDashboardMode = 'plan';

    // --- AUTHENTICATION ---
    btnLogin.addEventListener('click', authenticate);
    pinInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') authenticate(); });
    btnLogout?.addEventListener('click', () => location.reload());

    async function authenticate() {
        const pin = pinInput.value.trim();
        if (pin.length !== 6) return;
        
        btnLogin.textContent = 'VERIFYING...';
        btnLogin.disabled = true;
        loginError.classList.add('hidden');

        try {
            const res = await fetch(`${ctx.apiUrl}?action=verify_admin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `payload=${encodeURIComponent(JSON.stringify({ pin }))}`
            });
            const json = await res.json();
            
            if (json.status === 'success') {
                sessionPin = pin;
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.classList.add('hidden');
                    dashboard.classList.remove('hidden');
                    dashboard.classList.add('flex');
                    setTimeout(() => dashboard.style.opacity = '1', 50);
                    showLoader('Authenticating...');
                    fetchData();
                }, 500);
            } else {
                throw new Error(json.message);
            }
        } catch (err) {
            loginError.textContent = err.message || 'Verification failed.';
            loginError.classList.remove('hidden');
        } finally {
            btnLogin.textContent = 'AUTHENTICATE';
            btnLogin.disabled = false;
        }
    }

    // --- DATA FETCH & NORMALIZE ---
    async function fetchData() {
        showLoader('Fetching Database...');
        try {
            const res = await fetch(`${ctx.apiUrl}?action=get_production_data&pin=${sessionPin}`);
            const json = await res.json();
            if (json.status !== 'success') throw new Error(json.message);
            
            parseDatabase(json.data);
            // loadMonthState (via parseDatabase) handles drawer + metrics render
        } catch (err) {
            alert('Failed to load database: ' + err.message);
        } finally {
            hideLoader();
        }
    }

    function parseDatabase(rawData) {
        // Reset maps so Strategy 1 dynamic headers refresh cleanly
        db.config = {};
        db.materials = {};
        db.bom = {};

        // 1. Store Raw Config for category-based routing
        db.config = {};
        db.configRaw = rawData.config; 
        rawData.config.forEach(c => {
            db.config[c.Variable_Name] = parseFloat(c.Value_RM) || 0;
        });

        const exRate = db.config['Exchange_Rate_CNY_RM'] || 0.6001;

        // 2. Map Materials to retain original currency and calculate live RM cost
        rawData.materials.forEach(m => {
            let currency = m.Currency || 'RM';
            let origCost = parseFloat(m.Original_Cost) || parseFloat(m.Unit_Cost_RM) || 0; 
            let costRM = currency === 'CNY' ? origCost * exRate : origCost;
            
            db.materials[m.Item_ID] = {
                category: m.Category,
                desc: m.Description,
                unit: m.Unit_Type,
                currency: currency,
                origCost: origCost,
                costRM: costRM
            };
        });

        // 3. Map BOM by Design_Code
        rawData.bom.forEach(b => {
            db.bom[b.Design_Code] = b;
        });

        // 4. Store Historical Plans and exact Base Prices from BOM
        db.allHistoricalPlans = rawData.plans;
        db.snapshots = rawData.snapshots || [];
        db.actualsMicro = rawData.actualsMicro || [];
        db.actualsMacro = rawData.actualsMacro || [];
        db.actualsCosting = rawData.actualsCosting || [];
        db.extraCosts = rawData.extraCosts || [];
        db.aiThinking = rawData.aiThinking || [];
        db.basePrices = {};
        
        Object.keys(db.bom).forEach(code => {
            db.basePrices[code] = parseFloat(db.bom[code].Base_Selling_Price) || 0;
        });

        if (monthInput && !monthInput.value) {
            let d = new Date();
            let mm = ('0' + (d.getMonth() + 1)).slice(-2);
            monthInput.value = d.getFullYear() + '-' + mm;
        }
        
        loadMonthState(monthInput.value);
    }

    // Historical Time-Travel Engine
    function loadMonthState(monthStr) {
        if (!monthStr) return;
        db.plans = [];
        const allDesigns = Object.keys(db.bom).sort();
        
        allDesigns.forEach(code => {
            const historical = db.allHistoricalPlans.find(p => {
                let pMonth = String(p.Plan_Month).includes('T') ? String(p.Plan_Month).split('T')[0].substring(0, 7) : String(p.Plan_Month).substring(0, 7);
                return pMonth === monthStr && p.Design_Code === code;
            });

            db.plans.push({
                Design_Code: code,
                Planned_Qty: historical ? (parseInt(historical.Planned_Qty) || 0) : 0,
                Target_Selling_Price: historical ? (parseFloat(historical.Target_Selling_Price) || 0) : (db.basePrices[code] || 0),
                Locked_Material_COGS_RM: historical ? historical.Locked_Material_COGS_RM : undefined,
                Locked_Direct_Labor_RM: historical ? historical.Locked_Direct_Labor_RM : undefined,
                Locked_Var_Overhead_RM: historical ? historical.Locked_Var_Overhead_RM : undefined
            });
        });

        db.currentExtraCosts = db.extraCosts.filter(c => {
            let cMonth = String(c.Plan_Month).includes('T') ? String(c.Plan_Month).split('T')[0].substring(0, 7) : String(c.Plan_Month).substring(0, 7);
            return cMonth === monthStr;
        });

        renderPlannerDrawer();
        calculateEngine();
    }

    if (monthInput) {
        monthInput.addEventListener('change', (e) => {
            loadMonthState(e.target.value);
        });
    }

    const btnSavePlan = document.getElementById('btn-save-plan');
    if (btnSavePlan) {
        btnSavePlan.addEventListener('click', async () => {
            const currentMonth = monthInput.value;
            if (!currentMonth) return alert("Please select a month first.");
            btnSavePlan.disabled = true;
            btnSavePlan.textContent = 'SAVING...';
            try {
                const payloadPlans = db.plans.map(p => ({
                    Design_Code: p.Design_Code, Planned_Qty: p.Planned_Qty, Target_Selling_Price: p.Target_Selling_Price,
                    Locked_Material_COGS_RM: p.Live_Material_COGS_RM, Locked_Direct_Labor_RM: p.Live_Direct_Labor_RM, Locked_Var_Overhead_RM: p.Live_Var_Overhead_RM
                }));
                await postManagerAction('save_monthly_plan', { month: currentMonth, plans: payloadPlans, snapshot: db.currentMacroSnapshot });
                // Map sheet-facing keys (GAS expects name/category/cost)
                const extrasPayload = (db.currentExtraCosts || []).map(ex => ({
                    name: ex.Cost_Name || ex.name,
                    category: ex.Category || ex.category || 'Operational',
                    cost: parseFloat(ex.Cost_RM != null ? ex.Cost_RM : ex.cost) || 0
                }));
                await postManagerAction('save_monthly_extra_costs', { month: currentMonth, extras: extrasPayload });
                await fetchData();
                alert(`Master Plan for ${currentMonth} synchronized.`);
            } catch (err) { alert('Save failed: ' + err.message); } 
            finally { btnSavePlan.disabled = false; btnSavePlan.textContent = 'Save Master Plan'; }
        });
    }

    document.getElementById('btn-add-extra-cost')?.addEventListener('click', () => {
        const name = prompt("Enter Cost Name (e.g. June Studio Rental):");
        if (!name) return;
        const cost = prompt("Enter Cost Amount (RM):");
        if (!cost || isNaN(cost)) return;
        db.currentExtraCosts.push({ Cost_Name: name, Category: 'Operational', Cost_RM: parseFloat(cost) });
        calculateEngine();
    });

    document.getElementById('btn-save-actuals')?.addEventListener('click', async () => {
        const currentMonth = monthInput.value;
        const btn = document.getElementById('btn-save-actuals');
        btn.disabled = true; btn.textContent = 'SAVING LEDGER...';
        
        const micro = [];
        document.querySelectorAll('.actual-vol-row').forEach(row => {
            micro.push({ design: row.dataset.design, prod: parseInt(row.querySelector('.act-prod').value) || 0, sold: parseInt(row.querySelector('.act-sold').value) || 0 });
        });
        
        const costing = [];
        document.querySelectorAll('.actual-cost-row').forEach(row => {
            costing.push({ id: row.dataset.id, category: row.dataset.category, qty: parseFloat(row.querySelector('.act-qty').value) || 0, cost: parseFloat(row.querySelector('.act-cost').value) || 0, remarks: row.querySelector('.act-remarks').value.trim() });
        });

        try {
            await postManagerAction('save_actual_pillar', { month: currentMonth, micro, costing });
            await fetchData();
            alert(`Actuals for ${currentMonth} secured to ledger.`);
        } catch (err) { alert('Save failed: ' + err.message); } 
        finally { btn.disabled = false; btn.textContent = 'Save Actuals to Ledger'; }
    });


    document.addEventListener('click', async (e) => {
        if (e.target && e.target.id === 'btn-clear-month-plan') {
            const currentMonth = monthInput.value;
            if (!currentMonth) return;
            if (!confirm(`Are you absolutely sure you want to permanently clear the production plan for ${currentMonth}?`)) return;

            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'DELETING...';

            try {
                const res = await fetch(`${ctx.apiUrl}?action=delete_monthly_plan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `payload=${encodeURIComponent(JSON.stringify({ pin: sessionPin, month: currentMonth }))}`
                });
                const json = await res.json();
                if (json.status !== 'success') throw new Error(json.message);
                
                await fetchData(); // Refresh state
                alert(`All planning data for ${currentMonth} has been cleared.`);
            } catch (err) {
                alert('Deletion failed: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Reset & Clear Plan';
            }
        }

        if (e.target && e.target.id === 'btn-clear-actuals') {
            const currentMonth = monthInput.value;
            if (!currentMonth) return;
            if (!confirm(`Are you absolutely sure you want to permanently clear the Actuals data for ${currentMonth}?`)) return;

            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'DELETING...';
            showLoader('Clearing Actuals...');

            try {
                const res = await fetch(`${ctx.apiUrl}?action=delete_monthly_actuals`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `payload=${encodeURIComponent(JSON.stringify({ pin: sessionPin, month: currentMonth }))}`
                });
                const json = await res.json();
                if (json.status !== 'success') throw new Error(json.message);
                
                await fetchData();
                alert(`Actuals data for ${currentMonth} has been cleared.`);
            } catch (err) {
                alert('Deletion failed: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Reset & Clear Actuals';
                hideLoader();
            }
        }
    });

    // --- UI RENDERING ---
    function renderPlannerDrawer() {
        plannerListContainer.innerHTML = '';
        db.plans.forEach(plan => {
            const div = document.createElement('div');
            div.className = 'glass-panel p-4 rounded-xl flex items-center gap-4';
            div.innerHTML = `
                <label class="relative flex items-center cursor-pointer">
                    <input type="checkbox" class="peer sr-only design-checkbox" data-design="${plan.Design_Code}">
                    <div class="w-6 h-6 border-2 border-white/20 rounded flex items-center justify-center peer-checked:bg-luxe peer-checked:border-luxe transition-colors">
                        <svg class="w-4 h-4 text-ink opacity-0 peer-checked:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>
                    </div>
                </label>
                <div class="flex-1">
                    <div class="text-white font-medium text-lg">${plan.Design_Code}</div>
                    <div class="text-white/40 text-[10px] uppercase tracking-widest">Target Selection</div>
                </div>
                <div class="flex gap-2 opacity-50 pointer-events-none transition-opacity qty-wrapper">
                    <div class="w-20 relative pb-4">
                        <p class="text-white/40 text-[8px] uppercase tracking-widest mb-1">Price (RM)</p>
                        <input type="number" min="0" step="0.01" value="${plan.Target_Selling_Price}" class="planner-price w-full bg-black/40 border border-white/10 rounded-lg text-white text-center py-2 focus:border-luxe outline-none transition-colors">
                        <div class="planner-margin-indicator absolute bottom-0 left-0 right-0 text-center text-[9px] font-medium whitespace-nowrap"></div>
                    </div>
                    <div class="w-20">
                        <p class="text-white/40 text-[8px] uppercase tracking-widest mb-1">Quantity</p>
                        <input type="number" min="0" value="${plan.Planned_Qty > 0 ? plan.Planned_Qty : ''}" class="planner-qty w-full bg-black/40 border border-white/10 rounded-lg text-white text-center py-2 focus:border-luxe outline-none transition-colors">
                    </div>
                </div>
            `;
            
            const cb = div.querySelector('.design-checkbox');
            const wrap = div.querySelector('.qty-wrapper');
            const qtyInp = div.querySelector('.planner-qty');

            const priceInp = div.querySelector('.planner-price');
            const marginInd = div.querySelector('.planner-margin-indicator');
            
            const updateDrawerMargin = () => {
                const currentPrice = parseFloat(priceInp.value) || 0;
                const metrics = calculateUnitMargin(plan.Design_Code, currentPrice);
                marginInd.textContent = `${metrics.marginPct.toFixed(1)}%`;
                marginInd.className = `planner-margin-indicator absolute bottom-0 left-0 right-0 text-center text-[9px] font-medium whitespace-nowrap ${metrics.marginPct >= 0 ? 'text-luxe' : 'text-red-400'}`;
            };
            
            priceInp.addEventListener('input', updateDrawerMargin);
            updateDrawerMargin(); // Calculate on render
            
            if (plan.Planned_Qty > 0) cb.checked = true;
            if (cb.checked) wrap.classList.remove('opacity-50', 'pointer-events-none');

            cb.addEventListener('change', (e) => {
                if(e.target.checked) {
                    wrap.classList.remove('opacity-50', 'pointer-events-none');
                    if(qtyInp.value === '' || qtyInp.value === '0') qtyInp.value = '';
                    qtyInp.focus(); 
                } else {
                    wrap.classList.add('opacity-50', 'pointer-events-none');
                    qtyInp.value = '';
                }
                if (window.applyDrawerFilters) window.applyDrawerFilters();
            });
            
            plannerListContainer.appendChild(div);
        });

        // Unified Smart Filter Logic
        const togglePlannedOnly = document.getElementById('toggle-planned-only');
        
        const applyDrawerFilters = () => {
            const searchEl = document.getElementById('planner-search');
            const toggleEl = document.getElementById('toggle-planned-only');
            const term = searchEl ? searchEl.value.toLowerCase() : '';
            const showPlannedOnly = toggleEl ? toggleEl.checked : false;
            
            Array.from(plannerListContainer.children).forEach(card => {
                const cb = card.querySelector('.design-checkbox');
                const design = cb.dataset.design.toLowerCase();
                const isPlanned = cb.checked;
                
                const matchesSearch = design.includes(term);
                const matchesToggle = !showPlannedOnly || isPlanned;
                
                if (matchesSearch && matchesToggle) {
                    card.classList.remove('hidden');
                    card.classList.add('flex');
                } else {
                    card.classList.add('hidden');
                    card.classList.remove('flex');
                }
            });
        };

        if (plannerSearch || document.getElementById('planner-search')) {
            const searchNode = document.getElementById('planner-search');
            if (searchNode) {
                searchNode.replaceWith(searchNode.cloneNode(true));
                document.getElementById('planner-search').addEventListener('input', applyDrawerFilters);
            }
        }
        if (togglePlannedOnly) {
            togglePlannedOnly.replaceWith(togglePlannedOnly.cloneNode(true));
            document.getElementById('toggle-planned-only').addEventListener('change', applyDrawerFilters);
        }

        // Attach global filter triggers to window for external buttons
        window.applyDrawerFilters = applyDrawerFilters;
        applyDrawerFilters();
    }

    function renderActivePlans() {
        const list = document.getElementById('plan-designs-list');
        const active = db.plans.filter(p => p.Planned_Qty > 0);

        if (list) {
            if (active.length === 0) {
                list.innerHTML = '<div class="text-white/30 text-sm">No designs planned for this month. Tap Modify Targets to begin.</div>';
            } else {
                list.innerHTML = active.map(p => `
                    <div class="glass-panel p-3 rounded-xl flex justify-between items-center gap-3">
                        <div>
                            <div class="text-white font-medium">${p.Design_Code}</div>
                            <div class="text-white/40 text-[10px] uppercase tracking-widest">RM ${parseFloat(p.Target_Selling_Price || 0).toFixed(2)} / unit</div>
                        </div>
                        <div class="text-luxe font-display text-xl">${p.Planned_Qty}</div>
                    </div>
                `).join('');
            }
        }

        if (plannerHeroCard && plannerActiveState) {
            if (active.length === 0) {
                plannerHeroCard.classList.remove('hidden');
                plannerHeroCard.classList.add('flex');
                plannerActiveState.classList.add('hidden');
                plannerActiveState.classList.remove('flex');
            } else {
                plannerHeroCard.classList.add('hidden');
                plannerHeroCard.classList.remove('flex');
                plannerActiveState.classList.remove('hidden');
                plannerActiveState.classList.add('flex');
                if (activeCountDisplay) activeCountDisplay.textContent = active.length;
            }
        }
    }

    if (btnModifyPlans) {
        btnModifyPlans.replaceWith(btnModifyPlans.cloneNode(true));
        document.getElementById('btn-modify-plans').addEventListener('click', () => {
            const toggle = document.getElementById('toggle-planned-only');
            if (toggle) toggle.checked = true;
            if (window.applyDrawerFilters) window.applyDrawerFilters();
            openPlanner();
        });
    }

    if (btnOpenPlanner) {
        btnOpenPlanner.replaceWith(btnOpenPlanner.cloneNode(true));
        document.getElementById('btn-open-planner').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const toggle = document.getElementById('toggle-planned-only');
            const search = document.getElementById('planner-search');
            if (toggle) toggle.checked = false;
            if (search) search.value = '';
            if (window.applyDrawerFilters) window.applyDrawerFilters();
            openPlanner();
        });
    }

    // --- COMPONENT PUBLISHER (DATABASE MANAGER) ---
    const btnOpenDbManager = document.getElementById('btn-open-db-manager');
    const dbManagerOverlay = document.getElementById('db-manager-overlay');
    const dbManagerDrawer = document.getElementById('db-manager-drawer');
    const closeDbManagerBtn = document.getElementById('close-db-manager-btn');
    const recipeBulkCheckboxContainer = document.getElementById('recipe-bulk-checkbox-container');
    const recipeDesignSearch = document.getElementById('recipe-design-search');

    function openDbManager() {
        renderBulkCheckboxes();
        document.body.style.overflow = 'hidden';
        dbManagerOverlay.classList.remove('hidden');
        setTimeout(() => dbManagerOverlay.classList.remove('opacity-0'), 10);
        dbManagerDrawer.classList.remove('translate-x-full');
        renderMaterialEditor();
        renderConfigEditor();
        populateBomDropdown();
    }

    function closeDbManager() {
        document.body.style.overflow = '';
        dbManagerOverlay.classList.add('opacity-0');
        setTimeout(() => dbManagerOverlay.classList.add('hidden'), 300);
        dbManagerDrawer.classList.add('translate-x-full');
    }

    function renderBulkCheckboxes() {
        if (!recipeBulkCheckboxContainer) return;
        recipeBulkCheckboxContainer.innerHTML = `
            <label class="flex items-center gap-3 cursor-pointer text-xs text-luxe font-medium select-none border-b border-white/10 pb-2 w-full">
                <input type="checkbox" id="recipe-master-select-all" class="rounded border-white/20 bg-black/40 text-luxe focus:ring-0">
                <span>SELECT ALL DESIGNS</span>
            </label>
        `;
        
        const designs = Object.keys(db.bom).sort();
        designs.forEach(code => {
            const lbl = document.createElement('label');
            lbl.className = "recipe-bulk-label flex items-center gap-3 cursor-pointer text-sm text-white/70 select-none hover:text-white w-full";
            lbl.innerHTML = `
                <input type="checkbox" value="${code}" class="recipe-design-cb rounded border-white/20 bg-black/40 text-luxe focus:ring-0">
                <span>${code}</span>
            `;
            recipeBulkCheckboxContainer.appendChild(lbl);
        });

        const masterCb = document.getElementById('recipe-master-select-all');
        masterCb.addEventListener('change', (e) => {
            document.querySelectorAll('.recipe-design-cb').forEach(cb => {
                if (cb.parentElement.style.display !== 'none') cb.checked = e.target.checked;
            });
        });

        if (recipeDesignSearch) {
            recipeDesignSearch.value = ''; // Clear search on open
            recipeDesignSearch.addEventListener('input', (e) => {
                const term = e.target.value.toLowerCase().trim();
                document.querySelectorAll('.recipe-bulk-label').forEach(lbl => {
                    const text = lbl.textContent.toLowerCase();
                    lbl.style.display = text.includes(term) ? 'flex' : 'none';
                });
            });
        }
    }

    async function postManagerAction(action, payloadObj, opts = {}) {
        if (!opts.skipLoader) showLoader('Executing...');
        try {
            const res = await fetch(`${ctx.apiUrl}?action=${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `payload=${encodeURIComponent(JSON.stringify({ ...payloadObj, pin: sessionPin }))}`
            });
            const json = await res.json();
            if (json.status !== 'success') throw new Error(json.message || 'Request failed');
            return json;
        } finally {
            if (!opts.skipLoader) hideLoader();
        }
    }

    if (btnOpenDbManager) btnOpenDbManager.addEventListener('click', openDbManager);
    if (closeDbManagerBtn) closeDbManagerBtn.addEventListener('click', closeDbManager);
    if (dbManagerOverlay) dbManagerOverlay.addEventListener('click', closeDbManager);

    const matAiRawName = document.getElementById('mat-ai-raw-name');
    const btnTriggerAi = document.getElementById('btn-trigger-ai');
    const matCategory = document.getElementById('mat-category');
    const matInputPrice = document.getElementById('mat-input-price');
    const matCurrencySelect = document.getElementById('mat-currency-select');
    const matItemId = document.getElementById('mat-item-id');
    const matDescription = document.getElementById('mat-description');
    const matUnitType = document.getElementById('mat-unit-type');
    const bomComponentName = document.getElementById('bom-component-name');
    const btnPublishComponent = document.getElementById('btn-publish-component');

    if (btnTriggerAi) {
        btnTriggerAi.addEventListener('click', async () => {
            const rawName = matAiRawName.value.trim();
            const category = matCategory.value.trim();
            if (!rawName || !category) return alert('Fill up Item Name and Category first.');

            btnTriggerAi.textContent = '...';
            btnTriggerAi.disabled = true;

            try {
                const json = await postManagerAction('draft_material_metadata', { materialName: rawName, category: category });
                if (json.data) {
                    matItemId.value = json.data.Item_ID || '';
                    matDescription.value = json.data.Description || '';
                    matUnitType.value = json.data.Unit_Type || '';
                    bomComponentName.value = json.data.BOM_Column || '';
                }
            } catch (err) {
                alert('AI Prediction dropped: ' + err.message);
            } finally {
                btnTriggerAi.textContent = 'AI Fit';
                btnTriggerAi.disabled = false;
            }
        });
    }
    
    if (btnPublishComponent) {
        btnPublishComponent.addEventListener('click', async () => {
            const item_id = matItemId.value.trim();
            const category = matCategory.value.trim();
            const description = matDescription.value.trim();
            const unit = matUnitType.value.trim();
            const price = parseFloat(matInputPrice.value) || 0;
            const currency = matCurrencySelect.value;
            const columnHeader = bomComponentName.value.trim();
            const materialQty = document.getElementById('bulk-material-qty').value;

            if (!item_id || !columnHeader) return alert('Please define the material details (or run AI Fit) first.');
            if (materialQty === '') return alert('Please set the application quantity.');

            const selectedCbs = document.querySelectorAll('.recipe-design-cb:checked');
            const targetDesigns = Array.from(selectedCbs).map(cb => cb.value);
            if (targetDesigns.length === 0) return alert('Please select at least one design to assign this component to.');

            btnPublishComponent.disabled = true;
            btnPublishComponent.textContent = 'PUBLISHING...';

            try {
                // Step 1: Initialize BOM Columns if new
                const sampleBom = db.bom[Object.keys(db.bom)[0]] || {};
                if (sampleBom[columnHeader + '_ID'] === undefined) {
                    await postManagerAction('add_bom_column', { componentName: columnHeader });
                }

                // Step 2: Register the raw material natively
                await postManagerAction('add_raw_material', {
                    item: { Item_ID: item_id, Category: category, Description: description, Unit_Type: unit, Currency: currency, Original_Cost: price }
                });

                // Step 3: Assign to selected designs
                const recipeFields = {};
                recipeFields[columnHeader + '_ID'] = item_id;
                recipeFields[columnHeader + '_Qty'] = parseFloat(materialQty);

                await postManagerAction('save_bulk_bom_recipes', {
                    designs: targetDesigns,
                    recipeFields: recipeFields
                });

                // Reset Panel
                matAiRawName.value = ''; matCategory.value = ''; matInputPrice.value = '';
                matItemId.value = ''; matDescription.value = ''; matUnitType.value = ''; 
                bomComponentName.value = ''; document.getElementById('bulk-material-qty').value = '';
                document.querySelectorAll('.recipe-design-cb').forEach(cb => cb.checked = false);
                document.getElementById('recipe-master-select-all').checked = false;

                await fetchData();
                alert('Component published and instantly assigned to ' + targetDesigns.length + ' designs.');
                closeDbManager();
            } catch (err) {
                alert('Transaction aborted: ' + err.message);
            } finally {
                btnPublishComponent.disabled = false;
                btnPublishComponent.textContent = 'Publish & Assign Component';
            }
        });
    }

    // --- FINANCIAL MATH UTILITY ---
    function calculateUnitMargin(designCode, targetPrice, recipeOverrides = null) {
        let matCost = 0;
        let labor = 0;
        
        if (recipeOverrides) {
            matCost = recipeOverrides.matCost;
            labor = recipeOverrides.labor;
        } else {
            const bom = db.bom[designCode];
            if (!bom) return { totalUnitCost: 0, marginRM: 0, marginPct: 0 };
            
            labor = parseFloat(bom.Direct_Labor_RM) || 0;
            Object.keys(bom).forEach(key => {
                if (!key.endsWith('_ID') || key === 'Design_Code') return;
                const prefix = key.slice(0, -3);
                const id = bom[key];
                if (!id || id === 'NONE') return;
                const qty = parseFloat(bom[prefix + '_Qty']) || 0;
                const mat = db.materials[id];
                if (mat) matCost += (mat.costRM * qty);
            });
        }

        let varOverhead = 0;
        db.configRaw.forEach(c => {
            if (c.Account_Category === 'Variable Selling') {
                const val = parseFloat(c.Value_RM) || 0;
                if (c.Variable_Name.includes('_Pct')) varOverhead += (targetPrice * val);
                else varOverhead += val;
            }
        });

        const totalUnitCost = matCost + labor + varOverhead;
        const marginRM = targetPrice - totalUnitCost;
        const marginPct = targetPrice > 0 ? (marginRM / targetPrice) * 100 : 0;

        return { totalUnitCost, marginRM, marginPct };
    }

    // --- AI CHART DRAWER DISPLAY STATE CONTROLLERS ---
    const btnOpenAiChat = document.getElementById('btn-open-ai-chat');
    const aiChatOverlay = document.getElementById('ai-chat-overlay');
    const aiChatDrawer = document.getElementById('ai-chat-drawer');
    const closeAiChatBtn = document.getElementById('close-ai-chat-btn');
    const aiChatFileInput = document.getElementById('ai-chat-file-input');
    const aiFilePreviewCard = document.getElementById('ai-file-preview-card');
    const aiFileName = document.getElementById('ai-file-name');
    const btnRemoveAiFile = document.getElementById('btn-remove-ai-file');

    function openAiChat() {
        document.body.style.overflow = 'hidden';
        aiChatOverlay.classList.remove('hidden');
        setTimeout(() => aiChatOverlay.classList.remove('opacity-0'), 10);
        aiChatDrawer.classList.remove('translate-x-full');
    }
    function closeAiChat() {
        document.body.style.overflow = '';
        aiChatOverlay.classList.add('opacity-0');
        setTimeout(() => aiChatOverlay.classList.add('hidden'), 300);
        aiChatDrawer.classList.add('translate-x-full');
    }
    btnOpenAiChat?.addEventListener('click', openAiChat);
    closeAiChatBtn?.addEventListener('click', closeAiChat);
    aiChatOverlay?.addEventListener('click', closeAiChat);

    aiChatFileInput?.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            aiFileName.textContent = e.target.files.length > 1
                ? `${e.target.files.length} files attached`
                : e.target.files[0].name;
            aiFilePreviewCard.classList.remove('hidden');
            aiFilePreviewCard.classList.add('flex');
        }
    });
    btnRemoveAiFile?.addEventListener('click', () => {
        aiChatFileInput.value = '';
        aiFilePreviewCard.classList.replace('flex', 'hidden');
    });

    // --- TEMPORAL ERP CALCULATION ENGINE ---
    function calculateEngine() {
        let planRev = 0, planCogs = 0, planVarOverhead = 0, planQtyTotal = 0, targetSoldTotal = 0;
        let reqs = {}; 
        let fixedOpex = 0;
        
        const sellThroughPct = parseFloat(document.getElementById('plan-sell-through')?.value) || 100;
        
        db.configRaw.forEach(c => { if (c.Account_Category === 'Fixed OPEX') fixedOpex += (parseFloat(c.Value_RM) || 0); });

        db.plans.forEach(plan => {
            const prodQty = parseInt(plan.Planned_Qty) || 0;
            if (prodQty <= 0) return;
            
            const soldQty = Math.round(prodQty * (sellThroughPct / 100));
            planQtyTotal += prodQty;
            targetSoldTotal += soldQty;
            
            const price = parseFloat(plan.Target_Selling_Price) || 0;
            planRev += (price * soldQty); // Revenue strictly on sold qty

            let designMatCogs = 0;
            const bom = db.bom[plan.Design_Code];
            if (bom) {
                Object.keys(bom).forEach(key => {
                    if (!key.endsWith('_ID') || key === 'Design_Code') return;
                    const id = bom[key];
                    const amount = parseFloat(bom[key.slice(0, -3) + '_Qty']) || 0;
                    if (!id || id === 'NONE' || amount <= 0) return;
                    
                    if (!reqs[id]) reqs[id] = 0;
                    reqs[id] += (amount * prodQty); // Production requires 100% materials
                    const mat = db.materials[id];
                    if (mat) designMatCogs += (mat.costRM * amount);
                });
            }

            const matCogs = plan.Locked_Material_COGS_RM !== undefined && plan.Locked_Material_COGS_RM !== "" ? parseFloat(plan.Locked_Material_COGS_RM) || 0 : designMatCogs;
            const labor = plan.Locked_Direct_Labor_RM !== undefined && plan.Locked_Direct_Labor_RM !== "" ? parseFloat(plan.Locked_Direct_Labor_RM) || 0 : parseFloat(bom?.Direct_Labor_RM) || 10;
            
            let dynamicOverhead = 0;
            db.configRaw.forEach(c => {
                if (c.Account_Category === 'Variable Selling') {
                    const val = parseFloat(c.Value_RM) || 0;
                    dynamicOverhead += c.Variable_Name.includes('_Pct') ? (price * val) : val;
                }
            });
            const overhead = plan.Locked_Var_Overhead_RM !== undefined && plan.Locked_Var_Overhead_RM !== "" ? parseFloat(plan.Locked_Var_Overhead_RM) || 0 : dynamicOverhead;

            // CORRECT MATH: COGS is strictly manufacturing. Overhead is strictly variable selling.
            const unitCogs = matCogs + labor;
            planCogs += (unitCogs * prodQty); 
            planVarOverhead += (overhead * soldQty); 

            plan.Live_Material_COGS_RM = matCogs;
            plan.Live_Direct_Labor_RM = labor;
            plan.Live_Var_Overhead_RM = overhead;
        });

        let totalExtraCosts = 0;
        (db.currentExtraCosts || []).forEach(ex => totalExtraCosts += (parseFloat(ex.Cost_RM) || 0));

        // Net Profit = Cash in the bank
        const planNetProfit = planRev - planCogs - planVarOverhead - fixedOpex - totalExtraCosts;
        
        // Split Margins
        const perfectGrossRev = planQtyTotal * (planRev / (targetSoldTotal || 1)); 
        // Perfect Margin = (Total theoretical revenue - COGS for all units - Overheads if all units sold) / Theoretical Revenue
        const perfectMargin = perfectGrossRev > 0 ? ((perfectGrossRev - planCogs - ((planVarOverhead / (targetSoldTotal || 1)) * planQtyTotal)) / perfectGrossRev) * 100 : 0;
        
        const cashMargin = planRev > 0 ? (planNetProfit / planRev) * 100 : 0;
        
        db.currentMacroSnapshot = { Locked_Fixed_OPEX_RM: fixedOpex, Total_Revenue_RM: planRev, Net_Profit_RM: planNetProfit };
        db.lastReqs = reqs;

        renderPlanPillar(planRev, planCogs, planNetProfit, perfectMargin, cashMargin, sellThroughPct, reqs);
        renderActualPillar(fixedOpex, reqs);
    }

    document.getElementById('plan-sell-through')?.addEventListener('input', calculateEngine);

    function renderPlanPillar(rev, cogs, profit, perfectMargin, cashMargin, sellThroughPct, reqs) {
        document.getElementById('plan-metrics-container').innerHTML = `
            <div class="glass-panel p-4 rounded-xl border border-white/5"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Revenue (${sellThroughPct}% Sold)</p><div class="text-xl font-display text-white">RM ${rev.toFixed(2)}</div></div>
            <div class="glass-panel p-4 rounded-xl border border-white/5"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">COGS (100% Prod)</p><div class="text-xl font-display text-white">RM ${cogs.toFixed(2)}</div></div>
            <div class="glass-panel p-4 rounded-xl border border-white/5"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Unit Gross Margin</p><div class="text-xl font-display text-white">${perfectMargin.toFixed(1)}%</div></div>
            <div class="glass-panel p-4 rounded-xl border border-white/5"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Net Cash Margin</p><div class="text-xl font-display ${cashMargin >= 0 ? 'text-white' : 'text-red-400'}">${cashMargin.toFixed(1)}%</div></div>
            <div class="glass-panel p-4 rounded-xl border ${profit >= 0 ? 'border-luxe/30 bg-luxe/5' : 'border-red-500/30 bg-red-500/5'}"><p class="text-luxe text-[9px] uppercase tracking-widest mb-1 font-bold">Est. Net Profit</p><div class="text-2xl font-display ${profit >= 0 ? 'text-luxe' : 'text-red-400'}">RM ${profit.toFixed(2)}</div></div>
        `;

        const designList = document.getElementById('plan-designs-list');
        designList.innerHTML = '';
        db.plans.filter(p => p.Planned_Qty > 0).forEach(p => {
            designList.innerHTML += `<div class="flex justify-between items-center bg-black/40 p-3 rounded-lg border border-white/5"><span class="text-white text-sm font-medium">${p.Design_Code}</span><span class="text-white/60 text-xs">${p.Planned_Qty} pcs @ RM ${p.Target_Selling_Price}</span></div>`;
        });
        if (designList.innerHTML === '') designList.innerHTML = '<p class="text-white/30 text-xs">No designs planned. Modify targets to begin.</p>';

        const extrasList = document.getElementById('plan-extras-list');
        extrasList.innerHTML = '';
        (db.currentExtraCosts || []).forEach((ex, index) => {
            extrasList.innerHTML += `<div class="flex justify-between items-center bg-black/40 p-3 rounded-lg border border-white/5"><div class="flex flex-col"><span class="text-white text-sm">${ex.Cost_Name}</span><span class="text-white/40 text-[9px] uppercase tracking-widest">${ex.Category}</span></div><div class="flex items-center gap-3"><span class="text-red-400 text-sm">-RM ${parseFloat(ex.Cost_RM).toFixed(2)}</span><button class="text-white/30 hover:text-red-400 tap-none btn-remove-extra" data-index="${index}">×</button></div></div>`;
        });
        document.querySelectorAll('.btn-remove-extra').forEach(btn => {
            btn.addEventListener('click', (e) => { db.currentExtraCosts.splice(e.target.dataset.index, 1); calculateEngine(); });
        });

        const procureList = document.getElementById('plan-procurement-list');
        procureList.innerHTML = '';
        Object.entries(reqs).forEach(([id, qty]) => {
            const mat = db.materials[id];
            if (mat) procureList.innerHTML += `<div class="flex justify-between items-center border-b border-white/5 pb-2 last:border-0"><div class="flex flex-col"><span class="text-white text-sm">${mat.desc}</span><span class="text-white/40 text-[9px] uppercase tracking-widest">${id}</span></div><div class="text-right"><div class="text-white/80 text-xs">${qty.toFixed(1)} ${mat.unit}</div><div class="text-white/40 text-[10px]">RM ${(mat.costRM * qty).toFixed(2)}</div></div></div>`;
        });

        // Keep planner hero card in sync with active plan count
        const active = db.plans.filter(p => p.Planned_Qty > 0);
        if (plannerHeroCard && plannerActiveState) {
            if (active.length === 0) {
                plannerHeroCard.classList.remove('hidden');
                plannerHeroCard.classList.add('flex');
                plannerActiveState.classList.add('hidden');
                plannerActiveState.classList.remove('flex');
            } else {
                plannerHeroCard.classList.add('hidden');
                plannerHeroCard.classList.remove('flex');
                plannerActiveState.classList.remove('hidden');
                plannerActiveState.classList.add('flex');
                if (activeCountDisplay) activeCountDisplay.textContent = active.length;
            }
        }
    }

    function renderActualPillar(fixedOpex, reqs) {
        const monthStr = monthInput.value;
        const aMacro = db.actualsMacro.find(m => String(m.Plan_Month).substring(0, 7) === monthStr) || { Actual_Revenue_RM: 0, Actual_Platform_Fees_RM: 0, Actual_Ad_Spend_RM: 0 };
        const microHistory = db.actualsMicro.filter(a => String(a.Date).substring(0, 7) === monthStr);
        const costingHistory = db.actualsCosting.filter(c => String(c.Month).substring(0, 7) === monthStr);

        let actualCogs = 0;
        Object.entries(reqs).forEach(([id, planQty]) => {
            const hist = costingHistory.find(c => c.Item_ID === id);
            const mat = db.materials[id];
            const actCost = hist ? parseFloat(hist.Actual_Total_Cost_RM) || 0 : (mat ? mat.costRM * planQty : 0);
            actualCogs += actCost;
        });
        
        const rev = parseFloat(aMacro.Actual_Revenue_RM) || 0;
        const fees = (parseFloat(aMacro.Actual_Platform_Fees_RM) || 0) + (parseFloat(aMacro.Actual_Ad_Spend_RM) || 0);
        
        let actualProfit = 0, actualMargin = 0;
        if (rev > 0 || actualCogs > 0) { // Only calculate if actuals exist
            actualProfit = rev - fees - fixedOpex - actualCogs;
            actualMargin = rev > 0 ? (actualProfit / rev) * 100 : 0;
        }

        document.getElementById('actual-metrics-container').innerHTML = `
            <div class="glass-panel p-4 rounded-xl border border-white/5"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Settled Net Revenue</p><div class="text-xl font-display text-white">RM ${rev.toFixed(2)}</div></div>
            <div class="glass-panel p-4 rounded-xl border border-white/5"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Actual Direct Costs</p><div class="text-xl font-display text-white">RM ${actualCogs.toFixed(2)}</div></div>
            <div class="glass-panel p-4 rounded-xl border border-white/5"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Realized Margin</p><div class="text-xl font-display ${actualMargin >= 0 ? 'text-white' : 'text-red-400'}">${actualMargin.toFixed(2)}%</div></div>
            <div class="glass-panel p-4 rounded-xl border ${actualProfit >= 0 ? 'border-luxe/30 bg-luxe/5' : 'border-red-500/30 bg-red-500/5'}"><p class="text-luxe text-[9px] uppercase tracking-widest mb-1 font-bold">Settled Profit</p><div class="text-2xl font-display ${actualProfit >= 0 ? 'text-luxe' : 'text-red-400'}">RM ${actualProfit.toFixed(2)}</div></div>
        `;

        const volList = document.getElementById('actual-designs-list');
        volList.innerHTML = '';
        db.plans.forEach(p => {
            const hist = microHistory.find(h => h.Design_Code === p.Design_Code);
            const prod = hist ? parseInt(hist.Qty_Produced) || 0 : parseInt(p.Planned_Qty) || 0;
            const sold = hist ? parseInt(hist.Qty_Sold) || 0 : 0;
            if (p.Planned_Qty === 0 && prod === 0 && sold === 0) return; // Zero-Filter

            volList.innerHTML += `
                <div class="glass-panel p-3 rounded-xl flex items-center justify-between gap-3 actual-vol-row" data-design="${p.Design_Code}">
                    <div class="flex-1"><span class="text-white text-sm font-medium">${p.Design_Code}</span><span class="text-white/40 text-[9px] uppercase tracking-widest block">Plan: ${p.Planned_Qty}</span></div>
                    <div class="flex gap-2 w-40">
                        <input type="number" class="act-prod w-1/2 bg-black/40 border border-white/10 rounded text-white text-center py-1 text-xs focus:border-luxe outline-none" placeholder="Prod" value="${prod}">
                        <input type="number" class="act-sold w-1/2 bg-black/40 border border-white/10 rounded text-luxe text-center py-1 text-xs focus:border-luxe outline-none font-bold" placeholder="Sold" value="${sold}">
                    </div>
                </div>`;
        });

        const costList = document.getElementById('actual-costing-list');
        costList.innerHTML = '';
        Object.entries(reqs).forEach(([id, planQty]) => {
            const mat = db.materials[id];
            if (!mat) return;
            const hist = costingHistory.find(c => c.Item_ID === id);
            const actQty = hist ? parseFloat(hist.Actual_Qty) || 0 : planQty;
            const actCost = hist ? parseFloat(hist.Actual_Total_Cost_RM) || 0 : (mat.costRM * planQty);
            const remarks = hist ? hist.Remarks : '';

            costList.innerHTML += `
                <div class="glass-panel p-3 rounded-xl flex flex-col gap-2 actual-cost-row" data-id="${id}" data-category="${mat.category}">
                    <div class="flex justify-between items-center"><span class="text-white text-sm truncate">${mat.desc}</span><span class="text-white/40 text-[9px] uppercase tracking-widest">${mat.category}</span></div>
                    <div class="flex gap-2">
                        <input type="number" step="0.01" class="act-qty w-1/3 bg-black/40 border border-white/10 rounded text-white text-center py-1.5 text-xs focus:border-luxe outline-none" placeholder="Actual ${mat.unit}" value="${actQty.toFixed(1)}">
                        <input type="number" step="0.01" class="act-cost w-1/3 bg-black/40 border border-white/10 rounded text-white text-center py-1.5 text-xs focus:border-luxe outline-none" placeholder="Total RM" value="${actCost.toFixed(2)}">
                        <input type="text" class="act-remarks w-1/3 bg-black/40 border border-white/10 rounded text-white/80 px-2 py-1.5 text-xs focus:border-luxe outline-none" placeholder="Remarks..." value="${remarks || ''}">
                    </div>
                </div>`;
        });
    }

    function renderAnalysisPillar() {
        const monthStr = monthInput.value;
        const aMacro = db.actualsMacro.find(m => String(m.Plan_Month).substring(0, 7) === monthStr) || { Actual_Revenue_RM: 0, Actual_Platform_Fees_RM: 0, Actual_Ad_Spend_RM: 0, AI_Remarks: "" };
        
        let planRev = 0, planQty = 0;
        db.plans.forEach(p => { planRev += (parseFloat(p.Target_Selling_Price) || 0) * (parseInt(p.Planned_Qty) || 0); planQty += parseInt(p.Planned_Qty) || 0; });

        const actRev = parseFloat(aMacro.Actual_Revenue_RM) || 0;
        const actPlatFees = parseFloat(aMacro.Actual_Platform_Fees_RM) || 0;
        const actAdSpend = parseFloat(aMacro.Actual_Ad_Spend_RM) || 0;

        // Isolate exact explicit variables for variance mapping
        const budgPlatFees = planRev * (db.config['TikTok_Fee_Pct'] || db.config['Platform_Commission_Pct'] || 0.20);
        const budgAdSpend = planQty * (db.config['Marketing_Per_Unit'] || 5.00);

        const revDelta = actRev - planRev;
        const platDelta = actPlatFees - budgPlatFees;
        const adDelta = actAdSpend - budgAdSpend;

        document.getElementById('analysis-variance-cards').innerHTML = `
            <div class="glass-panel p-4 rounded-xl"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Revenue Variance</p><div class="text-xl font-display text-white">RM ${actRev.toFixed(2)}</div><div class="text-xs ${revDelta >= 0 ? 'text-luxe' : 'text-red-400'} mt-1 font-medium">${revDelta >= 0 ? '+' : ''}RM ${revDelta.toFixed(2)} vs Target (RM ${planRev.toFixed(0)})</div></div>
            <div class="glass-panel p-4 rounded-xl"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Platform Fees (Settled)</p><div class="text-xl font-display text-white">RM ${actPlatFees.toFixed(2)}</div><div class="text-xs ${platDelta <= 0 ? 'text-luxe' : 'text-red-400'} mt-1 font-medium">${platDelta > 0 ? 'Over budget by' : 'Under budget by'} RM ${Math.abs(platDelta).toFixed(2)}</div></div>
            <div class="glass-panel p-4 rounded-xl"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Ad Spend (Settled)</p><div class="text-xl font-display text-white">RM ${actAdSpend.toFixed(2)}</div><div class="text-xs ${adDelta <= 0 ? 'text-luxe' : 'text-red-400'} mt-1 font-medium">${adDelta > 0 ? 'Over budget by' : 'Under budget by'} RM ${Math.abs(adDelta).toFixed(2)}</div></div>
        `;

        const remarksStr = aMacro.AI_Remarks || aMacro.ai_remarks || "";
        const remarksCard = document.getElementById('analysis-ai-remarks');

        // Temporal Inventory Math (Carry Forward)
        const invList = document.getElementById('analysis-inventory-list');
        invList.innerHTML = '';
        db.plans.forEach(p => {
            let openingAsset = 0;
            // Sum all history BEFORE the currently selected month
            db.actualsMicro.forEach(a => {
                if (a.Design_Code !== p.Design_Code) return;
                const rowMonth = String(a.Date).substring(0, 7);
                if (rowMonth < monthStr) {
                    openingAsset += (parseInt(a.Qty_Produced) || 0) - (parseInt(a.Qty_Sold) || 0);
                }
            });
            
            const currentHist = db.actualsMicro.find(a => String(a.Date).substring(0, 7) === monthStr && a.Design_Code === p.Design_Code);
            const currentProd = currentHist ? parseInt(currentHist.Qty_Produced) || 0 : parseInt(p.Planned_Qty) || 0;
            const currentSold = currentHist ? parseInt(currentHist.Qty_Sold) || 0 : 0;
            const closingAsset = openingAsset + currentProd - currentSold;

            if (p.Planned_Qty === 0 && currentProd === 0 && currentSold === 0 && openingAsset === 0) return; // Zero-Filter

            invList.innerHTML += `
                <div class="glass-panel p-3 rounded-xl flex flex-col gap-2">
                    <div class="flex justify-between items-center"><span class="text-white text-sm font-medium">${p.Design_Code}</span><span class="text-luxe text-xs font-bold font-display">Close: ${closingAsset} pcs</span></div>
                    <div class="grid grid-cols-3 text-[10px] text-white/50 border-t border-white/5 pt-2">
                        <div>Opening: <span class="text-white">${openingAsset}</span></div>
                        <div class="text-center">+ Prod: <span class="text-white">${currentProd}</span></div>
                        <div class="text-right">- Sold: <span class="text-white">${currentSold}</span></div>
                    </div>
                </div>`;
        });

        let actCogs = 0;
        const costingHistory = db.actualsCosting.filter(c => String(c.Month).substring(0, 7) === monthStr);
        Object.entries(db.lastReqs || {}).forEach(([id, planQty]) => {
            const hist = costingHistory.find(c => c.Item_ID === id);
            const mat = db.materials[id];
            actCogs += hist ? parseFloat(hist.Actual_Total_Cost_RM) || 0 : (mat ? mat.costRM * planQty : 0);
        });
        
        let planCogs = 0;
        db.plans.forEach(p => { 
            const prod = parseInt(p.Planned_Qty) || 0; 
            planCogs += (p.Live_Material_COGS_RM || 0) * prod; 
            planCogs += (p.Live_Direct_Labor_RM || 0) * prod; 
        });
        
        let totalExtra = 0;
        (db.currentExtraCosts || []).forEach(ex => totalExtra += parseFloat(ex.Cost_RM) || 0);

        const expDelta = actCogs - (planCogs + totalExtra);

        const expCards = document.getElementById('analysis-expenditure-cards');
        if (expCards) {
            expCards.innerHTML = `
            <div class="glass-panel p-4 rounded-xl"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Planned Direct Costs + Extras</p><div class="text-xl font-display text-white">RM ${(planCogs + totalExtra).toFixed(2)}</div></div>
            <div class="glass-panel p-4 rounded-xl"><p class="text-white/40 text-[9px] uppercase tracking-widest mb-1">Actual Expenditure Ledger</p><div class="text-xl font-display text-white">RM ${actCogs.toFixed(2)}</div><div class="text-xs ${expDelta <= 0 ? 'text-luxe' : 'text-red-400'} mt-1 font-medium">${expDelta > 0 ? 'Overspent by' : 'Saved'} RM ${Math.abs(expDelta).toFixed(2)}</div></div>
        `;
        }
        
        if (remarksCard) {
            if (remarksStr) {
                remarksCard.classList.remove('hidden');
                // Parse markdown bolding basic support
                remarksCard.innerHTML = `<span class="text-luxe text-[9px] uppercase tracking-widest font-bold">CFO Report</span><div class="text-white/80 text-sm leading-relaxed mt-2 whitespace-pre-wrap">${remarksStr.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white">$1</strong>')}</div>`;
            } else remarksCard.classList.add('hidden');
        }
    }


    // --- MASTER SETTINGS TABS & EDITORS ---
    const tabBtns = document.querySelectorAll('.settings-tab-btn');
    const panels = document.querySelectorAll('.settings-panel');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => { b.classList.remove('bg-luxe', 'text-ink'); b.classList.add('text-white/40', 'hover:bg-white/5'); });
            btn.classList.remove('text-white/40', 'hover:bg-white/5');
            btn.classList.add('bg-luxe', 'text-ink');

            panels.forEach(p => {
                p.classList.add('hidden');
                p.classList.remove('flex');
            });
            const target = document.getElementById(btn.dataset.target);
            if (target) {
                target.classList.remove('hidden');
                target.classList.add('flex');
            }
        });
    });

    // Materials Render & Save
    const matEditorList = document.getElementById('material-editor-list');
    function renderMaterialEditor() {
        if (!matEditorList) return;
        matEditorList.innerHTML = '';
        Object.entries(db.materials).forEach(([id, mat]) => {
            const displayCostRM = mat.currency === 'CNY' ? `(≈ RM ${mat.costRM.toFixed(2)})` : '';
            matEditorList.innerHTML += `
                <div class="glass-panel p-3 rounded-xl flex items-center justify-between gap-3">
                    <div class="flex-1 truncate">
                        <p class="text-white text-sm truncate">${mat.desc}</p>
                        <p class="text-white/40 text-[10px] uppercase tracking-widest">${id} • ${mat.unit}</p>
                    </div>
                    <div class="w-32 flex flex-col items-end shrink-0">
                        <div class="flex items-center gap-1 w-full bg-black/40 border border-white/10 rounded-lg overflow-hidden">
                            <span class="text-white/50 text-[10px] pl-2 font-medium">${mat.currency}</span>
                            <input type="number" step="0.01" data-mat-id="${id}" value="${mat.origCost}" class="mat-price-input flex-1 bg-transparent text-white text-right py-2 pr-2 text-sm focus:outline-none">
                        </div>
                        <span class="text-[9px] text-white/30 mt-1 mr-1">${displayCostRM}</span>
                    </div>
                </div>`;
        });
    }

    document.getElementById('btn-save-materials')?.addEventListener('click', async (e) => {
        const btn = e.target;
        const updates = Array.from(document.querySelectorAll('.mat-price-input')).map(inp => ({
            id: inp.dataset.matId, price: parseFloat(inp.value) || 0
        }));
        btn.textContent = 'UPDATING...';
        try {
            await postManagerAction('update_material_prices', { updates });
            await fetchData();
            alert('Material Catalog updated successfully.');
        } catch(err) { alert('Error: ' + err.message); }
        btn.textContent = 'Update Catalog Prices';
    });

    // Config Render & Save
    const configEditorList = document.getElementById('config-editor-list');
    function renderConfigEditor() {
        if (!configEditorList) return;
        configEditorList.innerHTML = '';
        db.configRaw.forEach(c => {
            const key = c.Variable_Name;
            const val = parseFloat(c.Value_RM) || 0;
            const cat = c.Account_Category || 'Operations';
            
            configEditorList.innerHTML += `
                <div class="glass-panel p-3 rounded-xl flex items-center justify-between gap-3">
                    <div class="flex-1 truncate">
                        <p class="text-white text-sm truncate">${key.replace(/_/g, ' ')}</p>
                        <p class="text-white/40 text-[10px] uppercase tracking-widest">${cat}</p>
                    </div>
                    <div class="w-24 shrink-0">
                        <input type="number" step="0.01" data-config-key="${key}" value="${val}" class="config-val-input w-full bg-black/40 border border-white/10 rounded-lg text-white text-center py-2 text-sm focus:border-luxe outline-none">
                    </div>
                </div>`;
        });
    }

    document.getElementById('btn-save-config')?.addEventListener('click', async (e) => {
        const btn = e.target;
        const updates = Array.from(document.querySelectorAll('.config-val-input')).map(inp => ({
            name: inp.dataset.configKey, value: parseFloat(inp.value) || 0
        }));
        btn.textContent = 'UPDATING...';
        try {
            await postManagerAction('update_global_config', { updates });
            await fetchData();
            alert('Global Config updated successfully.');
        } catch(err) { alert('Error: ' + err.message); }
        btn.textContent = 'Update Operations';
    });

    // --- TAB 4: RECIPE MANAGER (BOM CRUD) ---
    const bomEditorSelect = document.getElementById('bom-editor-select');
    const bomCloneSelect = document.getElementById('bom-clone-select');
    const bomEditorFields = document.getElementById('bom-editor-fields');
    const bomNewDesignCode = document.getElementById('bom-new-design-code');
    const btnDeleteDesign = document.getElementById('btn-delete-design');
    const btnSaveBomRecipe = document.getElementById('btn-save-bom-recipe');

    let bomMode = 'edit';

    document.getElementById('mode-edit-design')?.addEventListener('click', (e) => {
        bomMode = 'edit';
        e.target.classList.replace('text-white/40', 'text-white');
        e.target.classList.add('bg-white/10');
        document.getElementById('mode-add-design').classList.replace('text-white', 'text-white/40');
        document.getElementById('mode-add-design').classList.remove('bg-white/10');
        document.getElementById('bom-edit-container').classList.remove('hidden');
        document.getElementById('bom-edit-container').classList.add('flex');
        document.getElementById('bom-create-container').classList.add('hidden');
        document.getElementById('bom-create-container').classList.remove('flex');
        if (bomEditorSelect.value) {
            btnDeleteDesign.classList.remove('hidden');
            renderBomRecipeFields(bomEditorSelect.value);
        } else {
            btnDeleteDesign.classList.add('hidden');
            bomEditorFields.innerHTML = '';
        }
    });

    document.getElementById('mode-add-design')?.addEventListener('click', (e) => {
        bomMode = 'create';
        e.target.classList.replace('text-white/40', 'text-white');
        e.target.classList.add('bg-white/10');
        document.getElementById('mode-edit-design').classList.replace('text-white', 'text-white/40');
        document.getElementById('mode-edit-design').classList.remove('bg-white/10');
        document.getElementById('bom-create-container').classList.remove('hidden');
        document.getElementById('bom-create-container').classList.add('flex');
        document.getElementById('bom-edit-container').classList.add('hidden');
        document.getElementById('bom-edit-container').classList.remove('flex');
        btnDeleteDesign.classList.add('hidden');
        bomEditorFields.innerHTML = '';
        if (bomCloneSelect.value) renderBomRecipeFields(bomCloneSelect.value);
    });

    function populateBomDropdown() {
        if (!bomEditorSelect || !bomCloneSelect) return;
        const optionsHTML = '<option value="">Select Design...</option>' +
            Object.keys(db.bom).sort().map(code => `<option value="${code}">${code}</option>`).join('');
        bomEditorSelect.innerHTML = optionsHTML;
        bomCloneSelect.innerHTML = '<option value="">Clone Recipe From...</option>' +
            Object.keys(db.bom).sort().map(code => `<option value="${code}">${code}</option>`).join('');
    }

    bomEditorSelect?.addEventListener('change', (e) => {
        if (bomMode === 'edit') {
            if (e.target.value) btnDeleteDesign.classList.remove('hidden');
            else btnDeleteDesign.classList.add('hidden');
            renderBomRecipeFields(e.target.value);
        }
    });

    bomCloneSelect?.addEventListener('change', (e) => {
        if (bomMode === 'create') renderBomRecipeFields(e.target.value);
    });

    function renderBomRecipeFields(code) {
        bomEditorFields.innerHTML = '';
        if (!code || !db.bom[code]) return;

        const sourceBom = db.bom[code];

        bomEditorFields.innerHTML += `
            <div class="glass-panel p-3 rounded-xl flex items-center justify-between gap-3 border border-luxe/50 mb-3 bg-luxe/5">
                <div class="flex-1 text-luxe text-xs uppercase tracking-widest font-bold">Base Selling Price</div>
                <div class="w-24 shrink-0">
                    <input type="number" step="0.01" id="bom-base-price-input" value="${parseFloat(sourceBom.Base_Selling_Price) || 0}" class="w-full bg-black/40 border border-luxe/30 rounded-lg text-white text-center py-2 text-sm focus:border-luxe outline-none">
                </div>
            </div>`;

        // Extract all dynamic component columns from the BOM database structural headers
        const sampleBom = db.bom[Object.keys(db.bom)[0]] || {};
        const prefixes = Object.keys(sampleBom).filter(k => k.endsWith('_ID') && k !== 'Design_Code').map(k => k.slice(0, -3));

        prefixes.forEach(prefix => {
            const currentId = sourceBom[prefix + '_ID'] || 'NONE';
            const currentQty = parseFloat(sourceBom[prefix + '_Qty']) || 0;

            let materialOptions = `<option value="NONE">None</option>`;
            Object.entries(db.materials).forEach(([matId, mat]) => {
                const selected = (currentId === matId) ? 'selected' : '';
                materialOptions += `<option value="${matId}" ${selected}>${mat.desc} - RM${mat.costRM.toFixed(2)}</option>`;
            });

            bomEditorFields.innerHTML += `
                <div class="glass-panel p-3 rounded-xl flex flex-col gap-2">
                    <div class="text-luxe text-[10px] uppercase tracking-widest">${prefix} Component</div>
                    <div class="flex gap-2">
                        <select id="select-${prefix}" data-bom-id-key="${prefix + '_ID'}" class="bom-field-select flex-1 bg-black/40 border border-white/10 rounded-lg text-white px-2 py-2 text-sm focus:border-luxe outline-none truncate">
                            ${materialOptions}
                        </select>
                        <button type="button" class="btn-quick-add-mat bg-white/10 text-white/70 hover:bg-luxe hover:text-ink px-3 rounded-lg transition tap-none font-bold" data-prefix="${prefix}">+</button>
                        <input type="number" step="0.01" placeholder="Qty" data-bom-qty-key="${prefix + '_Qty'}" value="${currentQty > 0 ? currentQty : ''}" class="bom-field-input w-20 bg-black/40 border border-white/10 rounded-lg text-white text-center py-2 text-sm focus:border-luxe outline-none">
                    </div>
                </div>`;
        });

        bomEditorFields.innerHTML += `
            <div class="glass-panel p-3 rounded-xl flex items-center justify-between gap-3 border border-luxe/30 mt-2">
                <div class="flex-1 text-luxe text-xs uppercase tracking-widest">Direct Labor (RM)</div>
                <div class="w-24 shrink-0">
                    <input type="number" step="0.01" id="bom-labor-input" value="${parseFloat(sourceBom.Direct_Labor_RM) || 0}" class="w-full bg-black/40 border border-white/10 rounded-lg text-white text-center py-2 text-sm focus:border-luxe outline-none">
                </div>
            </div>`;

        bomEditorFields.innerHTML += `
            <div id="recipe-sandbox-card" class="glass-panel p-4 rounded-xl border border-white/20 mt-4 bg-ink shadow-soft flex flex-col gap-2 transition-all">
                <div class="flex justify-between items-center border-b border-white/10 pb-2 mb-1">
                    <span class="text-white/70 text-xs uppercase tracking-widest">Est. Unit Cost (Materials + OPEX)</span>
                    <span id="sandbox-unit-cost" class="text-white font-medium text-sm">RM 0.00</span>
                </div>
                <div class="flex justify-between items-center">
                    <span class="text-luxe text-xs uppercase tracking-widest font-bold">Contribution Margin</span>
                    <span id="sandbox-margin" class="font-display text-xl text-luxe">0.00%</span>
                </div>
            </div>`;

        // Bind Quick-Add Modal Triggers (after all innerHTML writes)
        document.querySelectorAll('.btn-quick-add-mat').forEach(btn => {
            btn.addEventListener('click', (e) => {
                openQuickAddModal(e.target.dataset.prefix);
            });
        });

        const updateSandbox = () => {
            const currentPrice = parseFloat(document.getElementById('bom-base-price-input').value) || 0;
            const labor = parseFloat(document.getElementById('bom-labor-input').value) || 0;
            
            let matCost = 0;
            document.querySelectorAll('.bom-field-select').forEach(sel => {
                const id = sel.value;
                if (id !== 'NONE' && db.materials[id]) {
                    const prefix = sel.dataset.bomIdKey.slice(0, -3);
                    const qtyInput = document.querySelector(`input[data-bom-qty-key="${prefix}_Qty"]`);
                    const qty = qtyInput ? (parseFloat(qtyInput.value) || 0) : 0;
                    matCost += (db.materials[id].costRM * qty);
                }
            });

            const metrics = calculateUnitMargin(code, currentPrice, { matCost, labor });
            
            document.getElementById('sandbox-unit-cost').textContent = `RM ${metrics.totalUnitCost.toFixed(2)}`;
            const marginEl = document.getElementById('sandbox-margin');
            marginEl.textContent = `${metrics.marginRM >= 0 ? '+' : ''}RM ${metrics.marginRM.toFixed(2)} (${metrics.marginPct.toFixed(1)}%)`;
            marginEl.className = `font-display text-xl sm:text-2xl ${metrics.marginPct >= 0 ? 'text-luxe' : 'text-red-400'}`;
        };

        // Attach to all inputs for true live-simulation
        document.getElementById('bom-base-price-input').addEventListener('input', updateSandbox);
        document.getElementById('bom-labor-input').addEventListener('input', updateSandbox);
        document.querySelectorAll('.bom-field-input').forEach(el => el.addEventListener('input', updateSandbox));
        document.querySelectorAll('.bom-field-select').forEach(el => el.addEventListener('change', updateSandbox));

        updateSandbox(); // Run once immediately
    }

    btnSaveBomRecipe?.addEventListener('click', async () => {
        const design = bomMode === 'edit' ? bomEditorSelect.value : bomNewDesignCode.value.trim().toUpperCase();
        if (!design) return alert('Please provide or select a Design Code.');

        if (bomMode === 'create' && db.bom[design]) {
            return alert('This Design Code already exists. Please use Edit mode or choose a new code.');
        }

        const recipeFields = {};
        document.querySelectorAll('.bom-field-select').forEach(sel => { recipeFields[sel.dataset.bomIdKey] = sel.value; });
        document.querySelectorAll('.bom-field-input').forEach(inp => { recipeFields[inp.dataset.bomQtyKey] = parseFloat(inp.value) || 0; });
        recipeFields['Direct_Labor_RM'] = parseFloat(document.getElementById('bom-labor-input').value) || 0;
        recipeFields['Base_Selling_Price'] = parseFloat(document.getElementById('bom-base-price-input').value) || 0;

        btnSaveBomRecipe.textContent = 'SAVING...';
        btnSaveBomRecipe.disabled = true;
        try {
            await postManagerAction('save_single_recipe', { design, recipeFields });
            await fetchData();
            alert(`Recipe for ${design} saved successfully.`);
            if (bomMode === 'create') {
                bomNewDesignCode.value = '';
                populateBomDropdown();
                document.getElementById('mode-edit-design').click();
                bomEditorSelect.value = design;
                renderBomRecipeFields(design);
                btnDeleteDesign.classList.remove('hidden');
            }
        } catch (err) { alert('Error: ' + err.message); }
        btnSaveBomRecipe.textContent = 'Save Recipe';
        btnSaveBomRecipe.disabled = false;
    });

    btnDeleteDesign?.addEventListener('click', async () => {
        const design = bomEditorSelect.value;
        if (!design) return;
        if (!confirm(`Are you sure you want to permanently delete design ${design} from the BOM Master?`)) return;

        btnDeleteDesign.textContent = '...';
        btnDeleteDesign.disabled = true;
        try {
            await postManagerAction('delete_design', { designCode: design });
            await fetchData();
            alert(`${design} deleted successfully.`);
            bomEditorFields.innerHTML = '';
            populateBomDropdown();
            btnDeleteDesign.classList.add('hidden');
        } catch (err) { alert('Error: ' + err.message); }
        btnDeleteDesign.textContent = 'Delete';
        btnDeleteDesign.disabled = false;
    });

    // --- INLINE QUICK-ADD MATERIAL LOGIC ---
    const quickAddModal = document.getElementById('quick-add-modal');
    const quickAddModalInner = document.getElementById('quick-add-modal-inner');

    function openQuickAddModal(prefix) {
        document.getElementById('quick-add-category').textContent = prefix;
        document.getElementById('quick-add-prefix').value = prefix;
        
        const selectEl = document.getElementById(`select-${prefix}`);
        const selectedId = selectEl ? selectEl.value : 'NONE';
        
        if (selectedId !== 'NONE' && db.materials[selectedId]) {
            const mat = db.materials[selectedId];
            document.getElementById('quick-add-id').value = selectedId + '-NEW';
            document.getElementById('quick-add-desc').value = mat.desc + ' (Copy)';
            document.getElementById('quick-add-unit').value = mat.unit;
            document.getElementById('quick-add-currency').value = mat.currency || 'RM';
            document.getElementById('quick-add-price').value = mat.origCost;
        } else {
            document.getElementById('quick-add-id').value = '';
            document.getElementById('quick-add-desc').value = '';
            document.getElementById('quick-add-unit').value = prefix.toLowerCase() === 'fabric' ? 'Meter' : 'Piece';
            document.getElementById('quick-add-currency').value = 'RM';
            document.getElementById('quick-add-price').value = '';
        }
        
        quickAddModal.classList.remove('hidden');
        setTimeout(() => {
            quickAddModal.classList.remove('opacity-0');
            quickAddModalInner.classList.remove('scale-95');
        }, 10);
    }

    function closeQuickAddModal() {
        quickAddModal.classList.add('opacity-0');
        quickAddModalInner.classList.add('scale-95');
        setTimeout(() => quickAddModal.classList.add('hidden'), 300);
    }

    document.getElementById('btn-close-quick-add')?.addEventListener('click', closeQuickAddModal);

    document.getElementById('btn-save-quick-add')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-save-quick-add');
        const prefix = document.getElementById('quick-add-prefix').value;
        const Item_ID = document.getElementById('quick-add-id').value.trim().toUpperCase();
        const Description = document.getElementById('quick-add-desc').value.trim();
        const Unit_Type = document.getElementById('quick-add-unit').value.trim();
        const Currency = document.getElementById('quick-add-currency').value;
        const Original_Cost = parseFloat(document.getElementById('quick-add-price').value) || 0;

        if (!Item_ID || !Description) return alert('Item ID and Description are required.');

        btn.disabled = true;
        btn.textContent = 'SAVING...';

        try {
            await postManagerAction('add_raw_material', {
                item: { Item_ID, Category: prefix, Description, Unit_Type, Currency, Original_Cost }
            });
            await fetchData();
            alert('Material catalog updated successfully.');
            closeQuickAddModal();

            const selectEl = document.getElementById(`select-${prefix}`);
            if (selectEl) {
                const newOption = document.createElement('option');
                newOption.value = Item_ID;
                const costRM = Currency === 'CNY' ? Original_Cost * (db.config['Exchange_Rate_CNY_RM'] || 0.6001) : Original_Cost;
                newOption.text = `${Description} - RM${costRM.toFixed(2)}`;
                selectEl.appendChild(newOption);
                selectEl.value = Item_ID;
            }
        } catch (err) {
            alert('Error: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Material';
        }
    });

    // --- AI CHAT INTERFACE & PAYLOAD PIPELINE ---
    const chatLog = document.getElementById('ai-chat-log');
    const chatInput = document.getElementById('ai-chat-input');
    const btnSendAiMessage = document.getElementById('btn-send-ai-message');

    function appendChatBubble(role, text) {
        const div = document.createElement('div');
        div.className = `glass-panel p-4 rounded-xl border max-w-[85%] mt-2 flex flex-col gap-1 ${role === 'user' ? 'self-end bg-white/5 border-white/10' : 'self-start border-luxe/20 bg-ink/30'}`;
        div.innerHTML = `
            <p class="text-[9px] uppercase tracking-widest font-semibold ${role === 'user' ? 'text-white/40 text-right' : 'text-luxe'}">${role === 'user' ? 'You' : 'Arabista Brain v4.0'}</p>
            <p class="text-white/80 text-xs leading-relaxed ${role === 'user' ? 'text-right' : ''} whitespace-pre-wrap">${text}</p>
        `;
        chatLog.appendChild(div);
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    btnSendAiMessage?.addEventListener('click', async () => {
        const prompt = chatInput.value.trim();
        const files = aiChatFileInput.files;

        if (!prompt && (!files || files.length === 0)) return;

        btnSendAiMessage.disabled = true;
        btnSendAiMessage.textContent = '...';

        appendChatBubble('user', prompt || '[Attached Document / Image]');

        // Show Typing Indicator
        const typingId = 'typing-' + Date.now();
        const typingDiv = document.createElement('div');
        typingDiv.id = typingId;
        typingDiv.className = `glass-panel p-4 rounded-xl border border-luxe/20 max-w-[85%] mt-2 self-start bg-ink/30`;
        typingDiv.innerHTML = `<p class="text-luxe text-[9px] uppercase tracking-widest font-semibold mb-1">Arabista Brain v4.0</p><p class="text-white/80 text-xs typing-dots">Thinking</p>`;
        chatLog.appendChild(typingDiv);
        chatLog.scrollTop = chatLog.scrollHeight;

        let imagesArray = [];
        if (files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                const reader = new FileReader();
                const base64 = await new Promise((resolve) => {
                    reader.onload = (e) => resolve(e.target.result.split(',')[1]);
                    reader.readAsDataURL(files[i]);
                });
                imagesArray.push({ mimeType: files[i].type, data: base64 });
            }
        }

        const currentMonth = document.getElementById('plan-month-input').value;
        const currentPlans = db.plans.filter(p => p.Planned_Qty > 0);

        const contextPayload = {
            plans: currentPlans,
            config: db.config
        };

        try {
            const res = await postManagerAction('ai_copilot_request', {
                prompt: prompt,
                images: imagesArray,
                context: contextPayload,
                month: currentMonth
            }, { skipLoader: true });

            document.getElementById(typingId)?.remove();
            appendChatBubble('ai', res.data.chat_response);

            // Instantly refresh the local state to pull down the newly updated actuals
            await fetchData();

            // Cleanup UI
            chatInput.value = '';
            document.getElementById('btn-remove-ai-file').click();

        } catch (err) {
            document.getElementById(typingId)?.remove();
            appendChatBubble('ai', `System Diagnostic Error: ${err.message}`);
        } finally {
            btnSendAiMessage.disabled = false;
            btnSendAiMessage.textContent = 'Send';
        }
    });

    chatInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            btnSendAiMessage.click();
        }
    });

    document.getElementById('btn-generate-autopsy')?.addEventListener('click', async () => {
        const currentMonth = monthInput.value;
        const btn = document.getElementById('btn-generate-autopsy');
        btn.disabled = true;
        btn.innerHTML = '<span class="inline-block w-2 h-2 rounded-full bg-luxe animate-ping mr-1"></span> Analyzing...';

        const context = {
            plans: db.plans.filter(p => p.Planned_Qty > 0),
            macro: db.actualsMacro.find(m => String(m.Plan_Month).substring(0, 7) === currentMonth),
            micro: db.actualsMicro.filter(a => String(a.Date).substring(0, 7) === currentMonth),
            extra: db.currentExtraCosts
        };

        try {
            await postManagerAction('generate_cfo_autopsy', { month: currentMonth, financialContext: context });
            await fetchData();
            if (pillarAnalysis && !pillarAnalysis.classList.contains('hidden')) renderAnalysisPillar();
        } catch (err) { alert('Autopsy failed: ' + err.message); }
        finally {
            btn.disabled = false;
            btn.innerHTML = 'Generate CFO Report';
        }
    });

})();
