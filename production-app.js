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
    
    const procurementList = document.getElementById('procurement-list');
    const metricRevenue = document.getElementById('metric-revenue');
    const metricCogs = document.getElementById('metric-cogs');
    const metricProfit = document.getElementById('metric-profit');
    const metricMargin = document.getElementById('metric-margin');
    const monthInput = document.getElementById('plan-month-input');
    
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

    // Mobile Tabs Logic (Using hidden/flex to fix absolute positioning issues)
    if (tabPlans && tabLedger) {
        tabPlans.addEventListener('click', () => {
            tabPlans.classList.replace('text-white/40', 'text-luxe');
            tabPlans.classList.replace('border-transparent', 'border-luxe');
            tabLedger.classList.replace('text-luxe', 'text-white/40');
            tabLedger.classList.replace('border-luxe', 'border-transparent');
            
            panelPlans.classList.remove('hidden');
            panelLedger.classList.add('hidden');
            panelLedger.classList.remove('block');
        });

        tabLedger.addEventListener('click', () => {
            tabLedger.classList.replace('text-white/40', 'text-luxe');
            tabLedger.classList.replace('border-transparent', 'border-luxe');
            tabPlans.classList.replace('text-luxe', 'text-white/40');
            tabPlans.classList.replace('border-luxe', 'border-transparent');
            
            panelLedger.classList.remove('hidden');
            panelLedger.classList.add('block');
            panelPlans.classList.add('hidden');
        });
    }

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
        
        renderActivePlans();
        calculateEngine();
        closePlanner();
    });

    // State
    let sessionPin = '';
    let db = { config: {}, configRaw: [], materials: {}, bom: {}, plans: [], allHistoricalPlans: [], basePrices: {}, snapshots: [], currentMacroSnapshot: null };

    // --- AUTHENTICATION ---
    btnLogin.addEventListener('click', authenticate);
    pinInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') authenticate(); });
    btnLogout.addEventListener('click', () => location.reload());

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
        try {
            const res = await fetch(`${ctx.apiUrl}?action=get_production_data&pin=${sessionPin}`);
            const json = await res.json();
            if (json.status !== 'success') throw new Error(json.message);
            
            parseDatabase(json.data);
            // loadMonthState (via parseDatabase) handles drawer + metrics render
        } catch (err) {
            alert('Failed to load database: ' + err.message);
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

        // 4. Store Historical Plans and extract Base Prices
        db.allHistoricalPlans = rawData.plans;
        db.snapshots = rawData.snapshots || [];
        db.basePrices = {};
        
        rawData.plans.forEach(p => {
            db.basePrices[p.Design_Code] = parseFloat(p.Target_Selling_Price) || 0;
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

        renderPlannerDrawer();
        renderActivePlans();
        calculateEngine();
    }

    if (monthInput) {
        monthInput.addEventListener('change', (e) => {
            loadMonthState(e.target.value);
        });
    }

    const btnSaveMonthPlan = document.getElementById('btn-save-month-plan');
    if (btnSaveMonthPlan) {
        btnSaveMonthPlan.addEventListener('click', async () => {
            const currentMonth = monthInput.value;
            if (!currentMonth) return alert("Please select a month first.");
            
            btnSaveMonthPlan.disabled = true;
            btnSaveMonthPlan.textContent = 'SAVING...';
            
            try {
                // Assemble locked arrays
                const payloadPlans = db.plans.map(p => ({
                    Design_Code: p.Design_Code,
                    Planned_Qty: p.Planned_Qty,
                    Target_Selling_Price: p.Target_Selling_Price,
                    Locked_Material_COGS_RM: p.Locked_Material_COGS_RM !== undefined && p.Locked_Material_COGS_RM !== "" ? p.Locked_Material_COGS_RM : p.Live_Material_COGS_RM,
                    Locked_Direct_Labor_RM: p.Locked_Direct_Labor_RM !== undefined && p.Locked_Direct_Labor_RM !== "" ? p.Locked_Direct_Labor_RM : p.Live_Direct_Labor_RM,
                    Locked_Var_Overhead_RM: p.Locked_Var_Overhead_RM !== undefined && p.Locked_Var_Overhead_RM !== "" ? p.Locked_Var_Overhead_RM : p.Live_Var_Overhead_RM
                }));

                const res = await fetch(`${ctx.apiUrl}?action=save_monthly_plan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `payload=${encodeURIComponent(JSON.stringify({ 
                        pin: sessionPin, 
                        month: currentMonth, 
                        plans: payloadPlans, 
                        snapshot: db.currentMacroSnapshot 
                    }))}`
                });
                const json = await res.json();
                if (json.status !== 'success') throw new Error(json.message || 'Request failed');
                await fetchData();
                alert(`Production plan for ${currentMonth} synchronized to database.`);
            } catch (err) {
                alert('Save failed: ' + err.message);
            } finally {
                btnSaveMonthPlan.disabled = false;
                btnSaveMonthPlan.textContent = 'Save Month to Database';
            }
        });
    }

    const btnClearMonthPlan = document.getElementById('btn-clear-month-plan');
    if (btnClearMonthPlan) {
        btnClearMonthPlan.addEventListener('click', async () => {
            const currentMonth = monthInput.value;
            if (!currentMonth) return;
            if (!confirm(`Are you absolutely sure you want to permanently clear the production plan for ${currentMonth}?`)) return;

            btnClearMonthPlan.disabled = true;
            btnClearMonthPlan.textContent = 'DELETING...';

            try {
                const res = await fetch(`${ctx.apiUrl}?action=delete_monthly_plan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `payload=${encodeURIComponent(JSON.stringify({ pin: sessionPin, month: currentMonth }))}`
                });
                const json = await res.json();
                if (json.status !== 'success') throw new Error(json.message);
                
                await fetchData();
                alert(`All planning data for ${currentMonth} has been cleared.`);
            } catch (err) {
                alert('Deletion failed: ' + err.message);
            } finally {
                btnClearMonthPlan.disabled = false;
                btnClearMonthPlan.textContent = 'Clear Month Plan';
            }
        });
    }

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
                    <div class="w-20">
                        <p class="text-white/40 text-[8px] uppercase tracking-widest mb-1">Price (RM)</p>
                        <input type="number" min="0" step="0.01" value="${plan.Target_Selling_Price}" class="planner-price w-full bg-black/40 border border-white/10 rounded-lg text-white text-center py-2 focus:border-luxe outline-none transition-colors">
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
        const active = db.plans.filter(p => p.Planned_Qty > 0);
        
        if(active.length === 0) {
            plannerHeroCard.classList.remove('hidden');
            plannerHeroCard.classList.add('flex');
            plannerActiveState.classList.add('hidden');
            plannerActiveState.classList.remove('flex');
        } else {
            plannerHeroCard.classList.add('hidden');
            plannerHeroCard.classList.remove('flex');
            plannerActiveState.classList.remove('hidden');
            plannerActiveState.classList.add('flex');
            activeCountDisplay.textContent = active.length;
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
        document.getElementById('btn-open-planner').addEventListener('click', () => {
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

    async function postManagerAction(action, payloadObj) {
        const res = await fetch(`${ctx.apiUrl}?action=${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `payload=${encodeURIComponent(JSON.stringify({ ...payloadObj, pin: sessionPin }))}`
        });
        const json = await res.json();
        if (json.status !== 'success') throw new Error(json.message || 'Request failed');
        return json;
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

    // --- FINANCIAL & PROCUREMENT ENGINE ---
    function calculateEngine() {
        let totalRevenue = 0;
        let totalCogs = 0;
        let totalVariableCost = 0;
        let reqs = {}; 

        // 1. Intelligently sum all Fixed OPEX from the database
        let fixedOpex = 0;
        db.configRaw.forEach(c => {
            if (c.Account_Category === 'Fixed OPEX') fixedOpex += (parseFloat(c.Value_RM) || 0);
        });

        db.plans.forEach(plan => {
            const qty = parseInt(plan.Planned_Qty) || 0;
            if (qty <= 0) return;

            const design = plan.Design_Code;
            const price = parseFloat(plan.Target_Selling_Price) || 0;
            totalRevenue += (price * qty);

            // Routing: If it has frozen history, use it. Otherwise, calculate live.
            if (plan.Locked_Material_COGS_RM !== undefined && plan.Locked_Material_COGS_RM !== "") {
                const matCogs = parseFloat(plan.Locked_Material_COGS_RM) || 0;
                const labor = parseFloat(plan.Locked_Direct_Labor_RM) || 0;
                const overhead = parseFloat(plan.Locked_Var_Overhead_RM) || 0;
                
                totalCogs += (matCogs * qty);
                totalVariableCost += ((matCogs + labor + overhead) * qty);
            } else {
                const bom = db.bom[design];
                if (!bom) return;

                const tailoring = parseFloat(bom.Direct_Labor_RM) || 10;
                
                // 2. Intelligently calculate Variable Selling Overheads
                let dynamicOverhead = 0;
                db.configRaw.forEach(c => {
                    if (c.Account_Category === 'Variable Selling') {
                        const val = parseFloat(c.Value_RM) || 0;
                        if (c.Variable_Name.includes('_Pct')) {
                            dynamicOverhead += (price * val);
                        } else {
                            dynamicOverhead += val;
                        }
                    }
                });
                
                let designMatCogs = 0;

                const addReq = (id, amount) => {
                    if (!id || id === 'NONE' || amount <= 0) return;
                    if (!reqs[id]) reqs[id] = 0;
                    reqs[id] += (amount * qty);
                    const mat = db.materials[id];
                    if (mat) designMatCogs += (mat.costRM * amount);
                };

                Object.keys(bom).forEach(key => {
                    if (!key.endsWith('_ID') || key === 'Design_Code') return;
                    const prefix = key.slice(0, -3);
                    const id = bom[key];
                    if (!id || id === 'NONE') return;
                    const amount = parseFloat(bom[prefix + '_Qty']) || 0;
                    addReq(id, amount);
                });

                totalCogs += (designMatCogs * qty);
                totalVariableCost += ((designMatCogs + tailoring + dynamicOverhead) * qty);

                // Attach live variables for saving
                plan.Live_Material_COGS_RM = designMatCogs;
                plan.Live_Direct_Labor_RM = tailoring;
                plan.Live_Var_Overhead_RM = dynamicOverhead;
            }
        });

        // Store Macro Snapshot
        const netProfit = totalRevenue - totalVariableCost - fixedOpex;
        db.currentMacroSnapshot = {
            Locked_Fixed_OPEX_RM: fixedOpex,
            Total_Revenue_RM: totalRevenue,
            Net_Profit_RM: netProfit
        };

        const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

        renderProcurement(reqs);

        metricRevenue.textContent = `RM ${totalRevenue.toFixed(2)}`;
        metricCogs.textContent = `RM ${totalCogs.toFixed(2)}`;
        
        if (metricMargin) {
            metricMargin.textContent = `${profitMargin.toFixed(2)}%`;
            metricMargin.className = profitMargin >= 0 ? 'font-display text-xl sm:text-2xl text-white' : 'font-display text-xl sm:text-2xl text-red-400';
        }

        metricProfit.textContent = `RM ${netProfit.toFixed(2)}`;
        metricProfit.className = netProfit >= 0 ? 'font-display text-2xl sm:text-3xl text-luxe' : 'font-display text-2xl sm:text-3xl text-red-400';
    }

    function renderProcurement(reqs) {
        // Group materials by category
        const groups = {};
        for (const [id, qty] of Object.entries(reqs)) {
            const mat = db.materials[id];
            if (!mat) continue;
            if (!groups[mat.category]) groups[mat.category] = [];
            
            const costRM = mat.costRM * qty;
            groups[mat.category].push({
                desc: mat.desc,
                qty: qty,
                unit: mat.unit,
                costRM: costRM
            });
        }

        if (Object.keys(groups).length === 0) {
            procurementList.innerHTML = '<div class="text-white/30 text-sm">No production planned.</div>';
            return;
        }

        let html = '';
        for (const [category, items] of Object.entries(groups)) {
            html += `<div class="mb-6"><h3 class="text-luxe text-[10px] uppercase tracking-widest mb-3 border-b border-white/10 pb-2">${category}</h3>`;
            items.forEach(i => {
                html += `
                    <div class="flex justify-between items-center mb-2">
                        <div>
                            <div class="text-white text-sm">${i.desc}</div>
                            <div class="text-white/40 text-xs">${i.qty.toFixed(1)} ${i.unit}</div>
                        </div>
                        <div class="text-white font-medium text-sm">RM ${i.costRM.toFixed(2)}</div>
                    </div>
                `;
            });
            html += `</div>`;
        }
        procurementList.innerHTML = html;
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

        // Bind Quick-Add Modal Triggers (after all innerHTML writes)
        document.querySelectorAll('.btn-quick-add-mat').forEach(btn => {
            btn.addEventListener('click', (e) => {
                openQuickAddModal(e.target.dataset.prefix);
            });
        });
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

})();
