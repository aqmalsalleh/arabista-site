/**
 * ARABISTA BACKEND API (v6.6 - Security & Auth Patch)
 * - Security: Added verifyToken() middleware to prevent IDOR attacks.
 * - Security: hubLogin() now generates and stores a secure UUID session token.
 * - Security: generateAlterationId() upgraded to 8 random characters to prevent brute-forcing.
 */

// --- CONFIGURATION ---
const LALA_BASE_URL = "https://rest.sandbox.lalamove.com"; 
const MARKET = "MY"; 

const AI_CONFIG = {
  META_TOKEN: PropertiesService.getScriptProperties().getProperty('META_TOKEN'),
  PHONE_NUMBER_ID: PropertiesService.getScriptProperties().getProperty('PHONE_NUMBER_ID'),
  WEBHOOK_VERIFY_TOKEN: PropertiesService.getScriptProperties().getProperty('WEBHOOK_VERIFY_TOKEN') || "ARABISTA_SECURE_HOOK_2026",
  GEMINI_API_KEY: PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')
};

// --- SENANGPAY CONFIG ---
// Credentials are stored in Script Properties (Project Settings > Script Properties).
// Required keys: SENANGPAY_SECRET_KEY, SENANGPAY_MERCHANT_ID
function getSenangPayConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    secretKey:  String(props.getProperty('SENANGPAY_SECRET_KEY')  || '').trim(),
    merchantId: String(props.getProperty('SENANGPAY_MERCHANT_ID') || '').trim()
  };
}

/**
 * Generates a SenangPay HMAC-SHA256 hash for a checkout request.
 * String sequence (per Manual Integration API spec):
 *   SecretKey + detail + amount + orderId
 * The resulting byte array is returned as a continuous lowercase hex string.
 *
 * @param {string} orderId  - The Alteration ID (e.g. "ALT-1234")
 * @param {number|string} amount - Payment amount (will be forced to "65.00" format)
 * @param {string} detail   - Order description (e.g. "Arabista Alteration ALT-1234")
 * @returns {string} Lowercase hex hash string
 */
function generateSenangPayHash(orderId, amount, detail) {
  const { secretKey } = getSenangPayConfig();
  if (!secretKey) throw new Error('SENANGPAY_SECRET_KEY is not set in Script Properties.');

  // Strictly enforce 2 decimal places as required by SenangPay (e.g. 65.00, not 65 or 65.5)
  const formattedAmount = parseFloat(amount).toFixed(2);

  // Exact string sequence: SecretKey + Detail + Amount + Order_ID
  const stringToHash = secretKey + detail + formattedAmount + orderId;

  // HMAC-SHA256 keyed with the Secret Key (mirrors PHP: hash_hmac('SHA256', string, secretKey))
  const signatureBytes = Utilities.computeHmacSha256Signature(stringToHash, secretKey);

  // Convert signed byte array to continuous lowercase hex string
  const hash = signatureBytes.reduce(
    (str, byte) => str + (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0'),
    ''
  );

  return hash;
}

/**
 * Handles the asynchronous SenangPay callback webhook (Section 3 of senangpay-rules.md).
 * SenangPay POSTs x-www-form-urlencoded params; this function is invoked from doPost()
 * before any JSON.parse() attempt.
 *
 * Hash verification sequence: SecretKey + status_id + order_id + transaction_id + msg
 * Returns plain text "OK" on success, "FAILED" on any error or hash mismatch.
 *
 * @param {Object} params - e.parameter from the Apps Script POST event
 */
function handleSenangPayWebhook(params) {
  const FAILED = ContentService.createTextOutput("FAILED").setMimeType(ContentService.MimeType.TEXT);
  const OK     = ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);

  try {
    const status_id      = String(params.status_id      || '');
    const order_id       = String(params.order_id       || '');
    const transaction_id = String(params.transaction_id || '');
    const msg            = String(params.msg            || '');
    const incomingHash   = String(params.hash           || '');

    // --- Step 1: Fetch secret key ---
    const { secretKey } = getSenangPayConfig();
    if (!secretKey) {
      Logger.log("SenangPay webhook: SENANGPAY_SECRET_KEY is not configured.");
      return FAILED;
    }

    // --- Step 2: Re-compute HMAC-SHA256 for verification ---
    // Exact sequence per spec: SecretKey + status_id + order_id + transaction_id + msg
    const stringToVerify = secretKey + status_id + order_id + transaction_id + msg;
    const signatureBytes = Utilities.computeHmacSha256Signature(stringToVerify, secretKey);
    const computedHash   = signatureBytes.reduce(
      (str, byte) => str + (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0'),
      ''
    );

    // --- Step 3: Reject tampered requests ---
    if (computedHash !== incomingHash) {
      Logger.log("SenangPay webhook: Hash mismatch for order " + order_id);
      return FAILED;
    }

    // --- Step 4: Only write to DB for successful payments (status_id === "1") ---
    // A failed payment (status_id "0") is acknowledged but not persisted.
    if (status_id !== "1") {
      Logger.log("SenangPay webhook: Payment failed or cancelled for order " + order_id);
      return OK;
    }

    // Ignore success callbacks with no transaction id (avoids marking PAID on sandbox/test noise).
    const txnTrim = String(transaction_id || "").trim();
    if (!txnTrim) {
      Logger.log("SenangPay webhook: status_id=1 but empty transaction_id — not persisting. order=" + order_id);
      return OK;
    }

    // --- Step 5: Update Incoming_Orders sheet ---
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("Incoming_Orders");
    if (!sheet) {
      Logger.log("SenangPay webhook: Incoming_Orders sheet not found.");
      return FAILED;
    }

    const allData = sheet.getDataRange().getValues();

    // --- Step 6: Find the matching order row and write payment data ---
    // Extract base order ID by removing -IN, -OUT, or -PICKUP suffix
    const baseOrderId = order_id.replace(/-(IN|OUT|PICKUP)$/i, '');

    for (let i = 1; i < allData.length; i++) {
      if (String(allData[i][1]).trim() === baseOrderId) { // col 2 = Alteration_ID (0-indexed: 1)
        const rowNum       = i + 1; // getRange is 1-indexed
        const orderStatus  = String(allData[i][13]).trim(); // col 14 = Order_Status

        // Route to outbound payment columns for "Ready for Return" and beyond;
        // otherwise write to inbound columns.
        const outboundPhases = ["Ready for Return", "Outbound Dispatched", "Completed", "Dispatched / Picked Up"];
        const isOutbound     = outboundPhases.includes(orderStatus);

        if (isOutbound) {
          sheet.getRange(rowNum, 29).setValue("PAID"); // Outbound_Payment_Status
          sheet.getRange(rowNum, 30).setValue(txnTrim); // Outbound_SP_Txn
          sheet.getRange(rowNum, 21).setValue("PAID"); // Auto-clear inbound debt
          
          // --- PHASE 4: TRIGGER SELF-PICKUP NOTIFICATIONS ---
          const outboundChoice = String(allData[i][22] || "").trim(); // Col 23
          if (outboundChoice.toLowerCase().includes("pickup") || outboundChoice.toLowerCase().includes("sendiri")) {
             const altId = baseOrderId;
             const custPhoneNum = String(allData[i][5]); // Col 6
             const hubName = String(allData[i][10]); // Col 11
             const trackerUrl = `https://arabistaofficial.com/alteration-tracker-staging.html?id=${altId}`;
             // Get Hub Details for GPS Navigation Link
             let hubPhoneNum = "";
             let hubLat = "";
             let hubLng = "";
             const hubSheet = ss.getSheetByName("Active_Hubs");
             if (hubSheet) {
               const hData = hubSheet.getDataRange().getDisplayValues();
               for (let h = 1; h < hData.length; h++) {
                 if (hData[h][1] === hubName) {
                   hubPhoneNum = hData[h][3];
                   hubLat = hData[h][4];
                   hubLng = hData[h][5];
                   break;
                 }
               }
             }
             
             // Create Google Maps direct route link
             const navLink = (hubLat && hubLng) ? `https://maps.google.com/?q=${hubLat},${hubLng}` : trackerUrl;

             // TP5B: Customer
             const custMsg = `*[READY FOR PICKUP]*\nOrder: ${altId}\n\nPayment successful! Your garment is now ready for collection.\n\nClick below for direct GPS navigation to the hub:\n🔗 ${navLink}`;
             sendWhatsAppText(custPhoneNum, custMsg);

             // TP4B: Hub (Interactive)
             const hubMsg = `*[STATUS: MENUNGGU PELANGGAN AMBIL]*\nPesanan: ${altId}\n\nPelanggan telah membuat pembayaran dan akan hadir ke kedai anda untuk mengambil baju mereka.\n\nApabila baju telah diserahkan kepada pelanggan, sila tekan butang di bawah untuk menutup pesanan ini.`;
             sendWhatsAppInteractive(hubPhoneNum, hubMsg, [
               { id: `HUB_HANDED_OVER|${altId}`, title: "Telah Diserahkan" }
             ]);
          }
        } else {
          sheet.getRange(rowNum, 21).setValue("PAID"); // Inbound_Payment_Status
          sheet.getRange(rowNum, 22).setValue(txnTrim); // Inbound_SP_Txn
        }

        touchDbUpdate();
        Logger.log("SenangPay webhook: Payment recorded for " + order_id + " | txn=" + txnTrim + " | dir=" + (isOutbound ? "outbound" : "inbound"));
        return OK;
      }
    }

    Logger.log("SenangPay webhook: Order ID not found — " + order_id);
    return FAILED;

  } catch (err) {
    Logger.log("SenangPay webhook: Unhandled error — " + err.toString());
    return ContentService.createTextOutput("FAILED").setMimeType(ContentService.MimeType.TEXT);
  }
}

// --- ADMIN UI MENU ---
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('👑 Arabista Admin')
      .addItem('Run Payout Cycle', 'runPayoutCycle')
      .addItem('Reverse / Refund Payout', 'reversePayout')
      .addToUi();
  ui.createMenu('Arabista HQ')
      .addItem('Launch Command Center', 'showDashboardModal')
      .addToUi();
}

function showDashboardModal() {
  const url = ScriptApp.getService().getUrl();

  const html = HtmlService.createHtmlOutput(`
    <div style="font-family: 'Inter', sans-serif; text-align: center; padding: 30px; background-color: #0F0F10; color: white; height: 100%; box-sizing: border-box;">
      <h2 style="color: #fbbf24; margin-bottom: 10px; font-family: serif; font-size: 24px;">Arabista Command Center</h2>
      <p style="color: #9ca3af; font-size: 14px; margin-bottom: 30px;">Your secure master dashboard is ready.</p>
      <a href="${url}?page=admin-alterations-staging" target="_blank" style="background-color: #f59e0b; color: #000; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; font-size: 12px; display: inline-block;">Launch Dashboard</a>
    </div>
  `).setWidth(400).setHeight(250);

  SpreadsheetApp.getUi().showModalDialog(html, 'System Access');
}

// --- 1. SETUP ---
function setupLalamoveKeys() {
  Logger.log("Keys managed in Script Properties.");
}

// --- DELTA POLLING HELPER ---
function touchDbUpdate() {
  PropertiesService.getScriptProperties().setProperty('LAST_DB_UPDATE', new Date().getTime().toString());
}

// --- AUTHENTICATION HELPER (NEW) ---
function verifyToken(hubName, clientToken) {
  if (!hubName || !clientToken) throw new Error("Unauthorized: Missing Credentials");
  const storedToken = PropertiesService.getScriptProperties().getProperty('HUB_TOKEN_' + hubName);
  if (clientToken !== storedToken) throw new Error("Unauthorized: Invalid or Expired Session");
}

// --- 2. POST ROUTER ---
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000); 

  try {
    // --- SENANGPAY WEBHOOK INTERCEPTOR ---
    // SenangPay sends x-www-form-urlencoded, not JSON — must be caught before JSON.parse.
    if (e.parameter && e.parameter.status_id && e.parameter.order_id) {
      return handleSenangPayWebhook(e.parameter);
    }

    // --- NEW JSON PARSING BLOCK FOR SWITCH INBOUND ---
    let payloadData = e.parameter || {};
    try {
      if (e.postData && e.postData.contents) {
        const parsed = JSON.parse(e.postData.contents);
        payloadData = { ...payloadData, ...parsed };
      }
    } catch (err) {}

    if (payloadData.action === "switch_inbound_method") {
      const altId = String(payloadData.alteration_id || "").trim();
      const method = String(payloadData.method || "").trim();

      if (altId && method) {
        const ssEarly = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ssEarly.getSheetByName("Incoming_Orders");
        if (sheet) {
          const data = sheet.getDataRange().getValues();
          let rowIndex = -1;
          let hubName = "";

          for (let i = 1; i < data.length; i++) {
            if (String(data[i][1]).trim() === altId) {
              rowIndex = i + 1;
              hubName = String(data[i][10]).trim();
              break;
            }
          }

          if (rowIndex !== -1) {
            const updatedDetailsRaw = String(payloadData.updated_item_details || "").trim();
            if (updatedDetailsRaw) {
              sheet.getRange(rowIndex, 13).setValue(updatedDetailsRaw);
            }

            sheet.getRange(rowIndex, 15).setValue(method);
            if (method === "Walk-in") {
              sheet.getRange(rowIndex, 14).setValue("Pending Dropoff");
              sheet.getRange(rowIndex, 16, rowIndex, 18).clearContent();
            } else if (method === "Lalamove") {
              sheet.getRange(rowIndex, 14).setValue("Awaiting Dispatch");
            }

            const hubSheet = ssEarly.getSheetByName("Active_Hubs");
            let hubPhone = "";
            if (hubSheet) {
              const hData = hubSheet.getDataRange().getDisplayValues();
              for (let h = 1; h < hData.length; h++) {
                if (hData[h][1] === hubName) {
                  hubPhone = hData[h][3];
                  break;
                }
              }
            }

            if (hubPhone) {
              if (method === "Walk-in") {
                const updateMsg = `*[KEMASKINI PESANAN]*\nPesanan: ${altId}\n\nPelanggan telah menukar cara penghantaran.\nPelanggan akan hadir sendiri (Drop-off) ke kedai anda. Sila pastikan ukuran pelanggan diambil.\n\nSila tekan butang di bawah HANYA selepas pelanggan menyerahkan baju tersebut secara fizikal.`;
                sendWhatsAppInteractive(hubPhone, updateMsg, [{ id: `HUB_RECEIVED|${altId}`, title: "Baju Diterima" }]);
              } else if (method === "Lalamove") {
                const itemDetailsDisplay = updatedDetailsRaw || String(sheet.getRange(rowIndex, 13).getValue()).trim();
                const updateMsg = `*[KEMASKINI PESANAN]*\nPesanan: ${altId}\n\nPelanggan telah menukar cara penghantaran. Mereka kini akan menggunakan khidmat Lalamove.\nSila tunggu rider tiba.\n\n*Butiran Alterasi:*\n${itemDetailsDisplay}`;
                sendWhatsAppText(hubPhone, updateMsg);
              }
            }

            touchDbUpdate();
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const data = JSON.parse(e.postData.contents);
    if (data.object === 'whatsapp_business_account') {
      handleWhatsAppWebhook(data);
      return ContentService.createTextOutput("EVENT_RECEIVED");
    }
    const timestamp = new Date();

    // Public Actions (No Hub Token Required)
    if (data.action === "get_lalamove_quote") return getLalamoveQuotation(data);
    if (data.action === "book_lalamove_order") return placeLalamoveOrder(data, ss);
    if (data.action === "get_lalamove_status") return getLiveLalamoveStatus(data, ss);
    if (data.action === "cancel_lalamove_order") return cancelLalamoveOrder(data, ss);
    // --- CANCEL ENTIRE ALTERATION ORDER ---
    if (data.action === "cancel_alteration") {
      const altId = data.alteration_id;
      if (!altId) return sendJSON({ status: "error", message: "ID required" });
      if (!cancelOrder(String(altId).trim())) {
        return sendJSON({ status: "error", message: "Order has already progressed and cannot be canceled." });
      }
      return sendJSON({ status: "success" });
    }
    if (data.action === "add_priority_fee") return addLivePriorityFee(data, ss);
    // --- INBOUND LIVE BOOST (PRIORITY FEE) — cumulative sheet write + Lalamove priority-fee sync ---
    if (data.action === "add_inbound_priority_fee") {
      const sheet = ss.getSheetByName("Incoming_Orders");
      if (!sheet) return sendJSON({ status: "error", message: "Incoming_Orders not found" });
      const altId = data.alteration_id;
      const addedTip = parseFloat(String(data.added_tip || 0).replace(/[^0-9.]/g, "")) || 0;
      if (addedTip <= 0) return sendJSON({ status: "error", message: "Invalid tip amount." });

      const rowNum = findRowByAlterationId(altId, sheet);
      if (rowNum === -1) return sendJSON({ status: "error", message: "ID not found" });

      const currentTipRaw = sheet.getRange(rowNum, 20).getValue();
      const currentTip = parseFloat(String(currentTipRaw).replace(/[^0-9.]/g, "")) || 0;
      const newTotalTip = currentTip + addedTip;

      sheet.getRange(rowNum, 20).setValue(newTotalTip);
      touchDbUpdate();

      // --- LALAMOVE API: push cumulative priority fee (same signing as callLalamoveAPI / addLivePriorityFee) ---
      const lalaOrderId = String(data.lalamove_order_id || "").trim();
      if (lalaOrderId) {
        try {
          const path = `/v3/orders/${lalaOrderId}/priority-fee`;
          const bodyObj = { data: { priorityFee: newTotalTip.toFixed(2) } };
          const response = callLalamoveAPI("POST", path, bodyObj);
          if (response.code !== 200 && response.code !== 201) {
            console.log("Lalamove priority-fee push failed:", response.code, response.body);
          }
        } catch (e) {
          console.log("Failed to push priority fee to Lalamove:", e);
        }
      }

      return sendJSON({ status: "success", new_total_tip: newTotalTip });
    }
    if (data.action === "get_senangpay_hash") {
      const hash = generateSenangPayHash(data.order_id, data.amount, data.detail);
      const { merchantId } = getSenangPayConfig();
      return sendJSON({ status: "success", hash: hash, merchant_id: merchantId });
    }
    if (data.action === "hub_login") return hubLogin(data, ss);
    if (data.action === "update_outbound_choice" || data.action === "update_address") return preflightAddressSync(data, ss);
    if (data.action === "update_outbound") return updateOutbound(data, ss);
    if (data.action === "hub_application") return submitHubApplication(data, ss, timestamp); // <-- NEW: HUB REGISTRATION
    if (!data.action) return submitNewOrder(data, ss, timestamp);

    // Protected Hub Actions (Token Required)
    verifyToken(data.hub_name, data.token);

    if (data.action === "get_dashboard") return getDashboard(data, ss);
    if (data.action === "update_order_status") return updateOrderStatus(data, ss);
    if (data.action === "search_order") return searchOrder(data, ss);
    if (data.action === "update_profile") return updateProfile(data, ss);

  } catch (error) {
    return sendJSON({ status: "error", message: error.toString() });
  } finally {
    lock.releaseLock();
  }
}

// --- 3. GET ROUTER ---
function doGet(e) {
  if (e.parameter['hub.mode'] === 'subscribe' && e.parameter['hub.verify_token'] === AI_CONFIG.WEBHOOK_VERIFY_TOKEN) {
    return ContentService.createTextOutput(e.parameter['hub.challenge']);
  }

  // HtmlService pages (e.g. ?page=admin-alterations-staging). Omit ?page= to keep JSON tracker / hub API behavior.
  const pageParam = e.parameter && e.parameter.page ? String(e.parameter.page).trim() : '';
  if (pageParam) {
    try {
      return HtmlService.createTemplateFromFile(pageParam).evaluate()
          .setTitle('Arabista HQ Command Center')
          .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
          .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    } catch (err) {
      return ContentService.createTextOutput("Arabista API is running. Route not found: " + pageParam);
    }
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const result = { hubs: [], orderData: null, trackData: null, pricing: {} };
    const pricingSheet = ss.getSheetByName("Pricing");
    if (pricingSheet) {
      const pData = pricingSheet.getDataRange().getDisplayValues();
      for (let i = 1; i < pData.length; i++) {
        let svc = String(pData[i][0]).trim();
        if (svc) {
          let key = svc.toLowerCase();
          if (key.includes('full')) key = 'full';
          else if (key.includes('hem')) key = 'hem';
          else if (key.includes('sleeve')) key = 'sleeve';
          else if (key.includes('shoulder')) key = 'shoulder';
          else if (key.includes('pad')) key = 'pads';
          result.pricing[key] = {
            service: svc,
            price: parseFloat(pData[i][1].replace(/[^\d.-]/g, '')) || 0,
            value: parseFloat(pData[i][2].replace(/[^\d.-]/g, '')) || 0,
            savings: parseFloat(pData[i][3].replace(/[^\d.-]/g, '')) || 0
          };
        }
      }
    }

    if (e.parameter.track_id) {
      const ioSheet = ss.getSheetByName("Incoming_Orders");
      const search = ioSheet.getRange("B:B").createTextFinder(e.parameter.track_id).matchEntireCell(true).findNext();
      if (search) {
        // Fetch full 30-column row for the new schema
        const rowData = ioSheet.getRange(search.getRow(), 1, 1, 30).getDisplayValues()[0];
        let currentStatus = rowData[13]; // col 14 = Order_Status
        if (currentStatus === "Dispatched / Picked Up") currentStatus = "Completed";
        
        let hubPhone = "";
        let hubQr = "images/hub-1-qr.webp"; 
        const hubSheetForLookup = ss.getSheetByName("Active_Hubs");
        if(hubSheetForLookup) {
            const hDataLookup = hubSheetForLookup.getDataRange().getDisplayValues();
            for (let i = 1; i < hDataLookup.length; i++) {
                if (hDataLookup[i][1] === rowData[10]) { 
                    hubPhone = hDataLookup[i][3];
                    if (hDataLookup[i][13]) { // Col N (Index 13) = Hub_QR_Path
                        hubQr = hDataLookup[i][13];
                    }
                    break;
                }
            }
        }

        result.trackData = {
          // ── Core order fields ──────────────────────────────────────────────────────
          alterationId:          rowData[1],   // col  2  Alteration_ID
          customerName:          rowData[4],   // col  5  Customer_Name
          customerPhone:         rowData[5],   // col  6  Phone_No
          unitNo:                rowData[6],   // col  7  Unit_No
          originalAddress:       rowData[7],   // col  8  Address_Details
          originalLat:           rowData[8],   // col  9  Customer_Lat
          originalLng:           rowData[9],   // col 10  Customer_Lng
          hubName:               rowData[10],  // col 11  Hub_Name
          hubPhone:              hubPhone,
          hubQr:                 hubQr,
          servicesTotal:         rowData[11],  // col 12  Services_Total
          itemDetails:           rowData[12],  // col 13  Item_Details
          orderStatus:           currentStatus,// col 14  Order_Status

          // ── Inbound Lalamove ───────────────────────────────────────────────────────
          inboundMode:           rowData[14],  // col 15  Inbound_Mode
          inboundLalaId:         rowData[15],  // col 16  Inbound_Lala_ID
          inboundLalaUrl:        rowData[16],  // col 17  Inbound_Lala_URL
          inboundLalaStatus:     rowData[17],  // col 18  Inbound_Lala_Status
          inboundBaseFare:       String(rowData[18]).replace(/[^0-9.]/g, ''), // col 19
          inboundPriorityFee:    String(rowData[19]).replace(/[^0-9.]/g, ''), // col 20
          inboundPaymentStatus:  rowData[20],  // col 21  Inbound_Payment_Status
          inboundSpTxn:          rowData[21],  // col 22  Inbound_SP_Txn

          // ── Outbound Lalamove / Self-Pickup ────────────────────────────────────────
          outboundChoice:        String(rowData[22] || "").trim(), // col 23  Outbound_Choice
          outboundLalaId:        String(rowData[23] || "").trim(), // col 24  Outbound_Lala_ID
          outboundLalaUrl:       String(rowData[24] || "").trim(), // col 25  Outbound_Lala_URL
          outboundLalaStatus:    String(rowData[25] || "").trim(), // col 26  Outbound_Lala_Status
          outboundBaseFare:      String(rowData[26]).replace(/[^0-9.]/g, ''), // col 27
          outboundPriorityFee:   String(rowData[27]).replace(/[^0-9.]/g, ''), // col 28
          outboundPaymentStatus: String(rowData[28] || "").trim(), // col 29  Outbound_Payment_Status
          outboundSpTxn:         String(rowData[29] || "").trim(), // col 30  Outbound_SP_Txn
        };
      } else { result.error = "Tracking ID not found."; }
    }

    const hubSheet = ss.getSheetByName("Active_Hubs");
    const hData = hubSheet.getDataRange().getDisplayValues();
    const ioSheet = ss.getSheetByName("Incoming_Orders");
    
    const allOrders = ioSheet ? ioSheet.getDataRange().getValues() : [];
    const backlog = {};
    for (let i = 1; i < allOrders.length; i++) {
      let s = String(allOrders[i][13]); // col 14 = Order_Status (0-indexed: 13)
      if (["Pending Dropoff", "Pending Approval", "Awaiting Dispatch", "In Progress", "Ready for Return"].includes(s)) {
        let h = String(allOrders[i][10]);
        backlog[h] = (backlog[h] || 0) + 1;
      }
    }

    for (let i = 1; i < hData.length; i++) {
      if (hData[i][9] === "Active") {
        result.hubs.push({
          id: parseInt(hData[i][0]), name: hData[i][1], address: hData[i][2], phone: hData[i][3],
          lat: parseFloat(hData[i][4]), lng: parseFloat(hData[i][5]), days: hData[i][6],
          open: hData[i][7], close: hData[i][8], max_capacity: parseInt(hData[i][11]) || 10,
          backlog: backlog[hData[i][1]] || 0
        });
      }
    }

    if (e.parameter.order) {
      const query = String(e.parameter.order).trim();
      if (query.startsWith("ALT-")) {
        const ioSheet = ss.getSheetByName("Incoming_Orders");
        if (ioSheet) {
          const search = ioSheet.getRange("B:B").createTextFinder(query).matchEntireCell(true).findNext();
          if (search) {
            const d = ioSheet.getRange(search.getRow(), 1, 1, 16).getDisplayValues()[0];
            let parsedItems = [];
            const itemLines = String(d[15]).split('\n');
            itemLines.forEach(line => {
              const match = line.match(/\[(.*?)\]/);
              if (match && match[1]) {
                parsedItems.push(match[1].trim() + " | 1");
              }
            });
            result.orderData = { 
                orderRef: d[3] || query, 
                name: d[4], 
                phone: d[5], 
                address: d[6], 
                itemsRaw: parsedItems.join(", ") 
            };
          }
        }
      } else {
        const oSheet = ss.getSheetByName("Website_Orders");
        if (oSheet) {
          const search = oSheet.getRange("A:A").createTextFinder(query).matchEntireCell(true).findNext();
          if (search) {
            const d = oSheet.getRange(search.getRow(), 1, 1, 5).getDisplayValues()[0];
            result.orderData = { orderRef: d[0], name: d[1], phone: d[2], address: d[3], itemsRaw: d[4] };
          }
        }
      }
    }
    
    return sendJSON(result);
  } catch (error) { return sendJSON({ error: error.toString() }); }
}

// --- 4. LALAMOVE INTEGRATION ---

function getLalamoveQuotation(data) {
  const formatCoord = (val) => { const num = parseFloat(val); return isNaN(num) ? "0.000000" : num.toFixed(6); };
  const pLat = formatCoord(data.pickupLat); const pLng = formatCoord(data.pickupLng);
  const dLat = formatCoord(data.dropoffLat); const dLng = formatCoord(data.dropoffLng);

  // Aggressive sanitization to prevent HMAC byte mismatches
  const cleanStr = (str) => String(str || "").replace(/[^\x20-\x7E]/g, "").trim().substring(0, 200);
  const pAddr = cleanStr(data.pickupAddress) || "Pickup Location";
  const dAddr = cleanStr(data.dropoffAddress) || "Dropoff Location";

  const body = {
    "data": {
      "serviceType": "MOTORCYCLE", "language": "en_MY",
      "stops": [
        { "coordinates": { "lat": pLat, "lng": pLng }, "address": pAddr },
        { "coordinates": { "lat": dLat, "lng": dLng }, "address": dAddr }
      ],
      "item": { "quantity": "1", "weight": "LESS_THAN_3_KG", "categories": ["OFFICE_ITEM"] },
      "isRouteOptimized": false
    }
  };

  const response = callLalamoveAPI("POST", "/v3/quotations", body);
  if (response.code === 201) {
    const resData = JSON.parse(response.body);
    return sendJSON({ status: "success", amount: resData.data.priceBreakdown.total, currency: "MYR", quotationId: resData.data.quotationId, stops: resData.data.stops });
  } else {
    return sendJSON({ status: "error", message: response.body });
  }
}

function placeLalamoveOrder(data, ss) {
  const formatPhone = (p) => {
    let clean = String(p).replace(/\D/g, '');
    if (clean.startsWith("60")) return "+" + clean;
    if (clean.startsWith("01")) return "+6" + clean;
    return "+60" + clean; 
  };

  const sheet = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.trackId).matchEntireCell(true).findNext();
  if (search) {
    const existingRow = search.getRow();
    // Idempotency: check the appropriate inbound/outbound lala ID AND Status columns
    const existingLalaCol = (data.direction === "Outbound") ? 24 : 16;
    const existingUrlCol  = (data.direction === "Outbound") ? 25 : 17;
    const existingStatCol = (data.direction === "Outbound") ? 26 : 18;

    const existingOrderId = String(sheet.getRange(existingRow, existingLalaCol).getValue()).trim();
    const existingStatus  = String(sheet.getRange(existingRow, existingStatCol).getValue()).trim();

    // Only block new bookings if the existing order is NOT canceled/rejected
    if (existingOrderId && existingStatus !== "CANCELED" && existingStatus !== "REJECTED") {
      const existingTrackingUrl = String(sheet.getRange(existingRow, existingUrlCol).getValue()).trim();
      return sendJSON({ status: "success", lalamove_order_id: existingOrderId, tracking_url: existingTrackingUrl });
    }
  }

  const senderPhone = formatPhone(data.senderPhone);
  const recipientPhone = formatPhone(data.recipientPhone);

  // Place-order only accepts stopId + name + phone on sender/recipients (no address,
  // no remarks). Unit/house must be included in pickupAddress/dropoffAddress when
  // requesting the quotation — same pattern as the earlier alteration-tracker.
  const body = {
    "data": {
      "quotationId": data.quotationId,
      "sender": {
          "stopId": data.senderStopId,
          "name": String(data.senderName || "").trim(),
          "phone": senderPhone
      },
      "recipients": [ {
          "stopId": data.recipientStopId,
          "name": String(data.recipientName || "").trim(),
          "phone": recipientPhone
      } ],
      "isPODEnabled": true
    }
  };

  const response = callLalamoveAPI("POST", "/v3/orders", body);
  
    if (response.code === 201) {
    const resData = JSON.parse(response.body);
    const orderRef = resData.data.orderId; 
    const trackingUrl = `https://share.sandbox.lalamove.com/tracking?orderId=${orderRef}&lang=en_MY`;
    const baseFareNum = parseFloat(String(data.baseFare || "0").replace(/[^0-9.]/g, "")) || 0;
    const baseFareStr = baseFareNum.toFixed(2);

    if (search) {
      const row = search.getRow();
      // Write to inbound or outbound columns using Batch Operations
      if (data.direction === "Inbound") {
        sheet.getRange(row, 14).setValue("Inbound Dispatched"); // Order_Status
        // Batch write Cols 16 to 19 (Lala_ID, URL, Status, Base_Fare)
        sheet.getRange(row, 16, 1, 4).setValues([[orderRef, trackingUrl, "ASSIGNING_DRIVER", baseFareStr]]);
      } else {
        sheet.getRange(row, 14).setValue("Outbound Dispatched"); // Order_Status
        // Batch write Cols 23 to 27 (Choice, Lala_ID, URL, Status, Base_Fare)
        sheet.getRange(row, 23, 1, 5).setValues([["Lalamove", orderRef, trackingUrl, "ASSIGNING_DRIVER", baseFareStr]]);
      }
      touchDbUpdate();

      // --- LALAMOVE API: PUSH PRE-PAID PRIORITY FEE (1-2 PUNCH) ---
      // POST /v3/orders does not accept priority on create; inject via priority-fee if sheet already has a fee (col 28 outbound, col 20 inbound).
      try {
        const dir = (data.direction || "").toLowerCase();
        const priorityFeeCol = (dir === "outbound") ? 28 : 20;
        const storedPriorityFeeRaw = sheet.getRange(row, priorityFeeCol).getValue();
        const storedPriorityFee = parseFloat(String(storedPriorityFeeRaw).replace(/[^0-9.]/g, '')) || 0;

        if (storedPriorityFee > 0) {
          const pBody = { data: { priorityFee: storedPriorityFee.toFixed(2) } };
          const pResponse = callLalamoveAPI("POST", "/v3/orders/" + orderRef + "/priority-fee", pBody);
          if (pResponse.code !== 200 && pResponse.code !== 201) {
            console.log("Lalamove priority-fee on placement failed:", pResponse.code, pResponse.body);
          }
        }
      } catch (e) {
        console.log("Failed to apply priority fee on placement:", e);
      }
      // ------------------------------------------------------------
      // WhatsApp Lalamove rider notifications are deferred to syncLalamoveStatuses()
      // when status changes from ASSIGNING_DRIVER to ON_GOING.
    }

      // --- RETRY HUB NOTIFICATION ---
      if (data.isRetry && data.direction === "Outbound" && search) {
        try {
          const row = search.getRow();
          const hubName = String(sheet.getRange(row, 11).getValue()).trim(); // Col 11 is Hub_Name
          const hubSheet = ss.getSheetByName("Active_Hubs");
          let hubPhone = "";
          if (hubSheet) {
            const hData = hubSheet.getDataRange().getDisplayValues();
            for (let h = 1; h < hData.length; h++) {
              if (hData[h][1] === hubName) {
                hubPhone = hData[h][3];
                break;
              }
            }
          }
          if (hubPhone) {
            const altId = String(sheet.getRange(row, 2).getValue()).trim();
            const hubMsg = `*[MAKLUMAN RETRY LALAMOVE]*\nPesanan: ${altId}\n\nSistem sedang mencari rider Lalamove baharu (Outbound) kerana carian sebelum ini tamat tempoh.\n🔗 Track Rider: ${trackingUrl}`;
            sendWhatsAppText(hubPhone, hubMsg);
          }
        } catch (e) {
          console.log("Failed to send Hub Retry notification:", e);
        }
      }

    return sendJSON({ status: "success", lalamove_order_id: orderRef, tracking_url: trackingUrl });
  } else {
    return sendJSON({ status: "error", message: response.body });
  }
}

/**
 * Customer cancellation: early states only. Notifies assigned Hub on WhatsApp.
 * Sheet uses CANCELED (all caps) for compatibility with tracker and other guards.
 */
function cancelOrder(alterationId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Incoming_Orders");
  if (!sheet) return false;
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(alterationId).trim()) {
      const status = String(data[i][13]).trim();

      if (status !== "Pending Approval" && status !== "Awaiting Drop-off" && status !== "Awaiting Hub Drop-off"
          && status !== "Pending Dropoff" && status !== "Awaiting Dispatch") {
        return false;
      }

      sheet.getRange(i + 1, 14).setValue("CANCELED");

      const hubName = String(data[i][10]).trim();
      if (hubName && hubName !== "TBD" && hubName !== "") {
        const hubSheet = ss.getSheetByName("Active_Hubs");
        if (hubSheet) {
          const hData = hubSheet.getDataRange().getDisplayValues();
          for (let h = 1; h < hData.length; h++) {
            if (String(hData[h][1]).trim() === hubName) {
              const hubPhone = hData[h][3];
              sendWhatsAppText(hubPhone, `*[MAKLUMAN PEMBATALAN]*\n\nPesanan *${String(alterationId).trim()}* telah dibatalkan oleh pelanggan. Anda tidak perlu lagi memproses pesanan ini.`);
              break;
            }
          }
        }
      }

      touchDbUpdate();
      return true;
    }
  }
  return false;
}

function cancelLalamoveOrder(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.track_id).matchEntireCell(true).findNext();
  if (!search) return sendJSON({ status: "error", message: "Order not found" });
  
  const row = search.getRow();
  // Determine direction from current Order_Status (col 14)
  const orderStatus  = String(sheet.getRange(row, 14).getValue()).trim();
  const isInbound    = orderStatus === "Inbound Dispatched";
  const lalaIdCol    = isInbound ? 16 : 24;
  const lalaStatCol  = isInbound ? 18 : 26;
  const lalamoveOrderId = sheet.getRange(row, lalaIdCol).getValue();
  if (!lalamoveOrderId) return sendJSON({ status: "error", message: "No Lalamove ID to cancel." });

  const response = callLalamoveAPI("DELETE", "/v3/orders/" + lalamoveOrderId, null);
  
  if (response.code === 200 || response.code === 204) {
    if (isInbound) {
      sheet.getRange(row, 14).setValue("Awaiting Dispatch"); // Order_Status
      // Batch clear Inbound Cols 16 to 20 (ID, URL, Status, Base_Fare, Priority_Fee — col 20 per sheet map)
      sheet.getRange(row, 16, 1, 5).setValues([["", "", "CANCELED", "", ""]]);
    } else {
      sheet.getRange(row, 14).setValue("Ready for Return"); // Order_Status
      // Batch clear Outbound Cols 23 to 26
      sheet.getRange(row, 23, 1, 4).setValues([["", "", "", "CANCELED"]]);
    }
    touchDbUpdate(); 
    return sendJSON({ status: "success" });
  } else {
    let errorMsg = "Cancellation failed. Driver may already be arriving.";
    try {
        const resBody = JSON.parse(response.body);
        if(resBody.message) errorMsg += " Reason: " + resBody.message;
    } catch(e) {}
    return sendJSON({ status: "error", message: errorMsg });
  }
}

/**
 * Injects a live priority fee into an active Lalamove order while the rider
 * is still being assigned (ASSIGNING_DRIVER status).
 * Calls: POST /v3/orders/{orderId}/priority-fee
 */
function addLivePriorityFee(data, ss) {
  const sheet  = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.track_id).matchEntireCell(true).findNext();
  if (!search) return sendJSON({ status: "error", message: "Order not found." });

  const row             = search.getRow();
  // Determine which lala ID is active from Order_Status (col 14)
  const orderStatus     = String(sheet.getRange(row, 14).getValue()).trim();
  const isOutbound      = orderStatus === "Outbound Dispatched";
  const lalaIdCol       = isOutbound ? 24 : 16; // Outbound vs Inbound Lala_ID
  const lalamoveOrderId = String(sheet.getRange(row, lalaIdCol).getValue()).trim();
  if (!lalamoveOrderId) return sendJSON({ status: "error", message: "No active Lalamove order for this track ID." });

  // Strip any RM prefix and ensure clean numeric string
  const tipsAmount = parseFloat(String(data.tips || 0).replace(/[^0-9.]/g, '') || 0).toFixed(2);
  const body = { "data": { "priorityFee": tipsAmount } };

  const response = callLalamoveAPI("POST", `/v3/orders/${lalamoveOrderId}/priority-fee`, body);
  if (response.code === 200 || response.code === 201) {
    // Persist the cumulative tip to the appropriate priority fee column
    const feeCol = isOutbound ? 28 : 20; // Outbound_Priority_Fee or Inbound_Priority_Fee
    sheet.getRange(row, feeCol).setValue(tipsAmount);
    touchDbUpdate();
    return sendJSON({ status: "success" });
  } else {
    return sendJSON({ status: "error", message: response.body });
  }
}

function syncLalamoveStatuses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Incoming_Orders");
  const data = sheet.getDataRange().getValues();
  let dbChanged = false;
  
  for (let i = 1; i < data.length; i++) {
    const inboundLalaId  = data[i][15]; // col 16 Inbound_Lala_ID  (0-idx: 15)
    const inboundStatus  = data[i][17]; // col 18 Inbound_Lala_Status
    const outboundLalaId = data[i][23]; // col 24 Outbound_Lala_ID  (0-idx: 23)
    const outboundStatus = data[i][25]; // col 26 Outbound_Lala_Status

    // ── Sync inbound ──────────────────────────────────────────────────────────
    if (inboundLalaId && inboundStatus !== "COMPLETED" && inboundStatus !== "CANCELED") {
      try {
        const response = callLalamoveAPI("GET", "/v3/orders/" + inboundLalaId, null);
        if (response.code === 200) {
          const resBody = JSON.parse(response.body);
          const newStatus = resBody.data.status;
          if (newStatus !== inboundStatus) {
            sheet.getRange(i + 1, 18).setValue(newStatus); // Inbound_Lala_Status
            dbChanged = true;

            if (newStatus === "ON_GOING" && String(inboundStatus).trim() === "ASSIGNING_DRIVER") {
              const trackingUrl = (resBody.data.shareLink && String(resBody.data.shareLink).trim()) || String(data[i][16]).trim();
              const altId = String(data[i][1]).trim();
              const custPhoneNum = String(data[i][5]).trim();
              const trackerUrl = "https://arabistaofficial.com/alteration-tracker-staging.html?id=" + altId;

              const custMsg = `*[LALAMOVE SECURED]*\nOrder: ${altId}\n\nYour inbound Lalamove rider is on the way to pick up your garment.\n🔗 Track Rider: ${trackingUrl}\n🔗 Order Dashboard: ${trackerUrl}`;
              sendWhatsAppText(custPhoneNum, custMsg);

              let hubPhone = "";
              const hubName = String(data[i][10]).trim();
              const hubSheet = ss.getSheetByName("Active_Hubs");
              if (hubSheet) {
                const hData = hubSheet.getDataRange().getDisplayValues();
                for (let h = 1; h < hData.length; h++) {
                  if (hData[h][1] === hubName) { hubPhone = hData[h][3]; break; }
                }
              }
              if (hubPhone) {
                const hubMsg = `*[STATUS: BAJU DALAM PERJALANAN]*\nPesanan: ${altId}\n\nLalamove Inbound sedang dalam perjalanan ke kedai anda.\n🔗 Track Rider: ${trackingUrl}\n\nTekan butang di bawah selepas baju telah diterima daripada rider.`;
                sendWhatsAppInteractive(hubPhone, hubMsg, [{ id: `HUB_RECEIVED|${altId}`, title: "Baju Diterima" }]);
              }
            }

            if (newStatus === "COMPLETED") {
              const currentOrderStatus = String(data[i][13]).trim();
              if (currentOrderStatus !== "In Progress" && currentOrderStatus !== "Ready for Return" && currentOrderStatus !== "Completed") {
                sheet.getRange(i + 1, 14).setValue("In Progress"); // Order_Status CORRECTED

                const altId = String(data[i][1]).trim();
                const custPhoneNum = String(data[i][5]).trim();
                const trackerUrl = "https://arabistaofficial.com/alteration-tracker-staging.html?id=" + altId;

                // TP3B: Item Received (Customer)
                const custMsg = `*[ITEM RECEIVED]*\nOrder: ${altId}\n\nYour item has safely arrived at the hub. The tailor is now preparing to begin your alteration!\n🔗 ${trackerUrl}`;
                sendWhatsAppText(custPhoneNum, custMsg);

                // TP3B: Hub Actionable (In Progress)
                let hubPhone = "";
                const hubName = String(data[i][10]).trim(); // Col 11
                const hubSheet = ss.getSheetByName("Active_Hubs");
                if (hubSheet) {
                  const hData = hubSheet.getDataRange().getDisplayValues();
                  for (let h = 1; h < hData.length; h++) {
                    if (hData[h][1] === hubName) { hubPhone = hData[h][3]; break; }
                  }
                }
                if (hubPhone) {
                  let cleanCustomerPhone = String(custPhoneNum).replace(/\D/g, '');
                  if (cleanCustomerPhone.startsWith('0')) cleanCustomerPhone = '6' + cleanCustomerPhone;

                  const hubMsg = `*[STATUS: SEDANG DIJAHIT]*\nPesanan: ${altId}\n\nLalamove Inbound telah selesai. Baju telah tiba di kedai anda.\n\n📞 *Hubungi Pelanggan:* https://wa.me/${cleanCustomerPhone} (Jika ada pertanyaan)\n\nApabila semua jahitan telah siap, sila tekan butang di bawah.`;
                  sendWhatsAppInteractive(hubPhone, hubMsg, [
                    { id: `HUB_COMPLETED|${altId}`, title: "Siap Dijahit" }
                  ]);
                }
              }
            }

            if (newStatus === "EXPIRED" || newStatus === "CANCELED" || newStatus === "REJECTED") {
              const altId = String(data[i][1]).trim();
              const custPhoneNum = String(data[i][5]).trim();
              const trackerUrl = "https://arabistaofficial.com/alteration-tracker-staging.html?id=" + altId;

              sheet.getRange(i + 1, 14).setValue("Awaiting Dispatch");
              sheet.getRange(i + 1, 16).setValue("");
              sheet.getRange(i + 1, 18).setValue(newStatus);

              const custMsg = `⚠️ *[RIDER SEARCH TIMEOUT]*\nOrder: ${altId}\n\nDue to high demand or weather, Lalamove could not secure a rider in time.\n\nPlease click your tracking link below to try searching for a rider again:\n🔗 ${trackerUrl}`;
              sendWhatsAppText(custPhoneNum, custMsg);
            }
          }
        }
      } catch (e) { Logger.log("Sync Inbound Error: " + e.toString()); }
      Utilities.sleep(500);
    }

    // ── Sync outbound ─────────────────────────────────────────────────────────
    if (outboundLalaId && outboundStatus !== "COMPLETED" && outboundStatus !== "CANCELED") {
      try {
        const response = callLalamoveAPI("GET", "/v3/orders/" + outboundLalaId, null);
        if (response.code === 200) {
          const resBody = JSON.parse(response.body);
          const newStatus = resBody.data.status;
          if (newStatus !== outboundStatus) {
            sheet.getRange(i + 1, 26).setValue(newStatus); // Outbound_Lala_Status
            dbChanged = true;

            if (newStatus === "ON_GOING" && String(outboundStatus).trim() === "ASSIGNING_DRIVER") {
              const trackingUrl = (resBody.data.shareLink && String(resBody.data.shareLink).trim()) || String(data[i][24]).trim();
              const altId = String(data[i][1]).trim();
              const custPhoneNum = String(data[i][5]).trim();

              const custMsg = `*[LALAMOVE DISPATCHED]*\nOrder: ${altId}\n\nPayment successful! Your return Lalamove rider is on the way to pick up your garment from the hub and deliver it to you.\n\nOnce you have received your items, please click the button below to close the order.\n\n🔗 Track Rider: ${trackingUrl}`;
              sendWhatsAppInteractive(custPhoneNum, custMsg, [
                { id: `CUST_RECEIVED|${altId}`, title: "Order Received" }
              ]);

              let hubPhone = "";
              const hubName = String(data[i][10]).trim();
              const hubSheet = ss.getSheetByName("Active_Hubs");
              if (hubSheet) {
                const hData = hubSheet.getDataRange().getDisplayValues();
                for (let h = 1; h < hData.length; h++) {
                  if (hData[h][1] === hubName) { hubPhone = hData[h][3]; break; }
                }
              }
              if (hubPhone) {
                const hubMsg = `*[STATUS: LALAMOVE OUTBOUND]*\nPesanan: ${altId}\n\nRider Lalamove (Outbound) sedang dalam perjalanan untuk mengambil baju dari kedai anda dan menghantar kepada pelanggan.\n🔗 Track Rider: ${trackingUrl}`;
                sendWhatsAppText(hubPhone, hubMsg);
              }
            }

            if (newStatus === "COMPLETED") {
              sheet.getRange(i + 1, 14).setValue("Completed"); // Order_Status

              try {
                const hubNameForLedger = String(data[i][10]).trim(); // Col 11: Hub_Name
                const itemDetailsForLedger = String(data[i][12]).trim(); // Col 13: Item_Details
                const oidLedger = String(data[i][1]).trim();
                recordHubPayoutToLedger(oidLedger, hubNameForLedger, itemDetailsForLedger);
              } catch (e) {
                Logger.log("Failed to write to Hub Ledger: " + e.message);
              }

              const altId = String(data[i][1]).trim();
              const custPhoneNum = String(data[i][5]).trim();
              const trackerUrl = "https://arabistaofficial.com/alteration-tracker-staging.html?id=" + altId;

              // TP6: Final Closure (Customer Message)
              const custMsg = `*[ORDER COMPLETED]*\nOrder: ${altId}\n\nYour garment has been successfully delivered by Lalamove, and this order is now officially closed. Thank you for choosing Arabista!\n🔗 ${trackerUrl}`;
              sendWhatsAppText(custPhoneNum, custMsg);

              // TP6: Final Closure (Hub Message)
              let hubPhone = "";
              const hubName = String(data[i][10]).trim(); // Col 11
              const hubSheet = ss.getSheetByName("Active_Hubs");
              if (hubSheet) {
                const hData = hubSheet.getDataRange().getDisplayValues();
                for (let h = 1; h < hData.length; h++) {
                  if (hData[h][1] === hubName) { hubPhone = hData[h][3]; break; }
                }
              }
              if (hubPhone) {
                const hubMsg = `*[SELESAI: PESANAN DITUTUP]*\nPesanan: ${altId}\n\nLalamove Outbound telah selesai dihantar. Pesanan ini ditutup sepenuhnya. Upah anda akan diproses.`;
                sendWhatsAppText(hubPhone, hubMsg);
              }
            }

            if (newStatus === "EXPIRED" || newStatus === "CANCELED" || newStatus === "REJECTED") {
              const altId = String(data[i][1]).trim();
              const custPhoneNum = String(data[i][5]).trim();
              const trackerUrl = "https://arabistaofficial.com/alteration-tracker-staging.html?id=" + altId;

              sheet.getRange(i + 1, 14).setValue("Ready for Return");
              sheet.getRange(i + 1, 24).setValue("");
              sheet.getRange(i + 1, 26).setValue(newStatus);

              const custMsg = `⚠️ *[RIDER SEARCH TIMEOUT]*\nOrder: ${altId}\n\nDue to high demand or weather, Lalamove could not secure a rider in time.\n\nYour payment is safe. Please click your tracking link below to retry the rider search:\n🔗 ${trackerUrl}`;
              sendWhatsAppText(custPhoneNum, custMsg);
            }
          }
        }
      } catch (e) { Logger.log("Sync Outbound Error: " + e.toString()); }
      Utilities.sleep(500);
    }
  }
  if (dbChanged) touchDbUpdate();
}

function getLiveLalamoveStatus(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.track_id).matchEntireCell(true).findNext();
  if (!search) return sendJSON({ status: "error", message: "Order not found" });
  
  const row = search.getRow();
  // Determine which lala ID is active from Order_Status (col 14)
  const orderStatus  = String(sheet.getRange(row, 14).getValue()).trim();
  const isOutbound   = orderStatus === "Outbound Dispatched";
  const lalaIdCol    = isOutbound ? 24 : 16; // Outbound_Lala_ID vs Inbound_Lala_ID
  const lalaStatCol  = isOutbound ? 26 : 18; // Outbound_Lala_Status vs Inbound_Lala_Status
  const lalamoveOrderId = sheet.getRange(row, lalaIdCol).getValue();
  if (!lalamoveOrderId) return sendJSON({ status: "error", message: "No Lalamove ID" });

  const response = callLalamoveAPI("GET", "/v3/orders/" + lalamoveOrderId, null);
  if (response.code === 200) {
    const resData = JSON.parse(response.body);
    const status = resData.data.status;
    const prevLalaStat = String(sheet.getRange(row, lalaStatCol).getValue()).trim();
    sheet.getRange(row, lalaStatCol).setValue(status); // direction-aware status column

    // If the status has officially changed, execute the broadcast logic (mirrors syncLalamoveStatuses)
    if (status !== prevLalaStat) {
      const orderId = String(sheet.getRange(row, 2).getValue()).trim();
      const custPhone = String(sheet.getRange(row, 6).getValue()).trim();
      const hubName = String(sheet.getRange(row, 11).getValue()).trim();
      const trackerUrl = `https://arabistaofficial.com/alteration-tracker-staging.html?id=${orderId}`;
      let trackingUrl = (resData.data.shareLink && String(resData.data.shareLink).trim()) || "";
      if (!trackingUrl) {
        trackingUrl = String(sheet.getRange(row, isOutbound ? 25 : 17).getValue()).trim();
      }

      let hubPhone = "";
      const hubSheet = ss.getSheetByName("Active_Hubs");
      if (hubSheet) {
        const hData = hubSheet.getDataRange().getDisplayValues();
        for (let h = 1; h < hData.length; h++) {
          if (hData[h][1] === hubName) { hubPhone = hData[h][3]; break; }
        }
      }

      // TRANSITION 1: Rider Secured (ON_GOING)
      if (status === "ON_GOING" && prevLalaStat === "ASSIGNING_DRIVER") {
        if (isOutbound) {
          const custMsg = `*[LALAMOVE DISPATCHED]*\nOrder: ${orderId}\n\nPayment successful! Your return Lalamove rider is on the way to pick up your garment from the hub and deliver it to you.\n\nOnce you have received your items, please click the button below to close the order.\n\n🔗 Track Rider: ${trackingUrl}`;
          sendWhatsAppInteractive(custPhone, custMsg, [{ id: `CUST_RECEIVED|${orderId}`, title: "Order Received" }]);
          if (hubPhone) {
            const hubMsg = `*[STATUS: LALAMOVE OUTBOUND]*\nPesanan: ${orderId}\n\nRider Lalamove (Outbound) sedang dalam perjalanan untuk mengambil baju dari kedai anda dan menghantar kepada pelanggan.\n🔗 Track Rider: ${trackingUrl}`;
            sendWhatsAppText(hubPhone, hubMsg);
          }
        } else {
          const custMsg = `*[LALAMOVE SECURED]*\nOrder: ${orderId}\n\nYour inbound Lalamove rider is on the way to pick up your garment.\n🔗 Track Rider: ${trackingUrl}\n🔗 Order Dashboard: ${trackerUrl}`;
          sendWhatsAppText(custPhone, custMsg);
          if (hubPhone) {
            const hubMsg = `*[STATUS: BAJU DALAM PERJALANAN]*\nPesanan: ${orderId}\n\nLalamove Inbound sedang dalam perjalanan ke kedai anda.\n🔗 Track Rider: ${trackingUrl}\n\nTekan butang di bawah selepas baju telah diterima daripada rider.`;
            sendWhatsAppInteractive(hubPhone, hubMsg, [{ id: `HUB_RECEIVED|${orderId}`, title: "Baju Diterima" }]);
          }
        }
      }

      // TRANSITION 2: Rider Arrived (COMPLETED)
      if (status === "COMPLETED") {
        if (isOutbound) {
          sheet.getRange(row, 14).setValue("Completed"); // Update Order_Status
          try {
            const hubNameForLedger = String(sheet.getRange(row, 11).getValue()).trim(); // Col 11: Hub_Name
            const itemDetailsForLedger = String(sheet.getRange(row, 13).getValue()).trim(); // Col 13: Item_Details
            recordHubPayoutToLedger(orderId, hubNameForLedger, itemDetailsForLedger);
          } catch (e) {
            Logger.log("Failed to write to Hub Ledger: " + e.message);
          }
          const custMsg = `*[ORDER COMPLETED]*\nOrder: ${orderId}\n\nYour garment has been successfully delivered by Lalamove, and this order is now officially closed. Thank you for choosing Arabista!\n🔗 ${trackerUrl}`;
          sendWhatsAppText(custPhone, custMsg);
          if (hubPhone) {
            const hubMsg = `*[SELESAI: PESANAN DITUTUP]*\nPesanan: ${orderId}\n\nLalamove Outbound telah selesai dihantar. Pesanan ini ditutup sepenuhnya. Upah anda akan diproses.`;
            sendWhatsAppText(hubPhone, hubMsg);
          }
        } else {
          const currentOrderStatus = String(sheet.getRange(row, 14).getValue()).trim();
          if (currentOrderStatus !== "In Progress" && currentOrderStatus !== "Ready for Return" && currentOrderStatus !== "Completed") {
            sheet.getRange(row, 14).setValue("In Progress"); // Update Order_Status
            const custMsg = `*[ITEM RECEIVED]*\nOrder: ${orderId}\n\nYour item has safely arrived at the hub. The tailor is now preparing to begin your alteration!\n🔗 ${trackerUrl}`;
            sendWhatsAppText(custPhone, custMsg);
            if (hubPhone) {
              let cleanCustomerPhone = String(custPhone).replace(/\D/g, '');
              if (cleanCustomerPhone.startsWith('0')) cleanCustomerPhone = '6' + cleanCustomerPhone;

              const hubMsg = `*[STATUS: SEDANG DIJAHIT]*\nPesanan: ${orderId}\n\nLalamove Inbound telah selesai. Baju telah tiba di kedai anda.\n\n📞 *Hubungi Pelanggan:* https://wa.me/${cleanCustomerPhone} (Jika ada pertanyaan)\n\nApabila semua jahitan telah siap, sila tekan butang di bawah.`;
              sendWhatsAppInteractive(hubPhone, hubMsg, [{ id: `HUB_COMPLETED|${orderId}`, title: "Siap Dijahit" }]);
            }
          }
        }
      }
    }

    touchDbUpdate();
    return sendJSON({ status: "success", lalamove_status: status });
  } else {
    return sendJSON({ status: "error", message: "API Error" });
  }
}

function callLalamoveAPI(method, path, bodyObj) {
  const props = PropertiesService.getScriptProperties();
  const key = String(props.getProperty('LALAMOVE_API_KEY') || "").trim();
  const secret = String(props.getProperty('LALAMOVE_SECRET') || "").trim();
  const baseUrl = String(props.getProperty('LALAMOVE_BASE_URL') || LALA_BASE_URL).trim();
  if (!key || !secret) throw new Error("API Keys not set.");

  const time = new Date().getTime().toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const rawSignature = `${time}\r\n${method}\r\n${path}\r\n\r\n${bodyStr}`;

  // Force strict UTF-8 encoding for the signature byte array
  const signatureBytes = Utilities.computeHmacSha256Signature(rawSignature, secret, Utilities.Charset.UTF_8);
  const signature = signatureBytes.reduce((str, byte) => str + (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0'), '');
  const token = `${key}:${time}:${signature}`;

  const options = {
    "method": method,
    "headers": { 
      "Authorization": `hmac ${token}`, 
      "Market": MARKET, 
      "Content-Type": "application/json; charset=UTF-8", 
      "Accept": "application/json" 
    },
    "muteHttpExceptions": true 
  };
  
  if (method === 'PUT' || method === 'POST') options.payload = bodyStr;

  const response = UrlFetchApp.fetch(baseUrl + path, options);
  return { code: response.getResponseCode(), body: response.getContentText() };
}

// --- SECURE LOGIN ---
function hubLogin(data, ss) {
  const hubSheet = ss.getSheetByName("Active_Hubs");
  const hubs = hubSheet.getDataRange().getDisplayValues();
  for (let i = 1; i < hubs.length; i++) {
    if (hubs[i][3] == data.phone && hubs[i][10] == data.pin) {
      const secureToken = Utilities.getUuid();
      PropertiesService.getScriptProperties().setProperty('HUB_TOKEN_' + hubs[i][1], secureToken);
      return sendJSON({ status: "success", hub_name: hubs[i][1], token: secureToken });
    }
  }
  throw new Error("Invalid Phone/PIN");
}

function getDashboard(data, ss) {
  const props = PropertiesService.getScriptProperties();
  const lastDbUpdate = parseInt(props.getProperty('LAST_DB_UPDATE')) || 0;
  
  if (data.last_sync && parseInt(data.last_sync) >= lastDbUpdate) {
    return sendJSON({ status: "no_change", timestamp: new Date().getTime() });
  }

  const hubSheet = ss.getSheetByName("Active_Hubs");
  const sheet = ss.getSheetByName("Incoming_Orders");
  let profile = {};
  const hubs = hubSheet.getDataRange().getDisplayValues();
  for (let i = 1; i < hubs.length; i++) {
    if (String(hubs[i][1]).trim() === String(data.hub_name).trim()) {
      profile = { address: hubs[i][2], phone: hubs[i][3], lat: hubs[i][4], lng: hubs[i][5], days: hubs[i][6], open: hubs[i][7], close: hubs[i][8], status: hubs[i][9], max_capacity: hubs[i][11] || 10 };
      break;
    }
  }
  
  const orders = { pending: [], inProgress: [], ready: [], completed: [] };
  const allOrders = sheet.getDataRange().getValues(); 
  const oneDayAgo = new Date().getTime() - (24 * 60 * 60 * 1000);
  
  for (let i = 1; i < allOrders.length; i++) {
    if (String(allOrders[i][10]).trim() === String(data.hub_name).trim()) {
      let s = String(allOrders[i][13]); // col 14 = Order_Status (0-indexed: 13)
      let orderDate = allOrders[i][0];
      let dateIso = (orderDate instanceof Date) ? orderDate.toISOString() : new Date(orderDate).toISOString();
      
      const orderObj = { 
        date:                 dateIso, 
        id:                   String(allOrders[i][1]),   // col 2  Alteration_ID
        custName:             String(allOrders[i][4]),   // col 5  Customer_Name
        custPhone:            String(allOrders[i][5]),   // col 6  Phone_No
        unitNo:               String(allOrders[i][6]),   // col 7  Unit_No
        address:              String(allOrders[i][7]),   // col 8  Address_Details
        fee:                  String(allOrders[i][11]),  // col 12 Services_Total
        items:                String(allOrders[i][12]),  // col 13 Item_Details
        status:               s,                        // col 14 Order_Status
        logisticsMode:        String(allOrders[i][14]),  // col 15 Inbound_Mode
        inboundLalaId:        String(allOrders[i][15] || ""), // col 16
        inboundLalaUrl:       String(allOrders[i][16] || ""), // col 17
        inboundLalaStatus:    String(allOrders[i][17] || ""), // col 18
        inboundPaymentStatus: String(allOrders[i][20] || ""), // col 21
        outboundChoice:       String(allOrders[i][22] || ""), // col 23
        outboundLalaId:       String(allOrders[i][23] || ""), // col 24
        outboundLalaUrl:      String(allOrders[i][24] || ""), // col 25
        outboundLalaStatus:   String(allOrders[i][25] || ""), // col 26
        outboundPaymentStatus:String(allOrders[i][28] || ""), // col 29
      };

      if (["Pending Dropoff", "Pending Approval", "Awaiting Dispatch"].includes(s)) {
        orders.pending.push(orderObj);
      }
      else if (s === "Inbound Dispatched") {
        orders.pending.push(orderObj);
      }
      else if (s === "Outbound Dispatched") {
        orders.inProgress.push(orderObj);
      }
      else if (["In Progress", "Ready for Return"].includes(s)) {
        orders.inProgress.push(orderObj);
      }
      else if (s === "Completed") {
        let orderTime = (orderDate instanceof Date) ? orderDate.getTime() : new Date(orderDate).getTime();
        if (orderTime >= oneDayAgo) {
            orders.completed.push(orderObj);
        }
      }
    }
  }

  // Calculate Wallet Balance from Hub_Ledger
  let walletBalance = 0;
  const ledgerSheet = ss.getSheetByName("Hub_Ledger");
  if (ledgerSheet) {
    const lData = ledgerSheet.getDataRange().getValues();
    for (let i = 1; i < lData.length; i++) {
      if (String(lData[i][1]).trim() === String(data.hub_name).trim() && String(lData[i][5]).trim() === "UNPAID") {
        walletBalance += parseFloat(lData[i][4]) || 0;
      }
    }
  }

  return sendJSON({
    status: "success",
    profile: profile,
    orders: orders,
    walletBalance: walletBalance,
    timestamp: new Date().getTime()
  });
}

function updateOrderStatus(data, ss) {
  const orderId = data.order_id;
  const newStatus = data.new_status;
  const hubName = data.hub_name;

  // 1. Fetch Hub Phone Number (required for the State Machine)
  const hubSheet = ss.getSheetByName("Active_Hubs");
  let hubPhone = "";
  if (hubSheet) {
    const hData = hubSheet.getDataRange().getDisplayValues();
    for (let h = 1; h < hData.length; h++) {
      if (String(hData[h][1]).trim() === String(hubName).trim()) {
        hubPhone = String(hData[h][3]).replace(/\D/g, '');
        if (hubPhone.startsWith('0')) hubPhone = '6' + hubPhone;
        break;
      }
    }
  }

  if (!hubPhone) throw new Error("Hub phone not found. Cannot route to state machine.");

  // 2. Map Web Portal Status Strings to WhatsApp State Machine Intents
  let actionIntent = "";
  const statusMap = String(newStatus).trim();

  if (statusMap === "Pending Dropoff" || statusMap === "Awaiting Dispatch") {
    actionIntent = "HUB_ACCEPT";
  } else if (statusMap === "REJECTED") {
    actionIntent = "HUB_REJECT";
  } else if (statusMap === "In Progress") {
    actionIntent = "HUB_RECEIVED";
  } else if (statusMap === "Ready for Return") {
    actionIntent = "HUB_COMPLETED";
  } else if (statusMap === "Completed") {
    actionIntent = "HUB_HANDED_OVER";
  }

  // 3. Route to State Machine or Fallback
  if (actionIntent) {
    // This fires the exact same logic as if the Hub tapped the WhatsApp button!
    const smResult = processInteractivePayload(hubPhone, actionIntent, orderId);
    if (smResult && smResult.success === false) {
      return sendJSON({ status: "error", message: smResult.message });
    }
    return sendJSON({ status: "success" });
  } else {
    // Legacy fallback for edge cases
    const sheet = ss.getSheetByName("Incoming_Orders");
    const search = sheet.getRange("B:B").createTextFinder(orderId).matchEntireCell(true).findNext();
    if (search) {
      const row = search.getRow();
      sheet.getRange(row, 14).setValue(statusMap);
      if (statusMap === "Dispatched") {
        sheet.getRange(row, 23).setValue("Lalamove"); // Outbound_Choice
      }
      touchDbUpdate();
      return sendJSON({ status: "success" });
    }
    throw new Error("Order not found");
  }
}

function searchOrder(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const query = data.query.toLowerCase();
  const results = [];
  const allOrders = sheet.getDataRange().getValues(); 
  
  for (let i = 1; i < allOrders.length; i++) {
    if (String(allOrders[i][10]).trim() === String(data.hub_name).trim()) {
      let id = String(allOrders[i][1]);
      let name = String(allOrders[i][4]);
      let phone = String(allOrders[i][5]);
      
      if (id.toLowerCase().includes(query) || name.toLowerCase().includes(query) || phone.includes(query)) {
        let orderDate = allOrders[i][0];
        let dateIso = (orderDate instanceof Date) ? orderDate.toISOString() : new Date(orderDate).toISOString();
        results.push({ 
            date: dateIso, 
            id: id, 
            custName: name, 
            custPhone: phone, 
            items: String(allOrders[i][15]), 
            status: String(allOrders[i][16]) 
        });
      }
    }
  }
  return sendJSON({ status: "success", results: results });
}

function updateProfile(data, ss) {
  const hubSheet = ss.getSheetByName("Active_Hubs");
  const hubs = hubSheet.getDataRange().getDisplayValues();
  for (let i = 1; i < hubs.length; i++) {
    if (String(hubs[i][1]).trim() === String(data.hub_name).trim()) {
      const r = i + 1;
      // Fetch the existing row into memory
      const rowData = hubSheet.getRange(r, 1, 1, 12).getValues()[0];

      // Update variables in memory (array is 0-indexed)
      rowData[2] = data.address;
      rowData[3] = data.phone;
      rowData[4] = data.lat;
      rowData[5] = data.lng;
      rowData[6] = data.days;
      rowData[7] = data.open;
      rowData[8] = data.close;
      rowData[9] = data.status;
      rowData[11] = data.max_capacity;

      // Write the entire row back in 1 API call
      hubSheet.getRange(r, 1, 1, 12).setValues([rowData]);

      touchDbUpdate();
      return sendJSON({ status: "success" });
    }
  }
  throw new Error("Hub not found");
}

/** Row index (1-based) for Alteration_ID in column B, or -1. */
function findRowByAlterationId(altId, sheet) {
  if (!altId || !sheet) return -1;
  const search = sheet.getRange("B:B").createTextFinder(String(altId)).matchEntireCell(true).findNext();
  return search ? search.getRow() : -1;
}

/**
 * PRE-FLIGHT SYNC: Cement outbound choice and/or exact map coordinates + unit before SenangPay redirect.
 * Columns align with doGet trackData: Unit 7, Address 8, Lat 9, Lng 10, Outbound_Choice 23.
 */
function preflightAddressSync(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  if (!sheet) throw new Error("Incoming_Orders not found");
  const rowNum = findRowByAlterationId(data.alteration_id, sheet);
  if (rowNum === -1) return sendJSON({ status: "error", message: "ID not found" });

  if (data.action === "update_outbound_choice") {
    const choice = data.choice != null ? String(data.choice) : "Lalamove";
    sheet.getRange(rowNum, 23).setValue(choice);
  }

  if (data.lat != null && data.lat !== "" && data.lng != null && data.lng !== "") {
    sheet.getRange(rowNum, 8).setValue(data.address != null ? String(data.address) : "");
    sheet.getRange(rowNum, 9).setValue(data.lat);
    sheet.getRange(rowNum, 10).setValue(data.lng);
  }
  if (data.unit !== undefined) {
    sheet.getRange(rowNum, 7).setValue(data.unit != null ? String(data.unit) : "");
  }

  // Save Outbound Priority Fee if provided (col 28: Outbound_Priority_Fee)
  if (data.priority_fee !== undefined) {
    const pf = parseFloat(String(data.priority_fee).replace(/[^0-9.]/g, "")) || 0;
    sheet.getRange(rowNum, 28).setValue(pf);
  }

  touchDbUpdate();
  return sendJSON({ status: "success" });
}

function updateOutbound(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.alteration_id).matchEntireCell(true).findNext();
  if (search) {
      // Allow empty string to clear choice (customer cancelled before payment / wants to re-select).
      const val = data.outbound_choice == null ? "" : String(data.outbound_choice);
      sheet.getRange(search.getRow(), 23).setValue(val); // col 23 = Outbound_Choice
      touchDbUpdate();
      return sendJSON({ status: "success" });
  }
  throw new Error("Order not found");
}

// --- HUB REGISTRATION LOGIC ---
function submitHubApplication(data, ss, timestamp) {
  const sheet = ss.getSheetByName("Hub_Applications");
  if (!sheet) throw new Error("Hub_Applications tab not found in spreadsheet");

  // 1. CREATE THE IMAGE FILE IN GOOGLE DRIVE
  // IMPORTANT: REPLACE THE ID BELOW WITH YOUR ACTUAL FOLDER ID!
  const folderId = "1qEVRxbTEklTjLfzFOh__m0EEdS5nWyWM"; 
  const folder = DriveApp.getFolderById(folderId);
  
  const decodedImage = Utilities.base64Decode(data.photo_base64);
  const blob = Utilities.newBlob(decodedImage, MimeType.JPEG, data.name + "_Workspace.jpg");
  const imageFile = folder.createFile(blob);
  
  // Ensure the file is viewable so you can click the link in your Google Sheet
  imageFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const imageUrl = imageFile.getUrl();

  // 2. APPEND THE ROW TO GOOGLE SHEETS
  const status = "Pending Review";
  
  sheet.appendRow([
    timestamp,
    data.name,
    data.shop,
    data.phone,
    data.address,
    data.lat,
    data.lng,
    data.capacity,
    data.experience,
    data.certifications,
    data.equipment,
    imageUrl, // Saves the generated Google Drive link!
    status
  ]);
  
  touchDbUpdate(); 
  return sendJSON({ status: "success" });
}

function submitNewOrder(data, ss, timestamp) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const altId = generateAlterationId();
  const formatCoord = (val) => { const n = parseFloat(val); return isNaN(n) ? "" : n.toFixed(6); };
  
  const status = "Pending Approval";

  // Strip any letters or spaces from incoming totals, defaulting to "0"
  let finalServicesTotal = String(data.Services_Total || "0").replace(/[^0-9.]/g, '');
  let finalGrandTotal    = String(data.Grand_Total    || "0").replace(/[^0-9.]/g, '');

  if (data.Service_Keys && Array.isArray(data.Service_Keys)) {
    const pricingSheet = ss.getSheetByName("Pricing");
    if (pricingSheet) {
      let backendTotal = 0;
      const pData = pricingSheet.getDataRange().getDisplayValues();
      const priceMap = {};

      for (let i = 1; i < pData.length; i++) {
        let svc = String(pData[i][0]).toLowerCase();
        let key = svc;
        if (svc.includes('full')) key = 'full';
        else if (svc.includes('hem')) key = 'hem';
        else if (svc.includes('sleeve')) key = 'sleeve';
        else if (svc.includes('shoulder')) key = 'shoulder';
        else if (svc.includes('pad')) key = 'pads';

        priceMap[key] = parseFloat(pData[i][1].replace(/[^\d.-]/g, '')) || 0;
      }

      for (let key of data.Service_Keys) {
        if (priceMap[key]) backendTotal += priceMap[key];
      }

      // Save as pure numbers (e.g., 6.00)
      finalServicesTotal = backendTotal.toFixed(2);
      finalGrandTotal    = backendTotal.toFixed(2);
    }
  }

  const rowData = [
      timestamp,                        // col  1  Timestamp
      altId,                            // col  2  Alteration_ID
      data.Order_Type   || "",          // col  3  Order_Type
      data.Order_Ref    || "",          // col  4  Order_Ref
      data.Customer_Name || "",         // col  5  Customer_Name
      data.Phone_No     || "",          // col  6  Phone_No
      data.Unit_No      || "",          // col  7  Unit_No
      data.Address_Details || "",       // col  8  Address_Details
      formatCoord(data.Customer_Lat),   // col  9  Customer_Lat
      formatCoord(data.Customer_Lng),   // col 10  Customer_Lng
      data.Hub_Name     || "",          // col 11  Hub_Name
      finalServicesTotal,               // col 12  Services_Total
      data.Item_Details || "",          // col 13  Item_Details
      status,                           // col 14  Order_Status
      data.Logistics_Mode || "",        // col 15  Inbound_Mode
      "",                               // col 16  Inbound_Lala_ID
      "",                               // col 17  Inbound_Lala_URL
      "",                               // col 18  Inbound_Lala_Status
      "",                               // col 19  Inbound_Base_Fare
      "",                               // col 20  Inbound_Priority_Fee
      "",                               // col 21  Inbound_Payment_Status
      "",                               // col 22  Inbound_SP_Txn
      "",                               // col 23  Outbound_Choice
      "",                               // col 24  Outbound_Lala_ID
      "",                               // col 25  Outbound_Lala_URL
      "",                               // col 26  Outbound_Lala_Status
      "",                               // col 27  Outbound_Base_Fare
      "",                               // col 28  Outbound_Priority_Fee
      "",                               // col 29  Outbound_Payment_Status
      ""                                // col 30  Outbound_SP_Txn
  ];
  
  sheet.appendRow(rowData);
  touchDbUpdate(); 

  // --- PHASE 4: TP1 hub approval (no outbound customer WA; customer uses frontend wa.me) ---
  const custPhone = data.Phone_No || "";
  let hubPhone = "";
  const hubSheet = ss.getSheetByName("Active_Hubs");
  if (hubSheet) {
    const hData = hubSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < hData.length; i++) {
      if (hData[i][1] === data.Hub_Name) {
        hubPhone = hData[i][3];
        break;
      }
    }
  }

  // Hub approval only — customer activates Meta window via frontend wa.me link (zero-cost activation).
  if (hubPhone) {
    const hubMsg = `*[PESANAN BARU: ${altId}]*\nStatus: Mohon Kelulusan\n\n*Butiran Alterasi:*\n${data.Item_Details || "Tiada Butiran"}\n\n*Jumlah Upah:* RM ${finalServicesTotal}\n*Pelanggan:* ${data.Customer_Name} (${custPhone})\n\nSila semak butiran di atas. Tekan butang di bawah untuk menerima atau menolak pesanan ini.`;
    sendWhatsAppInteractive(hubPhone, hubMsg, [
      { id: `HUB_ACCEPT|${altId}`, title: "Terima Pesanan" },
      { id: `HUB_REJECT|${altId}`, title: "Tolak Pesanan" }
    ]);
  }

  return sendJSON({ status: "success", alteration_id: altId });
}

function sendJSON(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }

// --- SECURITY UPGRADE: 8-CHARACTER RANDOMNESS ---
function generateAlterationId() {
  const date = new Date(); const month = ("0" + (date.getMonth() + 1)).slice(-2); const year = date.getFullYear().toString().slice(-2); 
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let randomStr = ''; 
  for (let i = 0; i < 8; i++) { randomStr += chars.charAt(Math.floor(Math.random() * chars.length)); } 
  return `ALT-${month}${year}-${randomStr}`;
}

function sendWhatsAppText(toPhone, messageText) {
  const phoneId = AI_CONFIG.PHONE_NUMBER_ID;
  const token = AI_CONFIG.META_TOKEN;
  if (!phoneId || !token) {
    console.warn("Meta credentials missing. Skipping WhatsApp send to: " + toPhone);
    return null;
  }

  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "text",
    text: { body: messageText }
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": `Bearer ${token}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    console.log("WA Send Response: " + response.getContentText());
    return JSON.parse(response.getContentText());
  } catch (e) {
    console.error("WA Send Error: " + e.toString());
    return null;
  }
}

/**
 * Sends an interactive WhatsApp message with up to 3 quick-reply buttons.
 * @param {string} toPhone - The recipient's phone number.
 * @param {string} bodyText - The main message text.
 * @param {Array} buttons - Array of button objects: [{ id: "PAYLOAD_ID", title: "Button Text" }] (Max 3, Max 20 chars per title).
 */
function sendWhatsAppInteractive(toPhone, bodyText, buttons) {
  const url = `https://graph.facebook.com/v18.0/${AI_CONFIG.PHONE_NUMBER_ID}/messages`;

  // Format the buttons into Meta's required JSON structure
  const formattedButtons = buttons.map(btn => ({
    type: "reply",
    reply: {
      id: btn.id,
      title: btn.title
    }
  }));

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: bodyText
      },
      action: {
        buttons: formattedButtons
      }
    }
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "Authorization": `Bearer ${AI_CONFIG.META_TOKEN}`
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    console.log("WA Interactive Response:", response.getContentText());
    return JSON.parse(response.getContentText());
  } catch (e) {
    console.error("WA Interactive Error:", e.toString());
    return null;
  }
}

function sendWhatsAppTemplate(toPhone, templateName, languageCode, components = []) {
  const phoneId = AI_CONFIG.PHONE_NUMBER_ID;
  const token = AI_CONFIG.META_TOKEN;
  if (!phoneId || !token) return null;

  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: components
    }
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": `Bearer ${token}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    console.log("WA Template Send Response: " + response.getContentText());
    return JSON.parse(response.getContentText());
  } catch (e) {
    console.error("WA Template Send Error: " + e.toString());
    return null;
  }
}

function parseMessageWithGemini(incomingText) {
  const apiKey = AI_CONFIG.GEMINI_API_KEY;
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

  const systemPrompt = `You are the Arabista HQ AI Switchboard Dispatcher.
Analyze the user's message and extract the intent into STRICT JSON format.
Possible intents: 
1. "CUSTOMER_ACTIVATION" (User is asking to activate live tracking for an order)
2. "CUSTOMER_FOLLOWUP" (User is following up on an existing order)
3. "HUB_ACCEPT" (Tailor says they can do the job, e.g., 'TERIMA', 'Boleh')
4. "HUB_REJECT" (Tailor cannot do the job)
5. "HUB_COMPLETED" (Tailor finished sewing, e.g., 'SIAP', 'Dah siap')
6. "CHECK_WALLET" (Tailor is asking to check their unpaid earnings, commission, or wallet balance)
7. "CHECK_QUEUE" (Tailor is asking about their current workload, pending orders, or if they have any jobs today, e.g., 'Ada order tak?', 'Check queue')
8. "UNKNOWN" (Messy/confusing tailor reply with conditions or questions)

Output JSON schema:
{
  "intent": "...",
  "order_id": "ALT-XXXX (extract if present, otherwise null)",
  "needs_admin_review": boolean (true if UNKNOWN or complex condition),
  "summary": "Short english summary of what they said"
}`;

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: incomingText }] }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());
    
    if (data.error) {
      return { intent: "ERROR", needs_admin_review: true, summary: "Gemini API Error: " + data.error.message };
    }

    let rawJson = data.candidates[0].content.parts[0].text;
    rawJson = rawJson.replace(/```json/gi, '').replace(/```/gi, '').trim();

    const parsed = JSON.parse(rawJson);
    
    // Strict boolean enforcement
    if (String(parsed.needs_admin_review).toLowerCase() === "false") {
        parsed.needs_admin_review = false;
    } else if (String(parsed.needs_admin_review).toLowerCase() === "true") {
        parsed.needs_admin_review = true;
    }

    return parsed;
  } catch (e) {
    return { intent: "ERROR", needs_admin_review: true, summary: "Parser Exception: " + e.toString() };
  }
}

function flagOrderForAdmin(orderId, summary) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Incoming_Orders");
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(orderId).trim()) {
      // Highlight row in red to alert Arabista HQ
      sheet.getRange(i + 1, 1, 1, sheet.getLastColumn()).setBackground("#ffe6e6");
      // Append Admin Note to Column AE (Admin_Notes)
      sheet.getRange(i + 1, 31).setValue("ADMIN REVIEW REQUIRED: " + summary);
      break;
    }
  }
}

function processWhatsAppIntent(senderPhone, aiAnalysis, isHub = false) {
  if (!aiAnalysis) return;
  const orderId = aiAnalysis.order_id;
  const intent = aiAnalysis.intent;
  const needsAdmin = aiAnalysis.needs_admin_review;

  // 1. Fallback for messy/confusing messages
  if (needsAdmin === true || intent === "UNKNOWN" || intent === "ERROR") {
    if (intent === "ERROR") {
      console.error("WhatsApp AI / parser error: " + (aiAnalysis.summary || ""));
    }
    const errorMsg = isHub 
      ? "⚠️ Mesej tidak jelas. Sila hubungi Admin HQ untuk bantuan lanjut."
      : "⚠️ Maaf, mesej anda tidak dapat diproses secara automatik. Admin Arabista HQ akan menyemak dan menghubungi anda sebentar lagi.";
    sendWhatsAppText(senderPhone, errorMsg);
    if (orderId) flagOrderForAdmin(orderId, aiAnalysis.summary);
    return;
  }

  // Wallet balance: no order ID required — handle before order lookup.
  if (intent === "CHECK_WALLET") {
    if (!isHub) {
      sendWhatsAppText(senderPhone, "⚠️ Fungsi ini khas untuk akaun Hub/Tailor sahaja.");
      return;
    }

    // Reverse-lookup the Hub Name using their phone number
    const ssWallet = SpreadsheetApp.getActiveSpreadsheet();
    let hubName = "";
    const hubSheetWallet = ssWallet.getSheetByName("Active_Hubs");
    if (hubSheetWallet) {
      const hData = hubSheetWallet.getDataRange().getValues();
      let cleanSender = String(senderPhone).replace(/\D/g, '');
      if (cleanSender.startsWith('0')) cleanSender = '6' + cleanSender;
      for (let h = 1; h < hData.length; h++) {
        let hp = String(hData[h][3]).replace(/\D/g, '');
        if (hp.startsWith('0')) hp = '6' + hp;
        if (hp === cleanSender) { hubName = String(hData[h][1]).trim(); break; }
      }
    }

    if (!hubName) {
      sendWhatsAppText(senderPhone, "⚠️ Akaun Hub anda tidak ditemui.");
      return;
    }

    let walletBalance = 0;
    const ledgerSheet = ssWallet.getSheetByName("Hub_Ledger");
    if (ledgerSheet) {
      const lData = ledgerSheet.getDataRange().getValues();
      for (let i = 1; i < lData.length; i++) {
        if (String(lData[i][1]).trim() === hubName && String(lData[i][5]).trim() === "UNPAID") {
          walletBalance += parseFloat(lData[i][4]) || 0;
        }
      }
    }

    const msg = `*[DOMPET HUB]*\nHub: ${hubName}\n\nBaki Upah Belum Dibayar: *RM ${walletBalance.toFixed(2)}*\n\nPembayaran akan diproses terus ke akaun bank anda mengikut jadual pembayaran Arabista.`;
    sendWhatsAppText(senderPhone, msg);
    return;
  }
  else if (intent === "CHECK_QUEUE") {
    if (!isHub) { sendWhatsAppText(senderPhone, "⚠️ Fungsi ini khas untuk akaun Hub/Tailor sahaja."); return; }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let hubName = "";
    const hubSheet = ss.getSheetByName("Active_Hubs");
    if (hubSheet) {
       const hData = hubSheet.getDataRange().getDisplayValues();
       let cleanSender = String(senderPhone).replace(/\D/g, '');
       if (cleanSender.startsWith('0')) cleanSender = '6' + cleanSender;
       for (let h = 1; h < hData.length; h++) {
           let hp = String(hData[h][3]).replace(/\D/g, '');
           if (hp.startsWith('0')) hp = '6' + hp;
           if (hp === cleanSender) { hubName = String(hData[h][1]).trim(); break; }
       }
    }
    if (!hubName) { sendWhatsAppText(senderPhone, "⚠️ Akaun Hub anda tidak ditemui."); return; }

    let pending = 0, inProgress = 0, awaiting = 0;
    const orderSheet = ss.getSheetByName("Incoming_Orders");
    if (orderSheet) {
       const oData = orderSheet.getDataRange().getValues();
       for (let i = 1; i < oData.length; i++) {
           if (String(oData[i][10]).trim() === hubName) {
               const status = String(oData[i][13]).trim();
               if (status === "Pending Approval") pending++;
               else if (status === "In Progress") inProgress++;
               else if (status === "Awaiting Drop-off" || status === "Awaiting Hub Drop-off") awaiting++;
           }
       }
    }
    const msg = `*[STATUS PESANAN HUB]*\nHub: ${hubName}\n\nMenunggu Kelulusan: *${pending}*\nMenunggu Baju Tiba: *${awaiting}*\nSedang Dijahit: *${inProgress}*\n\n_Log masuk ke Portal Hub untuk butiran lanjut._`;
    sendWhatsAppText(senderPhone, msg);
    return;
  }

  if (!orderId) {
    sendWhatsAppText(senderPhone, "Sila nyatakan ID Pesanan (contoh: ALT-1234) untuk semakan.");
    return;
  }

  // 2. Fetch Order Data
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Incoming_Orders");
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  let orderData = null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(orderId).trim()) {
      rowIndex = i + 1;
      orderData = data[i];
      break;
    }
  }

  if (rowIndex === -1) {
    sendWhatsAppText(senderPhone, `Pesanan ${orderId} tidak dijumpai dalam sistem.`);
    return;
  }

  const currentStatus = String(orderData[13]).trim(); // Column N (Order_Status)
  const inboundMode = orderData[14];   // Column O (Inbound_Mode)
  const custPhone = orderData[5];      // Column F (Phone_No)

  // Strict Transition Enforcement
  if (intent === "HUB_ACCEPT" && currentStatus !== "Pending Approval") {
    sendWhatsAppText(senderPhone, `⚠️ Ralat: Pesanan ini berstatus '${currentStatus}'. Hanya pesanan 'Pending Approval' boleh diterima.`);
    return;
  }
  if (intent === "HUB_RECEIVED_BAJU" && currentStatus !== "Awaiting Drop-off" && currentStatus !== "Awaiting Hub Drop-off" && currentStatus !== "Pending Dropoff" && currentStatus !== "Inbound Dispatched") {
    sendWhatsAppText(senderPhone, `⚠️ Ralat: Baju tidak boleh diterima pada status '${currentStatus}'. Sila pastikan status adalah 'Awaiting Drop-off'.`);
    return;
  }
  if (intent === "HUB_COMPLETED" && currentStatus !== "In Progress") {
    sendWhatsAppText(senderPhone, `⚠️ Ralat: Sila sahkan penerimaan baju (Butang: Baju Diterima) terlebih dahulu sebelum menekan butang ini.`);
    return;
  }
  if (intent === "HUB_HANDED_OVER" && currentStatus !== "Ready for Return") {
    sendWhatsAppText(senderPhone, `⚠️ Ralat: Sila sahkan baju 'Siap Dijahit' terlebih dahulu.`);
    return;
  }

  // 3. Execute Intent Logic
  if (intent === "CUSTOMER_ACTIVATION" || intent === "CUSTOMER_FOLLOWUP") {
    if (isHub) {
        const portalUrl = `https://arabistaofficial.com/hub-portal.html`;
        const msg = `*[MAKLUMAN HUB]*\n- *Pesanan:* ${orderId}\n- *Status Semasa:* ${currentStatus}\n\nSila log masuk ke Hub Portal untuk menguruskan pesanan ini:\n${portalUrl}`;
        sendWhatsAppText(senderPhone, msg);
    } else {
        const trackerUrl = `https://arabistaofficial.com/alteration-tracker-staging.html?id=${orderId}`;
        const msg = `*[ARABISTA ALTERATION ORDER]*\n- *Order:* ${orderId}\n- *Status:* ${currentStatus}\n\nTrack your live order status here:\n${trackerUrl}`;
        sendWhatsAppText(senderPhone, msg);
    }
  }
  else if (intent === "HUB_ACCEPT") {
    const isLalamove = String(inboundMode).toLowerCase().includes("lalamove");
    const newStatus = isLalamove ? "Awaiting Dispatch" : "Pending Dropoff";

    sheet.getRange(rowIndex, 14).setValue(newStatus); // Order_Status column N
    sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).setBackground(null);
    // Clear any red background

    if (!isLalamove) {
      // Walk-in Flow: Immediately push the "Baju Diterima" interactive button to the Hub
      const hubMsg = `*[STATUS: MENUNGGU PELANGGAN]*\nPesanan: ${orderId}\n\nPelanggan akan hadir ke kedai anda untuk menghantar baju. Sila pastikan ukuran pelanggan diambil.\n\nSila tekan butang di bawah *hanya selepas* pelanggan menyerahkan baju tersebut secara fizikal.`;
      sendWhatsAppInteractive(senderPhone, hubMsg, [
        { id: `HUB_RECEIVED|${orderId}`, title: "Baju Diterima" }
      ]);

      // Customer Flow (Walk-in): English text with instructions to navigate via Tracker
      const custMsg = `✅ *[ORDER ACCEPTED]*\nThe Hub has accepted your alteration order (${orderId}).\n\nPlease drop off your item(s) at the Hub. You can view the Hub's address and get GPS navigation directions directly from your tracker:\n🔗 https://arabistaofficial.com/alteration-tracker-staging.html?id=${orderId}`;
      sendWhatsAppText(custPhone, custMsg);
    } else {
      // Lalamove Flow: Hub waits for customer to book the inbound rider
      sendWhatsAppText(senderPhone, `✅ Pesanan ${orderId} diterima. Menunggu pelanggan menempah rider.`);

      // Customer Flow (Lalamove): English text with instructions to book rider via Tracker
      const custMsg = `✅ *[ORDER ACCEPTED]*\nThe Hub has accepted your alteration order (${orderId}).\n\nPlease click your tracker link below to proceed with booking your Lalamove inbound delivery:\n🔗 https://arabistaofficial.com/alteration-tracker-staging.html?id=${orderId}`;
      sendWhatsAppText(custPhone, custMsg);
    }
  }
  else if (intent === "HUB_RECEIVED_BAJU") {
    sheet.getRange(rowIndex, 14).setValue("In Progress");

    let cleanCustomerPhone = String(orderData[5]).replace(/\D/g, ''); // Col 6 = Phone_No
    if (cleanCustomerPhone.startsWith('0')) cleanCustomerPhone = '6' + cleanCustomerPhone;

    const msg = `*[STATUS: SEDANG DIJAHIT]*\nPesanan: ${orderId}\n\nTerima kasih. Baju telah disahkan terima. Sila mulakan proses alterasi.\n\n📞 *Hubungi Pelanggan:* https://wa.me/${cleanCustomerPhone} (Jika ada pertanyaan)\n\nApabila semua jahitan telah siap, sila tekan butang di bawah untuk memaklumkan pelanggan.`;
    sendWhatsAppInteractive(senderPhone, msg, [
      { id: `HUB_COMPLETED|${orderId}`, title: "Siap Dijahit" }
    ]);

    const trackerUrl = `https://arabistaofficial.com/alteration-tracker-staging.html?id=${orderId}`;
    const custMsg = `*[ITEM RECEIVED]*\nOrder: ${orderId}\n\nYour garment has safely arrived at the hub! Our tailor is now beginning the alteration process. We will notify you the moment it is ready.\n🔗 ${trackerUrl}`;
    sendWhatsAppText(custPhone, custMsg);
    touchDbUpdate();
  }
  else if (intent === "HUB_COMPLETED") {
    sheet.getRange(rowIndex, 14).setValue("Ready for Return");
    sendWhatsAppText(senderPhone, `✅ Status dikemaskini: Sedia untuk dipulangkan.`);

    const custMsg = `*[ALTERATION COMPLETE]*\nOrder: ${orderId}\n\nGood news!\nYour garment is ready.\n\nPlease click the link below to proceed with your payment and choose how you would like to receive your item (Lalamove or Self-Pickup).\n🔗 https://arabistaofficial.com/alteration-tracker-staging.html?id=${orderId}`;
    sendWhatsAppText(custPhone, custMsg);
  }
  else if (intent === "HUB_HANDED_OVER") {
    const outboundChoice = String(orderData[22]).trim();
    if (outboundChoice.toLowerCase() === "lalamove") {
      sendWhatsAppText(senderPhone, `⚠️ Tindakan tidak sah. Pesanan ini menggunakan Lalamove. Sistem akan auto-update apabila rider selesai.`);
      return;
    }

    sheet.getRange(rowIndex, 14).setValue("Completed");

    try {
      const hubNameForLedger = String(orderData[10]).trim();
      const itemDetailsForLedger = String(orderData[12]).trim();
      recordHubPayoutToLedger(orderId, hubNameForLedger, itemDetailsForLedger);
    } catch (e) {
      Logger.log("Failed to write to Hub Ledger: " + e.message);
    }

    const trackerUrl = `https://arabistaofficial.com/alteration-tracker-staging.html?id=${orderId}`;
    sendWhatsAppText(senderPhone, `*[SELESAI: PESANAN DITUTUP]*\nPesanan: ${orderId}\n\nTerima kasih! Baju telah berjaya diserahkan dan pesanan ini ditutup sepenuhnya. Upah anda akan diproses ke dalam akaun.`);
    const custMsg = `*[ORDER COMPLETED]*\nOrder: ${orderId}\n\nYour garment has been successfully handed over, and this order is now officially closed. Thank you for choosing Arabista!\n🔗 ${trackerUrl}`;
    sendWhatsAppText(custPhone, custMsg);
    touchDbUpdate();
  }
}

function handleWhatsAppWebhook(data) {
  const cache = CacheService.getScriptCache();
  try {
    const entry = data.entry[0];
    const changes = entry.changes[0].value;

    if (changes.messages && changes.messages.length > 0) {
      const msg = changes.messages[0];
      const messageId = msg.id; // Unique ID from Meta

      // DEDUPLICATION GUARD: If we saw this ID in the last 60 seconds, stop immediately.
      if (cache.get(messageId)) {
        console.log("Duplicate message ignored: " + messageId);
        return;
      }
      cache.put(messageId, "processed", 60);

      const senderPhone = msg.from;

      if (msg.type === "text") {
        const incomingText = msg.text.body;
        console.log(`Received message from ${senderPhone}: ${incomingText}`);

        // UX UPDATE: Option A - Phone Number Mapping to bypass manual Order ID entry
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ss.getSheetByName("Incoming_Orders");
        const allData = sheet ? sheet.getDataRange().getValues() : [];
        let activeOrders = [];
        // Strip non-digits and standardize to '60...' for matching
        let cleanSender = String(senderPhone).replace(/\D/g, '');
        if (cleanSender.startsWith('0')) cleanSender = '6' + cleanSender;
        
        // --- NEW: HUB DETECTION ---
        let isHub = false;
        let hubNameForSender = "";
        const hubSheet = ss.getSheetByName("Active_Hubs");
        if (hubSheet) {
            const hubData = hubSheet.getDataRange().getValues();
            for (let h = 1; h < hubData.length; h++) {
                let hPhone = String(hubData[h][3]).replace(/\D/g, ''); // col 4 Phone
                if (hPhone.startsWith('0')) hPhone = '6' + hPhone;
                if (hPhone === cleanSender) {
                    isHub = true;
                    hubNameForSender = String(hubData[h][1]).trim();
                    break;
                }
            }
        }

        for (let i = 1; i < allData.length; i++) {
            let status = String(allData[i][13]).trim(); // col 14 Order_Status
            if (["Completed", "CANCELED", "REJECTED"].includes(status)) continue;

            if (isHub) {
                let rowHubName = String(allData[i][10]).trim(); // col 11 Hub_Name
                if (rowHubName === hubNameForSender) {
                    activeOrders.push(String(allData[i][1]).trim());
                }
            } else {
                let rowPhone = String(allData[i][5]).replace(/\D/g, ''); // col 6 Phone_No
                if (rowPhone.startsWith('0')) rowPhone = '6' + rowPhone;
                if (rowPhone === cleanSender) {
                    activeOrders.push(String(allData[i][1]).trim());
                }
            }
        }
        
        let aiAnalysis;
        const lowerText = incomingText.toLowerCase();
        // Bypass AI for the standard activation template
        if (lowerText.includes("activate live tracking")) {
            aiAnalysis = { intent: "CUSTOMER_ACTIVATION", needs_admin_review: false, summary: "Auto-detected tracking request" };
        } else {
            aiAnalysis = parseMessageWithGemini(incomingText);
        }
        if (activeOrders.length === 1) {
            // Exactly one active order - bypass Gemini ID extraction entirely
            aiAnalysis.order_id = activeOrders[0];
            console.log("Auto-mapped to single active order:", aiAnalysis.order_id);
            processWhatsAppIntent(senderPhone, aiAnalysis, isHub);
        } else if (activeOrders.length > 1) {
            // Multiple orders: Check if they typed the specific ID, otherwise prompt them
            if (aiAnalysis.order_id && activeOrders.includes(aiAnalysis.order_id)) {
                processWhatsAppIntent(senderPhone, aiAnalysis, isHub);
            } else {
                const multiMsg = isHub 
                    ? "Terdapat pelbagai pesanan aktif di hub anda. Sila nyatakan ID Pesanan yang spesifik (contoh: ALT-1234)."
                    : "I see you have multiple active alteration orders! Please reply with the specific Order ID you are inquiring about (e.g., ALT-1234).";
                sendWhatsAppText(senderPhone, multiMsg);
            }
        } else {
            // Treat as new inquiry or fallback to Gemini
            console.log("Gemini Analysis (No Active Mapping):", aiAnalysis);
            processWhatsAppIntent(senderPhone, aiAnalysis, isHub);
        }
      }
      else if (msg.type === "interactive") {
        // Extract the hidden payload from the button click
        const payload = msg.interactive.button_reply.id;
        console.log(`Received button click from ${senderPhone}: ${payload}`);

        // Payloads are formatted as "ACTION|ORDER_ID" (e.g., "HUB_ACCEPT|ALT-1234")
        const parts = payload.split('|');
        const action = parts[0];
        const orderId = parts.length > 1 ? parts[1] : null;

        // Route to the strict state machine
        processInteractivePayload(senderPhone, action, orderId);
      }
    }
  } catch (e) {
    console.error("Webhook processing error: " + e.toString());
  }
}

/**
 * Processes interactive button payloads strictly based on the current order status.
 * Prevents "time travel" by ensuring actions only execute at the correct stage.
 */
function processInteractivePayload(phone, action, orderId) {
  console.log(`[STATE MACHINE] Action: ${action} | Order: ${orderId}`);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Incoming_Orders");
  if (!sheet) return { success: false, message: "Incoming_Orders sheet not found." };

  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  let orderData = null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(orderId).trim()) {
      rowIndex = i + 1;
      orderData = data[i];
      break;
    }
  }

  if (rowIndex === -1) {
    const msg = `⚠️ Ralat: Pesanan ${orderId} tidak dijumpai dalam pangkalan data.`;
    sendWhatsAppText(phone, msg);
    return { success: false, message: msg };
  }

  const currentStatus = String(orderData[13]).trim(); // Col 14: Order_Status
  const inboundMode   = String(orderData[14]).trim(); // Col 15: Inbound_Mode
  const custPhone     = String(orderData[5]).trim();  // Col 6: Phone_No
  const outboundChoice= String(orderData[22]).trim(); // Col 23: Outbound_Choice

  const trackerUrl = `https://arabistaofficial.com/alteration-tracker-staging.html?id=${orderId}`;

  // Helper for invalid states (Time Travel Guard)
  const sendInvalidState = () => {
    const msg = `⚠️ Tindakan tidak sah. Pesanan ${orderId} kini berada di status: ${currentStatus}.`;
    sendWhatsAppText(phone, msg);
    return { success: false, message: msg };
  };

  // ----------------------------------------------------------------------
  // STATE 1: HUB_ACCEPT or HUB_REJECT
  // ----------------------------------------------------------------------
  if (action === "HUB_ACCEPT" || action === "HUB_REJECT") {
    if (currentStatus !== "Pending Approval") return sendInvalidState();

    if (action === "HUB_REJECT") {
      sheet.getRange(rowIndex, 14).setValue("REJECTED");
      sendWhatsAppText(phone, `*[SELESAI: PESANAN DITOLAK]*\nPesanan: ${orderId}\n\nTerima kasih. Pesanan ini telah ditolak.`);

      const custMsg = `*[HUB UNAVAILABLE]*\nOrder: ${orderId}\n\nUnfortunately, your selected hub is currently at full capacity and cannot accept your order right now.\n\nPlease click the link below to select a different hub for your alteration:\n🔗 ${trackerUrl}`;
      sendWhatsAppText(custPhone, custMsg);
      touchDbUpdate();
      return { success: true };
    }

    if (action === "HUB_ACCEPT") {
      sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).setBackground(null); // Clear red flag
      
      const isLalamove = (inboundMode.toLowerCase().includes("lalamove"));
      const newStatus = isLalamove ? "Awaiting Dispatch" : "Pending Dropoff";
      sheet.getRange(rowIndex, 14).setValue(newStatus);

      if (!isLalamove) {
        // TP2B: Drop-off Inbound (Hub Message)
        const hubMsg = `*[STATUS: MENUNGGU PELANGGAN]*\nPesanan: ${orderId}\n\nPelanggan akan hadir ke kedai anda untuk menghantar baju. Sila pastikan ukuran pelanggan diambil.\n\nSila tekan butang di bawah *hanya selepas* pelanggan menyerahkan baju tersebut secara fizikal.`;
        sendWhatsAppInteractive(phone, hubMsg, [
          { id: `HUB_RECEIVED|${orderId}`, title: "Baju Diterima" }
        ]);
      } else {
         // Hub gets officially notified later when customer books the rider
         sendWhatsAppText(phone, `✅ Pesanan ${orderId} diterima. Menunggu pelanggan menempah rider.`);
      }

      // TP2: Hub Approved (Customer Message)
      const custMsg = `*[ACTION REQUIRED]*\nOrder: ${orderId}\n\nGreat news! The hub has accepted your order.\n\nPlease click the link below to choose your inbound delivery method (Lalamove or Hub Drop-off) and send your garment to the tailor.\n🔗 ${trackerUrl}`;
      sendWhatsAppText(custPhone, custMsg);
      touchDbUpdate();
      return { success: true };
    }
  }

  // ----------------------------------------------------------------------
  // STATE 2: HUB_RECEIVED (Garments Arrived)
  // ----------------------------------------------------------------------
  else if (action === "HUB_RECEIVED") {
    const okReceive = ["Pending Dropoff", "Inbound Dispatched", "Awaiting Drop-off", "Awaiting Hub Drop-off"];
    if (!okReceive.includes(currentStatus)) return sendInvalidState();

    sheet.getRange(rowIndex, 14).setValue("In Progress");

    // TP3: Sewing Phase (Hub Message)
    let cleanCustomerPhone = String(orderData[5]).replace(/\D/g, ''); // Col 6 = Phone_No
    if (cleanCustomerPhone.startsWith('0')) cleanCustomerPhone = '6' + cleanCustomerPhone;

    const hubMsg = `*[STATUS: SEDANG DIJAHIT]*\nPesanan: ${orderId}\n\nTerima kasih. Baju telah disahkan terima. Sila mulakan proses alterasi.\n\n📞 *Hubungi Pelanggan:* https://wa.me/${cleanCustomerPhone} (Jika ada pertanyaan)\n\nApabila semua jahitan telah siap, sila tekan butang di bawah untuk memaklumkan pelanggan.`;
    sendWhatsAppInteractive(phone, hubMsg, [
      { id: `HUB_COMPLETED|${orderId}`, title: "Siap Dijahit" }
    ]);

    // TP3: Garments Received (Customer Message)
    const custMsg = `*[ITEM RECEIVED]*\nOrder: ${orderId}\n\nYour garment has safely arrived at the hub! Our tailor is now beginning the alteration process. We will notify you the moment it is ready.\n🔗 ${trackerUrl}`;
    sendWhatsAppText(custPhone, custMsg);
    touchDbUpdate();
    return { success: true };
  }

  // ----------------------------------------------------------------------
  // STATE 3: HUB_COMPLETED (Sewing Finished)
  // ----------------------------------------------------------------------
  else if (action === "HUB_COMPLETED") {
    if (currentStatus !== "In Progress") return sendInvalidState();

    sheet.getRange(rowIndex, 14).setValue("Ready for Return");

    sendWhatsAppText(phone, `✅ Status dikemaskini: Sedia untuk dipulangkan. Menunggu pelanggan membuat bayaran.`);

    // TP4: Sewing Complete (Customer Message)
    const custMsg = `*[ALTERATION COMPLETE]*\nOrder: ${orderId}\n\nGood news! Your garment is ready.\n\nPlease click the link below to proceed with your payment and choose how you would like to receive your item (Lalamove or Self-Pickup).\n🔗 ${trackerUrl}`;
    sendWhatsAppText(custPhone, custMsg);
    touchDbUpdate();
    return { success: true };
  }

  // ----------------------------------------------------------------------
  // STATE 4: HUB_HANDED_OVER (Self-Pickup Completed)
  // ----------------------------------------------------------------------
  else if (action === "HUB_HANDED_OVER") {
    if (currentStatus !== "Ready for Return") return sendInvalidState();
    
    // SECURITY: Prevent Hub from handing over if Lalamove is handling it
    if (outboundChoice.toLowerCase() === "lalamove") {
      const msg = `⚠️ Tindakan tidak sah. Pesanan ini menggunakan Lalamove. Sistem akan auto-update apabila rider selesai.`;
      sendWhatsAppText(phone, msg);
      return { success: false, message: msg };
    }

    sheet.getRange(rowIndex, 14).setValue("Completed");

    // TRIGGER FINANCIAL PAYOUT TO LEDGER
    try {
      const hubNameForLedger = String(orderData[10]).trim(); // Col 11: Hub_Name
      const itemDetailsForLedger = String(orderData[12]).trim(); // Col 13: Item_Details
      recordHubPayoutToLedger(orderId, hubNameForLedger, itemDetailsForLedger);
    } catch (e) {
      Logger.log("Failed to write to Hub Ledger: " + e.message);
    }

    // TP6: Final Closure (Hub Message)
    sendWhatsAppText(phone, `*[SELESAI: PESANAN DITUTUP]*\nPesanan: ${orderId}\n\nTerima kasih! Baju telah berjaya diserahkan dan pesanan ini ditutup sepenuhnya. Upah anda akan diproses ke dalam akaun.`);

    // TP6: Order Completed (Customer Message)
    const custMsg = `*[ORDER COMPLETED]*\nOrder: ${orderId}\n\nYour garment has been successfully handed over, and this order is now officially closed. Thank you for choosing Arabista!\n🔗 ${trackerUrl}`;
    sendWhatsAppText(custPhone, custMsg);
    touchDbUpdate();
    return { success: true };
  }

  // ----------------------------------------------------------------------
  // STATE 5: CUST_RECEIVED (Customer manual override for Outbound)
  // ----------------------------------------------------------------------
  else if (action === "CUST_RECEIVED") {
    if (currentStatus === "Completed") return { success: true }; // Already done

    // Only allow manual receipt if an outbound process is actually active
    if (currentStatus !== "Outbound Dispatched" && currentStatus !== "Ready for Return") {
      const msg = `Order ${orderId} is currently in status: ${currentStatus}. You can only mark it as received once it has been dispatched.`;
      sendWhatsAppText(phone, msg);
      return { success: false, message: msg };
    }

    // Force statuses to completion
    sheet.getRange(rowIndex, 14).setValue("Completed");    // Order_Status
    sheet.getRange(rowIndex, 26).setValue("COMPLETED");    // Outbound_Lala_Status (Col Z)

    // TRIGGER FINANCIAL PAYOUT TO LEDGER
    try {
      const hubNameForLedger = String(orderData[10]).trim(); // Col 11: Hub_Name
      const itemDetailsForLedger = String(orderData[12]).trim(); // Col 13: Item_Details
      recordHubPayoutToLedger(orderId, hubNameForLedger, itemDetailsForLedger);
    } catch (e) {
      Logger.log("Failed to write to Hub Ledger: " + e.message);
    }

    // TP6: Final Closure (Customer Message)
    const custMsg = `*[ORDER COMPLETED]*\nOrder: ${orderId}\n\nThank you for confirming! Your order is now officially closed. We hope you love your newly altered garment!\n🔗 ${trackerUrl}`;
    sendWhatsAppText(phone, custMsg);

    // TP6: Final Closure (Hub Message)
    let hubPhone = "";
    const hubName = String(orderData[10]).trim(); // Col 11
    const hubSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Active_Hubs");
    if (hubSheet) {
      const hData = hubSheet.getDataRange().getDisplayValues();
      for (let h = 1; h < hData.length; h++) {
        if (hData[h][1] === hubName) { hubPhone = hData[h][3]; break; }
      }
    }

    if (hubPhone) {
      const hubMsg = `*[SELESAI: PESANAN DITUTUP]*\nPesanan: ${orderId}\n\nPelanggan telah mengesahkan penerimaan baju secara manual. Pesanan ini ditutup sepenuhnya. Upah anda akan diproses.`;
      sendWhatsAppText(hubPhone, hubMsg);
    }

    touchDbUpdate();
    return { success: true };
  }

  // ----------------------------------------------------------------------
  // UNKNOWN ACTION
  // ----------------------------------------------------------------------
  else {
    console.warn("Unknown interactive action:", action);
    return { success: false, message: "Unknown action" };
  }
}

// ============================================================================
// FINANCIAL ENGINE: HUB PAYOUT LEDGER
// ============================================================================
function recordHubPayoutToLedger(orderId, hubName, itemDetails) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ledgerSheet = ss.getSheetByName("Hub_Ledger");
  if (!ledgerSheet) return;

  // 1. Fetch Wholesale Pricing Mapping
  const pricingSheet = ss.getSheetByName("Pricing");
  let payoutMap = {};
  if (pricingSheet) {
    const pData = pricingSheet.getDataRange().getValues();
    for (let i = 1; i < pData.length; i++) {
      const serviceName = String(pData[i][0]).trim();
      const payoutAmount = parseFloat(pData[i][4]) || 0; // Col E (Index 4) = Tailor_Payout
      if (serviceName) payoutMap[serviceName] = payoutAmount;
    }
  }

  // Fallbacks if Pricing sheet is missing or column is empty
  const getPayout = (name, fallback) => payoutMap[name] !== undefined && payoutMap[name] > 0 ? payoutMap[name] : fallback;
  const rates = {
    full: getPayout("Full Body", 30),
    hem: getPayout("Hem", 12),
    sleeve: getPayout("Sleeve", 12), // Tracker string match
    shoulder: getPayout("Shoulder", 12), // Tracker string match
    pads: getPayout("Pads", 5)
  };

  // 2. Parse Item_Details to count occurrences of each service
  const text = String(itemDetails || "");
  const fullCount = (text.match(/Full Body/gi) || []).length;
  const hemCount = (text.match(/Hem/gi) || []).length;
  const sleeveCount = (text.match(/Sleeves/gi) || []).length;
  const shoulderCount = (text.match(/Shoulders/gi) || []).length;
  const padsCount = (text.match(/Pads/gi) || []).length;

  // 3. Calculate exact payable amount
  const totalPayout = (fullCount * rates.full) +
                      (hemCount * rates.hem) +
                      (sleeveCount * rates.sleeve) +
                      (shoulderCount * rates.shoulder) +
                      (padsCount * rates.pads);

  if (totalPayout <= 0) return; // Prevent 0 or negative log entries

  // 4. Write Credit to Ledger
  const timestamp = Utilities.formatDate(new Date(), "Asia/Kuala_Lumpur", "yyyy-MM-dd HH:mm:ss");
  ledgerSheet.appendRow([
    timestamp,
    hubName,
    orderId,
    "CREDIT",
    totalPayout,
    "UNPAID"
  ]);

  Logger.log(`Ledger Updated: ${hubName} credited RM ${totalPayout} for ${orderId}`);
}

// ============================================================================
// ADMIN PAYOUT CYCLE ENGINE
// ============================================================================
function runPayoutCycle() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ledgerSheet = ss.getSheetByName("Hub_Ledger");
  const ui = SpreadsheetApp.getUi();

  if (!ledgerSheet) {
    ui.alert("Error: Hub_Ledger sheet not found.");
    return;
  }

  const data = ledgerSheet.getDataRange().getValues();
  let hubDataMap = {};
  let payoutSummary = {};
  let rowsToUpdate = [];
  let totalPayout = 0;

  // 1. Scan Ledger for ALL UNPAID balances and group by Hub
  for (let i = 1; i < data.length; i++) {
    const hubName = String(data[i][1]).trim();
    const amount = parseFloat(data[i][4]) || 0;
    const status = String(data[i][5]).trim();

    if (status === "UNPAID" && amount !== 0) {
      if (!hubDataMap[hubName]) {
        hubDataMap[hubName] = { netTotal: 0, rows: [] };
      }
      hubDataMap[hubName].netTotal += amount;
      hubDataMap[hubName].rows.push(i + 1);
    }
  }

  // 1B. Filter Hubs: Only process Hubs with a Positive Net Balance
  for (const [hub, hData] of Object.entries(hubDataMap)) {
    if (hData.netTotal > 0) {
      payoutSummary[hub] = hData.netTotal;
      totalPayout += hData.netTotal;
      rowsToUpdate = rowsToUpdate.concat(hData.rows);
    }
  }

  if (rowsToUpdate.length === 0) {
    ui.alert("Zero Balance", "There are no Hubs with a positive unpaid net balance.", ui.ButtonSet.OK);
    return;
  }

  // 2. Fetch Bank Info from newly structured Active_Hubs
  const hubSheet = ss.getSheetByName("Active_Hubs");
  let hubBankMap = {};
  if (hubSheet) {
    const hData = hubSheet.getDataRange().getDisplayValues();
    for (let h = 1; h < hData.length; h++) {
      let qrInfo = String(hData[h][13] || "").trim();
      let bankName = String(hData[h][14] || "").trim();
      let bankAcc = String(hData[h][15] || "").trim();

      let bankTextArr = [];
      if (bankName) bankTextArr.push(bankName);
      if (bankAcc) bankTextArr.push(bankAcc);
      let finalBankText = bankTextArr.length > 0 ? bankTextArr.join(" - ") : "Tiada Info Bank";

      let finalQrText = qrInfo ? `=HYPERLINK("${qrInfo}", "📷 View QR")` : "Tiada QR";

      hubBankMap[hData[h][1]] = { bank: finalBankText, qr: finalQrText };
    }
  }

  // 3. Generate Summary Message
  let summaryMsg = "PAYOUT CYCLE SUMMARY:\n\n";
  let reportData = [["Hub Name", "Total Payout (RM)", "Bank Details", "QR Link", "Action: Notify Hub"]];

  for (const [hub, amount] of Object.entries(payoutSummary)) {
    summaryMsg += `• ${hub}: RM ${amount.toFixed(2)}\n`;
    let info = hubBankMap[hub] || { bank: "Tiada Info Bank", qr: "Tiada QR" };
    reportData.push([hub, amount.toFixed(2), info.bank, info.qr, false]);
  }

  summaryMsg += `\nTotal Disbursed: RM ${totalPayout.toFixed(2)}\n\n`;
  summaryMsg += "Do you want to mark these as PAID and generate a transfer report?";

  // 4. Request Admin Confirmation
  const response = ui.alert("Confirm Payout", summaryMsg, ui.ButtonSet.YES_NO);

  if (response == ui.Button.YES) {
    rowsToUpdate.forEach(function (row) {
      ledgerSheet.getRange(row, 6).setValue("PAID");
    });

    // 5. Generate Dedicated Report Sheet
    const dateStr = Utilities.formatDate(new Date(), "Asia/Kuala_Lumpur", "yyyyMMdd_HHmm");
    const reportName = `Payout_${dateStr}`;
    const reportSheet = ss.insertSheet(reportName);

    reportSheet.getRange(1, 1, reportData.length, 5).setValues(reportData);
    reportSheet.getRange("A1:E1").setFontWeight("bold");
    reportSheet.getRange("B:B").setNumberFormat("0.00");

    reportSheet.autoResizeColumns(1, 2);
    reportSheet.setColumnWidth(3, 250);
    reportSheet.setColumnWidth(4, 120);
    reportSheet.setColumnWidth(5, 150);

    // 6. Inject Google Sheets Native Checkboxes in Col 5
    if (reportData.length > 1) {
      reportSheet.getRange(2, 5, reportData.length - 1, 1).insertCheckboxes();
    }

    touchDbUpdate();
    ui.alert("Success", `Ledger updated!\n\nA summary report has been created in: ${reportName}. Make your transfers, then click the checkboxes to notify the tailors!`, ui.ButtonSet.OK);
  }
}

// ============================================================================
// ADMIN: REVERSE / REFUND PAYOUT ENGINE
// ============================================================================
function reversePayout() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ledgerSheet = ss.getSheetByName("Hub_Ledger");

  if (!ledgerSheet) {
    ui.alert("Error", "Hub_Ledger sheet not found.", ui.ButtonSet.OK);
    return;
  }

  const response = ui.prompt("Reverse Payout", "Enter the Alteration ID to refund (e.g., ALT-ABCD-1234):", ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const targetId = response.getResponseText().trim();
  if (!targetId) return;

  const data = ledgerSheet.getDataRange().getValues();
  let foundOriginal = false;
  let originalAmount = 0;
  let hubName = "";

  // Find the original CREDIT line for this order
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][2]).trim() === targetId && String(data[i][3]).trim() === "CREDIT") {
      hubName = String(data[i][1]).trim();
      originalAmount = parseFloat(data[i][4]);
      foundOriginal = true;
      break;
    }
  }

  if (!foundOriginal) {
    ui.alert("Not Found", `No original payout CREDIT found for order ${targetId}.`, ui.ButtonSet.OK);
    return;
  }

  const confirm = ui.alert("Confirm Reversal", `Original payout found for ${hubName} (RM ${originalAmount.toFixed(2)}).\n\nDo you want to inject a negative DEBIT to balance this account?`, ui.ButtonSet.YES_NO);

  if (confirm === ui.Button.YES) {
    const timestamp = Utilities.formatDate(new Date(), "Asia/Kuala_Lumpur", "yyyy-MM-dd HH:mm:ss");
    ledgerSheet.appendRow([
      timestamp,
      hubName,
      targetId,
      "DEBIT (REFUND)",
      -originalAmount,
      "UNPAID"
    ]);
    ui.alert("Success", `A DEBIT of -RM ${originalAmount.toFixed(2)} has been applied to ${hubName}'s ledger. It will be deducted in the next payout cycle.`, ui.ButtonSet.OK);
  }
}

// ============================================================================
// SMART CHECKBOX TRIGGER (INSTALLABLE ON-EDIT)
// ============================================================================
function onEditTrigger(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();

  // Guard: Only run if the user is editing a dynamically generated Payout sheet
  if (!sheetName.startsWith("Payout_")) return;

  const col = e.range.getColumn();
  const row = e.range.getRow();

  // Guard: Only trigger on Column 5 (Action) and ignore the header row
  if (col === 5 && row > 1) {
    if (e.value === "TRUE") { // Checkbox was clicked
      const hubName = sheet.getRange(row, 1).getValue();
      const amount = sheet.getRange(row, 2).getValue();
      const ss = e.source;

      const hubSheet = ss.getSheetByName("Active_Hubs");
      let hubPhone = "";
      if (hubSheet) {
        const hData = hubSheet.getDataRange().getDisplayValues();
        for (let h = 1; h < hData.length; h++) {
          if (hData[h][1] === hubName) { hubPhone = hData[h][3]; break; }
        }
      }

      if (!hubPhone) {
        e.range.uncheck(); // Revert check if no phone found
        return;
      }

      const formattedAmount = parseFloat(amount).toFixed(2);
      const msg = `*[MAKLUMAN PEMBAYARAN]*\nHub: ${hubName}\n\nPengurusan Arabista telah membuat pindahan wang sebanyak *RM ${formattedAmount}* ke akaun bank anda untuk upah alterasi.\n\nSila semak penyata bank anda. Terima kasih atas kerjasama anda!`;

      try {
        sendWhatsAppText(hubPhone, msg);
        // Transform checkbox into permanent text
        e.range.clearDataValidations();
        e.range.setValue("✅ NOTIFIED");
        e.range.setFontColor("#15803d").setFontWeight("bold");
      } catch (err) {
        Logger.log("WhatsApp send failed: " + err);
        e.range.uncheck();
      }
    }
  }
}

// ============================================================================
// ARABISTA HQ MASTER DASHBOARD API
// ============================================================================

function adminLogin(pin) {
  // Hardcoded secure PIN
  if (String(pin).trim() === "77704") {
    return { success: true, token: "HQ-GOD-MODE-TOKEN" };
  }
  return { success: false, message: "Invalid PIN" };
}

function getAdminDashboardData(token) {
  if (token !== "HQ-GOD-MODE-TOKEN") return { success: false, message: "Unauthorized" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Fetch Orders & Interventions
  const ordersSheet = ss.getSheetByName("Incoming_Orders");
  if (!ordersSheet) return { success: false, message: "Incoming_Orders sheet not found" };

  const oData = ordersSheet.getDataRange().getDisplayValues();
  const activeOrders = [];
  const interventions = [];

  for (let i = 1; i < oData.length; i++) {
    const status = String(oData[i][13]).trim(); // Col 14
    if (status !== "Completed" && status !== "Canceled" && status !== "") {
      const order = {
        row: i + 1,
        id: String(oData[i][1]).trim(), // Col 2
        custName: String(oData[i][4]).trim(), // Col 5
        custPhone: String(oData[i][5]).trim(), // Col 6
        hubName: String(oData[i][10]).trim(), // Col 11
        status: status,
        inboundLala: String(oData[i][15]).trim(), // Col 16
        outboundLala: String(oData[i][23]).trim(), // Col 24
        notes: String(oData[i][30]).trim() // Col 31 Admin_Notes
      };
      activeOrders.push(order);
      if (order.notes !== "") interventions.push(order);
    }
  }

  // 2. Fetch Hub Fleet
  const hubSheet = ss.getSheetByName("Active_Hubs");
  const hubs = [];
  if (hubSheet) {
    const hData = hubSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < hData.length; i++) {
      if (String(hData[i][1]).trim() !== "") {
        hubs.push({
          row: i + 1,
          name: String(hData[i][1]).trim(), // Col 2
          phone: String(hData[i][3]).trim(), // Col 4
          bankName: String(hData[i][5]).trim(), // Col 6
          bankAcc: String(hData[i][6]).trim(), // Col 7
          status: String(hData[i][7]).trim(), // Col 8
          capacity: String(hData[i][8]).trim(), // Col 9
          qrUrl: String(hData[i][9] || "").trim() // Col 10
        });
      }
    }
  }

  // 3. Aggregate Ledger for Payouts
  const ledgerSheet = ss.getSheetByName("Hub_Ledger");
  const payouts = {}; // Object to hold net balances

  if (ledgerSheet) {
    const lData = ledgerSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < lData.length; i++) {
      const pStatus = String(lData[i][5]).trim().toUpperCase(); // Col 6
      if (pStatus === "UNPAID") {
        const hub = String(lData[i][1]).trim(); // Col 2
        const type = String(lData[i][3]).trim().toUpperCase(); // Col 4
        const amount = parseFloat(lData[i][4]) || 0; // Col 5

        if (!payouts[hub]) payouts[hub] = { balance: 0, rows: [] };
        payouts[hub].rows.push(i + 1);

        if (type === "CREDIT") payouts[hub].balance += amount;
        if (type.includes("DEBIT")) payouts[hub].balance -= amount;
      }
    }
  }

  // Format final payout array matching active hubs
  const payoutQueue = [];
  Object.keys(payouts).forEach(hubName => {
    // Only queue hubs with a positive net balance owed to them
    if (payouts[hubName].balance > 0) {
      const hubInfo = hubs.find(h => h.name === hubName) || {};
      payoutQueue.push({
        hubName: hubName,
        amount: payouts[hubName].balance.toFixed(2),
        bankName: hubInfo.bankName || "N/A",
        bankAcc: hubInfo.bankAcc || "N/A",
        phone: hubInfo.phone || "",
        qrUrl: hubInfo.qrUrl || "",
        ledgerRows: payouts[hubName].rows
      });
    }
  });

  return {
    success: true,
    data: {
      interventions: interventions,
      orders: activeOrders,
      hubs: hubs,
      payouts: payoutQueue
    }
  };
}

function executeAdminAction(payload) {
  if (payload.token !== "HQ-GOD-MODE-TOKEN") return { success: false, message: "Unauthorized" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    if (payload.action === "CLEAR_FLAG") {
      const sheet = ss.getSheetByName("Incoming_Orders");
      if (sheet) sheet.getRange(payload.row, 31).clearContent();
      return { success: true };
    }

    if (payload.action === "UPDATE_STATUS") {
      const sheet = ss.getSheetByName("Incoming_Orders");
      if (sheet) {
        sheet.getRange(payload.row, 14).setValue(payload.newStatus);
        if (typeof touchDbUpdate === "function") touchDbUpdate(); // Trigger active polling update
      }
      return { success: true };
    }

    if (payload.action === "TOGGLE_HUB") {
      const sheet = ss.getSheetByName("Active_Hubs");
      if (sheet) sheet.getRange(payload.row, 8).setValue(payload.newStatus); // Update Active/Busy
      return { success: true };
    }

    if (payload.action === "MARK_PAID") {
      const sheet = ss.getSheetByName("Hub_Ledger");
      if (sheet && payload.rows && payload.rows.length > 0) {
        payload.rows.forEach(r => sheet.getRange(r, 6).setValue("PAID"));

        const msg = `*[MAKLUMAN PEMBAYARAN]*\nHub: ${payload.hubName}\n\nPengurusan Arabista HQ telah membuat pindahan wang sebanyak *RM ${payload.amount}* ke akaun bank anda untuk penyelesaian upah alterasi.\n\nSila semak penyata bank anda. Terima kasih!`;
        if (typeof sendWhatsAppText === "function") {
          sendWhatsAppText(payload.phone, msg);
        }
      }
      return { success: true };
    }

    return { success: false, message: "Unknown Action" };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}
