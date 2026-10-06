(() => {
  "use strict";

  const SESSION_KEY = "invoicebook.v1.session";

  function storageKeys() {
    const prefix = state.user ? `invoicebook.v1.${state.user.id}` : "invoicebook.v1.guest";
    return {
      company: `${prefix}.company`,
      catalog: `${prefix}.catalog`,
      invoices: `${prefix}.invoices`,
      draft: `${prefix}.draft`,
    };
  }

  const aud = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
  });

  const state = {
    company: blankCompany(),
    catalog: [],
    invoices: [],
    draft: null,
    view: "create",
    editingId: null,
    detailId: null,
    user: null,
    token: "",
  };

  const template = document.getElementById("sheet-template");
  let previewSheet = null;
  let toastTimer = 0;
  let profileTimer = 0;
  let profileSaving = false;
  let profileDirty = false;
  let acceptProfileSync = false;

  const DEFAULT_THEME = "#1e4d3a";

  function themeColor(value) {
    const text = String(value || "").trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(text)) return text;
    if (/^#[0-9a-f]{3}$/.test(text)) {
      return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    }
    return DEFAULT_THEME;
  }

  function mixTowardWhite(hex, whiteAmount) {
    const value = parseInt(hex.slice(1), 16);
    const mix = (channel) => Math.round(channel + (255 - channel) * whiteAmount);
    const red = mix((value >> 16) & 255);
    const green = mix((value >> 8) & 255);
    const blue = mix(value & 255);
    return `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
  }

  function relativeLuminance(hex) {
    const value = parseInt(hex.slice(1), 16);
    const channel = (part) => {
      const scaled = part / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return (
      0.2126 * channel((value >> 16) & 255) +
      0.7152 * channel((value >> 8) & 255) +
      0.0722 * channel(value & 255)
    );
  }

  function onAccent(hex) {
    const background = relativeLuminance(hex);
    const contrast = (foreground) => {
      const lighter = Math.max(background, foreground);
      const darker = Math.min(background, foreground);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const ink = "#241c16";
    const paper = "#f7fbf8";
    return contrast(relativeLuminance(ink)) >= contrast(relativeLuminance(paper)) ? ink : paper;
  }

  function applyTheme(hex, root) {
    const color = themeColor(hex);
    const node = root || document.documentElement;
    node.style.setProperty("--accent", color);
    node.style.setProperty("--accent-soft", mixTowardWhite(color, 0.86));
    node.style.setProperty("--on-accent", onAccent(color));
    return color;
  }

  function syncThemeControl() {
    const color = themeColor((state.draft && state.draft.theme) || state.company.theme);
    const input = document.getElementById("theme-color");
    if (input) input.value = color;
    document.querySelectorAll(".theme-dot").forEach((dot) => {
      dot.setAttribute("aria-pressed", dot.dataset.theme === color ? "true" : "false");
    });
    applyTheme(color);
  }

  const TEMPLATES = ["classic", "banner", "editorial"];

  function templateName(value) {
    return TEMPLATES.includes(value) ? value : "classic";
  }

  function setTheme(hex) {
    const color = themeColor(hex);
    state.company.theme = color;
    if (state.draft) state.draft.theme = color;
    saveCompany();
    saveDraft();
    syncThemeControl();
    updatePreview();
  }

  function blankCompany() {
    return { name: "", abn: "", address: "", phone: "", email: "", logo: "", template: "classic", theme: "#1e4d3a" };
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function todayISO() {
    const date = new Date();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function money(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return NaN;
    return Math.round((number + Number.EPSILON) * 100) / 100;
  }

  function parseMoney(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0 || value > 9999999.99) return null;
      return money(value);
    }
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    let normalized = raw.replace(/[$\s]/g, "");
    if (normalized.includes(",") && normalized.includes(".")) {
      normalized = normalized.replace(/,/g, "");
    } else if (normalized.includes(",")) {
      normalized = normalized.replace(",", ".");
    }
    if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
    const number = Number(normalized);
    if (number > 9999999.99) return null;
    return money(number);
  }

  function normalizeQty(value) {
    const number = typeof value === "number" ? value : parseFloat(String(value ?? "").trim());
    if (!Number.isFinite(number) || number <= 0) return 1;
    return Math.round(Math.min(number, 9999) * 100) / 100;
  }

  function formatQty(value) {
    const number = normalizeQty(value);
    return Number.isInteger(number) ? String(number) : String(number);
  }

  function formatDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return "";
    const [year, month, day] = iso.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return "";
    }
    return date.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  function asText(value, max) {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, max);
  }

  function safeLogo(value) {
    if (typeof value !== "string") return "";
    if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value)) return "";
    if (value.length > 600000) return "";
    return value;
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function persist(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      setStorageStatus("");
      return true;
    } catch (error) {
      const full = error && (error.name === "QuotaExceededError" || error.code === 22);
      setStorageStatus(
        full
          ? "Storage is full, so the latest change was not saved. Delete old invoices or remove the logo."
          : "This browser blocked storage, so the latest change was not saved."
      );
      return false;
    }
  }

  function setStorageStatus(message) {
    const node = document.getElementById("storage-status");
    node.textContent = message;
    node.hidden = !message;
  }

  function saveCompany() {
    const ok = persist(storageKeys().company, {
      ...state.company,
      logo: safeLogo(state.company.logo),
    });
    if (acceptProfileSync) scheduleProfileSave();
    return ok;
  }

  function saveCatalog() {
    return persist(storageKeys().catalog, state.catalog);
  }

  function saveInvoices() {
    return persist(storageKeys().invoices, state.invoices);
  }

  function saveDraft() {
    return persist(storageKeys().draft, state.draft);
  }

  function scheduleProfileSave() {
    if (!state.user || !state.token) return;
    profileDirty = true;
    window.clearTimeout(profileTimer);
    profileTimer = window.setTimeout(flushProfile, 400);
  }

  async function flushProfile() {
    if (!state.user || !state.token || profileSaving) return;
    profileDirty = false;
    profileSaving = true;
    const company = sanitizeCompany(state.company);
    try {
      await api("/api/profile", {
        method: "PUT",
        body: JSON.stringify({ company }),
      });
      setStorageStatus("");
    } catch (error) {
      if (state.user) {
        setStorageStatus(error.message === "OFFLINE"
          ? "The account file is not running, so company details were only saved in this browser."
          : (error.message || "Company details were not saved to the account file."));
      }
    } finally {
      profileSaving = false;
      if (profileDirty && state.user) scheduleProfileSave();
    }
  }

  function sanitizeCompany(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      name: asText(source.name, 120),
      abn: asText(source.abn, 20),
      address: asText(source.address, 500),
      phone: asText(source.phone, 40),
      email: asText(source.email, 120),
      logo: safeLogo(source.logo),
      template: templateName(source.template),
      theme: themeColor(source.theme),
    };
  }

  function uniqueById(items) {
    const seen = new Set();
    for (const item of items) {
      if (!item.id || seen.has(item.id)) item.id = uid();
      seen.add(item.id);
    }
    return items;
  }

  function sanitizeCatalog(list) {
    if (!Array.isArray(list)) return [];
    const items = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const description = asText(raw.description, 180);
      const price = parseMoney(raw.unitPrice != null ? raw.unitPrice : raw.price);
      if (!description || price == null) continue;
      items.push({
        id: asText(raw.id, 80) || uid(),
        description,
        price,
        units: normalizeQty(raw.units),
      });
    }
    return uniqueById(items);
  }

  function sanitizeInvoice(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.lines)) return null;
    const lines = [];
    for (const line of raw.lines) {
      if (!line || typeof line !== "object") continue;
      const description = asText(line.description, 180);
      const price = parseMoney(line.price);
      const qty = normalizeQty(line.qty);
      if (!description || price == null || !(Number(line.qty) > 0)) continue;
      lines.push({
        id: asText(line.id, 80) || uid(),
        description,
        qty,
        price,
        amount: money(qty * price),
      });
    }
    if (!lines.length) return null;
    const sums = totals(lines);
    const date = formatDate(raw.date) ? raw.date : todayISO();
    return {
      id: asText(raw.id, 80) || uid(),
      number: asText(raw.number, 40) || "INV-0000",
      date,
      createdAt: asText(raw.createdAt, 40) || new Date().toISOString(),
      company: sanitizeCompany(raw.company),
      billTo: {
        name: asText(raw.billTo && raw.billTo.name, 120) || "Client",
        address: asText(raw.billTo && raw.billTo.address, 500),
        phone: asText(raw.billTo && raw.billTo.phone, 40),
      },
      lines,
      ...sums,
      template: templateName(raw.template),
      theme: themeColor(raw.theme),
    };
  }

  function freshDraft(invoices) {
    return {
      number: nextNumber(invoices),
      date: todayISO(),
      billTo: { name: "", address: "", phone: "" },
      selected: {},
    };
  }

  function sanitizeDraft(raw, invoices) {
    const base = freshDraft(invoices);
    base.template = templateName(state.company.template);
    base.theme = themeColor(state.company.theme);
    if (!raw || typeof raw !== "object") return base;
    const selected = {};
    if (raw.selected && typeof raw.selected === "object") {
      for (const [id, value] of Object.entries(raw.selected)) {
        if (!value || typeof value !== "object") continue;
        selected[asText(id, 80)] = {
          on: Boolean(value.on),
          qty: normalizeQty(value.qty),
        };
      }
    }
    const editId = asText(raw.editId, 80);
    return {
      number: asText(raw.number, 40) || base.number,
      date: formatDate(raw.date) ? raw.date : base.date,
      billTo: {
        name: asText(raw.billTo && raw.billTo.name, 120),
        address: asText(raw.billTo && raw.billTo.address, 500),
        phone: asText(raw.billTo && raw.billTo.phone, 40),
      },
      selected,
      editId: invoices.some((invoice) => invoice.id === editId) ? editId : undefined,
      template: templateName((raw && raw.template) || state.company.template),
      theme: themeColor((raw && raw.theme) || state.company.theme),
    };
  }

  function nextNumber(invoices) {
    let max = 0;
    for (const invoice of invoices) {
      const match = /^INV-(\d+)$/i.exec(String(invoice.number || "").trim());
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return `INV-${String(max + 1).padStart(4, "0")}`;
  }

  function totals(lines) {
    const subtotal = money(lines.reduce((sum, line) => sum + line.amount, 0));
    const gst = money(subtotal * 0.1);
    const total = money(subtotal + gst);
    return { subtotal, gst, total };
  }

  function currentLines() {
    const lines = [];
    for (const item of state.catalog) {
      const selected = state.draft.selected[item.id];
      if (!selected || !selected.on) continue;
      const qty = normalizeQty(selected.qty);
      const price = money(item.price);
      lines.push({
        id: item.id,
        description: item.description,
        qty,
        price,
        amount: money(qty * price),
      });
    }
    return lines;
  }

  function buildDraftModel() {
    const lines = currentLines();
    return {
      number: state.draft.number,
      date: state.draft.date,
      company: state.company,
      billTo: state.draft.billTo,
      lines,
      ...totals(lines),
      template: templateName(state.draft.template || state.company.template),
      theme: themeColor(state.draft.theme || state.company.theme),
    };
  }

  function formatAbn(value) {
    const text = (value || "").trim();
    if (!text) return "";
    if (/^(ABN|ACN)\b/i.test(text)) return text;
    return `ABN/ACN ${text}`;
  }

  function contactLine(company) {
    return [company.phone, company.email]
      .map((part) => (part || "").trim())
      .filter(Boolean)
      .join(" · ");
  }

  function setField(root, name, value, placeholder) {
    const node = root.querySelector(`[data-field="${name}"]`);
    const text = (value ?? "").toString().trim();
    if (!text && !placeholder) {
      node.textContent = "";
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.textContent = text || placeholder;
    node.classList.toggle("is-placeholder", !text);
  }

  function fillSheet(root, model, placeholders) {
    root.classList.remove("template-classic", "template-banner", "template-editorial");
    root.classList.add(`template-${templateName(model.template)}`);
    applyTheme(model.theme, root);
    const company = model.company || blankCompany();
    const bill = model.billTo || { name: "", address: "", phone: "" };
    const logo = root.querySelector('[data-field="logo"]');
    if (company.logo) {
      logo.src = company.logo;
      logo.hidden = false;
      logo.alt = company.name ? `${company.name} logo` : "Company logo";
    } else {
      logo.removeAttribute("src");
      logo.hidden = true;
      logo.alt = "";
    }

    setField(root, "company-name", company.name, placeholders ? "Company name" : "");
    setField(root, "company-abn", formatAbn(company.abn), placeholders ? "ABN/ACN" : "");
    setField(root, "company-address", company.address, placeholders ? "Address" : "");
    setField(root, "company-contact", contactLine(company), placeholders ? "Phone · email" : "");
    setField(root, "number", model.number, placeholders ? "INV-0001" : "");
    setField(root, "date", formatDate(model.date), placeholders ? "Date" : "");
    setField(root, "bill-name", bill.name, placeholders ? "Client name" : "");
    setField(root, "bill-address", bill.address, placeholders ? "Client address" : "");
    setField(root, "bill-phone", bill.phone, placeholders ? "Client phone" : "");

    const tbody = root.querySelector('[data-field="lines"]');
    tbody.replaceChildren();
    if (!model.lines.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.className = "is-placeholder";
      cell.textContent = "Selected descriptions will appear here";
      row.append(cell);
      tbody.append(row);
    } else {
      for (const line of model.lines) {
        const row = document.createElement("tr");
        const description = document.createElement("td");
        description.textContent = line.description;
        const qty = document.createElement("td");
        qty.className = "num";
        qty.textContent = formatQty(line.qty);
        const price = document.createElement("td");
        price.className = "num";
        price.textContent = aud.format(line.price);
        const amount = document.createElement("td");
        amount.className = "num";
        amount.textContent = aud.format(line.amount);
        row.append(description, qty, price, amount);
        tbody.append(row);
      }
    }

    root.querySelector('[data-field="subtotal"]').textContent = aud.format(model.subtotal || 0);
    root.querySelector('[data-field="gst"]').textContent = aud.format(model.gst || 0);
    root.querySelector('[data-field="total"]').textContent = aud.format(model.total || 0);
    root.querySelector('[data-field="gst-words"]').textContent = aud.format(model.gst || 0);
  }

  function updateRowAmounts() {
    document.querySelectorAll(".service").forEach((row) => {
      const item = state.catalog.find((entry) => entry.id === row.dataset.id);
      const amountNode = row.querySelector(".line-amount");
      if (!item || !amountNode) return;
      const selected = state.draft.selected[item.id];
      if (!selected || !selected.on) {
        amountNode.textContent = "";
        amountNode.hidden = true;
        return;
      }
      const amount = money(item.price * normalizeQty(selected.qty));
      amountNode.hidden = false;
      amountNode.textContent = `Price ${aud.format(amount)}`;
      amountNode.setAttribute("aria-label", `Price ${aud.format(amount)}`);
    });
  }

  function updatePreview() {
    if (!previewSheet) return;
    const model = buildDraftModel();
    fillSheet(previewSheet, model, true);
    document.getElementById("sum-subtotal").textContent = aud.format(model.subtotal);
    document.getElementById("sum-gst").textContent = aud.format(model.gst);
    document.getElementById("sum-total").textContent = aud.format(model.total);
    updateRowAmounts();
  }

  function toast(message) {
    const node = document.getElementById("toast");
    node.textContent = message;
    node.classList.add("is-on");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.classList.remove("is-on"), 3200);
  }

  function showErrors(messages) {
    const box = document.getElementById("form-errors");
    const list = document.getElementById("form-error-list");
    list.replaceChildren();
    if (!messages.length) {
      box.hidden = true;
      return;
    }
    for (const message of messages) {
      const item = document.createElement("li");
      item.textContent = message;
      list.append(item);
    }
    box.hidden = false;
    box.focus();
  }

  function fillFormFromState() {
    document.getElementById("company-name").value = state.company.name;
    document.getElementById("company-abn").value = state.company.abn;
    document.getElementById("company-address").value = state.company.address;
    document.getElementById("company-phone").value = state.company.phone;
    document.getElementById("company-email").value = state.company.email;
    document.getElementById("invoice-date").value = state.draft.date;
    document.getElementById("invoice-number").value = state.draft.number;
    document.getElementById("bill-name").value = state.draft.billTo.name;
    document.getElementById("bill-address").value = state.draft.billTo.address;
    document.getElementById("bill-phone").value = state.draft.billTo.phone;
    const chosen = templateName(state.draft.template || state.company.template);
    const radio = document.querySelector(`input[name="invoice-template"][value="${chosen}"]`);
    if (radio) radio.checked = true;
    syncThemeControl();
  }

  function readFormIntoState() {
    state.company.name = document.getElementById("company-name").value;
    state.company.abn = document.getElementById("company-abn").value;
    state.company.address = document.getElementById("company-address").value;
    state.company.phone = document.getElementById("company-phone").value;
    state.company.email = document.getElementById("company-email").value;
    state.draft.date = document.getElementById("invoice-date").value;
    state.draft.number = document.getElementById("invoice-number").value;
    state.draft.billTo.name = document.getElementById("bill-name").value;
    state.draft.billTo.address = document.getElementById("bill-address").value;
    state.draft.billTo.phone = document.getElementById("bill-phone").value;
  }

  function syncEditUi() {
    const editing = Boolean(state.draft.editId);
    document.getElementById("edit-banner").hidden = !editing;
    document.getElementById("generate-btn").textContent = editing ? "Update invoice" : "Generate invoice";
  }

  function renderLogoThumb() {
    const box = document.getElementById("logo-preview");
    const remove = document.getElementById("logo-remove");
    box.replaceChildren();
    if (state.company.logo) {
      const image = document.createElement("img");
      image.src = state.company.logo;
      image.alt = "";
      box.append(image);
      remove.hidden = false;
    } else {
      box.textContent = "Logo";
      remove.hidden = true;
    }
  }

  function bindField(id, assign, save) {
    const node = document.getElementById(id);
    const write = () => {
      assign(node.value);
      save();
      updatePreview();
    };
    node.addEventListener("input", write);
    node.addEventListener("blur", () => {
      if (node.type !== "date") node.value = node.value.trim();
      write();
    });
  }

  function renderCatalog() {
    const list = document.getElementById("catalog-list");
    const empty = document.getElementById("catalog-empty");
    list.replaceChildren();
    empty.hidden = state.catalog.length > 0;
    for (const item of state.catalog) {
      list.append(state.editingId === item.id ? editorRow(item) : catalogRow(item));
    }
    updatePreview();
  }

  function catalogRow(item) {
    const selected = state.draft.selected[item.id] || { on: false, qty: normalizeQty(item.units) };
    const row = document.createElement("li");
    row.className = `service${selected.on ? " is-on" : ""}`;
    row.dataset.id = item.id;

    const main = document.createElement("label");
    main.className = "service-main";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.on;
    checkbox.addEventListener("change", () => {
      const previous = state.draft.selected[item.id] || { qty: normalizeQty(item.units) };
      state.draft.selected[item.id] = { on: checkbox.checked, qty: normalizeQty(previous.qty) };
      row.classList.toggle("is-on", checkbox.checked);
      saveDraft();
      updatePreview();
    });

    const copy = document.createElement("span");
    copy.className = "service-copy";
    const name = document.createElement("span");
    name.className = "service-name";
    name.textContent = item.description;
    const price = document.createElement("span");
    price.className = "service-price";
    price.textContent = `${aud.format(item.price)} per unit`;
    copy.append(name, price);
    main.append(checkbox, copy);

    const side = document.createElement("div");
    side.className = "service-side";
    const qtyLabel = document.createElement("label");
    qtyLabel.className = "qty";
    qtyLabel.textContent = "Units";
    const qty = document.createElement("input");
    qty.type = "number";
    qty.min = "0.01";
    qty.step = "0.01";
    qty.value = formatQty(selected.qty);
    qty.setAttribute("aria-label", `Units for ${item.description}`);
    qty.addEventListener("wheel", (event) => event.currentTarget.blur(), { passive: true });
    qty.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
    qty.addEventListener("input", () => {
      const parsed = parseFloat(qty.value);
      state.draft.selected[item.id] = {
        on: true,
        qty: Number.isFinite(parsed) && parsed > 0 ? normalizeQty(parsed) : selected.qty || 1,
      };
      checkbox.checked = true;
      row.classList.add("is-on");
      saveDraft();
      updatePreview();
    });
    qtyLabel.append(qty);

    const amount = document.createElement("span");
    amount.className = "line-amount";
    amount.hidden = !selected.on;

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn small ghost";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit ${item.description}`);
    edit.addEventListener("click", () => {
      state.editingId = item.id;
      renderCatalog();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn small danger";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${item.description}`);
    remove.addEventListener("click", () => {
      if (!window.confirm(`Remove "${item.description}" from saved descriptions?`)) return;
      state.catalog = state.catalog.filter((entry) => entry.id !== item.id);
      delete state.draft.selected[item.id];
      saveCatalog();
      saveDraft();
      renderCatalog();
    });

    side.append(qtyLabel, amount, edit, remove);
    row.append(main, side);
    return row;
  }

  function editorRow(item) {
    const row = document.createElement("li");
    row.className = "service";
    row.dataset.id = item.id;
    const editor = document.createElement("div");
    editor.className = "editor";
    const description = document.createElement("input");
    description.type = "text";
    description.value = item.description;
    description.maxLength = 180;
    description.setAttribute("aria-label", "Description");
    const price = document.createElement("input");
    price.type = "number";
    price.min = "0";
    price.step = "0.01";
    price.value = String(item.price);
    price.setAttribute("aria-label", "Unit price excluding GST");
    const units = document.createElement("input");
    units.type = "number";
    units.min = "0.01";
    units.step = "0.01";
    units.value = formatQty(item.units);
    units.setAttribute("aria-label", "Units");
    editor.append(description, price, units);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn small primary";
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn small ghost";
    cancel.textContent = "Cancel";

    const commit = () => {
      const nextDescription = description.value.trim();
      const nextPrice = parseMoney(price.value);
      const nextUnits = normalizeQty(units.value);
      if (!nextDescription) {
        toast("Enter a description.");
        description.focus();
        return;
      }
      if (nextPrice == null) {
        toast("Enter a unit price of 0 or more.");
        price.focus();
        return;
      }
      if (!(parseFloat(units.value) > 0)) {
        toast("Enter units greater than 0.");
        units.focus();
        return;
      }
      item.description = nextDescription;
      item.price = nextPrice;
      item.units = nextUnits;
      state.editingId = null;
      saveCatalog();
      renderCatalog();
    };

    save.addEventListener("click", commit);
    cancel.addEventListener("click", () => {
      state.editingId = null;
      renderCatalog();
    });
    description.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });
    price.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });
    units.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });

    const side = document.createElement("div");
    side.className = "service-side";
    side.append(save, cancel);
    row.append(editor, side);
    window.setTimeout(() => description.focus(), 0);
    return row;
  }

  function updateServiceCalc() {
    const node = document.getElementById("service-calc");
    const price = parseMoney(document.getElementById("service-price").value);
    const units = parseFloat(document.getElementById("service-units").value);
    if (price == null || !(units > 0)) {
      node.textContent = "Price $0.00";
      return;
    }
    node.textContent = `Price ${aud.format(money(price * normalizeQty(units)))}`;
  }

  function addService() {
    const descriptionInput = document.getElementById("service-desc");
    const priceInput = document.getElementById("service-price");
    const unitsInput = document.getElementById("service-units");
    const error = document.getElementById("service-error");
    const description = descriptionInput.value.trim();
    const price = parseMoney(priceInput.value);
    const units = parseFloat(unitsInput.value);
    if (!description) {
      error.hidden = false;
      error.textContent = "Enter a description.";
      descriptionInput.focus();
      return;
    }
    if (price == null) {
      error.hidden = false;
      error.textContent = "Enter a unit price of 0 or more, excluding GST.";
      priceInput.focus();
      return;
    }
    if (!(units > 0)) {
      error.hidden = false;
      error.textContent = "Enter units greater than 0.";
      unitsInput.focus();
      return;
    }
    error.hidden = true;
    state.catalog.push({ id: uid(), description, price, units: normalizeQty(units) });
    saveCatalog();
    descriptionInput.value = "";
    priceInput.value = "";
    unitsInput.value = "1";
    updateServiceCalc();
    renderCatalog();
    toast("Description saved. Price is unit price times units.");
    descriptionInput.focus();
  }

  function showView(name) {
    state.view = name;
    document.getElementById("view-create").hidden = name !== "create";
    document.getElementById("view-invoices").hidden = name !== "invoices";
    document.getElementById("view-detail").hidden = name !== "detail";
    const newTab = document.getElementById("nav-new");
    const savedTab = document.getElementById("nav-saved");
    if (name === "create") newTab.setAttribute("aria-current", "page");
    else newTab.removeAttribute("aria-current");
    if (name === "invoices" || name === "detail") savedTab.setAttribute("aria-current", "page");
    else savedTab.removeAttribute("aria-current");
    if (name === "invoices") renderInvoiceList();
    if (name === "detail") {
      const invoice = state.invoices.find((entry) => entry.id === state.detailId);
      applyTheme(invoice && invoice.theme);
    } else {
      syncThemeControl();
    }
  }

  function updateCount() {
    document.getElementById("saved-count").textContent = String(state.invoices.length);
  }

  function sortedInvoices() {
    return [...state.invoices].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }

  function renderInvoiceList() {
    const list = document.getElementById("invoice-list");
    const query = document.getElementById("invoice-search").value.trim().toLowerCase();
    list.replaceChildren();
    const invoices = sortedInvoices().filter((invoice) => {
      if (!query) return true;
      const haystack = [
        invoice.number,
        invoice.billTo.name,
        invoice.company.name,
        ...invoice.lines.map((line) => line.description),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

    if (!invoices.length) {
      const item = document.createElement("li");
      item.className = "empty";
      item.textContent = state.invoices.length
        ? "No invoices match that search."
        : "No invoices yet. Generate one and it will stay in this browser.";
      list.append(item);
      updateCount();
      return;
    }

    for (const invoice of invoices) {
      const item = document.createElement("li");
      item.className = "inv-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "inv-open";
      open.addEventListener("click", () => showDetail(invoice.id));

      const number = document.createElement("span");
      number.className = "inv-number";
      number.textContent = invoice.number;
      const who = document.createElement("span");
      who.className = "inv-who";
      who.textContent = invoice.billTo.name;
      const when = document.createElement("span");
      when.className = "inv-when";
      when.textContent = formatDate(invoice.date);
      const amount = document.createElement("span");
      amount.className = "inv-amount";
      amount.textContent = aud.format(invoice.total);
      open.append(number, who, when, amount);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn danger";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete ${invoice.number}`);
      remove.addEventListener("click", () => deleteInvoice(invoice.id));
      item.append(open, remove);
      list.append(item);
    }
    updateCount();
  }

  function showDetail(id) {
    const invoice = state.invoices.find((entry) => entry.id === id);
    if (!invoice) {
      showView("invoices");
      return;
    }
    state.detailId = id;
    const title = document.getElementById("detail-title");
    title.textContent = `${invoice.number} · ${invoice.billTo.name}`;
    const sheet = template.content.firstElementChild.cloneNode(true);
    fillSheet(sheet, invoice, false);
    document.getElementById("detail-mount").replaceChildren(sheet);
    showView("detail");
    title.focus();
  }

  function deleteInvoice(id) {
    const invoice = state.invoices.find((entry) => entry.id === id);
    if (!invoice) return;
    const label = invoice.billTo.name ? `${invoice.number} for ${invoice.billTo.name}` : invoice.number;
    if (!window.confirm(`Delete ${label}? This removes it from this browser.`)) return;
    const previous = state.invoices;
    state.invoices = state.invoices.filter((entry) => entry.id !== id);
    if (!saveInvoices()) {
      state.invoices = previous;
      return;
    }
    if (state.draft.editId === id) {
      delete state.draft.editId;
      saveDraft();
      syncEditUi();
    }
    toast("Invoice deleted from this browser.");
    showView("invoices");
  }

  function editInvoice(invoice) {
    const selected = {};
    let added = false;
    for (const line of invoice.lines) {
      let item =
        state.catalog.find((entry) => entry.id === line.id) ||
        state.catalog.find((entry) => entry.description === line.description && entry.price === line.price);
      if (!item) {
        item = { id: line.id || uid(), description: line.description, price: line.price, units: normalizeQty(line.qty) };
        state.catalog.push(item);
        added = true;
      }
      selected[item.id] = { on: true, qty: line.qty };
    }
    if (added) saveCatalog();
    state.draft = {
      editId: invoice.id,
      number: invoice.number,
      date: invoice.date,
      billTo: {
        name: invoice.billTo.name,
        address: invoice.billTo.address,
        phone: invoice.billTo.phone,
      },
      selected,
      template: templateName(invoice.template),
      theme: themeColor(invoice.theme),
    };
    state.company.template = state.draft.template;
    state.company.theme = state.draft.theme;
    saveCompany();
    saveDraft();
    fillFormFromState();
    syncEditUi();
    showErrors([]);
    renderCatalog();
    showView("create");
    toast("Prices use your saved descriptions. Generate again to update this invoice.");
  }

  function applyNewDraft() {
    const chosen = templateName(state.company.template);
    state.draft = freshDraft(state.invoices);
    state.draft.template = chosen;
    state.draft.theme = themeColor(state.company.theme);
    state.editingId = null;
    saveDraft();
    fillFormFromState();
    syncEditUi();
    showErrors([]);
    renderCatalog();
  }

  function generateInvoice() {
    readFormIntoState();
    if (!state.draft.number.trim()) {
      const others = state.invoices.filter((invoice) => invoice.id !== state.draft.editId);
      state.draft.number = nextNumber(others);
      document.getElementById("invoice-number").value = state.draft.number;
    }

    const errors = [];
    if (!state.company.name.trim()) errors.push("Company name is required.");
    if (state.company.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.company.email.trim())) {
      errors.push("Enter a valid company email, or leave it blank.");
    }
    if (!formatDate(state.draft.date)) errors.push("Choose an invoice date.");
    if (!state.draft.billTo.name.trim()) errors.push("Bill to name is required.");
    const lines = currentLines();
    if (!lines.length) errors.push("Tick at least one description.");
    const number = state.draft.number.trim();
    const clash = state.invoices.some(
      (invoice) => invoice.id !== state.draft.editId && invoice.number.toLowerCase() === number.toLowerCase()
    );
    if (clash) errors.push("That invoice number is already used.");
    showErrors(errors);
    if (errors.length) return;

    const existing = state.invoices.find((invoice) => invoice.id === state.draft.editId);
    const invoice = {
      id: existing ? existing.id : uid(),
      number,
      date: state.draft.date,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      company: {
        name: state.company.name.trim(),
        abn: state.company.abn.trim(),
        address: state.company.address.trim(),
        phone: state.company.phone.trim(),
        email: state.company.email.trim(),
        logo: safeLogo(state.company.logo),
      },
      billTo: {
        name: state.draft.billTo.name.trim(),
        address: state.draft.billTo.address.trim(),
        phone: state.draft.billTo.phone.trim(),
      },
      lines,
      ...totals(lines),
      template: templateName(state.draft.template),
      theme: themeColor(state.draft.theme),
    };

    state.company = {
      ...state.company,
      ...invoice.company,
      logo: state.company.logo,
      template: invoice.template,
      theme: invoice.theme,
    };
    saveCompany();

    const previous = state.invoices;
    state.invoices = existing
      ? state.invoices.map((entry) => (entry.id === existing.id ? invoice : entry))
      : [...state.invoices, invoice];
    if (!saveInvoices()) {
      state.invoices = previous;
      return;
    }

    applyNewDraft();
    updateCount();
    showDetail(invoice.id);
    toast(existing ? "Invoice updated on this device." : "Invoice generated and saved on this device.");
  }

  function currentModel() {
    if (state.view !== "detail") {
      readFormIntoState();
      const selected = document.querySelector('input[name="invoice-template"]:checked');
      if (selected) state.draft.template = templateName(selected.value);
      const colorInput = document.getElementById("theme-color");
      if (colorInput) state.draft.theme = themeColor(colorInput.value);
    }
    if (state.view === "detail") {
      return state.invoices.find((invoice) => invoice.id === state.detailId) || null;
    }
    return buildDraftModel();
  }

  function preparePrintSheet() {
    const model = currentModel();
    if (!model) return null;
    const sheet = template.content.firstElementChild.cloneNode(true);
    fillSheet(sheet, model, state.view !== "detail");
    document.getElementById("print-host").replaceChildren(sheet);
    return sheet;
  }

  const PRINT_TITLE = "\u200B";

  function printInvoice() {
    const model = currentModel();
    if (!model) return;
    const frame = document.getElementById("print-frame");
    const doc = frame.contentDocument;
    const styleUrl = new URL("styles.css", window.location.href).href;
    const fontUrl = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,650&amp;family=Outfit:wght@400;500;600&amp;display=swap";
    doc.open();
    doc.write(
      `<!DOCTYPE html><html lang="en-AU"><head><meta charset="utf-8"><title>${PRINT_TITLE}</title>` +
        `<link rel="stylesheet" href="${fontUrl}">` +
        `<link rel="stylesheet" href="${styleUrl}">` +
        `<style>@page{size:A4;margin:0}html,body{margin:0;background:#fff}html,body,.sheet,.sheet *{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>` +
        `</head><body></body></html>`
    );
    doc.close();
    applyTheme(model.theme, doc.documentElement);
    const sheet = template.content.firstElementChild.cloneNode(true);
    fillSheet(sheet, model, state.view !== "detail");
    doc.body.append(sheet);

    const previousTitle = document.title;
    document.title = PRINT_TITLE;
    const win = frame.contentWindow;
    win.addEventListener("afterprint", () => {
      document.title = previousTitle;
    }, { once: true });
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      win.focus();
      win.print();
    };
    const cssLink = [...doc.querySelectorAll('link[rel="stylesheet"]')].find((node) => node.href.includes("styles.css"));
    const cssReady = new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (!cssLink) {
        done();
        return;
      }
      cssLink.addEventListener("load", done, { once: true });
      cssLink.addEventListener("error", done, { once: true });
      try {
        if (cssLink.sheet && cssLink.sheet.cssRules && cssLink.sheet.cssRules.length) done();
      } catch {
        /* The file is still loading. */
      }
    });
    const fontsReady = doc.fonts && doc.fonts.ready ? doc.fonts.ready.catch(() => undefined) : Promise.resolve();
    Promise.all([cssReady, fontsReady]).then(start);
    window.setTimeout(start, 1500);
  }

  function downloadBackup() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      company: state.company,
      catalog: state.catalog,
      invoices: state.invoices,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `invoice-book-backup-${todayISO()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function restoreBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || ""));
        if (!data || data.version !== 1) throw new Error("bad version");
        const company = sanitizeCompany(data.company);
        const catalog = sanitizeCatalog(data.catalog);
        const invoices = uniqueById(
          (Array.isArray(data.invoices) ? data.invoices : []).map(sanitizeInvoice).filter(Boolean)
        );
        if (
          !window.confirm(
            "Replace company details, descriptions, and invoices on this device with the backup?"
          )
        ) {
          return;
        }
        state.company = company;
        state.catalog = catalog;
        state.invoices = invoices;
        state.draft = freshDraft(invoices);
        state.editingId = null;
        const saved = [saveCompany(), saveCatalog(), saveInvoices(), saveDraft()].every(Boolean);
        fillFormFromState();
        renderLogoThumb();
        syncEditUi();
        renderCatalog();
        updateCount();
        showView("invoices");
        if (!saved) return;
        toast("Backup restored on this device.");
      } catch {
        toast("That file is not an Invoice Book backup.");
      }
    };
    reader.readAsText(file);
  }

  function compressLogo(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("Upload a PNG, JPG, WEBP, or GIF logo."));
        return;
      }
      if (file.type === "image/svg+xml") {
        reject(new Error("Use a PNG, JPG, WEBP, or GIF logo."));
        return;
      }
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const max = 360;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        URL.revokeObjectURL(url);
        const webp = canvas.toDataURL("image/webp", 0.86);
        resolve(webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png"));
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image."));
      };
      image.src = url;
    });
  }

  function setAuthError(message) {
    const node = document.getElementById("auth-error");
    node.textContent = message || "";
    node.hidden = !message;
  }

  function setAuthMode(mode) {
    const login = mode !== "register";
    document.getElementById("login-form").hidden = !login;
    document.getElementById("register-form").hidden = login;
    document.getElementById("show-login").setAttribute("aria-selected", login ? "true" : "false");
    document.getElementById("show-register").setAttribute("aria-selected", login ? "false" : "true");
    document.getElementById("auth-title").textContent = login ? "Sign in" : "Create account";
    setAuthError("");
  }

  function showSignedOut(offline) {
    acceptProfileSync = false;
    state.user = null;
    state.token = "";
    document.getElementById("view-auth").hidden = false;
    document.getElementById("app-nav").hidden = true;
    document.getElementById("account-bar").hidden = true;
    document.getElementById("view-create").hidden = true;
    document.getElementById("view-invoices").hidden = true;
    document.getElementById("view-detail").hidden = true;
    document.getElementById("auth-offline").hidden = !offline;
    document.getElementById("login-form").querySelector("button").disabled = offline;
    document.getElementById("register-form").querySelector("button").disabled = offline;
    document.getElementById("show-login").disabled = offline;
    document.getElementById("show-register").disabled = offline;
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        },
        body: options.body,
      });
    } catch {
      throw new Error("OFFLINE");
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") throw new Error("OFFLINE");
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  function rememberSession(token) {
    state.token = token;
    try {
      localStorage.setItem(SESSION_KEY, token);
    } catch {
      setStorageStatus("This browser blocked storage, so you will need to sign in again next time.");
    }
  }

  function loadWorkspace(company) {
    acceptProfileSync = false;
    state.company = sanitizeCompany(company);
    state.catalog = sanitizeCatalog(loadJson(storageKeys().catalog, []));
    const storedInvoices = loadJson(storageKeys().invoices, []);
    state.invoices = uniqueById(
      (Array.isArray(storedInvoices) ? storedInvoices : []).map(sanitizeInvoice).filter(Boolean)
    );
    state.draft = sanitizeDraft(loadJson(storageKeys().draft, null), state.invoices);
    for (const id of Object.keys(state.draft.selected)) {
      if (!state.catalog.some((item) => item.id === id)) delete state.draft.selected[id];
    }
    state.editingId = null;
    state.detailId = null;
    saveCompany();
  }

  function enterApp(user) {
    state.user = { id: user.id, username: user.username };
    document.getElementById("view-auth").hidden = true;
    document.getElementById("auth-offline").hidden = true;
    document.getElementById("app-nav").hidden = false;
    document.getElementById("account-bar").hidden = false;
    document.getElementById("account-name").textContent = user.username;
    loadWorkspace(user.company);
    fillFormFromState();
    renderLogoThumb();
    syncEditUi();
    renderCatalog();
    renderInvoiceList();
    showView("create");
    acceptProfileSync = true;
  }

  async function signOut() {
    window.clearTimeout(profileTimer);
    profileDirty = false;
    acceptProfileSync = false;
    const token = state.token;
    state.user = null;
    try {
      if (token) await api("/api/logout", { method: "POST" });
    } catch {
      /* The local sign-in still ends if the account file is closed. */
    }
    state.token = "";
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* Ignore a blocked storage write. */
    }
    state.company = blankCompany();
    state.catalog = [];
    state.invoices = [];
    state.draft = sanitizeDraft(null, []);
    state.editingId = null;
    state.detailId = null;
    fillFormFromState();
    renderLogoThumb();
    if (previewSheet) updatePreview();
    showSignedOut(false);
    setAuthMode("login");
  }

  function companyFromRegister() {
    return sanitizeCompany({
      name: document.getElementById("reg-company-name").value,
      abn: document.getElementById("reg-abn").value,
      address: document.getElementById("reg-address").value,
      phone: document.getElementById("reg-phone").value,
      email: document.getElementById("reg-email").value,
      logo: "",
      template: "classic",
      theme: DEFAULT_THEME,
    });
  }

  function prefillRegisterFromLegacy() {
    const legacy = sanitizeCompany(loadJson("invoicebook.v1.company", null));
    if (!legacy.name || document.getElementById("reg-company-name").value) return;
    document.getElementById("reg-company-name").value = legacy.name;
    document.getElementById("reg-abn").value = legacy.abn;
    document.getElementById("reg-address").value = legacy.address;
    document.getElementById("reg-phone").value = legacy.phone;
    document.getElementById("reg-email").value = legacy.email;
  }

  async function restoreSession() {
    if (location.protocol === "file:") {
      showSignedOut(true);
      return;
    }
    let token = "";
    try {
      token = localStorage.getItem(SESSION_KEY) || "";
    } catch {
      token = "";
    }
    if (!token) {
      showSignedOut(false);
      return;
    }
    state.token = token;
    try {
      const data = await api("/api/me");
      enterApp(data.user);
    } catch (error) {
      state.token = "";
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {
        /* Ignore a blocked storage write. */
      }
      showSignedOut(error.message === "OFFLINE");
    }
  }

  function bindEvents() {
    bindField("company-name", (value) => {
      state.company.name = value;
    }, saveCompany);
    bindField("company-abn", (value) => {
      state.company.abn = value;
    }, saveCompany);
    bindField("company-address", (value) => {
      state.company.address = value;
    }, saveCompany);
    bindField("company-phone", (value) => {
      state.company.phone = value;
    }, saveCompany);
    bindField("company-email", (value) => {
      state.company.email = value;
    }, saveCompany);
    bindField("invoice-date", (value) => {
      state.draft.date = value;
    }, saveDraft);
    bindField("invoice-number", (value) => {
      state.draft.number = value;
    }, saveDraft);
    bindField("bill-name", (value) => {
      state.draft.billTo.name = value;
    }, saveDraft);
    bindField("bill-address", (value) => {
      state.draft.billTo.address = value;
    }, saveDraft);
    bindField("bill-phone", (value) => {
      state.draft.billTo.phone = value;
    }, saveDraft);

    document.getElementById("logo-input").addEventListener("change", async (event) => {
      const [file] = event.target.files || [];
      event.target.value = "";
      if (!file) return;
      try {
        state.company.logo = await compressLogo(file);
        saveCompany();
        renderLogoThumb();
        updatePreview();
        toast("Logo saved on this device.");
      } catch (error) {
        toast(error.message || "Could not use that logo.");
      }
    });

    document.getElementById("logo-remove").addEventListener("click", () => {
      state.company.logo = "";
      saveCompany();
      renderLogoThumb();
      updatePreview();
    });

    document.getElementById("service-add").addEventListener("click", addService);
    for (const id of ["service-desc", "service-price", "service-units"]) {
      document.getElementById(id).addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addService();
        }
      });
    }
    for (const id of ["service-price", "service-units"]) {
      document.getElementById(id).addEventListener("input", updateServiceCalc);
      document.getElementById(id).addEventListener("wheel", (event) => {
        event.currentTarget.blur();
      }, { passive: true });
    }

    document.getElementById("invoice-form").addEventListener("submit", (event) => {
      event.preventDefault();
      generateInvoice();
    });
    document.getElementById("invoice-form").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.target.tagName !== "INPUT") return;
      if (event.target.id === "service-desc" || event.target.id === "service-price" || event.target.id === "service-units") return;
      event.preventDefault();
    });
    document.querySelectorAll('input[name="invoice-template"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const chosen = templateName(input.value);
        state.company.template = chosen;
        state.draft.template = chosen;
        saveCompany();
        saveDraft();
        updatePreview();
      });
    });
    document.getElementById("theme-color").addEventListener("input", (event) => {
      setTheme(event.target.value);
    });
    document.querySelectorAll(".theme-dot").forEach((dot) => {
      dot.addEventListener("click", () => setTheme(dot.dataset.theme));
    });
    document.getElementById("print-draft").addEventListener("click", printInvoice);
    document.getElementById("reset-draft").addEventListener("click", () => {
      const hasClient = state.draft.billTo.name || state.draft.billTo.address || state.draft.billTo.phone;
      const hasTicks = Object.values(state.draft.selected).some((entry) => entry && entry.on);
      if ((hasClient || hasTicks) && !window.confirm("Clear the client and ticked descriptions? Company details and saved descriptions stay.")) {
        return;
      }
      applyNewDraft();
    });

    document.getElementById("log-out").addEventListener("click", () => {
      signOut();
    });
    document.getElementById("show-login").addEventListener("click", () => setAuthMode("login"));
    document.getElementById("show-register").addEventListener("click", () => setAuthMode("register"));
    document.getElementById("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      setAuthError("");
      const username = document.getElementById("login-username").value.trim();
      const password = document.getElementById("login-password").value;
      if (!username || !password) {
        setAuthError("Enter your username and password.");
        return;
      }
      const button = document.getElementById("login-submit");
      button.disabled = true;
      try {
        const data = await api("/api/login", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
        rememberSession(data.token);
        document.getElementById("login-password").value = "";
        enterApp(data.user);
      } catch (error) {
        setAuthError(error.message === "OFFLINE"
          ? "The account file is not running."
          : (error.message || "Could not sign in."));
        if (error.message === "OFFLINE") showSignedOut(true);
      } finally {
        button.disabled = !document.getElementById("auth-offline").hidden;
      }
    });
    document.getElementById("register-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      setAuthError("");
      const username = document.getElementById("reg-username").value.trim();
      const password = document.getElementById("reg-password").value;
      const confirm = document.getElementById("reg-password2").value;
      const company = companyFromRegister();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/.test(username)) {
        setAuthError("Username must be 3–40 characters and use letters, numbers, dots, or dashes.");
        return;
      }
      if (password.length < 8) {
        setAuthError("Password must be at least 8 characters.");
        return;
      }
      if (password !== confirm) {
        setAuthError("Those passwords do not match.");
        return;
      }
      if (!company.name) {
        setAuthError("Add the company name.");
        return;
      }
      const button = document.getElementById("register-submit");
      button.disabled = true;
      try {
        const data = await api("/api/register", {
          method: "POST",
          body: JSON.stringify({ username, password, company }),
        });
        rememberSession(data.token);
        document.getElementById("reg-password").value = "";
        document.getElementById("reg-password2").value = "";
        enterApp(data.user);
        toast("Account saved. Company details are filled in.");
      } catch (error) {
        setAuthError(error.message === "OFFLINE"
          ? "The account file is not running."
          : (error.message || "Could not create the account."));
        if (error.message === "OFFLINE") showSignedOut(true);
      } finally {
        button.disabled = !document.getElementById("auth-offline").hidden;
      }
    });

    document.getElementById("nav-new").addEventListener("click", () => showView("create"));
    document.getElementById("nav-saved").addEventListener("click", () => showView("invoices"));
    document.getElementById("invoice-search").addEventListener("input", renderInvoiceList);
    document.getElementById("backup-download").addEventListener("click", downloadBackup);
    document.getElementById("backup-restore").addEventListener("change", (event) => {
      const [file] = event.target.files || [];
      event.target.value = "";
      if (file) restoreBackup(file);
    });
    document.getElementById("detail-back").addEventListener("click", () => showView("invoices"));
    document.getElementById("detail-print").addEventListener("click", printInvoice);
    document.getElementById("detail-edit").addEventListener("click", () => {
      const invoice = state.invoices.find((entry) => entry.id === state.detailId);
      if (invoice) editInvoice(invoice);
    });
    document.getElementById("detail-delete").addEventListener("click", () => {
      if (state.detailId) deleteInvoice(state.detailId);
    });

    window.addEventListener("beforeprint", () => {
      document.title = PRINT_TITLE;
      preparePrintSheet();
    });
    window.addEventListener("afterprint", () => {
      document.title = "Invoice Book";
    });
    window.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        printInvoice();
      }
    });
  }

  function boot() {
    previewSheet = template.content.firstElementChild.cloneNode(true);
    document.getElementById("preview-mount").append(previewSheet);
    prefillRegisterFromLegacy();
    bindEvents();
    restoreSession();
  }

  boot();
})();
