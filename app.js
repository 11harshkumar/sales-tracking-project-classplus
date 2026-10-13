"use strict";

/* ===== Dukaan Hisab - app logic =====
   Nothing is saved anywhere. All data lives in the `state` object below
   and is lost when the page is refreshed (this is a prototype).
   The product list and sample history come from data.json. */

/* ---------- 1. State ---------- */

const state = {
  items: [],          // products from data.json
  transactions: [],   // sample + newly saved transactions
  voiceDemo: [],      // sample voice result from data.json
  cart: {},           // current New Record: { itemId: { qty, price } }
  nextId: 1,          // id for the next new transaction
  range: null,        // dashboard date range: { from: Date, to: Date }
  shop: { name: "Dukaan Hisab", upiId: "" },   // shop details from data.json
  language: null      // chosen on the language popup (kept in memory only)
};

// Speech recognition language for each choice in the language popup
const SPEECH_LANG = { Hindi: "hi-IN", English: "en-IN", Bengali: "bn-IN", Punjabi: "pa-IN" };

const cardRefs = {};  // product card elements, so we can update them quickly

/* ---------- 2. Small helpers ---------- */

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function money(n) {
  return "₹" + Number(n).toLocaleString("en-IN");
}

function findItem(id) {
  return state.items.find((item) => item.id === id);
}

function txTotal(tx) {
  return tx.lines.reduce((sum, line) => sum + line.price * line.qty, 0);
}

function txUnits(tx) {
  return tx.lines.reduce((sum, line) => sum + line.qty, 0);
}

// Money counts as "collected" for paid sales, and for Udhar once it is received.
function isCollected(tx) {
  return tx.status === "paid" || tx.status === "received";
}

// How the money came in: Cash or UPI (for Udhar, this is set when it is received).
function methodOf(tx) {
  return tx.type === "sale" ? tx.paymentMethod : tx.receivedMethod;
}

// The date on which the money actually came in.
function collectedAt(tx) {
  return tx.type === "sale" ? tx.createdAt : tx.receivedAt;
}

/* ---------- 3. Date helpers ---------- */

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeek(d) {            // Monday is the first day
  const x = startOfDay(d);
  const daysSinceMonday = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - daysSinceMonday);
  return x;
}

function endOfWeek(d) {
  const x = startOfWeek(d);
  x.setDate(x.getDate() + 6);
  return endOfDay(x);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

function dayKey(d) {
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

function formatDate(d) {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function formatTime(d) {
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true }).toUpperCase();
}

function dayLabel(d) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return "Today, " + formatDate(d);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday, " + formatDate(d);
  return formatDate(d);
}

function toInputValue(d) {           // Date -> "yyyy-mm-dd" for <input type="date">
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}

// Seed data uses "days ago" so the sample history always looks recent.
function dateFromOffset(daysAgo, time) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const parts = time.split(":").map(Number);
  d.setHours(parts[0], parts[1], 0, 0);
  return d;
}

/* ---------- 4. Toast message ---------- */

let toastTimer = null;
function toast(message, kind) {
  const box = $("toast");
  box.textContent = message;
  box.className = "toast " + (kind || "");
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2800);
}

/* ---------- 5. Screens ---------- */

function showScreen(name) {
  ["home", "new", "dashboard"].forEach((n) => {
    $("screen-" + n).hidden = (n !== name);
  });
  window.scrollTo(0, 0);
}

/* ---------- 6. Load data.json ---------- */

async function loadData() {
  const status = $("home-status");
  status.hidden = false;
  status.className = "status-box";
  status.textContent = "Loading your records...";
  try {
    const response = await fetch("data.json");
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    if (!Array.isArray(data.items) || !Array.isArray(data.transactions)) {
      throw new Error("data.json has the wrong format");
    }

    state.items = data.items;
    state.voiceDemo = data.voiceDemo || [];
    state.shop = data.shop || state.shop;
    state.transactions = data.transactions.map((t) => ({
      id: t.id,
      createdAt: dateFromOffset(t.dayOffset, t.time),
      type: t.type,
      paymentMethod: t.paymentMethod || null,
      status: t.status,
      receivedAt: t.status === "received" ? dateFromOffset(t.receivedDayOffset, t.receivedTime) : null,
      receivedMethod: t.receivedMethod || null,
      customer: t.customer || null,
      lines: t.lines.map((l) => ({ itemId: l.itemId, price: l.price, qty: l.qty }))
    }));
    state.nextId = Math.max(0, ...state.transactions.map((t) => t.id)) + 1;

    // Default dashboard range: from the first record until today
    const earliest = new Date(Math.min(...state.transactions.map((t) => t.createdAt)));
    state.range = { from: startOfDay(earliest), to: endOfDay(new Date()) };

    status.hidden = true;
    buildProductCards();
    renderHistory();
    renderDashboard();
  } catch (error) {
    status.className = "status-box error";
    status.textContent = "";
    status.appendChild(el("p", "", "Could not load data.json. Please open this app through a local web server (for example VS Code Live Server), not by double-clicking the file."));
    const retry = el("button", "", "Try Again");
    retry.type = "button";
    retry.addEventListener("click", loadData);
    status.appendChild(retry);
  }
}

/* ---------- 7. Home: transaction history ---------- */

function statusText(tx) {
  if (tx.type === "sale") return "Paid by " + tx.paymentMethod;
  if (tx.status === "pending") return "Udhar pending from " + tx.customer.name;
  return "Udhar received from " + tx.customer.name;
}

function buildTxCard(tx) {
  const card = el("article", "tx-card " + tx.type);

  const top = el("div", "tx-top");
  top.appendChild(el("span", "tx-time", formatTime(tx.createdAt)));
  top.appendChild(el("span", "badge " + tx.type, tx.type === "sale" ? "Sale" : "Udhar"));
  card.appendChild(top);

  const mid = el("div", "tx-mid");
  mid.appendChild(el("span", "", txUnits(tx) + " Items"));
  mid.appendChild(el("span", "tx-amount", money(txTotal(tx))));
  card.appendChild(mid);

  const pending = tx.type === "udhar" && tx.status === "pending";
  card.appendChild(el("p", "tx-status" + (pending ? " pending" : ""), statusText(tx)));

  const button = el("button", "view-btn", "View Details");
  button.type = "button";
  button.addEventListener("click", () => openDetails(tx.id));
  card.appendChild(button);

  return card;
}

function renderHistory() {
  const box = $("history");
  box.innerHTML = "";

  if (state.transactions.length === 0) {
    box.appendChild(el("div", "status-box", "No records yet. Tap New Record to add your first sale."));
    return;
  }

  const sorted = [...state.transactions].sort((a, b) => b.createdAt - a.createdAt);
  let lastDay = "";
  sorted.forEach((tx) => {
    const key = dayKey(tx.createdAt);
    if (key !== lastDay) {
      box.appendChild(el("h2", "day-heading", dayLabel(tx.createdAt)));
      lastDay = key;
    }
    box.appendChild(buildTxCard(tx));
  });
}

/* ---------- 8. Transaction details dialog ---------- */

function openDetails(txId) {
  const tx = state.transactions.find((t) => t.id === txId);
  if (!tx) return;

  $("det-title").textContent = tx.type === "sale" ? "Sale Details" : "Udhar Details";
  let meta = formatDate(tx.createdAt) + ", " + formatTime(tx.createdAt);
  if (tx.type === "sale") meta += " - Paid by " + tx.paymentMethod;
  $("det-meta").textContent = meta;

  const rows = $("det-rows");
  rows.innerHTML = "";
  tx.lines.forEach((line) => {
    const item = findItem(line.itemId);
    const tr = document.createElement("tr");
    tr.appendChild(el("td", "", item ? item.name : "Item #" + line.itemId));
    tr.appendChild(el("td", "", String(line.qty)));
    tr.appendChild(el("td", "", money(line.price)));
    tr.appendChild(el("td", "", money(line.price * line.qty)));
    rows.appendChild(tr);
  });
  $("det-total").textContent = money(txTotal(tx));

  const customerBox = $("det-customer");
  const receivedBtn = $("det-received");
  receivedBtn.hidden = true;
  $("det-method").hidden = true;
  customerBox.hidden = true;
  document.querySelector('input[name="recv-method"][value="Cash"]').checked = true;

  if (tx.type === "udhar") {
    customerBox.hidden = false;
    const done = tx.status === "received";
    customerBox.className = "det-customer" + (done ? " done" : "");
    customerBox.textContent = tx.customer.name + " (" + tx.customer.phone + ") - " +
      (done ? "Received on " + formatDate(tx.receivedAt) + (tx.receivedMethod ? " by " + tx.receivedMethod : "") : "Not paid yet");
    if (!done) {
      $("det-method").hidden = false;
      receivedBtn.hidden = false;
      receivedBtn.onclick = () => markReceived(tx.id);
    }
  }

  $("dlg-details").showModal();
}

function markReceived(txId) {
  const tx = state.transactions.find((t) => t.id === txId);
  if (!tx || tx.status !== "pending") return;
  tx.status = "received";
  tx.receivedAt = new Date();
  tx.receivedMethod = document.querySelector('input[name="recv-method"]:checked').value;
  $("dlg-details").close();
  renderHistory();
  renderDashboard();
  toast(money(txTotal(tx)) + " received from " + tx.customer.name + " (" + tx.receivedMethod + ")", "ok");
}

/* ---------- 9. New Record: product cards ---------- */

function buildThumb(item) {
  const thumb = el("div", "thumb");
  const letter = item.name.charAt(0).toUpperCase();
  if (item.image) {
    const img = document.createElement("img");
    img.src = item.image;
    img.alt = item.name;
    img.addEventListener("error", () => {      // broken link -> show placeholder letter
      thumb.textContent = letter;
    });
    thumb.appendChild(img);
  } else {
    thumb.textContent = letter;
  }
  return thumb;
}

// Cards are built once. Searching only hides/shows them, so typed prices are not lost.
function buildProductCards() {
  const list = $("product-list");
  list.innerHTML = "";

  state.items.forEach((item) => {
    const card = el("article", "product");
    card.appendChild(buildThumb(item));

    const info = el("div", "info");
    info.appendChild(el("h3", "", item.name));
    info.appendChild(el("p", "cat", item.category));

    const priceLabel = el("label", "price-label", "₹");
    const priceInput = document.createElement("input");
    priceInput.type = "number";
    priceInput.min = "0";
    priceInput.inputMode = "numeric";
    priceInput.className = "price-input";
    priceInput.setAttribute("aria-label", item.name + " price per " + item.unit);
    priceLabel.appendChild(priceInput);
    priceLabel.appendChild(document.createTextNode(" per " + item.unit));
    info.appendChild(priceLabel);
    card.appendChild(info);

    const qtyRow = el("div", "qty-row");
    const controls = el("div", "qty-controls");
    const minus = el("button", "qty-btn", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", "Decrease " + item.name);
    const qtyValue = el("output", "qty-value", "0");
    const plus = el("button", "qty-btn plus", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", "Increase " + item.name);
    controls.append(minus, qtyValue, plus);

    const lineBox = el("div", "line-total", "Line total");
    const lineValue = el("strong", "", "₹0");
    lineBox.appendChild(lineValue);
    qtyRow.append(controls, lineBox);
    card.appendChild(qtyRow);

    minus.addEventListener("click", () => setQty(item.id, state.cart[item.id].qty - 1));
    plus.addEventListener("click", () => setQty(item.id, state.cart[item.id].qty + 1));
    priceInput.addEventListener("input", () => {
      const value = parseFloat(priceInput.value);
      state.cart[item.id].price = (isNaN(value) || value < 0) ? 0 : value;
      refreshCard(item.id);
      updateSummary();
    });

    cardRefs[item.id] = { card, priceInput, qtyValue, lineValue };
    list.appendChild(card);
  });

  resetNewRecord();
}

function refreshCard(id) {
  const ref = cardRefs[id];
  const row = state.cart[id];
  ref.qtyValue.textContent = row.qty;
  ref.lineValue.textContent = money(row.price * row.qty);
  ref.card.classList.toggle("selected", row.qty > 0);
}

function setQty(id, qty) {
  state.cart[id].qty = Math.max(0, qty);       // never below zero
  refreshCard(id);
  updateSummary();
}

function resetNewRecord() {
  state.items.forEach((item) => {
    state.cart[item.id] = { qty: 0, price: item.price };   // default price comes from data.json
    cardRefs[item.id].priceInput.value = item.price;
    refreshCard(item.id);
  });
  $("search").value = "";
  filterProducts();
  document.querySelector('input[name="payment"][value="Cash"]').checked = true;
  updateSummary();
}

function getSelectedLines() {
  return state.items
    .filter((item) => state.cart[item.id].qty > 0)
    .map((item) => ({ itemId: item.id, price: state.cart[item.id].price, qty: state.cart[item.id].qty }));
}

function updateSummary() {
  const lines = getSelectedLines();
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  $("sum-units").textContent = units;
  $("sum-products").textContent = lines.length;
  $("sum-total").textContent = money(total);
  const method = document.querySelector('input[name="payment"]:checked').value;
  if (!lines.length) $("btn-save-sale").textContent = "Save Sale";
  else if (method === "UPI") $("btn-save-sale").textContent = "Total " + total + " Rs - Save";   // opens the QR code
  else $("btn-save-sale").textContent = total + " Rs Sale - Save";
}

function filterProducts() {
  const query = $("search").value.trim().toLowerCase();
  let visible = 0;
  state.items.forEach((item) => {
    const match = item.name.toLowerCase().includes(query) || item.category.toLowerCase().includes(query);
    cardRefs[item.id].card.hidden = !match;
    if (match) visible++;
  });
  $("no-match").hidden = visible > 0;
}

function openNewRecord() {
  resetNewRecord();
  $("new-datetime").textContent = formatDate(new Date()) + ", " + formatTime(new Date());
  showScreen("new");
}

/* ---------- 10. Saving transactions ---------- */

function addTransaction(fields) {
  const tx = Object.assign({
    id: state.nextId++,
    createdAt: new Date(),
    receivedAt: null,
    paymentMethod: null,
    customer: null,
    lines: getSelectedLines()
  }, fields);
  state.transactions.push(tx);
  renderHistory();
  renderDashboard();
  showScreen("home");
  return tx;
}

function currentTotal() {
  return getSelectedLines().reduce((s, l) => s + l.price * l.qty, 0);
}

function saveSale() {
  if (getSelectedLines().length === 0) {
    toast("Please add at least one item first.", "error");
    return;
  }
  const method = document.querySelector('input[name="payment"]:checked').value;
  if (method === "UPI") {
    openQrDialog();                    // the sale is saved after the payment is confirmed
  } else {
    finishSale("Cash");
  }
}

function finishSale(method) {
  const tx = addTransaction({ type: "sale", status: "paid", paymentMethod: method });
  toast("Sale saved: " + money(txTotal(tx)), "ok");
}

/* ----- UPI QR popup ----- */

function openQrDialog() {
  const total = currentTotal();
  const upiId = state.shop.upiId || "";
  const link = "upi://pay?pa=" + encodeURIComponent(upiId) +
    "&pn=" + encodeURIComponent(state.shop.name || "Shop") +
    "&am=" + total.toFixed(2) + "&cu=INR&tn=" + encodeURIComponent("Payment to " + (state.shop.name || "Shop"));

  $("qr-total").textContent = money(total);
  $("qr-upi").textContent = "UPI ID: " + upiId;
  try {
    $("qr-image").innerHTML = QR.toSvg(link);
  } catch (e) {
    $("qr-image").textContent = "Could not make the QR code.";
  }
  $("dlg-qr").showModal();
}

function confirmUpiPayment() {
  $("dlg-qr").close();
  finishSale("UPI");
}

function openUdharDialog() {
  const lines = getSelectedLines();
  if (lines.length === 0) {
    toast("Please add at least one item first.", "error");
    return;
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  $("udhar-total").textContent = money(total);
  $("udhar-name").value = "";
  $("udhar-phone").value = "";
  $("udhar-error").hidden = true;
  $("dlg-udhar").showModal();
}

function saveUdhar(event) {
  event.preventDefault();
  const name = $("udhar-name").value.trim();
  let phone = $("udhar-phone").value.replace(/\D/g, "");
  if (phone.length === 12 && phone.startsWith("91")) phone = phone.slice(2);

  const error = $("udhar-error");
  if (name.length < 2) {
    error.textContent = "Please enter the customer's name.";
    error.hidden = false;
    return;
  }
  if (phone.length !== 10) {
    error.textContent = "Please enter a 10-digit phone number.";
    error.hidden = false;
    return;
  }

  // Udhar is a recorded sale, but money is NOT collected yet (status: pending).
  const tx = addTransaction({ type: "udhar", status: "pending", customer: { name: name, phone: phone } });
  $("dlg-udhar").close();
  toast("Udhar saved for " + tx.customer.name + ": " + money(txTotal(tx)), "ok");
}

/* ---------- 11. Dashboard ---------- */

function collectedBetween(from, to, method) {      // method is optional: "Cash" or "UPI"
  return state.transactions
    .filter((tx) => isCollected(tx) && collectedAt(tx) >= from && collectedAt(tx) <= to)
    .filter((tx) => !method || methodOf(tx) === method)
    .reduce((sum, tx) => sum + txTotal(tx), 0);
}

function renderBars(box, rows, emptyMessage) {
  box.innerHTML = "";
  if (rows.length === 0) {
    box.appendChild(el("p", "empty-text", emptyMessage));
    return;
  }
  const max = rows[0].value;
  rows.forEach((row) => {
    const wrap = el("div", "bar-row");
    const head = el("div", "bar-head");
    head.appendChild(el("span", "", row.label));
    head.appendChild(el("strong", "", row.value + " sold"));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = Math.round((row.value / max) * 100) + "%";
    track.appendChild(fill);
    wrap.append(head, track);
    box.appendChild(wrap);
  });
}

function topList(totals) {                 // { label: qty } -> sorted array
  return Object.keys(totals)
    .map((label) => ({ label: label, value: totals[label] }))
    .sort((a, b) => b.value - a.value);
}

function renderWeekBars() {
  const box = $("week-bars");
  box.innerHTML = "";
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ date: d, value: collectedBetween(startOfDay(d), endOfDay(d)) });
  }
  const max = Math.max(1, ...days.map((d) => d.value));
  days.forEach((day) => {
    const col = el("div", "day-col");
    col.appendChild(el("span", "day-amt", money(day.value)));
    const bar = el("div", "day-bar");
    bar.style.height = Math.round((day.value / max) * 100) + "px";
    col.appendChild(bar);
    col.appendChild(el("span", "day-name", day.date.toLocaleDateString("en-IN", { weekday: "short" })));
    box.appendChild(col);
  });
}

function renderRange() {
  const from = state.range.from;
  const to = state.range.to;
  $("filter-from").value = toInputValue(from);
  $("filter-to").value = toInputValue(to);
  $("range-label").textContent = "Showing " + formatDate(from) + " to " + formatDate(to);

  const inRange = state.transactions.filter((tx) => tx.createdAt >= from && tx.createdAt <= to);

  const totalSales = inRange.reduce((s, tx) => s + txTotal(tx), 0);
  const udharSales = inRange.filter((tx) => tx.type === "udhar").reduce((s, tx) => s + txTotal(tx), 0);
  const outstanding = inRange
    .filter((tx) => tx.type === "udhar" && tx.status === "pending")
    .reduce((s, tx) => s + txTotal(tx), 0);
  const paidSales = totalSales - udharSales;

  $("stat-total").textContent = money(totalSales);
  $("stat-collected").textContent = money(collectedBetween(from, to));

  const cash = collectedBetween(from, to, "Cash");
  const upi = collectedBetween(from, to, "UPI");
  $("earn-cash").textContent = money(cash);
  $("earn-upi").textContent = money(upi);
  $("mix-cash").style.width = (cash + upi) ? (cash / (cash + upi) * 100) + "%" : "0%";
  $("mix-upi").style.width = (cash + upi) ? (upi / (cash + upi) * 100) + "%" : "0%";
  $("stat-outstanding").textContent = money(outstanding);

  $("mix-paid").style.width = totalSales ? (paidSales / totalSales * 100) + "%" : "0%";
  $("mix-udhar").style.width = totalSales ? (udharSales / totalSales * 100) + "%" : "0%";
  $("mix-paid-amt").textContent = money(paidSales);
  $("mix-udhar-amt").textContent = money(udharSales);

  // Quantity sold per product and per category
  const itemTotals = {};
  const catTotals = {};
  inRange.forEach((tx) => {
    tx.lines.forEach((line) => {
      const item = findItem(line.itemId);
      if (!item) return;
      itemTotals[item.name] = (itemTotals[item.name] || 0) + line.qty;
      catTotals[item.category] = (catTotals[item.category] || 0) + line.qty;
    });
  });
  const items = topList(itemTotals);
  const cats = topList(catTotals);

  $("best-item").textContent = items.length ? items[0].label : "-";
  $("best-item-qty").textContent = items.length ? items[0].value + " sold" : "No sales";
  $("best-cat").textContent = cats.length ? cats[0].label : "-";
  $("best-cat-qty").textContent = cats.length ? cats[0].value + " sold" : "No sales";

  renderBars($("top-items"), items.slice(0, 5), "No sales in these dates.");
  renderBars($("top-cats"), cats.slice(0, 5), "No sales in these dates.");
}

function renderDashboard() {
  if (!state.range) return;
  const now = new Date();
  $("earn-today").textContent = money(collectedBetween(startOfDay(now), endOfDay(now)));
  $("earn-week").textContent = money(collectedBetween(startOfWeek(now), endOfWeek(now)));
  $("earn-month").textContent = money(collectedBetween(startOfMonth(now), endOfMonth(now)));
  renderWeekBars();
  renderRange();
}

function applyFilter() {
  const error = $("filter-error");
  const fromValue = $("filter-from").value;
  const toValue = $("filter-to").value;

  if (!fromValue || !toValue) {
    error.textContent = "Please choose both start and end dates.";
    error.hidden = false;
    return;
  }
  const from = new Date(fromValue + "T00:00:00");
  const to = new Date(toValue + "T00:00:00");
  if (from > to) {
    error.textContent = "Start date cannot be after the end date.";
    error.hidden = false;
    return;
  }
  error.hidden = true;
  state.range = { from: startOfDay(from), to: endOfDay(to) };
  renderRange();
}

function showAllRecords() {
  const earliest = new Date(Math.min(...state.transactions.map((t) => t.createdAt)));
  state.range = { from: startOfDay(earliest), to: endOfDay(new Date()) };
  $("filter-error").hidden = true;
  renderRange();
}

/* ---------- 12. Voice input (Hindi) ---------- */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let spokenText = "";

const NUMBER_WORDS = {
  ek: 1, one: 1, "एक": 1,
  do: 2, two: 2, "दो": 2,
  teen: 3, three: 3, "तीन": 3,
  char: 4, chaar: 4, four: 4, "चार": 4,
  paanch: 5, panch: 5, five: 5, "पांच": 5, "पाँच": 5,
  chhe: 6, chhah: 6, che: 6, six: 6, "छह": 6, "छः": 6, "छे": 6,
  saat: 7, seven: 7, "सात": 7,
  aath: 8, eight: 8, "आठ": 8,
  nau: 9, nine: 9, "नौ": 9,
  das: 10, ten: 10, "दस": 10
};

function setVoiceStatus(message) {
  $("voice-status").textContent = message;
}

function showSpokenText(text) {
  const box = $("voice-text");
  box.textContent = text || "Your words will show here.";
  box.classList.toggle("has-text", Boolean(text));
}

function setListening(on) {
  listening = on;
  $("voice-toggle").classList.toggle("listening", on);
}

function openVoiceDialog() {
  spokenText = "";
  showSpokenText("");
  setListening(false);
  setVoiceStatus(SpeechRec
    ? "Tap the mic to start"
    : "Voice is not supported in this browser. You can tap Next to see a sample, or add items by hand.");
  $("dlg-voice").showModal();
}

function startListening() {
  if (!SpeechRec) {
    setVoiceStatus("Voice is not supported in this browser. You can still add items by hand.");
    return;
  }
  recognition = new SpeechRec();
  recognition.lang = SPEECH_LANG[state.language] || "hi-IN";
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onstart = () => {
    setListening(true);
    setVoiceStatus("Listening... speak now");
  };
  recognition.onresult = (event) => {
    let text = "";
    for (let i = 0; i < event.results.length; i++) {
      text += event.results[i][0].transcript + " ";
    }
    spokenText = text.trim();
    showSpokenText(spokenText);
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      setVoiceStatus("Microphone permission was denied. Please allow it, or add items by hand.");
    } else if (event.error === "no-speech") {
      setVoiceStatus("Could not hear anything. Tap the mic and try again.");
    } else {
      setVoiceStatus("Voice did not work (" + event.error + "). You can add items by hand.");
    }
  };
  recognition.onend = () => {
    setListening(false);
    if ($("voice-status").textContent.startsWith("Listening")) setVoiceStatus("Stopped. Tap Next to continue.");
  };

  try {
    recognition.start();
  } catch (e) {
    setVoiceStatus("Could not start the microphone. Please try again.");
  }
}

function stopListening() {
  if (recognition && listening) recognition.stop();
}

// Turn the spoken sentence into [{ itemId, qty }].
function parseSpeech(text) {
  let work = text.toLowerCase().replace(/[.,!?।]/g, " ");

  // 1. Find product names. Longest names first, so "dairy milk" wins over "milk".
  const pairs = [];
  state.items.forEach((item) => {
    const names = [item.name.toLowerCase()].concat(item.aliases || []);
    names.forEach((n) => pairs.push({ itemId: item.id, alias: n.toLowerCase() }));
  });
  pairs.sort((a, b) => b.alias.length - a.alias.length);

  const found = [];
  pairs.forEach((pair) => {
    let at = work.indexOf(pair.alias);
    while (at !== -1) {
      found.push({ itemId: pair.itemId, start: at, end: at + pair.alias.length });
      work = work.slice(0, at) + "_".repeat(pair.alias.length) + work.slice(at + pair.alias.length);
      at = work.indexOf(pair.alias);
    }
  });
  found.sort((a, b) => a.start - b.start);

  // 2. Find number words (and digits)
  const numbers = [];
  const wordPattern = /\S+/g;
  let m;
  while ((m = wordPattern.exec(work)) !== null) {
    const word = m[0];
    let value = null;
    if (/^\d+$/.test(word)) value = parseInt(word, 10);
    else if (NUMBER_WORDS[word] !== undefined) value = NUMBER_WORDS[word];
    if (value !== null) numbers.push({ start: m.index, end: m.index + word.length, value: value, used: false });
  }

  // 3. Each product takes the number just before it, otherwise the number just after it
  const result = [];
  found.forEach((f) => {
    let qty = 1;
    const before = numbers.find((n) => !n.used && n.end <= f.start && work.slice(n.end, f.start).trim() === "");
    const after = numbers.find((n) => !n.used && n.start >= f.end && work.slice(f.end, n.start).trim() === "");
    const chosen = before || after;
    if (chosen) {
      chosen.used = true;
      qty = chosen.value;
    }
    result.push({ itemId: f.itemId, qty: qty });
  });
  return result;
}

function voiceNext() {
  stopListening();
  let results = spokenText ? parseSpeech(spokenText) : [];
  let usedDemo = false;

  // Prototype fallback: if nothing was understood, add the sample items from data.json
  if (results.length === 0) {
    results = state.voiceDemo;
    usedDemo = true;
  }

  results.forEach((r) => {
    if (state.cart[r.itemId]) setQty(r.itemId, state.cart[r.itemId].qty + r.qty);
  });

  $("dlg-voice").close();
  if (usedDemo && results.length) {
    toast("Sample items added (demo). Please check and edit before saving.");
  } else {
    toast("Items added. Please check them, then save.", "ok");
  }
}

/* ---------- 13. Language popup ---------- */

function openLanguageDialog() {
  $("dlg-lang").showModal();
}

function chooseLanguage(name) {
  state.language = name;
  $("btn-language").textContent = "🌐 " + name;
  $("dlg-lang").close();
}

/* ---------- 14. Button wiring ---------- */

function setup() {
  $("btn-new").addEventListener("click", openNewRecord);
  $("btn-dashboard").addEventListener("click", () => { renderDashboard(); showScreen("dashboard"); });
  $("btn-home-mic").addEventListener("click", () => { openNewRecord(); openVoiceDialog(); });
  $("btn-back-new").addEventListener("click", () => showScreen("home"));
  $("btn-back-dash").addEventListener("click", () => showScreen("home"));

  $("search").addEventListener("input", filterProducts);
  document.querySelectorAll('input[name="payment"]').forEach((radio) => radio.addEventListener("change", updateSummary));
  $("btn-save-sale").addEventListener("click", saveSale);
  $("btn-save-udhar").addEventListener("click", openUdharDialog);

  $("udhar-form").addEventListener("submit", saveUdhar);
  $("udhar-cancel").addEventListener("click", () => $("dlg-udhar").close());
  $("udhar-close-x").addEventListener("click", () => $("dlg-udhar").close());

  $("det-close").addEventListener("click", () => $("dlg-details").close());
  $("det-close-x").addEventListener("click", () => $("dlg-details").close());

  $("voice-toggle").addEventListener("click", () => (listening ? stopListening() : startListening()));
  $("voice-next").addEventListener("click", voiceNext);
  const closeVoice = () => { stopListening(); $("dlg-voice").close(); };
  $("voice-cancel").addEventListener("click", closeVoice);
  $("voice-close-x").addEventListener("click", closeVoice);

  $("qr-done").addEventListener("click", confirmUpiPayment);
  $("qr-close").addEventListener("click", () => $("dlg-qr").close());
  $("qr-close-x").addEventListener("click", () => $("dlg-qr").close());

  // Language popup: must choose one the first time, can change it later from the Home screen
  document.querySelectorAll(".lang-option").forEach((btn) => {
    btn.addEventListener("click", () => chooseLanguage(btn.dataset.lang));
  });
  $("dlg-lang").addEventListener("cancel", (event) => { if (!state.language) event.preventDefault(); });
  $("btn-language").addEventListener("click", openLanguageDialog);

  $("btn-apply").addEventListener("click", applyFilter);
  $("btn-all").addEventListener("click", showAllRecords);

  openLanguageDialog();
  loadData();
}

setup();
