const STORAGE_KEY = "parkingSlots";
const DEFAULT_TOTAL = 20;
const MAX_SLOTS = 100;

const STATUS = {
  EMPTY: "empty",
  OCCUPIED: "occupied",
};

const TYPES = {
  normal: { label: "Normal", icon: "🚗" },
  vip: { label: "VIP", icon: "⭐" },
  handicapped: { label: "Handicapped", icon: "♿" },
};

const TYPE_KEYS = Object.keys(TYPES);

const THEME_KEY = "parkingTheme";
const THEMES = {
  LIGHT: "light",
  DARK: "dark",
};

const searchQueries = {
  admin: "",
  user: "",
};

const latestData = {
  admin: null,
  user: null,
};

const SEARCH_DEFAULT_MESSAGE = 'Showing all slots. Try “Slot 3”, “empty slots”, or “nearest empty slot”.';
const timerIntervals = {};

function createEmptySlot(overrides = {}) {
  const now = Date.now();
  return {
    status: STATUS.EMPTY,
    type: "normal",
    lastChanged: now,
    lastFreeDuration: 0,
    lastOccupiedDuration: 0,
    ...overrides,
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    hours.toString().padStart(2, "0"),
    minutes.toString().padStart(2, "0"),
    seconds.toString().padStart(2, "0"),
  ];
  return parts.join(":");
}

function getCurrentTimerText(slot, now = Date.now()) {
  const label = slot.status === STATUS.OCCUPIED ? "Occupied for" : "Free for";
  const duration = formatDuration(now - (slot.lastChanged || now));
  return `${label} ${duration}`;
}

function getPreviousTimerText(slot) {
  const label = slot.status === STATUS.OCCUPIED ? "Last free" : "Last occupied";
  const previous =
    slot.status === STATUS.OCCUPIED ? slot.lastFreeDuration : slot.lastOccupiedDuration;
  if (!previous) {
    return `${label}: --`;
  }
  return `${label}: ${formatDuration(previous)}`;
}

applyThemePreference(getStoredTheme());

function readStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getStoredTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === THEMES.DARK ? THEMES.DARK : THEMES.LIGHT;
}

function updateThemeToggleVisual(theme = document.documentElement.dataset.theme) {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;
  const isDark = theme === THEMES.DARK;
  toggle.classList.toggle("is-dark", isDark);
  toggle.setAttribute("aria-pressed", String(isDark));
}

function applyThemePreference(theme) {
  const normalized = theme === THEMES.DARK ? THEMES.DARK : THEMES.LIGHT;
  document.documentElement.dataset.theme = normalized;
  updateThemeToggleVisual(normalized);
  return normalized;
}

function setThemePreference(theme) {
  const applied = applyThemePreference(theme);
  localStorage.setItem(THEME_KEY, applied);
}

function initThemeToggle() {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;
  updateThemeToggleVisual();
  toggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || THEMES.LIGHT;
    const next = current === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
    setThemePreference(next);
  });
}

function runSlotSearch(query, data) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return { indices: [], message: SEARCH_DEFAULT_MESSAGE };
  }

  const slots = data.slots;
  const slotMatch = trimmed.match(/slot\s*(\d+)/);
  if (slotMatch) {
    const requested = Number(slotMatch[1]);
    if (requested >= 1 && requested <= slots.length) {
      return { indices: [requested - 1], message: `Highlighted Slot ${requested}.` };
    }
    return { indices: [], message: `Slot ${requested} is outside the current range.` };
  }

  const wantsNearest = trimmed.includes("nearest") || trimmed.includes("closest");
  const wantsEmpty = /(empty|free|available)/.test(trimmed);
  const wantsOccupied = trimmed.includes("occupied");
  const typeKey = TYPE_KEYS.find((key) => trimmed.includes(key));
  const statusFilter = wantsEmpty ? STATUS.EMPTY : wantsOccupied ? STATUS.OCCUPIED : null;

  if (wantsNearest && (wantsEmpty || !statusFilter)) {
    const idx = slots.findIndex(
      (slot) => slot.status === STATUS.EMPTY && (!typeKey || slot.type === typeKey)
    );
    if (idx >= 0) {
      const label = typeKey ? `${TYPES[typeKey].label} ` : "";
      return { indices: [idx], message: `Nearest empty ${label}slot is Slot ${idx + 1}.` };
    }
    const label = typeKey ? `${TYPES[typeKey].label.toLowerCase()} ` : "";
    return { indices: [], message: `No empty ${label}slots available right now.` };
  }

  if (!statusFilter && !typeKey) {
    return { indices: [], message: `No matches. Try “Slot 4” or “empty slots”.` };
  }

  const indices = [];
  slots.forEach((slot, idx) => {
    if (typeKey && slot.type !== typeKey) return;
    if (statusFilter && slot.status !== statusFilter) return;
    indices.push(idx);
  });

  if (indices.length) {
    let descriptor = "";
    if (statusFilter === STATUS.EMPTY) descriptor += "empty ";
    if (statusFilter === STATUS.OCCUPIED) descriptor += "occupied ";
    if (typeKey) descriptor += `${TYPES[typeKey].label} `;
    descriptor = descriptor.trim() || "matching";
    const plural = indices.length > 1 ? "slots" : "slot";
    return { indices, message: `Highlighted ${indices.length} ${descriptor} ${plural}.` };
  }

  return { indices: [], message: `No slots found for “${query.trim()}”.` };
}

function applySearchHighlights(page, data) {
  const query = searchQueries[page] ?? "";
  const { indices, message } = runSlotSearch(query, data);
  const hint = document.getElementById(`${page}SearchHint`);
  if (hint) {
    hint.textContent = message;
  }
  return indices;
}

function setupSearchInputs(page, rerender) {
  const input = document.getElementById(`${page}Search`);
  if (!input) return;
  const clearBtn = document.getElementById(`${page}SearchClear`);
  input.value = searchQueries[page] ?? "";

  const refresh = () => rerender(ensureData());

  input.addEventListener("input", () => {
    searchQueries[page] = input.value;
    refresh();
  });

  clearBtn?.addEventListener("click", () => {
    searchQueries[page] = "";
    input.value = "";
    refresh();
  });
}

function normalizeSlot(entry) {
  if (typeof entry === "string") {
    return createEmptySlot({ status: entry });
  }
  if (!entry || typeof entry !== "object") {
    return createEmptySlot();
  }
  return {
    status: entry.status === STATUS.OCCUPIED ? STATUS.OCCUPIED : STATUS.EMPTY,
    type: TYPE_KEYS.includes(entry.type) ? entry.type : "normal",
    lastChanged: typeof entry.lastChanged === "number" ? entry.lastChanged : Date.now(),
    lastFreeDuration: typeof entry.lastFreeDuration === "number" ? entry.lastFreeDuration : 0,
    lastOccupiedDuration:
      typeof entry.lastOccupiedDuration === "number" ? entry.lastOccupiedDuration : 0,
  };
}

function ensureData() {
  let data = readStorage();
  let changed = false;
  if (!data || !Array.isArray(data.slots)) {
    data = {
      total: DEFAULT_TOTAL,
      slots: Array(DEFAULT_TOTAL)
        .fill(null)
        .map(() => createEmptySlot()),
      updatedAt: Date.now(),
    };
    changed = true;
  }

  data.slots = data.slots.map(normalizeSlot);

  if (data.slots.length !== data.total) {
    const diff = data.total - data.slots.length;
    if (diff > 0) {
      const additions = Array(diff)
        .fill(null)
        .map(() => createEmptySlot());
      data.slots = data.slots.concat(additions);
    } else {
      data.slots = data.slots.slice(0, data.total);
    }
    changed = true;
  }
  if (changed) {
    writeStorage(data);
  }
  return data;
}

function setTotalSlots(total) {
  const sanitized = Math.max(1, Math.min(MAX_SLOTS, Number(total) || DEFAULT_TOTAL));
  const data = ensureData();
  data.total = sanitized;
  if (data.slots.length > sanitized) {
    data.slots = data.slots.slice(0, sanitized);
  } else if (data.slots.length < sanitized) {
    const additions = Array(sanitized - data.slots.length)
      .fill(null)
      .map(() => createEmptySlot());
    data.slots = data.slots.concat(additions);
  }
  data.updatedAt = Date.now();
  writeStorage(data);
  return data;
}

function toggleSlot(index) {
  const data = ensureData();
  const slot = data.slots[index];
  if (!slot) return data;
  const now = Date.now();
  if (slot.status === STATUS.EMPTY) {
    slot.lastFreeDuration = now - slot.lastChanged;
    slot.status = STATUS.OCCUPIED;
  } else {
    slot.lastOccupiedDuration = now - slot.lastChanged;
    slot.status = STATUS.EMPTY;
  }
  slot.lastChanged = now;
  data.updatedAt = now;
  writeStorage(data);
  return data;
}

function setSlotType(index, type) {
  if (!TYPE_KEYS.includes(type)) return ensureData();
  const data = ensureData();
  data.slots[index].type = type;
  data.updatedAt = Date.now();
  writeStorage(data);
  return data;
}

function getCounts(data) {
  const summary = data.slots.reduce(
    (acc, slot) => {
      if (slot.status === STATUS.OCCUPIED) {
        acc.occupied += 1;
      }
      if (slot.type === "vip") {
        acc.vipTotal += 1;
        if (slot.status === STATUS.EMPTY) {
          acc.vipFree += 1;
        }
      }
      return acc;
    },
    { occupied: 0, vipTotal: 0, vipFree: 0 }
  );

  const empty = data.total - summary.occupied;
  const occupancy = data.total ? Math.round((summary.occupied / data.total) * 100) : 0;
  const freePercent = data.total ? Math.round((empty / data.total) * 100) : 0;

  return {
    empty,
    occupied: summary.occupied,
    vipFree: summary.vipFree,
    vipTotal: summary.vipTotal,
    occupancy,
    freePercent,
  };
}

function renderStats(container, data) {
  if (!container) return;
  const { empty, occupied, vipFree, vipTotal, occupancy, freePercent } = getCounts(data);

  container.innerHTML = `
    <div class="stat-card primary">
      <p class="stat-label">Total Slots</p>
      <p class="stat-value">${data.total}</p>
      <p class="stat-sub">Configured capacity</p>
    </div>
    <div class="stat-card positive">
      <p class="stat-label">Free Slots</p>
      <p class="stat-value">${empty}</p>
      <p class="stat-sub">${freePercent}% available</p>
    </div>
    <div class="stat-card alert">
      <p class="stat-label">Occupied Slots</p>
      <p class="stat-value">${occupied}</p>
      <p class="stat-sub">${occupancy}% in use</p>
    </div>
    <div class="stat-card neutral">
      <p class="stat-label">VIP Free Slots</p>
      <p class="stat-value">${vipFree}</p>
      <p class="stat-sub">of ${vipTotal} VIP spots</p>
    </div>
    <div class="stat-card accent">
      <div class="stat-chart" style="--value: ${occupancy};">
        <span>${occupancy}<small>%</small></span>
      </div>
      <div>
        <p class="stat-label">% Occupancy</p>
        <p class="stat-value">${occupancy}%</p>
        <p class="stat-sub">${occupied} of ${data.total} slots</p>
      </div>
    </div>
  `;
}

function renderSlots(container, data, options = {}) {
  if (!container) return;
  const { readOnly = false, highlights = [], onUpdate } = options;
  const highlightSet = new Set(highlights);
  container.innerHTML = "";
  data.slots.forEach((slotData, idx) => {
    const slot = document.createElement("div");
    slot.className = `slot ${slotData.status} type-${slotData.type}${readOnly ? " read-only" : ""}`;
    if (highlightSet.has(idx)) {
      slot.classList.add("highlight");
    }
    slot.setAttribute("role", "button");
    slot.tabIndex = readOnly ? -1 : 0;

    const head = document.createElement("div");
    head.className = "slot-head";
    head.innerHTML = `<strong>Slot ${idx + 1}</strong>`;

    const badge = document.createElement("span");
    badge.className = `type-badge type-${slotData.type}`;
    const meta = TYPES[slotData.type];
    badge.textContent = `${meta.icon} ${meta.label}`;
    head.appendChild(badge);

    const statusText = document.createElement("div");
    statusText.className = "slot-status";
    statusText.textContent = slotData.status === STATUS.EMPTY ? "Empty" : "Occupied";

    const timers = document.createElement("div");
    timers.className = "slot-timers";

    const currentTimer = document.createElement("p");
    currentTimer.className = "slot-timer slot-timer-current";
    currentTimer.textContent = getCurrentTimerText(slotData);

    const previousTimer = document.createElement("p");
    previousTimer.className = "slot-timer slot-timer-previous";
    previousTimer.textContent = getPreviousTimerText(slotData);

    timers.append(currentTimer, previousTimer);

    slot.append(head, statusText, timers);

    if (!readOnly) {
      slot.addEventListener("click", () => {
        const updated = toggleSlot(idx);
        onUpdate?.(updated);
      });
      slot.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          slot.click();
        }
      });

      const typeWrap = document.createElement("div");
      typeWrap.className = "type-select-wrapper";
      const select = document.createElement("select");
      select.className = "type-select";
      TYPE_KEYS.forEach((key) => {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = TYPES[key].label;
        select.appendChild(option);
      });
      select.value = slotData.type;
      select.addEventListener("click", (evt) => evt.stopPropagation());
      select.addEventListener("change", (evt) => {
        const updated = setSlotType(idx, evt.target.value);
        onUpdate?.(updated);
      });
      typeWrap.appendChild(select);
      slot.appendChild(typeWrap);
    } else {
      slot.classList.add("read-only");
    }

    container.appendChild(slot);
  });
}

function updateSlotTimers(container, data) {
  if (!container) return;
  const now = Date.now();
  const slotElements = container.querySelectorAll(".slot");
  slotElements.forEach((slotEl, idx) => {
    const slotData = data.slots[idx];
    if (!slotData) return;
    const currentEl = slotEl.querySelector(".slot-timer-current");
    const previousEl = slotEl.querySelector(".slot-timer-previous");
    if (currentEl) {
      currentEl.textContent = getCurrentTimerText(slotData, now);
    }
    if (previousEl) {
      previousEl.textContent = getPreviousTimerText(slotData);
    }
  });
}

function startSlotTimerLoop(page, containerId) {
  clearInterval(timerIntervals[page]);
  timerIntervals[page] = setInterval(() => {
    const container = document.getElementById(containerId);
    if (!container) return;
    const data = latestData[page];
    if (!data) return;
    updateSlotTimers(container, data);
  }, 1000);
}

function initAdminPage() {
  const totalInput = document.getElementById("totalInput");
  const statsEl = document.getElementById("adminStats");
  const gridEl = document.getElementById("adminSlotGrid");

  const render = (payload) => {
    latestData.admin = payload;
    if (totalInput) {
      totalInput.value = payload.total;
    }
    renderStats(statsEl, payload);
    const highlights = applySearchHighlights("admin", payload);
    renderSlots(gridEl, payload, { highlights, onUpdate: render });
    updateSlotTimers(gridEl, payload);
  };

  render(ensureData());
  setupSearchInputs("admin", render);
  startSlotTimerLoop("admin", "adminSlotGrid");

  const applyBtn = document.getElementById("applyTotal");
  applyBtn?.addEventListener("click", () => {
    const newTotal = Number(totalInput.value);
    const updated = setTotalSlots(newTotal);
    render(updated);
  });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      const updated = readStorage() ?? ensureData();
      render(updated);
    }
  });
}

function initUserPage() {
  const statsEl = document.getElementById("userStats");
  const gridEl = document.getElementById("userSlotGrid");

  const render = (payload) => {
    latestData.user = payload;
    renderStats(statsEl, payload);
    const highlights = applySearchHighlights("user", payload);
    renderSlots(gridEl, payload, { readOnly: true, highlights });
    updateSlotTimers(gridEl, payload);
  };

  render(ensureData());
  setupSearchInputs("user", render);
  startSlotTimerLoop("user", "userSlotGrid");

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      const updated = readStorage() ?? ensureData();
      render(updated);
    }
  });
}

window.addEventListener("storage", (event) => {
  if (event.key === THEME_KEY) {
    applyThemePreference(event.newValue);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  const page = document.body.dataset.page;
  if (page === "admin") {
    initAdminPage();
  }
  if (page === "user") {
    initUserPage();
  }
});

