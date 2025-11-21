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
const pageRenderers = {};
const CHAT_TYPING_DELAY = 350;
const CHAT_GREETING =
  "Hi! I’m your parking assistant. Ask me to find empty slots, VIP spaces, counts, or the nearest spot.";
const RUSH_COLLECTION = "parkingSessions";
const RUSH_LOOKBACK_DAYS = 7;
const FORECAST_CACHE_DURATION = 5 * 60 * 1000;

const firebaseService = {
  initialized: false,
  enabled: false,
  app: null,
  db: null,
};

const forecastCache = {
  data: null,
  totalSlots: null,
  expiresAt: 0,
  promise: null,
};

function createEmptySlot(overrides = {}) {
  const now = Date.now();
  return {
    status: STATUS.EMPTY,
    type: "normal",
    lastChanged: now,
    lastFreeDuration: 0,
    lastOccupiedDuration: 0,
    sessionId: null,
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
  return ${label} ${duration};
}

function getPreviousTimerText(slot) {
  const label = slot.status === STATUS.OCCUPIED ? "Last free" : "Last occupied";
  const previous =
    slot.status === STATUS.OCCUPIED ? slot.lastFreeDuration : slot.lastOccupiedDuration;
  if (!previous) {
    return ${label}: --;
  }
  return ${label}: ${formatDuration(previous)};
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
      return { indices: [requested - 1], message: Highlighted Slot ${requested}. };
    }
    return { indices: [], message: Slot ${requested} is outside the current range. };
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
      return { indices: [idx], message: Nearest empty ${label}slot is Slot ${idx + 1}. };
    }
    const label = typeKey ? `${TYPES[typeKey].label.toLowerCase()} ` : "";
    return { indices: [], message: No empty ${label}slots available right now. };
  }

  if (!statusFilter && !typeKey) {
    return { indices: [], message: No matches. Try “Slot 4” or “empty slots”. };
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
    return { indices, message: Highlighted ${indices.length} ${descriptor} ${plural}. };
  }

  return { indices: [], message: No slots found for “${query.trim()}”. };
}

function applySearchHighlights(page, data) {
  const query = searchQueries[page] ?? "";
  const { indices, message } = runSlotSearch(query, data);
  const hint = document.getElementById(${page}SearchHint);
  if (hint) {
    hint.textContent = message;
  }
  return indices;
}

function setupSearchInputs(page, rerender) {
  const input = document.getElementById(${page}Search);
  if (!input) return;
  const clearBtn = document.getElementById(${page}SearchClear);
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

function initFirebaseApp() {
  if (firebaseService.initialized) {
    return firebaseService;
  }
  firebaseService.initialized = true;
  try {
    if (!window.firebase || !window.PARKING_FIREBASE_CONFIG) {
      throw new Error("Missing Firebase SDK or config");
    }
    if (firebase.apps && firebase.apps.length) {
      firebaseService.app = firebase.app();
    } else {
      firebaseService.app = firebase.initializeApp(window.PARKING_FIREBASE_CONFIG);
    }
    firebaseService.db = firebase.firestore();
    firebaseService.enabled = true;
  } catch (error) {
    console.warn("[Parking] Firebase disabled:", error?.message || error);
    firebaseService.enabled = false;
  }
  return firebaseService;
}

function getFirebaseDb() {
  if (!firebaseService.initialized) {
    initFirebaseApp();
  }
  return firebaseService.enabled ? firebaseService.db : null;
}

function generateSessionId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return session-${Date.now()}-${Math.random().toString(16).slice(2, 10)};
}

function recordSessionStart(sessionId, slotIndex, slotType) {
  const db = getFirebaseDb();
  if (!db || !sessionId) return Promise.resolve();
  const now = Date.now();
  return db
    .collection(RUSH_COLLECTION)
    .doc(sessionId)
    .set(
      {
        sessionId,
        slotIndex,
        slotNumber: slotIndex + 1,
        slotType,
        timeIn: now,
        timeOut: null,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    )
    .catch((error) => {
      console.warn("[Parking] Failed to record time-in:", error);
    });
}

function recordSessionEnd(sessionId) {
  const db = getFirebaseDb();
  if (!db || !sessionId) return Promise.resolve();
  const now = Date.now();
  return db
    .collection(RUSH_COLLECTION)
    .doc(sessionId)
    .set(
      {
        timeOut: now,
        updatedAt: now,
      },
      { merge: true }
    )
    .catch((error) => {
      console.warn("[Parking] Failed to record time-out:", error);
    });
}

function fetchSessionsSince(cutoffMs) {
  const db = getFirebaseDb();
  if (!db) {
    return Promise.reject(new Error("Firebase is not enabled"));
  }
  return db
    .collection(RUSH_COLLECTION)
    .where("timeIn", ">=", cutoffMs)
    .orderBy("timeIn", "asc")
    .get()
    .then((snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })))
    .catch((error) => {
      console.warn("[Parking] Failed to load sessions:", error);
      throw error;
    });
}

function appendChatMessage(page, role, text) {
  const container = document.getElementById(${page}ChatMessages);
  if (!container || !text) return;
  const bubble = document.createElement("div");
  bubble.className = chat-bubble ${role};
  String(text)
    .split(/\n+/)
    .forEach((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      bubble.appendChild(p);
    });
  container.appendChild(bubble);
  container.scrollTo({
    top: container.scrollHeight,
    behavior: "smooth",
  });
}

function formatSlotList(indices) {
  if (!Array.isArray(indices) || !indices.length) {
    return "";
  }
  const slots = indices.map((idx) => Slot ${idx + 1});
  if (slots.length <= 3) {
    return slots.join(", ");
  }
  return ${slots.length} slots;
}

function applyChatSearch(page, query) {
  if (!query) return;
  searchQueries[page] = query;
  const input = document.getElementById(${page}Search);
  if (input) {
    input.value = query;
  }
  const rerender = pageRenderers[page];
  if (typeof rerender === "function") {
    const payload = latestData[page] ?? ensureData();
    rerender(payload);
  }
}

function buildChatResponse(query, data) {
  const trimmed = query.trim();
  if (!trimmed) {
    return { text: "Please ask me about parking availability or slot status." };
  }
  const normalized = trimmed.toLowerCase();
  const counts = getCounts(data);

  if (/(how many|cars parked|vehicles parked|occupied)/.test(normalized)) {
    const carWord = counts.occupied === 1 ? "car" : "cars";
    const slotWord = counts.empty === 1 ? "slot" : "slots";
    return {
      text: There ${counts.occupied === 1 ? "is" : "are"} ${counts.occupied} ${carWord} parked and ${counts.empty} free ${slotWord} out of ${data.total}.,
    };
  }

  if (/vip/.test(normalized) && /(free|empty|available)/.test(normalized)) {
    const result = runSlotSearch("vip empty slots", data);
    const list = formatSlotList(result.indices);
    if (result.indices.length) {
      return {
        text: VIP slots open: ${list}. I highlighted them for you.,
        followupQuery: "VIP empty slots",
      };
    }
    return { text: "All VIP slots are occupied at the moment." };
  }

  if (
    /nearest|closest/.test(normalized) ||
    /where should i park|park my car|need a spot/.test(normalized)
  ) {
    const wantsVip = /vip/.test(normalized);
    const searchQuery = wantsVip ? "nearest empty vip slot" : "nearest empty slot";
    const result = runSlotSearch(searchQuery, data);
    if (result.indices.length) {
      const slotNumber = result.indices[0] + 1;
      return {
        text: ${wantsVip ? "VIP " : ""}Slot ${slotNumber} is the closest empty spot.,
        followupQuery: searchQuery,
      };
    }
    return {
      text: "I couldn’t find a free spot right now. I’ll keep highlighting new openings as they appear.",
    };
  }

  if (/empty|free|occupied|slot/.test(normalized)) {
    const result = runSlotSearch(trimmed, data);
    const list = formatSlotList(result.indices);
    return {
      text: result.indices.length ? `${result.message}${list ? ` (${list})` : ""}` : result.message,
      followupQuery: trimmed,
    };
  }

  return {
    text:
      "I can answer things like “Show me empty slots”, “Which VIP slot is free?”, “How many cars are parked?”, or “Nearest empty slot?”. Try one of those!",
  };
}

function initChatAssistant(page, greeting = CHAT_GREETING) {
  const form = document.getElementById(${page}ChatForm);
  const input = document.getElementById(${page}ChatInput);
  const messages = document.getElementById(${page}ChatMessages);
  if (!form || !input || !messages) return;

  if (!messages.dataset.initialized) {
    appendChatMessage(page, "bot", greeting);
    messages.dataset.initialized = "true";
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    appendChatMessage(page, "user", query);
    input.value = "";
    const reply = () => {
      const data = latestData[page] ?? ensureData();
      const response = buildChatResponse(query, data);
      appendChatMessage(page, "bot", response.text);
      if (response.followupQuery) {
        applyChatSearch(page, response.followupQuery);
      }
    };
    window.setTimeout(reply, CHAT_TYPING_DELAY);
  });
}

function requestForecastForPage(page, totalSlots) {
  const grid = document.getElementById(${page}Forecast);
  const statusEl = document.getElementById(${page}ForecastStatus);
  if (!grid || !statusEl || !totalSlots) return;

  if (!getFirebaseDb()) {
    updateForecastUI(page, { status: "disabled" });
    return;
  }

  const now = Date.now();
  if (
    forecastCache.data &&
    forecastCache.totalSlots === totalSlots &&
    forecastCache.expiresAt > now
  ) {
    updateForecastUI(page, { status: "ready", data: forecastCache.data });
    return;
  }

  updateForecastUI(page, { status: "loading" });

  if (!forecastCache.promise) {
    forecastCache.promise = loadRushForecast(totalSlots)
      .then((data) => {
        forecastCache.data = data;
        forecastCache.totalSlots = totalSlots;
        forecastCache.expiresAt = Date.now() + FORECAST_CACHE_DURATION;
        return data;
      })
      .catch((error) => {
        forecastCache.data = null;
        console.warn("[Parking] Rush forecast failed:", error);
        throw error;
      })
      .finally(() => {
        forecastCache.promise = null;
      });
  }

  forecastCache.promise
    .then((data) => {
      if (data) {
        updateForecastUI(page, { status: "ready", data });
      } else {
        updateForecastUI(page, { status: "empty" });
      }
    })
    .catch(() => {
      updateForecastUI(page, { status: "error" });
    });
}

async function loadRushForecast(totalSlots) {
  const cutoff = Date.now() - RUSH_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const sessions = await fetchSessionsSince(cutoff);
  if (!sessions.length) {
    return null;
  }
  const summary = calculateRushForecast(sessions, totalSlots);
  if (!summary) {
    return null;
  }
  const waitInfo = getWaitEstimate(summary.rushProbability);
  return {
    ...summary,
    busyLabel: formatHourLabel(summary.busyHour),
    emptyLabel: formatHourLabel(summary.emptyHour),
    rushPercent: Math.round((summary.rushProbability || 0) * 100),
    waitLabel: waitInfo.label,
    waitEta: waitInfo.eta,
  };
}

function calculateRushForecast(sessions, totalSlots, now = Date.now()) {
  if (!Array.isArray(sessions) || !sessions.length || !totalSlots) {
    return null;
  }
  const buckets = Array(24).fill(0);
  const daySet = new Set();

  sessions.forEach((session) => {
    const startMs = toMillis(session.timeIn);
    const endMs = toMillis(session.timeOut) || now;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return;
    }
    distributeSessionMinutes(buckets, startMs, endMs, daySet);
  });

  if (!daySet.size) {
    return null;
  }

  const trackedDays = Math.min(RUSH_LOOKBACK_DAYS, Math.max(1, daySet.size));
  const denominator = 60 * totalSlots * trackedDays;
  if (!denominator) {
    return null;
  }

  const probabilities = buckets.map((minutes) =>
    Math.max(0, Math.min(1, minutes / denominator))
  );
  const busyHour = probabilities.indexOf(Math.max(...probabilities));
  const emptyHour = probabilities.indexOf(Math.min(...probabilities));
  const currentHour = new Date(now).getHours();
  const rushProbability = probabilities[currentHour] ?? 0;

  return {
    busyHour,
    emptyHour,
    rushProbability,
    probabilities,
    dayCount: trackedDays,
    sampleSize: sessions.length,
  };
}

function distributeSessionMinutes(buckets, startMs, endMs, daySet) {
  let cursor = startMs;
  while (cursor < endMs) {
    const cursorDate = new Date(cursor);
    daySet.add(cursorDate.toDateString());
    const hour = cursorDate.getHours();
    const hourEnd = new Date(cursorDate);
    hourEnd.setMinutes(59, 59, 999);
    const segmentEnd = Math.min(endMs, hourEnd.getTime());
    const minutes = Math.max(0, (segmentEnd - cursor) / 60000);
    if (Number.isFinite(minutes)) {
      buckets[hour] += minutes;
    }
    cursor = segmentEnd + 1;
  }
}

function toMillis(value) {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value.toMillis === "function") {
    return value.toMillis();
  }
  return Number(value) || null;
}

function formatHourLabel(hour) {
  if (!Number.isFinite(hour)) return "--";
  const normalized = ((Math.floor(hour) % 24) + 24) % 24;
  const period = normalized >= 12 ? "PM" : "AM";
  let humanHour = normalized % 12;
  if (humanHour === 0) {
    humanHour = 12;
  }
  return ${humanHour}:00 ${period};
}

function getWaitEstimate(probability) {
  if (!Number.isFinite(probability)) {
    return { label: "--", eta: "" };
  }
  if (probability >= 0.85) {
    return { label: "Very high", eta: "15-20 min" };
  }
  if (probability >= 0.65) {
    return { label: "High", eta: "10-15 min" };
  }
  if (probability >= 0.4) {
    return { label: "Moderate", eta: "5-8 min" };
  }
  if (probability >= 0.2) {
    return { label: "Low", eta: "2-4 min" };
  }
  return { label: "Very low", eta: "< 2 min" };
}

function updateForecastUI(page, state) {
  const grid = document.getElementById(${page}Forecast);
  const statusEl = document.getElementById(${page}ForecastStatus);
  if (!grid || !statusEl) return;

  const placeholders = {
    disabled: "Connect firebase-config.js to enable predictions.",
    loading: "Crunching last 7 days of parking activity...",
    error: "Couldn't load predictions. Please try again soon.",
    empty: "Need more historical data to forecast rush hours.",
  };

  if (state.status === "ready" && state.data) {
    const { data } = state;
    setForecastField(
      grid,
      "busy",
      data.busyLabel,
      Peak hour · ${(data.probabilities?.[data.busyHour] * 100 || 0).toFixed(0)}%
    );
    setForecastField(
      grid,
      "empty",
      data.emptyLabel,
      Likely free · ${(data.probabilities?.[data.emptyHour] * 100 || 0).toFixed(0)}%
    );
    setForecastField(grid, "rush", ${data.rushPercent ?? 0}%, "Current hour");
    setForecastField(
      grid,
      "wait",
      data.waitLabel,
      data.waitEta ? ${data.waitEta} expected : "Based on recent rush hours"
    );
    statusEl.textContent = `Based on last ${data.dayCount || RUSH_LOOKBACK_DAYS} days · ${
      data.sampleSize || 0
    } trips`;
    return;
  }

  const message = placeholders[state.status] || "";
  statusEl.textContent = message;

  if (state.status === "loading") {
    ["busy", "empty", "rush", "wait"].forEach((key) => {
      setForecastField(grid, key, "...", "Loading");
    });
    return;
  }

  const metaText =
    state.status === "disabled"
      ? "Connect Firebase"
      : state.status === "empty"
      ? "Need history"
      : "Unavailable";

  ["busy", "empty", "rush", "wait"].forEach((key) => {
    setForecastField(grid, key, "--", metaText);
  });
}

function setForecastField(grid, key, value, meta) {
  const valueEl = grid.querySelector([data-forecast-value="${key}"]);
  if (valueEl && typeof value !== "undefined") {
    valueEl.textContent = value;
  }
  const metaEl = grid.querySelector([data-forecast-meta="${key}"]);
  if (metaEl && typeof meta !== "undefined") {
    metaEl.textContent = meta;
  }
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
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
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
  const wasEmpty = slot.status === STATUS.EMPTY;
  let newSessionPayload = null;
  let sessionToClose = null;

  if (wasEmpty) {
    slot.lastFreeDuration = now - slot.lastChanged;
    slot.status = STATUS.OCCUPIED;
    slot.sessionId = slot.sessionId || generateSessionId();
    newSessionPayload = { sessionId: slot.sessionId, type: slot.type };
  } else {
    slot.lastOccupiedDuration = now - slot.lastChanged;
    slot.status = STATUS.EMPTY;
    if (slot.sessionId) {
      sessionToClose = slot.sessionId;
    }
    slot.sessionId = null;
  }
  slot.lastChanged = now;
  data.updatedAt = now;
  writeStorage(data);
  if (newSessionPayload) {
    recordSessionStart(newSessionPayload.sessionId, index, newSessionPayload.type);
  }
  if (sessionToClose) {
    recordSessionEnd(sessionToClose);
  }
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
    slot.className = slot ${slotData.status} type-${slotData.type}${readOnly ? " read-only" : ""};
    if (highlightSet.has(idx)) {
      slot.classList.add("highlight");
    }
    slot.setAttribute("role", "button");
    slot.tabIndex = readOnly ? -1 : 0;

    const head = document.createElement("div");
    head.className = "slot-head";
    head.innerHTML = <strong>Slot ${idx + 1}</strong>;

    const badge = document.createElement("span");
    badge.className = type-badge type-${slotData.type};
    const meta = TYPES[slotData.type];
    badge.textContent = ${meta.icon} ${meta.label};
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
    requestForecastForPage("admin", payload.total);
  };

  pageRenderers.admin = render;
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

  initChatAssistant("admin");
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
    requestForecastForPage("user", payload.total);
  };

  pageRenderers.user = render;
  render(ensureData());
  setupSearchInputs("user", render);
  startSlotTimerLoop("user", "userSlotGrid");

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      const updated = readStorage() ?? ensureData();
      render(updated);
    }
  });

  initChatAssistant("user");
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