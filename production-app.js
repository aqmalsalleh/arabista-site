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
    
    const plansGrid = document.getElementById('plans-grid');
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

    const qtyModal = document.getElementById('qty-modal');
    const closeQtyModalBtn = document.getElementById('close-qty-modal');
    const modalDesignTitle = document.getElementById('modal-design-title');
    const modalDesignPrice = document.getElementById('modal-design-price');
    const modalQtyInput = document.getElementById('modal-qty-input');
    const modalQtyDec = document.getElementById('modal-qty-dec');
    const modalQtyInc = document.getElementById('modal-qty-inc');
    const saveQtyBtn = document.getElementById('save-qty-btn');

    let activeModalDesign = null;

    // Mobile Tabs Logic
    if (tabPlans && tabLedger) {
        tabPlans.addEventListener('click', () => {
            tabPlans.classList.replace('text-white/40', 'text-luxe');
            tabPlans.classList.replace('border-transparent', 'border-luxe');
            tabLedger.classList.replace('text-luxe', 'text-white/40');
            tabLedger.classList.replace('border-luxe', 'border-transparent');
            
            panelPlans.classList.replace('opacity-0', 'opacity-100');
            panelPlans.classList.replace('pointer-events-none', 'pointer-events-auto');
            panelPlans.classList.replace('z-0', 'z-10');
            
            panelLedger.classList.replace('opacity-100', 'opacity-0');
            panelLedger.classList.replace('pointer-events-auto', 'pointer-events-none');
            panelLedger.classList.replace('z-10', 'z-0');
        });

        tabLedger.addEventListener('click', () => {
            tabLedger.classList.replace('text-white/40', 'text-luxe');
            tabLedger.classList.replace('border-transparent', 'border-luxe');
            tabPlans.classList.replace('text-luxe', 'text-white/40');
            tabPlans.classList.replace('border-luxe', 'border-transparent');
            
            panelLedger.classList.replace('opacity-0', 'opacity-100');
            panelLedger.classList.replace('pointer-events-none', 'pointer-events-auto');
            panelLedger.classList.replace('z-0', 'z-10');
            
            panelPlans.classList.replace('opacity-100', 'opacity-0');
            panelPlans.classList.replace('pointer-events-auto', 'pointer-events-none');
            panelPlans.classList.replace('z-10', 'z-0');
        });
    }

    // Modal Logic
    function openQtyModal(design, price, currentQty) {
        activeModalDesign = design;
        modalDesignTitle.textContent = design;
        modalDesignPrice.textContent = `RM ${parseFloat(price).toFixed(2)}`;
        modalQtyInput.value = currentQty;
        
        qtyModal.classList.remove('hidden');
        setTimeout(() => {
            qtyModal.classList.replace('opacity-0', 'opacity-100');
            qtyModal.querySelector('.glass-panel').classList.replace('scale-95', 'scale-100');
        }, 10);
    }

    function closeQtyModal() {
        qtyModal.classList.replace('opacity-100', 'opacity-0');
        qtyModal.querySelector('.glass-panel').classList.replace('scale-100', 'scale-95');
        setTimeout(() => qtyModal.classList.add('hidden'), 300);
        activeModalDesign = null;
    }

    closeQtyModalBtn.addEventListener('click', closeQtyModal);
    modalQtyDec.addEventListener('click', () => { modalQtyInput.value = Math.max(0, parseInt(modalQtyInput.value || 0) - 1); });
    modalQtyInc.addEventListener('click', () => { modalQtyInput.value = parseInt(modalQtyInput.value || 0) + 1; });
    saveQtyBtn.addEventListener('click', () => {
        if (!activeModalDesign) return;
        const newQty = parseInt(modalQtyInput.value || 0);
        
        // Update DB Array
        const plan = db.plans.find(p => p.Design_Code === activeModalDesign);
        if (plan) plan.Planned_Qty = newQty;
        
        // Update UI Card
        const display = document.getElementById(`qty-display-${activeModalDesign}`);
        if (display) {
            display.textContent = newQty > 0 ? `${newQty} units` : 'Set Quantity';
            display.className = newQty > 0 ? 'text-luxe font-medium text-sm mt-1' : 'text-white/30 text-xs mt-1 uppercase tracking-widest';
        }
        
        calculateEngine();
        closeQtyModal();
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
            renderPlans();
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

        // 4. Store Plans
        db.plans = rawData.plans;
        if (db.plans.length > 0 && monthInput) {
            let dStr = String(db.plans[0].Plan_Month).trim();
            if (dStr.includes('T')) dStr = dStr.split('T')[0].substring(0, 7);
            monthInput.value = dStr;
        }
    }

    // --- UI RENDERING ---
    function renderPlans() {
        plansGrid.innerHTML = '';
        db.plans.forEach(plan => {
            const qty = parseInt(plan.Planned_Qty) || 0;
            const qtyText = qty > 0 ? `${qty} units` : 'Set Quantity';
            const qtyClass = qty > 0 ? 'text-luxe font-medium text-sm mt-1' : 'text-white/30 text-xs mt-1 uppercase tracking-widest';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'glass-panel p-5 rounded-2xl flex flex-col items-start w-full text-left hover:bg-white/5 transition-colors tap-none group';
            btn.innerHTML = `
                <div class="w-full flex justify-between items-center mb-3">
                    <div class="text-white font-display text-xl sm:text-2xl">${plan.Design_Code}</div>
                    <div class="w-8 h-8 rounded-full bg-white/5 group-hover:bg-luxe flex items-center justify-center transition-colors">
                        <svg class="w-4 h-4 text-white/50 group-hover:text-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                    </div>
                </div>
                <div class="text-white/40 text-[10px] uppercase tracking-widest border-t border-white/10 pt-2 w-full">RM ${parseFloat(plan.Target_Selling_Price).toFixed(2)}</div>
                <div id="qty-display-${plan.Design_Code}" class="${qtyClass}">${qtyText}</div>
            `;
            btn.addEventListener('click', () => openQtyModal(plan.Design_Code, plan.Target_Selling_Price, parseInt(plan.Planned_Qty) || 0));
            plansGrid.appendChild(btn);
        });
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