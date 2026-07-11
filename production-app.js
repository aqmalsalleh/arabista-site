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
    const monthLabel = document.getElementById('plan-month-label');

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
        if (db.plans.length > 0) monthLabel.textContent = db.plans[0].Plan_Month;
    }

    // --- UI RENDERING ---
    function renderPlans() {
        plansGrid.innerHTML = '';
        db.plans.forEach(plan => {
            const div = document.createElement('div');
            div.className = 'glass-panel p-4 rounded-xl flex items-center justify-between';
            div.innerHTML = `
                <div>
                    <div class="text-white font-medium text-lg">${plan.Design_Code}</div>
                    <div class="text-white/40 text-[10px] uppercase tracking-widest">RM ${parseFloat(plan.Target_Selling_Price).toFixed(2)}</div>
                </div>
                <div class="w-24">
                    <input type="number" min="0" data-design="${plan.Design_Code}" data-price="${plan.Target_Selling_Price}" value="${plan.Planned_Qty || 0}" class="qty-input w-full bg-black/40 border border-white/10 rounded-lg text-white text-center py-2 text-lg focus:border-luxe outline-none transition-colors">
                </div>
            `;
            plansGrid.appendChild(div);
        });

        document.querySelectorAll('.qty-input').forEach(inp => {
            inp.addEventListener('input', calculateEngine);
        });
    }

    // --- FINANCIAL & PROCUREMENT ENGINE ---
    function calculateEngine() {
        let totalRevenue = 0;
        let totalCogs = 0;
        let totalVariableCost = 0; // COGS + Tailoring + TikTok + Marketing
        
        let reqs = {}; // To aggregate raw materials

        const inputs = document.querySelectorAll('.qty-input');
        inputs.forEach(inp => {
            const qty = parseInt(inp.value) || 0;
            if (qty <= 0) return;

            const design = inp.dataset.design;
            const price = parseFloat(inp.dataset.price);
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

        // Update DOM
        metricRevenue.textContent = `RM ${totalRevenue.toFixed(2)}`;
        metricCogs.textContent = `RM ${totalCogs.toFixed(2)}`;
        metricProfit.textContent = `RM ${netProfit.toFixed(2)}`;
        metricProfit.className = netProfit >= 0 ? 'font-display text-3xl text-luxe' : 'font-display text-3xl text-red-400';
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