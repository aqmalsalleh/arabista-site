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

    btnOpenPlanner.addEventListener('click', openPlanner);
    closePlannerBtn.addEventListener('click', closePlanner);
    plannerOverlay.addEventListener('click', closePlanner);
    savePlannerBtn.addEventListener('click', () => {
        // Sync active inputs back to db.plans array
        const activeInputs = plannerListContainer.querySelectorAll('.planner-qty');
        activeInputs.forEach(inp => {
            const design = inp.dataset.design;
            const qty = parseInt(inp.value) || 0;
            const plan = db.plans.find(p => p.Design_Code === design);
            if (plan) plan.Planned_Qty = qty;
        });
        
        renderActivePlans();
        calculateEngine();
        closePlanner();
    });

    // State
    let sessionPin = '';
    let db = { config: {}, materials: {}, bom: {}, plans: [] };

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
            renderPlannerDrawer(); // Render the drawer checkboxes
            calculateEngine(); // Initial zero-state calculation
        } catch (err) {
            alert('Failed to load database: ' + err.message);
        }
    }

    function parseDatabase(rawData) {
        // 1. Map Config to Key/Value dict
        rawData.config.forEach(c => {
            db.config[c.Variable_Name] = parseFloat(c.Value_RM) || 0;
        });

        const exRate = db.config['Exchange_Rate_CNY_RM'] || 0.6001;

        // 2. Map Materials and enforce RM pricing (handles both CNY and RM raw data)
        rawData.materials.forEach(m => {
            let costRM = 0;
            if (m.Unit_Cost_CNY) {
                costRM = parseFloat(m.Unit_Cost_CNY) * exRate;
            } else if (m.Unit_Cost_RM) {
                costRM = parseFloat(m.Unit_Cost_RM);
            }
            db.materials[m.Item_ID] = {
                category: m.Category,
                desc: m.Description,
                unit: m.Unit_Type,
                costRM: costRM
            };
        });

        // 3. Map BOM by Design_Code
        rawData.bom.forEach(b => {
            db.bom[b.Design_Code] = b;
        });

        // 4. Store Plans and force default Qty to 0
        db.plans = rawData.plans.map(p => {
            p.Planned_Qty = 0;
            return p;
        });
        
        if (db.plans.length > 0 && monthInput) {
            let dStr = String(db.plans[0].Plan_Month).trim();
            if (dStr.includes('T')) dStr = dStr.split('T')[0].substring(0, 7);
            monthInput.value = dStr;
        }
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
                    <div class="text-white/40 text-[10px] uppercase tracking-widest">RM ${parseFloat(plan.Target_Selling_Price).toFixed(2)}</div>
                </div>
                <div class="w-24 opacity-50 pointer-events-none transition-opacity qty-wrapper">
                    <input type="number" min="0" data-design="${plan.Design_Code}" value="0" class="planner-qty w-full bg-black/40 border border-white/10 rounded-lg text-white text-center py-2 focus:border-luxe outline-none transition-colors">
                </div>
            `;
            
            // Toggle opacity/pointer events of the input field based on checkbox
            const cb = div.querySelector('.design-checkbox');
            const wrap = div.querySelector('.qty-wrapper');
            const inp = div.querySelector('.planner-qty');
            
            cb.addEventListener('change', (e) => {
                if(e.target.checked) {
                    wrap.classList.remove('opacity-50', 'pointer-events-none');
                    inp.value = ''; // Blank out for immediate typing
                    inp.focus(); 
                } else {
                    wrap.classList.add('opacity-50', 'pointer-events-none');
                    inp.value = 0;
                }
            });
            
            plannerListContainer.appendChild(div);
        });

        // Search Filter Logic
        if (plannerSearch) {
            plannerSearch.addEventListener('input', (e) => {
                const term = e.target.value.toLowerCase();
                const cards = plannerListContainer.children;
                Array.from(cards).forEach(card => {
                    const design = card.querySelector('.design-checkbox').dataset.design.toLowerCase();
                    if (design.includes(term)) {
                        card.classList.remove('hidden');
                        card.classList.add('flex');
                    } else {
                        card.classList.add('hidden');
                        card.classList.remove('flex');
                    }
                });
            });
        }
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
        btnModifyPlans.addEventListener('click', openPlanner);
    }

    // --- FINANCIAL & PROCUREMENT ENGINE ---
    function calculateEngine() {
        let totalRevenue = 0;
        let totalCogs = 0;
        let totalVariableCost = 0; // COGS + Tailoring + TikTok + Marketing
        
        let reqs = {}; // To aggregate raw materials

        db.plans.forEach(plan => {
            const qty = parseInt(plan.Planned_Qty) || 0;
            if (qty <= 0) return;

            const design = plan.Design_Code;
            const price = parseFloat(plan.Target_Selling_Price);
            const bom = db.bom[design];
            if (!bom) return;

            // Revenue
            totalRevenue += (price * qty);

            // Labor & Variable Overheads
            const tailoring = parseFloat(bom.Direct_Labor_RM) || 10;
            const tiktokFee = price * (db.config['TikTok_Fee_Pct'] || 0.20);
            const marketing = db.config['Marketing_Per_Unit'] || 5;
            totalVariableCost += ((tailoring + tiktokFee + marketing) * qty);

            // BOM Explosion (Aggregating Procurement)
            const addReq = (id, amount) => {
                if (!id || id === 'NONE' || amount <= 0) return;
                if (!reqs[id]) reqs[id] = 0;
                reqs[id] += (amount * qty);
            };

            addReq(bom.Fabric_ID, parseFloat(bom.Fabric_Qty));
            addReq(bom.Shawl_ID, parseFloat(bom.Shawl_Qty));
            addReq(bom.Lace_ID, parseFloat(bom.Lace_Qty));
            addReq(bom.Box_ID, parseFloat(bom.Box_Qty));
            addReq(bom.Bubble_ID, parseFloat(bom.Bubble_Qty));
            addReq(bom.ZipLock_ID, parseFloat(bom.ZipLock_Qty));
            addReq(bom.Accessory_ID, parseFloat(bom.Accessory_Qty));
        });

        // Calculate COGS and render procurement list
        renderProcurement(reqs);

        // Calculate Totals for Top Bar
        for (const [id, qty] of Object.entries(reqs)) {
            const mat = db.materials[id];
            if (mat) totalCogs += (mat.costRM * qty);
        }

        totalVariableCost += totalCogs;

        // Fixed OPEX
        const fixedOpex = (db.config['Factory_Rental'] || 0) + 
                          (db.config['Staff_Hostel'] || 0) + 
                          (db.config['Helper_Salary'] || 0) + 
                          (db.config['Utilities'] || 0);

        const netProfit = totalRevenue - totalVariableCost - fixedOpex;
        const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

        // Update DOM
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

})();