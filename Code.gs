/**
 * ARABISTA BACKEND API (v6.6 - Security & Auth Patch)
 * - Security: Added verifyToken() middleware to prevent IDOR attacks.
 * - Security: hubLogin() now generates and stores a secure UUID session token.
 * - Security: generateAlterationId() upgraded to 8 random characters to prevent brute-forcing.
 */

// --- CONFIGURATION ---
const LALA_BASE_URL = "https://rest.sandbox.lalamove.com"; 
const MARKET = "MY"; 

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
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const data = JSON.parse(e.postData.contents);
    const timestamp = new Date();

    // Public Actions (No Hub Token Required)
    if (data.action === "get_lalamove_quote") return getLalamoveQuotation(data);
    if (data.action === "book_lalamove_order") return placeLalamoveOrder(data, ss);
    if (data.action === "get_lalamove_status") return getLiveLalamoveStatus(data, ss);
    if (data.action === "cancel_lalamove_order") return cancelLalamoveOrder(data, ss); 
    if (data.action === "hub_login") return hubLogin(data, ss);
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
        const rowData = ioSheet.getRange(search.getRow(), 1, 1, 23).getDisplayValues()[0];
        let currentStatus = rowData[16];
        if (currentStatus === "Dispatched / Picked Up") currentStatus = "Completed";
        
        let hubPhone = "";
        let hubQr = "images/hub-1-qr.webp"; 
        const hubSheetForLookup = ss.getSheetByName("Active_Hubs");
        if(hubSheetForLookup) {
            const hDataLookup = hubSheetForLookup.getDataRange().getDisplayValues();
            for (let i = 1; i < hDataLookup.length; i++) {
                if (hDataLookup[i][1] === rowData[10]) { 
                    hubPhone = hDataLookup[i][3];
                    if (hDataLookup[i][12]) { 
                        hubQr = hDataLookup[i][12];
                    }
                    break;
                }
            }
        }

        result.trackData = {
          alterationId: rowData[1], 
          customerName: rowData[4], 
          customerPhone: rowData[5],
          originalAddress: rowData[6], 
          originalLat: rowData[7],     
          originalLng: rowData[8],     
          hubName: rowData[10], 
          hubPhone: hubPhone,         
          hubQr: hubQr,               
          itemDetails: rowData[15], 
          orderStatus: currentStatus, 
          servicesTotal: rowData[13], 
          returnEligibility: rowData[17], 
          outboundChoice: rowData[18], 
          trackingUrl: rowData[19],
          lalamoveOrderId: rowData[20], 
          logisticsDirection: rowData[21],
          lalamoveStatus: rowData[22] 
        };
      } else { result.error = "Tracking ID not found."; }
    }

    const hubSheet = ss.getSheetByName("Active_Hubs");
    const hData = hubSheet.getDataRange().getDisplayValues();
    const ioSheet = ss.getSheetByName("Incoming_Orders");
    
    const allOrders = ioSheet ? ioSheet.getDataRange().getValues() : [];
    const backlog = {};
    for (let i = 1; i < allOrders.length; i++) {
      let s = String(allOrders[i][16]);
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

  // Idempotency guard: if a Lalamove booking already exists for this order
  // (e.g. a previous request succeeded but the client lost the response due to
  // a tab-switch / network abort), return the existing booking instead of
  // creating a duplicate.
  const sheet = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.trackId).matchEntireCell(true).findNext();
  if (search) {
    const existingRow = search.getRow();
    const existingOrderId = String(sheet.getRange(existingRow, 21).getValue()).trim();
    if (existingOrderId) {
      const existingTrackingUrl = String(sheet.getRange(existingRow, 20).getValue()).trim();
      return sendJSON({ status: "success", lalamove_order_id: existingOrderId, tracking_url: existingTrackingUrl });
    }
  }

  const senderPhone = formatPhone(data.senderPhone);
  const recipientPhone = formatPhone(data.recipientPhone);

  const body = {
    "data": {
      "quotationId": data.quotationId,
      "sender": { 
          "stopId": data.senderStopId, 
          "name": data.senderName, 
          "phone": senderPhone
      },
      "recipients": [ { 
          "stopId": data.recipientStopId, 
          "name": data.recipientName, 
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

    if (search) {
      const row = search.getRow();
      sheet.getRange(row, 17).setValue("Dispatched");
      sheet.getRange(row, 20).setValue(trackingUrl);
      sheet.getRange(row, 21).setValue(orderRef); 
      
      if (data.direction) {
          sheet.getRange(row, 22).setValue(data.direction); 
          if (data.direction === "Outbound") {
              sheet.getRange(row, 19).setValue("Lalamove");
          }
      }
      
      sheet.getRange(row, 23).setValue("ASSIGNING_DRIVER"); 
      touchDbUpdate(); 
    }
    return sendJSON({ status: "success", lalamove_order_id: orderRef, tracking_url: trackingUrl });
  } else {
    return sendJSON({ status: "error", message: response.body });
  }
}

function cancelLalamoveOrder(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.track_id).matchEntireCell(true).findNext();
  if (!search) return sendJSON({ status: "error", message: "Order not found" });
  
  const row = search.getRow();
  const lalamoveOrderId = sheet.getRange(row, 21).getValue(); 
  const direction = sheet.getRange(row, 22).getValue(); 

  if (!lalamoveOrderId) return sendJSON({ status: "error", message: "No Lalamove ID to cancel." });

  const response = callLalamoveAPI("DELETE", "/v3/orders/" + lalamoveOrderId, null);
  
  if (response.code === 200 || response.code === 204) {
    if (direction === "Inbound") sheet.getRange(row, 17).setValue("Awaiting Dispatch");
    else if (direction === "Outbound") {
      sheet.getRange(row, 17).setValue("Ready for Return");
      sheet.getRange(row, 19).setValue(""); 
    }
    
    sheet.getRange(row, 20).setValue(""); 
    sheet.getRange(row, 21).setValue(""); 
    sheet.getRange(row, 23).setValue("CANCELED"); 
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

function syncLalamoveStatuses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Incoming_Orders");
  const data = sheet.getDataRange().getValues();
  let dbChanged = false;
  
  for (let i = 1; i < data.length; i++) {
    const status = data[i][16]; 
    const lalaId = data[i][20]; 
    const direction = data[i][21]; 
    const lalaStatus = data[i][22]; 

    if (status === "Dispatched" && lalaId && lalaStatus !== "COMPLETED" && lalaStatus !== "CANCELED") {
      try {
        const response = callLalamoveAPI("GET", "/v3/orders/" + lalaId, null);
        if (response.code === 200) {
          const resData = JSON.parse(response.body);
          const newStatus = resData.data.status;
          
          if (newStatus !== lalaStatus) {
            sheet.getRange(i + 1, 23).setValue(newStatus); 
            dbChanged = true;
            if (direction === "Outbound" && newStatus === "COMPLETED") {
              sheet.getRange(i + 1, 17).setValue("Completed");
            }
          }
        }
      } catch (e) {
        Logger.log("Sync Error: " + e.toString());
      }
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
  const lalamoveOrderId = sheet.getRange(row, 21).getValue();
  if (!lalamoveOrderId) return sendJSON({ status: "error", message: "No Lalamove ID" });

  const response = callLalamoveAPI("GET", "/v3/orders/" + lalamoveOrderId, null);
  if (response.code === 200) {
    const resData = JSON.parse(response.body);
    const status = resData.data.status;
    sheet.getRange(row, 23).setValue(status); 
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
    if (hubs[i][1] === data.hub_name) {
      profile = { address: hubs[i][2], phone: hubs[i][3], lat: hubs[i][4], lng: hubs[i][5], days: hubs[i][6], open: hubs[i][7], close: hubs[i][8], status: hubs[i][9], max_capacity: hubs[i][11] || 10 };
      break;
    }
  }
  
  const orders = { pending: [], inProgress: [], ready: [], completed: [] };
  const allOrders = sheet.getDataRange().getValues(); 
  const oneDayAgo = new Date().getTime() - (24 * 60 * 60 * 1000);
  
  for (let i = 1; i < allOrders.length; i++) {
    if (allOrders[i][10] === data.hub_name) {
      let s = String(allOrders[i][16]);
      let orderDate = allOrders[i][0];
      let dateIso = (orderDate instanceof Date) ? orderDate.toISOString() : new Date(orderDate).toISOString();
      
      const lalaId = String(allOrders[i][20] || ""); 
      const outboundChoice = String(allOrders[i][18] || ""); 
      const direction = String(allOrders[i][21] || ""); 
      const lalaStatus = String(allOrders[i][22] || ""); 
      
      const orderObj = { 
        date: dateIso, 
        id: String(allOrders[i][1]), 
        custName: String(allOrders[i][4]), 
        custPhone: String(allOrders[i][5]), 
        items: String(allOrders[i][15]), 
        status: s, 
        returnElig: String(allOrders[i][17]), 
        outbound: outboundChoice, 
        fee: String(allOrders[i][12]), 
        logisticsMode: String(allOrders[i][9]), 
        lalamoveId: lalaId,
        direction: direction,
        lalamoveStatus: lalaStatus 
      };

      if (["Pending Dropoff", "Pending Approval", "Awaiting Dispatch"].includes(s)) {
        orders.pending.push(orderObj);
      } 
      else if (s === "Dispatched") {
        if (direction === "Inbound") orders.pending.push(orderObj);
        else orders.inProgress.push(orderObj);
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
  return sendJSON({ status: "success", profile: profile, orders: orders, timestamp: new Date().getTime() });
}

function updateOrderStatus(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.order_id).matchEntireCell(true).findNext();
  if (search) { 
    const row = search.getRow();
    sheet.getRange(row, 17).setValue(data.new_status);
    if(data.new_status === "Dispatched") {
       sheet.getRange(row, 22).setValue("Outbound");
    }
    touchDbUpdate();
    return sendJSON({ status: "success" }); 
  }
  throw new Error("Order not found");
}

function searchOrder(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const query = data.query.toLowerCase();
  const results = [];
  const allOrders = sheet.getDataRange().getValues(); 
  
  for (let i = 1; i < allOrders.length; i++) {
    if (allOrders[i][10] === data.hub_name) {
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
    if (hubs[i][1] === data.hub_name) {
      const r = i + 1;
      hubSheet.getRange(r, 3).setValue(data.address); hubSheet.getRange(r, 4).setValue(data.phone);
      hubSheet.getRange(r, 5).setValue(data.lat); hubSheet.getRange(r, 6).setValue(data.lng);
      hubSheet.getRange(r, 7).setValue(data.days); hubSheet.getRange(r, 8).setValue(data.open);
      hubSheet.getRange(r, 9).setValue(data.close); hubSheet.getRange(r, 10).setValue(data.status);
      hubSheet.getRange(r, 12).setValue(data.max_capacity);
      touchDbUpdate();
      return sendJSON({ status: "success" });
    }
  }
  throw new Error("Hub not found");
}

function updateOutbound(data, ss) {
  const sheet = ss.getSheetByName("Incoming_Orders");
  const search = sheet.getRange("B:B").createTextFinder(data.alteration_id).matchEntireCell(true).findNext();
  if (search) { 
      sheet.getRange(search.getRow(), 19).setValue(data.outbound_choice); 
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
  
  let returnEligibility = "N/A", status = "Pending Approval"; 
  let direction = ""; 

  if (data.Logistics_Mode === "Lalamove") {
    direction = "Inbound"; 
  }

  let finalServicesTotal = data.Services_Total || "RM 0";
  let finalGrandTotal = data.Grand_Total || "RM 0";

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
      
      finalServicesTotal = "RM " + backendTotal;
      finalGrandTotal = "RM " + backendTotal; 
    }
  }

  const rowData = [
      timestamp, 
      altId, 
      data.Order_Type || "", 
      data.Order_Ref || "", 
      data.Customer_Name || "", 
      data.Phone_No || "", 
      data.Address_Details || "", 
      formatCoord(data.Customer_Lat), 
      formatCoord(data.Customer_Lng), 
      data.Logistics_Mode || "", 
      data.Hub_Name || "", 
      data.Logistics_Schedule || "", 
      data.Delivery_Fee || "", 
      finalServicesTotal, 
      finalGrandTotal, 
      data.Item_Details || "", 
      status, 
      returnEligibility, 
      "", 
      "", 
      "", 
      direction, 
      ""
  ];
  
  sheet.appendRow(rowData);
  touchDbUpdate(); 
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