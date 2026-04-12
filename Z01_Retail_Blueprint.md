# 📘 ARABISTA RETAIL & PRE-SALE ALTERATION (Master Blueprint v1.4)

## 1. The Isolation Strategy
* **Webhook_Router_STAGING.gs:** A master script traffic cop. Reads incoming Meta and SenangPay webhooks. Routes `ALT-` to the existing Alteration backend and `ORD-` to the new Retail backend.
* **Retail_STAGING.gs:** The isolated backend handling e-commerce sales, stock reservations, Pos Laju API, and retail Telegram routing. 

## 2. The Dual-Layer Inventory Database (DB_Website_Orders_STAGING)
* **Database A: Physical Warehouse (Inventory_Physical)**
  * Columns: `Base_Item`, `Size`, `Total_Manufactured`, `Reserved_Stock`, `Sold_Stock`, `Available_To_Sell`.
* **Database B: Storefront Matrix (Inventory_Matrix)**
  * Columns: `SKU_Code`, `Base_Item`, `Size`, `Requires_Alteration`, `Retail_Price`, `Weight_KG`.

## 3. The Slide-Out Cart UI & Logistics Math
* **Auto-Open Drawer:** Slide-out cart automatically opens showing itemized requests.
* **Shipping Gate:** User enters Delivery Postcode inside the drawer.
* **Dynamic Math:** Frontend sums total `Weight_KG`, queries Pos Laju API (via Retail_STAGING) based on postcode zone, and displays Grand Total.

## 4. The 15-Minute Reservation & Check-Out
* **Soft Lock:** Clicking "Proceed to Payment" moves stock from `Available` to `Reserved` in Database A (expires in 15 mins).
* **SenangPay Payload:** Clean summary: "Arabista Retail Order: ORD-Z01-ABCD".
* **The Sweeper (Cron Job):** Runs every 5 minutes. Unpaid carts older than 15 mins are deleted; stock released.

## 5. Quota-Saving WhatsApp & Telegram Fulfillment
* **Post-Checkout:** User lands on `success-staging.html` and clicks "Activate Order Updates", triggering the initial WhatsApp message.
* **Telegram Command Center:** Topic opens in "Retail Ops" group showing details and Pos Laju AWB PDF.
* **Dispatch:** Admin taps [ Mark as Shipped ] in Telegram.
* **Customer Notification:** Zero-emoji, premium-formatted WhatsApp message with Pos Laju tracking link is sent.