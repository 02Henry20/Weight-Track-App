import {
  auth,
  initializeAuthPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "./firebase.js";
import {
  DEFAULT_GOALS,
  DEFAULT_SETTINGS,
  clearLastLocalSession,
  connectUserData,
  connectLocalUserData,
  deleteEntry,
  disconnectUserData,
  exportState,
  getLastLocalSession,
  hasPendingWrites,
  importState,
  isUsingCacheOnly,
  fetchNutriPilotWeeklyCalories,
  saveBodyComposition,
  saveCalories,
  saveWeeklyCalorieEntries,
  saveGoals,
  saveSettings,
  saveWeight,
  setStoreErrorHandler,
  state,
  subscribeState,
  synchronizeUserData
} from "./store.js";
import {
  analyseBody,
  analyseDietPhase,
  analyseGoals,
  analyseMaintenance,
  analyseWeight,
  buildInsight,
  findBestMaintenanceWindow,
  findBestTrendWindow,
  addDays,
  formatLongDate,
  round,
  todayString
} from "./calculations.js";
import {
  drawBodyCompositionChart,
  drawGoalCompositionProjectionChart,
  drawMaintenanceChart,
  drawPhysiqueMap,
  drawWeightChart,
  redrawOnResize
} from "./charts.js";

const APP_VERSION = "2.4.15";

const VIEW_LABELS = {
  overview: ["TODAY'S SIGNAL", "Overview"],
  log: ["INPUT", "Log data"],
  trends: ["ANALYSIS", "Trends"],
  body: ["COMPOSITION", "Body"],
  goals: ["DIRECTION", "Goals"],
  settings: ["CONTROL", "Settings"]
};

const elements = {
  authShell: document.querySelector("#auth-shell"),
  appShell: document.querySelector("#app-shell"),
  bootStatus: document.querySelector("#boot-status"),
  bootText: document.querySelector("#boot-text"),
  authForm: document.querySelector("#auth-form"),
  authEmail: document.querySelector("#auth-email"),
  authPassword: document.querySelector("#auth-password"),
  authMessage: document.querySelector("#auth-message"),
  signOut: document.querySelector("#sign-out-button"),
  userChip: document.querySelector("#user-chip"),
  settingsUserEmail: document.querySelector("#settings-user-email"),
  syncPill: document.querySelector("#sync-pill"),
  syncLabel: document.querySelector("#sync-label"),
  syncDetail: document.querySelector("#sync-detail"),
  mobileSyncPill: document.querySelector("#mobile-sync-pill"),
  mobileSyncLabel: document.querySelector("#mobile-sync-label"),
  mobileSyncDetail: document.querySelector("#mobile-sync-detail"),
  viewKicker: document.querySelector("#view-kicker"),
  viewTitle: document.querySelector("#view-title"),
  modalBackdrop: document.querySelector("#modal-backdrop"),
  toastContainer: document.querySelector("#toast-container")
};

let activeView = "overview";
let currentCalorieMode = "daily";
let confirmResolver = null;
let syncChoiceResolver = null;
let activeModalType = null;
let confirmPreviousModal = null;
let latestAnalyses = null;
let renderScheduled = false;
let localSessionOpen = false;
let nutripilotWeeklyCandidates = [];
let settingsAutosaveTimer = null;
let settingsSaveSequence = 0;
const SETTINGS_AUTOSAVE_DELAY_MS = 650;
const MOBILE_SETTINGS_QUERY = "(max-width: 680px)";

function setFormMessage(element, text, error = false) {
  element.textContent = text;
  element.classList.toggle("error", error);
}

function firebaseErrorMessage(error) {
  const messages = {
    "auth/email-already-in-use": "An account already exists for this email.",
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/missing-password": "Enter your password.",
    "auth/weak-password": "Use a password with at least six characters.",
    "auth/network-request-failed": "No connection. Sign-in requires internet unless your session is already cached.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "permission-denied": "Firebase denied access. Publish the new firestore.rules file included with this app."
  };
  return messages[error?.code] ?? error?.message ?? "Something went wrong.";
}

function setAuthBusy(busy) {
  for (const control of elements.authForm.querySelectorAll("button, input")) {
    control.disabled = busy;
  }
}

function showToast(title, copy = "", type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const marker = document.createElement("span");
  marker.textContent = type === "error" ? "!" : "✓";
  marker.style.color = type === "error" ? "#ff8797" : "#35d07f";
  marker.style.fontWeight = "850";
  const content = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const text = document.createElement("span");
  text.textContent = copy;
  content.append(heading, text);
  toast.append(marker, content);
  elements.toastContainer.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function isTodayWeightLogged() {
  const today = todayString();
  return state.weights.some(entry => entry.date === today);
}

function queueWrite(promise, title, onlineCopy = "Saved on this device and synchronizing with Firebase.") {
  showToast(title, navigator.onLine ? onlineCopy : "Saved on this device. Review synchronization when you are online.");
  promise.catch(error => {
    showToast("Save failed", firebaseErrorMessage(error), "error");
  });
}

async function initializeAuthentication() {
  const localSession = getLastLocalSession();
  let openedLocalSession = false;
  if (localSession && connectLocalUserData(localSession)) {
    openedLocalSession = true;
    localSessionOpen = true;
    elements.authShell.hidden = true;
    elements.appShell.hidden = false;
    elements.userChip.textContent = localSession.email || localSession.uid;
    elements.settingsUserEmail.textContent = localSession.email || localSession.uid;
    elements.bootStatus.classList.add("ready");
    elements.bootText.textContent = "Opened saved device data";
    navigateTo("overview");
  }

  try {
    await initializeAuthPersistence();
    elements.bootStatus.classList.add("ready");
    elements.bootText.textContent = openedLocalSession ? "Saved device data ready · sync when online" : "Device storage ready · conflict-safe sync";
  } catch (error) {
    elements.bootStatus.classList.add("error");
    elements.bootText.textContent = firebaseErrorMessage(error);
  }

  onAuthStateChanged(auth, async user => {
    if (user) {
      localSessionOpen = false;
      elements.authShell.hidden = true;
      elements.appShell.hidden = false;
      elements.userChip.textContent = user.email ?? user.uid;
      elements.settingsUserEmail.textContent = user.email ?? user.uid;
      navigateTo("overview");
      try {
        await connectUserData(user, askSyncChoice);
      } catch (error) {
        showToast("Synchronization failed", firebaseErrorMessage(error), "error");
      }
    } else {
      if (localSessionOpen) return;
      if (syncChoiceResolver) resolveSyncChoice("cloud");
      disconnectUserData();
      elements.authShell.hidden = false;
      elements.appShell.hidden = true;
      elements.authPassword.value = "";
    }
  });
}

async function signOutHandler() {
  localSessionOpen = false;
  clearLastLocalSession();
  disconnectUserData();
  elements.authShell.hidden = false;
  elements.appShell.hidden = true;
  elements.authPassword.value = "";
  try {
    await signOut(auth);
  } catch (error) {
    showToast("Sign out failed", firebaseErrorMessage(error), "error");
  }
}

async function signInHandler(event) {
  event.preventDefault();
  setAuthBusy(true);
  setFormMessage(elements.authMessage, "");
  try {
    await signInWithEmailAndPassword(auth, elements.authEmail.value.trim(), elements.authPassword.value);
  } catch (error) {
    setFormMessage(elements.authMessage, firebaseErrorMessage(error), true);
  } finally {
    setAuthBusy(false);
  }
}

function navigateTo(view) {
  if (!VIEW_LABELS[view]) return;
  activeView = view;

  document.querySelectorAll("[data-view-section]").forEach(section => {
    section.classList.toggle("active", section.dataset.viewSection === view);
  });
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  elements.viewKicker.textContent = VIEW_LABELS[view][0];
  elements.viewTitle.textContent = VIEW_LABELS[view][1];
  if (view === "log" && window.matchMedia("(max-width: 900px)").matches) {
    setLogHistoriesCollapsed(true);
  }
  if (view === "settings") resetSettingsDropdowns();
  document.querySelector(".content-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  window.requestAnimationFrame(renderActiveCharts);
}

function resetSettingsDropdowns() {
  const isMobile = window.matchMedia(MOBILE_SETTINGS_QUERY).matches;
  document.querySelectorAll("[data-settings-dropdown]").forEach(dropdown => {
    dropdown.open = !isMobile;
  });
  document.querySelectorAll(".setting-help[open]").forEach(details => details.removeAttribute("open"));
}

function setLogHistoriesCollapsed(collapsed) {
  document.querySelectorAll("[data-history-card]").forEach(card => {
    card.classList.toggle("collapsed", collapsed);
    const toggle = card.querySelector("[data-history-toggle]");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.textContent = collapsed ? "Show" : "Hide";
    }
  });
}

function toggleHistoryCard(button) {
  const card = button.closest("[data-history-card]");
  if (!card) return;
  const collapsed = !card.classList.contains("collapsed");
  card.classList.toggle("collapsed", collapsed);
  button.setAttribute("aria-expanded", String(!collapsed));
  button.textContent = collapsed ? "Show" : "Hide";
}

function openModal(type) {
  activeModalType = type;
  prepareModal(type);
  elements.modalBackdrop.hidden = false;
  document.querySelectorAll("[data-modal]").forEach(modal => {
    modal.hidden = modal.dataset.modal !== type;
  });
  document.body.style.overflow = "hidden";
}

function closeModal() {
  if (confirmResolver || syncChoiceResolver) return;
  activeModalType = null;
  elements.modalBackdrop.hidden = true;
  elements.modalBackdrop.classList.remove("modal-top");
  document.querySelectorAll("[data-modal]").forEach(modal => {
    modal.hidden = true;
  });
  document.body.style.overflow = "";
}

function findEntry(collection, date) {
  return collection.find(entry => entry.date === date) ?? null;
}

function prepareModal(type) {
  const today = todayString();

  if (type === "weight") {
    const dateInput = document.querySelector("#weight-date");
    const valueInput = document.querySelector("#weight-value");
    dateInput.value = today;
    const todayEntry = findEntry(state.weights, today);
    const startingValue = todayEntry?.weight ?? latestAnalyses?.weight.latestRaw?.weight ?? 72;
    valueInput.value = Number(startingValue).toFixed(1);
    document.querySelector("#weight-last-note").textContent = todayEntry
      ? "A measurement already exists today. Saving will ask before overwriting it."
      : latestAnalyses?.weight.latestRaw
        ? `Latest recorded weight: ${latestAnalyses.weight.latestRaw.weight.toFixed(1)} kg on ${formatLongDate(latestAnalyses.weight.latestRaw.date)}.`
        : "No previous weight. Adjust the starting value.";
    setFormMessage(document.querySelector("#weight-form-message"), "");
  }

  if (type === "body") {
    const todayEntry = findEntry(state.bodyEntries, today);
    document.querySelector("#body-date").value = today;
    document.querySelector("#body-fat-value").value = Number(todayEntry?.bodyFat ?? latestAnalyses?.body.latest?.bodyFat ?? 15).toFixed(1);
    document.querySelector("#body-weight-value").value = Number(todayEntry?.weight ?? latestAnalyses?.weight.latestRaw?.weight ?? 72).toFixed(1);
    setFormMessage(document.querySelector("#body-form-message"), "");
  }

  if (type === "calories") {
    const todayEntry = findEntry(state.calorieEntries, today);
    document.querySelector("#calorie-date").value = today;
    currentCalorieMode = todayEntry?.mode ?? "daily";
    document.querySelector("#calorie-value").value = todayEntry?.value ?? "";
    updateCalorieModeUI();
    updateCaloriePreview();
    setFormMessage(document.querySelector("#calorie-form-message"), "");
  }
}

function askConfirmation(title, copy, acceptLabel = "Overwrite") {
  return new Promise(resolve => {
    confirmPreviousModal = activeModalType;
    confirmResolver = resolve;
    elements.modalBackdrop.hidden = false;
    document.querySelectorAll("[data-modal]").forEach(modal => {
      modal.hidden = modal.dataset.modal !== "confirm";
    });
    document.querySelector("#confirm-title").textContent = title;
    document.querySelector("#confirm-copy").textContent = copy;
    document.querySelector("#confirm-accept").textContent = acceptLabel;
    document.body.style.overflow = "hidden";
  });
}

function resolveConfirmation(value) {
  if (!confirmResolver) return;
  const resolver = confirmResolver;
  const previousModal = confirmPreviousModal;
  confirmResolver = null;
  confirmPreviousModal = null;

  if (!value && previousModal) {
    activeModalType = previousModal;
    document.querySelectorAll("[data-modal]").forEach(modal => {
      modal.hidden = modal.dataset.modal !== previousModal;
    });
    elements.modalBackdrop.hidden = false;
  } else {
    document.querySelectorAll("[data-modal]").forEach(modal => {
      modal.hidden = true;
    });
    elements.modalBackdrop.hidden = true;
    elements.modalBackdrop.classList.remove("modal-top");
    document.body.style.overflow = "";
  }

  resolver(value);
}

function askSyncChoice(summary) {
  return new Promise(resolve => {
    syncChoiceResolver = resolve;
    activeModalType = "sync-conflict";
    elements.modalBackdrop.hidden = false;
    elements.modalBackdrop.classList.add("modal-top");
    document.querySelectorAll("[data-modal]").forEach(modal => {
      modal.hidden = modal.dataset.modal !== "sync-conflict";
    });
    setText("#sync-local-summary", `${summary.local.weights} weight · ${summary.local.body} body · ${summary.local.calories} calorie records`);
    setText("#sync-cloud-summary", `${summary.cloud.weights} weight · ${summary.cloud.body} body · ${summary.cloud.calories} calorie records`);
    setText("#sync-conflict-summary", summary.conflicts
      ? `${summary.conflicts} same-date record${summary.conflicts === 1 ? "" : "s"} differ between this device and Firebase.`
      : "The two copies contain different records or settings.");
    document.body.style.overflow = "hidden";
  });
}

function resolveSyncChoice(choice) {
  if (!syncChoiceResolver) return;
  const resolver = syncChoiceResolver;
  syncChoiceResolver = null;
  activeModalType = null;
  document.querySelectorAll("[data-modal]").forEach(modal => {
    modal.hidden = true;
  });
  elements.modalBackdrop.hidden = true;
  elements.modalBackdrop.classList.remove("modal-top");
  document.body.style.overflow = "";
  resolver(choice);
}

function stepInput(inputId, step) {
  const input = document.querySelector(`#${inputId}`);
  const minimum = input.min === "" ? -Infinity : Number(input.min);
  const maximum = input.max === "" ? Infinity : Number(input.max);
  const current = Number(input.value) || 0;
  const decimals = String(step).includes(".") ? String(step).split(".")[1].length : 0;
  input.value = Math.min(maximum, Math.max(minimum, current + Number(step))).toFixed(decimals);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function updateWeightModalForDate() {
  const date = document.querySelector("#weight-date").value;
  const existing = findEntry(state.weights, date);
  if (existing) {
    document.querySelector("#weight-value").value = existing.weight.toFixed(1);
    document.querySelector("#weight-last-note").textContent = "This date already contains a measurement. Saving will require confirmation.";
  }
}

function updateBodyModalForDate() {
  const date = document.querySelector("#body-date").value;
  const existing = findEntry(state.bodyEntries, date);
  if (existing) {
    document.querySelector("#body-fat-value").value = existing.bodyFat.toFixed(1);
    document.querySelector("#body-weight-value").value = existing.weight.toFixed(1);
  }
}

function updateCalorieModeUI() {
  document.querySelectorAll("[data-calorie-mode]").forEach(button => {
    button.classList.toggle("active", button.dataset.calorieMode === currentCalorieMode);
  });
  document.querySelector("#calorie-value-label").textContent = currentCalorieMode === "weekly"
    ? "Average kcal/day for this 7-day period"
    : "Calories for this day";
  document.querySelector("#calorie-value").placeholder = "2400";
}

function updateCaloriePreview() {
  const value = Number(document.querySelector("#calorie-value").value);
  document.querySelector("#calorie-daily-preview").textContent = Number.isFinite(value) && value > 0
    ? `${Math.round(value).toLocaleString()} kcal/day`
    : "— kcal/day";
}

function formatWeekRange(startDate, endDate) {
  return `${formatLongDate(startDate)} – ${formatLongDate(endDate)}`;
}

function selectedNutriPilotWeeks() {
  return [...document.querySelectorAll("[data-nutripilot-week]:checked")]
    .map(input => nutripilotWeeklyCandidates.find(week => week.id === input.value))
    .filter(Boolean);
}

function updateNutriPilotSelectionSummary() {
  const total = nutripilotWeeklyCandidates.length;
  const selected = selectedNutriPilotWeeks().length;
  const selectAll = document.querySelector("#nutripilot-select-all");
  const importButton = document.querySelector("#nutripilot-import-confirm");

  setText("#nutripilot-selection-summary", total ? `${selected}/${total} week${total === 1 ? "" : "s"} selected` : "No importable weeks");
  if (importButton) importButton.disabled = selected === 0;
  if (selectAll) {
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
    selectAll.disabled = total === 0;
  }
}

function renderNutriPilotWeeks() {
  const list = document.querySelector("#nutripilot-week-list");
  const importButton = document.querySelector("#nutripilot-import-confirm");
  if (!list || !importButton) return;

  list.replaceChildren();
  if (!nutripilotWeeklyCandidates.length) {
    const empty = document.createElement("div");
    empty.className = "nutripilot-empty";
    empty.textContent = "No new complete past NutriPilot weeks were found. Weeks with any existing CalStat calorie entry are hidden.";
    list.append(empty);
    importButton.disabled = true;
    setText("#nutripilot-sync-status", "Nothing new to import.");
    updateNutriPilotSelectionSummary();
    return;
  }

  setText("#nutripilot-sync-status", `Found ${nutripilotWeeklyCandidates.length} new past week${nutripilotWeeklyCandidates.length === 1 ? "" : "s"}.`);

  for (const week of nutripilotWeeklyCandidates) {
    const row = document.createElement("label");
    row.className = "nutripilot-week-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = week.id;
    checkbox.checked = true;
    checkbox.dataset.nutripilotWeek = week.id;
    checkbox.addEventListener("change", updateNutriPilotSelectionSummary);

    const copy = document.createElement("div");
    copy.className = "nutripilot-week-copy";

    const title = document.createElement("strong");
    title.textContent = formatWeekRange(week.start, week.end);

    const meta = document.createElement("small");
    const loggedDays = week.activeDayCount > 0
      ? `${week.activeDayCount}/${week.calendarDayCount} logged days`
      : "Logged-day count unavailable";
    const totalKcal = Number.isFinite(week.totalKcal)
      ? ` · ${Math.round(week.totalKcal).toLocaleString()} kcal total`
      : "";
    meta.textContent = `${loggedDays}${totalKcal}`;

    copy.append(title, meta);

    const value = document.createElement("span");
    value.className = "nutripilot-week-value";
    value.textContent = `${Math.round(week.averageKcal).toLocaleString()} kcal/day`;

    row.append(checkbox, copy, value);
    list.append(row);
  }

  updateNutriPilotSelectionSummary();
}

async function openNutriPilotSync() {
  const button = document.querySelector("#sync-nutripilot-button");
  const message = document.querySelector("#calorie-form-message");
  if (button) button.disabled = true;
  setFormMessage(message, "Reading NutriPilot weekly report caches…");

  try {
    nutripilotWeeklyCandidates = await fetchNutriPilotWeeklyCalories();
    renderNutriPilotWeeks();
    openModal("nutripilot-sync");
    setFormMessage(message, "");
  } catch (error) {
    const copy = firebaseErrorMessage(error);
    setFormMessage(message, copy, true);
    showToast("NutriPilot sync failed", copy, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function toggleAllNutriPilotWeeks(checked) {
  document.querySelectorAll("[data-nutripilot-week]").forEach(input => {
    input.checked = checked;
  });
  updateNutriPilotSelectionSummary();
}

function importSelectedNutriPilotWeeks() {
  const selected = selectedNutriPilotWeeks().filter(week => {
    return !state.calorieEntries.some(entry => entry.date >= week.start && entry.date <= week.end);
  });

  if (!selected.length) {
    setText("#nutripilot-sync-status", "No selected weeks are still importable.");
    updateNutriPilotSelectionSummary();
    return;
  }

  const entries = selected.map(week => ({
    date: week.end,
    value: Math.round(week.averageKcal)
  }));
  const promise = saveWeeklyCalorieEntries(entries);
  queueWrite(
    promise,
    "NutriPilot weeks imported",
    `${selected.length} weekly average${selected.length === 1 ? "" : "s"} added as CalStat calorie entries.`
  );
  closeModal();
}

async function submitWeight(event) {
  event.preventDefault();
  const date = document.querySelector("#weight-date").value;
  const weight = Number(document.querySelector("#weight-value").value);
  const message = document.querySelector("#weight-form-message");

  if (!date || !Number.isFinite(weight) || weight < 20 || weight > 500) {
    setFormMessage(message, "Enter a valid date and weight between 20 and 500 kg.", true);
    return;
  }

  const existing = findEntry(state.weights, date);
  if (existing && Math.abs(existing.weight - weight) > 0.0001) {
    const accepted = await askConfirmation(
      "Overwrite daily weight?",
      `${formatLongDate(date)} already contains ${existing.weight.toFixed(1)} kg. Replace it with ${weight.toFixed(1)} kg?`
    );
    if (!accepted) return;
  }

  queueWrite(saveWeight({ date, weight }), "Weight saved");
  closeModal();
}

async function submitBody(event) {
  event.preventDefault();
  const date = document.querySelector("#body-date").value;
  const bodyFat = Number(document.querySelector("#body-fat-value").value);
  const weight = Number(document.querySelector("#body-weight-value").value);
  const message = document.querySelector("#body-form-message");

  if (!date || !Number.isFinite(bodyFat) || bodyFat < 2 || bodyFat > 70 || !Number.isFinite(weight) || weight < 20 || weight > 500) {
    setFormMessage(message, "Enter a valid body-fat percentage and associated weight.", true);
    return;
  }

  const existing = findEntry(state.bodyEntries, date);
  if (existing) {
    const accepted = await askConfirmation(
      "Overwrite body composition?",
      `${formatLongDate(date)} already has a body-composition entry. Replace it with ${bodyFat.toFixed(1)}% at ${weight.toFixed(1)} kg?`
    );
    if (!accepted) return;
  }

  queueWrite(saveBodyComposition({ date, bodyFat, weight }), "Body composition saved");
  closeModal();
}

async function submitCalories(event) {
  event.preventDefault();
  const date = document.querySelector("#calorie-date").value;
  const value = Number(document.querySelector("#calorie-value").value);
  const message = document.querySelector("#calorie-form-message");
  const maximum = 10_000;

  if (!date || !Number.isFinite(value) || value <= 0 || value > maximum) {
    setFormMessage(message, "Enter a valid calorie value for the selected period.", true);
    return;
  }

  const existing = findEntry(state.calorieEntries, date);
  if (existing) {
    const accepted = await askConfirmation(
      "Overwrite calorie entry?",
      `${formatLongDate(date)} already has a calorie entry. Replace it with this ${currentCalorieMode} value?`
    );
    if (!accepted) return;
  }

  queueWrite(saveCalories({ date, mode: currentCalorieMode, value }), "Calorie entry saved");
  closeModal();
}

function submitGoals(event) {
  event.preventDefault();
  const targetWeight = document.querySelector("#goal-weight-input").value;
  const dailyDeficit = document.querySelector("#goal-deficit-input").value;
  const targetDate = document.querySelector("#goal-date-input").value;
  const message = document.querySelector("#goals-message");

  if (targetWeight && (Number(targetWeight) < 20 || Number(targetWeight) > 500)) {
    setFormMessage(message, "Target weight must be between 20 and 500 kg.", true);
    return;
  }
  if (Number(dailyDeficit) < 0 || Number(dailyDeficit) > 1500) {
    setFormMessage(message, "Daily deficit must be between 0 and 1,500 kcal.", true);
    return;
  }

  queueWrite(saveGoals({ targetWeight, targetBodyFat: null, dailyDeficit, targetDate }), "Goals saved");
  setFormMessage(message, navigator.onLine ? "Goals saved and synchronizing with Firebase." : "Goals saved on this device.");
}

function settingsFromForm() {
  return {
    theme: document.querySelector("#setting-theme").value,
    colorTheme: document.querySelector("#setting-color-theme").value,
    animation: document.querySelector("#setting-animation").value,
    heightCm: document.querySelector("#setting-height").value,
    referenceSex: document.querySelector("#setting-reference-sex").value,
    mapMetric: document.querySelector("#setting-map-metric").value,
    smoothingDays: document.querySelector("#setting-smoothing").value,
    trendWindowDays: document.querySelector("#setting-trend-window").value,
    maintenanceWindowDays: document.querySelector("#setting-maintenance-window").value,
    predictionDays: document.querySelector("#setting-prediction-days").value,
    chartStartDate: document.querySelector("#setting-chart-start-date").value,
    chartScaleMode: document.querySelector("#setting-chart-scale-mode").value,
    chartWeightMin: document.querySelector("#setting-chart-weight-min").value,
    chartWeightMax: document.querySelector("#setting-chart-weight-max").value,
    energyDensityKcalPerKg: document.querySelector("#setting-energy-density").value,
    trendConfidenceView: document.querySelector("#setting-trend-confidence").value
  };
}

function validateSettings(settings, message) {
  if (Number(settings.heightCm) < 120 || Number(settings.heightCm) > 230) {
    setFormMessage(message, "Height must be between 120 and 230 cm.", true);
    return false;
  }
  const integerDayFields = [
    [settings.smoothingDays, 1, 90, "Weight smoothing"],
    [settings.trendWindowDays, 7, 730, "Trend analysis window"],
    [settings.maintenanceWindowDays, 7, 730, "Maintenance estimation window"],
    [settings.predictionDays, 7, 3650, "Prediction horizon"]
  ];
  for (const [value, minimum, maximum, label] of integerDayFields) {
    const numericValue = Number(value);
    if (!Number.isInteger(numericValue) || numericValue < minimum || numericValue > maximum) {
      setFormMessage(message, `${label} must be a whole number between ${minimum} and ${maximum} days.`, true);
      return false;
    }
  }
  if (settings.chartStartDate && settings.chartStartDate > todayString()) {
    setFormMessage(message, "Chart history cannot start in the future.", true);
    return false;
  }
  const fixedMin = Number(settings.chartWeightMin);
  const fixedMax = Number(settings.chartWeightMax);
  if (settings.chartScaleMode === "fixed" && (!Number.isFinite(fixedMin) || !Number.isFinite(fixedMax) || fixedMin >= fixedMax)) {
    setFormMessage(message, "Fixed weight chart range needs a valid minimum below maximum.", true);
    return false;
  }
  return true;
}

function saveSettingsFromForm({ autosave = false } = {}) {
  const message = document.querySelector("#settings-message");
  const settings = settingsFromForm();
  if (!validateSettings(settings, message)) return false;

  const saveSequence = ++settingsSaveSequence;
  setFormMessage(message, autosave ? "Saving settings automatically…" : "Saving settings…");

  saveSettings(settings)
    .then(() => {
      if (saveSequence === settingsSaveSequence) {
        setFormMessage(message, navigator.onLine ? "Settings saved automatically and synchronizing with Firebase." : "Settings saved automatically on this device.");
      }
    })
    .catch(error => {
      if (saveSequence === settingsSaveSequence) setFormMessage(message, firebaseErrorMessage(error), true);
      showToast("Settings save failed", firebaseErrorMessage(error), "error");
    });
  return true;
}

function scheduleSettingsAutosave(delay = SETTINGS_AUTOSAVE_DELAY_MS) {
  if (settingsAutosaveTimer) window.clearTimeout(settingsAutosaveTimer);
  setFormMessage(document.querySelector("#settings-message"), "Settings will save automatically.");
  settingsAutosaveTimer = window.setTimeout(() => {
    settingsAutosaveTimer = null;
    saveSettingsFromForm({ autosave: true });
  }, Math.max(0, delay));
}

function submitSettings(event) {
  event.preventDefault();
  if (settingsAutosaveTimer) {
    window.clearTimeout(settingsAutosaveTimer);
    settingsAutosaveTimer = null;
  }
  saveSettingsFromForm({ autosave: true });
}

function createHistoryRow({ title, subtitle, value, pending, collectionName, id }) {
  const row = document.createElement("div");
  row.className = "history-row";

  const primary = document.createElement("div");
  primary.className = "history-primary";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("small");
  detail.textContent = subtitle;
  primary.append(heading, detail);
  if (pending) {
    const pendingLabel = document.createElement("span");
    pendingLabel.className = "pending-label";
    pendingLabel.textContent = "Waiting to sync";
    primary.append(pendingLabel);
  }

  const valueElement = document.createElement("span");
  valueElement.className = "history-value";
  valueElement.textContent = value;

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "history-delete";
  deleteButton.textContent = "×";
  deleteButton.setAttribute("aria-label", `Delete ${title}`);
  deleteButton.addEventListener("click", async () => {
    const accepted = await askConfirmation("Delete entry?", `${title} will be removed from the local cache and Firebase.`, "Delete");
    if (!accepted) return;
    queueWrite(deleteEntry(collectionName, id), "Entry deleted");
  });

  row.append(primary, valueElement, deleteButton);
  return row;
}

function renderHistory(containerId, entries, mapper) {
  const container = document.querySelector(`#${containerId}`);
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No entries yet.";
    container.append(empty);
    return;
  }
  for (const entry of entries.slice(0, 20)) container.append(mapper(entry));
}

function formatSigned(value, digits = 1, suffix = "") {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
}

function updateSyncStatus() {
  const pending = hasPendingWrites();
  const sync = state.sync;
  const firebaseUnavailable = Boolean(state.user?.offlineOnly) || !navigator.onLine || sync.status === "offline";
  let className = "sync-pill";
  let label = "Connecting";
  let detail = sync.detail || "Checking data";

  if (firebaseUnavailable) {
    className = "sync-pill offline";
    label = pending ? "Firebase unavailable" : "Device only";
    detail = pending ? "Saved locally; sign in online to sync" : "No Firebase connection";
  } else if (sync.status === "conflict") {
    className = "sync-pill conflict";
    label = "Sync choice needed";
    detail = "Cloud and device differ";
  } else if (sync.status === "error") {
    className = "sync-pill error";
    label = "Firebase error";
    detail = sync.detail;
  } else if (pending || sync.status === "loading" || isUsingCacheOnly()) {
    className = "sync-pill";
    label = pending ? "Changes pending" : "Comparing data";
    detail = sync.detail || "Checking Firebase";
  } else {
    className = "sync-pill synced";
    label = "Synced";
    detail = sync.detail || "Device and Firebase aligned";
  }

  elements.syncPill.className = className;
  elements.syncLabel.textContent = label;
  elements.syncDetail.textContent = detail;

  if (elements.mobileSyncPill) {
    elements.mobileSyncPill.hidden = false;
    elements.mobileSyncPill.className = `${className} mobile-sync-pill`;
    elements.mobileSyncLabel.textContent = label === "Synced" ? "Synced" : label === "Device only" ? "Device only" : label;
    elements.mobileSyncDetail.textContent = "";
  }

  const syncButton = document.querySelector("#sync-now-button");
  if (syncButton) {
    syncButton.disabled = firebaseUnavailable;
    syncButton.title = firebaseUnavailable ? "Firebase is unavailable. Sign in online before synchronizing." : "";
  }
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function applyAppearance(settings = state.settings) {
  document.documentElement.dataset.theme = settings.theme === "light" ? "light" : "dark";
  document.documentElement.dataset.colorTheme = ["ocean", "forest", "violet", "ember"].includes(settings.colorTheme)
    ? settings.colorTheme
    : "ocean";
  document.documentElement.dataset.motion = settings.animation === "off" ? "off" : "on";
}

function setConfidenceBadge(selector, confidence, score = null) {
  const badge = document.querySelector(selector);
  badge.className = `confidence-badge ${confidence ?? ""}`.trim();
  badge.textContent = score == null ? confidence : `${confidence} · ${score}%`;
}

function renderOverview(analyses) {
  const { weight, maintenance, goals, insight } = analyses;
  setText("#overview-current-weight", weight.latestRaw ? weight.latestRaw.weight.toFixed(1) : "—");
  setText("#overview-weight-date", weight.latestRaw ? formatLongDate(weight.latestRaw.date) : "No data");
  setText("#overview-average-weight", weight.average7 == null ? "—" : `${weight.average7.toFixed(1)} kg`);
  const averageStart = weight.latestRaw ? new Date(`${weight.latestRaw.date}T00:00:00`) : null;
  if (averageStart) averageStart.setDate(averageStart.getDate() - 6);
  const averageCount = averageStart
    ? weight.raw.filter(entry => new Date(`${entry.date}T00:00:00`) >= averageStart).length
    : 0;
  setText("#overview-average-note", weight.average7 == null ? "Waiting for measurements" : `${averageCount} measurement${averageCount === 1 ? "" : "s"} in the last 7 days`);
  setText("#overview-weekly-trend", weight.weeklyRate == null ? "—" : `${formatSigned(weight.weeklyRate, 2)} kg/wk`);
  setText("#overview-trend-note", weight.regression ? `${state.settings.trendWindowDays}-day model` : "Needs at least two measurements");
  setText("#overview-maintenance", maintenance.current?.estimate == null ? "—" : `${Math.round(maintenance.current.estimate).toLocaleString()} kcal`);
  setText("#overview-maintenance-note", maintenance.current?.estimate == null ? "Needs weight + calorie history" : `${maintenance.current.confidence} confidence · ±${Math.round(maintenance.current.uncertainty)} kcal`);

  const deltaElement = document.querySelector("#overview-weight-change");
  if (weight.latestRaw && weight.previousRaw) {
    const delta = weight.latestRaw.weight - weight.previousRaw.weight;
    deltaElement.textContent = `${formatSigned(delta, 1)} kg from previous measurement`;
    deltaElement.className = `metric-delta ${delta < 0 ? "negative" : delta > 0 ? "positive" : "neutral"}`;
  } else {
    deltaElement.textContent = "Add your first measurement";
    deltaElement.className = "metric-delta neutral";
  }

  const overviewAddWeightButton = document.querySelector("#overview-add-weight");
  if (overviewAddWeightButton) overviewAddWeightButton.hidden = isTodayWeightLogged();

  const goalDifference = goals.difference;
  const goalDaysValue = document.querySelector("#goal-days-value");
  const goalDaysLabel = document.querySelector("#goal-days-label");
  const goalCountdownMeta = document.querySelector("#goal-countdown-meta");
  if (goalDifference == null) {
    goalDaysValue.textContent = "—";
    goalDaysLabel.textContent = goals.targetWeight == null ? "Set a target weight" : "Add weight data";
    goalCountdownMeta.textContent = goals.targetWeight == null
      ? "The estimate will use your current weight trend."
      : "Add at least two weight measurements to estimate progress.";
  } else if (Math.abs(goalDifference) <= 0.05) {
    goalDaysValue.textContent = "Reached";
    goalDaysLabel.textContent = "Target achieved";
    goalCountdownMeta.textContent = "You are at the configured target weight.";
  } else if (goals.etaDays != null && goals.etaDate) {
    goalDaysValue.textContent = `${Math.abs(goalDifference).toFixed(1)} kg`;
    goalDaysLabel.textContent = goalDifference > 0 ? "to gain until target" : "to lose until target";
    const daysLeft = Math.max(1, Math.ceil(goals.etaDays));
    goalCountdownMeta.textContent = `${daysLeft.toLocaleString()} day${daysLeft === 1 ? "" : "s"} · ETA ${formatLongDate(goals.etaDate)}`;
  } else {
    goalDaysValue.textContent = `${Math.abs(goalDifference).toFixed(1)} kg`;
    goalDaysLabel.textContent = goalDifference > 0 ? "to gain · trend not aligned" : "to lose · trend not aligned";
    goalCountdownMeta.textContent = "Log more aligned measurements to estimate the date.";
  }
  setText("#goal-target-weight", goals.targetWeight == null ? "—" : `${goals.targetWeight.toFixed(1)} kg`);
  setText("#goal-eta", goals.etaDate ? formatLongDate(goals.etaDate) : "Not enough trend");

  setText("#insight-title", insight.title);
  setText("#insight-text", insight.text);
  setText("#insight-confidence", insight.confidence);
}

function renderLog() {
  setText("#weight-count-badge", state.weights.length.toString());
  setText("#body-count-badge", state.bodyEntries.length.toString());
  setText("#calorie-count-badge", state.calorieEntries.length.toString());

  renderHistory("weight-history", state.weights, entry => createHistoryRow({
    title: formatLongDate(entry.date),
    subtitle: "Daily scale weight",
    value: `${entry.weight.toFixed(1)} kg`,
    pending: entry.pending,
    collectionName: "weights",
    id: entry.id
  }));

  renderHistory("body-history", state.bodyEntries, entry => createHistoryRow({
    title: formatLongDate(entry.date),
    subtitle: `${entry.weight.toFixed(1)} kg associated weight`,
    value: `${entry.bodyFat.toFixed(1)}%`,
    pending: entry.pending,
    collectionName: "bodyComposition",
    id: entry.id
  }));

  renderHistory("calorie-history", state.calorieEntries, entry => createHistoryRow({
    title: formatLongDate(entry.date),
    subtitle: entry.mode === "weekly" ? "7-day kcal/day average" : "Daily intake",
    value: entry.mode === "weekly" ? `${Math.round(entry.dailyAverage ?? entry.value).toLocaleString()} kcal/day` : `${Math.round(entry.value).toLocaleString()} kcal`,
    pending: entry.pending,
    collectionName: "calories",
    id: entry.id
  }));
}

function renderTrends(analyses) {
  const { weight, maintenance, dietPhase } = analyses;
  const predictionDays = Number(state.settings.predictionDays) || Math.round((Number(state.settings.predictionMonths) || 3) * 30.4375);
  const trendWindowBadge = document.querySelector("#trend-window-badge");
  if (trendWindowBadge) {
    trendWindowBadge.innerHTML = `<span>${state.settings.trendWindowDays}-day model</span><span>${predictionDays}-day forecast</span>`;
  }
  setText("#trend-current", weight.current == null ? "—" : `${weight.current.toFixed(1)} kg`);
  setText("#trend-rate", weight.weeklyRate == null ? "—" : `${formatSigned(weight.weeklyRate, 2)} kg/week`);
  setText("#trend-projected", weight.projectedWeight == null ? "—" : `${weight.projectedWeight.toFixed(1)} kg`);

  const phaseBadge = document.querySelector("#diet-phase-badge");
  phaseBadge.className = `diet-phase-badge phase-${dietPhase.key}`;
  phaseBadge.textContent = dietPhase.label;
  setText("#diet-phase-copy", dietPhase.description);

  const analysisQualityCard = document.querySelector("#analysis-quality-card");
  const trendsGrid = analysisQualityCard.closest(".analytics-grid");
  const showTrendConfidence = state.settings.trendConfidenceView !== "off";
  analysisQualityCard.hidden = !showTrendConfidence;
  trendsGrid.classList.toggle("quality-panel-hidden", !showTrendConfidence);
  if (showTrendConfidence) {
    const confidence = weight.trendConfidence;
    document.querySelector("#trend-sufficiency-fill").style.width = `${confidence.dataSufficiencyScore}%`;
    document.querySelector("#trend-volatility-fill").style.width = `${confidence.volatilityScore ?? 0}%`;
    setText("#trend-sufficiency-score", `${confidence.dataSufficiencyScore}%`);
    setText("#trend-volatility-score", confidence.volatilityScore == null ? "—" : `${confidence.volatilityScore}%`);
    setText("#trend-confidence-copy", confidence.volatilityScore == null
      ? `${confidence.measurementCount} measurement${confidence.measurementCount === 1 ? "" : "s"} in the selected trend window. Add at least three readings to score volatility.`
      : `${confidence.measurementCount} measurements across ${confidence.spanDays} days · ${confidence.volatilityLabel.toLowerCase()} volatility · ±${confidence.volatilityKg.toFixed(2)} kg around the trend.`);
  }

  if (maintenance.current?.estimate != null) {
    setConfidenceBadge("#maintenance-confidence", maintenance.current.confidence, maintenance.current.confidenceScore);
    setText("#maintenance-summary", `${Math.round(maintenance.current.estimate).toLocaleString()} ± ${Math.round(maintenance.current.uncertainty).toLocaleString()} kcal/day`);
    setText("#maintenance-explanation", `Average intake ${Math.round(maintenance.current.averageIntake).toLocaleString()} kcal/day · ${Math.round(maintenance.current.calorieCoverage * 100)}% calorie coverage.`);
  } else {
    setConfidenceBadge("#maintenance-confidence", "low");
    setText("#maintenance-confidence", "No estimate");
    setText("#maintenance-summary", "—");
    setText("#maintenance-explanation", "Add at least several weight and calorie entries across the configured analysis window.");
  }

  if (showTrendConfidence) {
    document.querySelector("#quality-meter-fill").style.width = `${maintenance.qualityScore}%`;
    setText("#quality-score", `${maintenance.qualityScore}%`);
    setText("#quality-copy", maintenance.qualityScore >= 75
      ? "Good model coverage. Recent calorie and weight data are internally consistent."
      : maintenance.qualityScore >= 48
        ? "Moderate model coverage. More calorie days and consistent morning weights will improve it."
        : "Low model coverage. Add measurements across multiple weeks before relying on the estimate.");
  }
}

function statusToneForCategory(category, type) {
  const value = String(category ?? "").toLowerCase();
  if (type === "bodyFat") {
    if (value.includes("athletic")) return "athletic";
    if (value.includes("fitness")) return "good";
    if (value.includes("essential")) return "warning";
    if (value.includes("high")) return "danger";
    return "neutral";
  }
  if (type === "bmi") {
    if (value.includes("healthy")) return "good";
    if (value.includes("obesity")) return "danger";
    if (value.includes("underweight") || value.includes("overweight")) return "warning";
    return "neutral";
  }
  if (value.includes("exceptional") || value.includes("highly muscular")) return "elite";
  if (value.includes("athletic")) return "athletic";
  if (value.includes("above average")) return "good";
  if (value.includes("below")) return "warning";
  return "neutral";
}

function applyMetricStatus(selector, tone) {
  const element = document.querySelector(selector);
  if (!element) return;
  const tones = ["neutral", "good", "athletic", "elite", "warning", "danger"];
  element.classList.remove(...tones.map(item => `status-${item}`));
  element.classList.add(`status-${tone}`);
  const card = element.closest(".metric-card");
  if (card) {
    card.classList.remove(...tones.map(item => `metric-status-${item}`));
    card.classList.add(`metric-status-${tone}`);
  }
}

function renderBody(analyses) {
  const body = analyses.body;
  setText("#body-latest-fat", body.latest ? `${body.latest.bodyFat.toFixed(1)}%` : "—");
  setText("#body-fat-category", body.latest ? body.bodyFatCategory : "No composition data");
  setText("#body-lean-mass", body.latest ? `${body.latest.leanMass.toFixed(1)} kg` : "—");
  setText("#body-bmi", body.currentBmi == null ? "—" : body.currentBmi.toFixed(1));
  setText("#body-bmi-category", body.currentBmi == null ? "Under 20 low · 20-25 reference · over 25 high" : body.bmiCategory);
  setText("#body-ffmi", body.latest?.normalizedFfmi == null ? "—" : body.latest.normalizedFfmi.toFixed(1));
  setText("#body-ffmi-category", body.latest?.normalizedFfmi == null ? "Needs body-fat data" : body.ffmiCategory);
  setText("#map-metric-name", state.settings.mapMetric === "bmi" ? "BMI" : "normalized FFMI");

  applyMetricStatus("#body-fat-category", body.latest ? statusToneForCategory(body.bodyFatCategory, "bodyFat") : "neutral");
  applyMetricStatus("#body-bmi-category", body.currentBmi == null ? "neutral" : statusToneForCategory(body.bmiCategory, "bmi"));
  applyMetricStatus("#body-ffmi-category", body.latest?.normalizedFfmi == null ? "neutral" : statusToneForCategory(body.ffmiCategory, "ffmi"));
}

function renderGoals(analyses) {
  const goals = analyses.goals;
  setText("#goal-forecast-title", goals.targetWeight == null ? "Set a target weight to begin" : `Trajectory toward ${goals.targetWeight.toFixed(1)} kg`);
  setText("#goal-days-remaining", goals.etaDays == null ? "—" : Math.round(goals.etaDays).toLocaleString());
  setText("#goal-current-trend", goals.weeklyRate == null ? "—" : `${formatSigned(goals.weeklyRate, 2)} kg/week`);
  setText("#goal-suggested-intake", goals.suggestedIntake == null ? "—" : `${Math.round(goals.suggestedIntake).toLocaleString()} kcal/day`);
  setText("#goal-predicted-date", goals.etaDate ? formatLongDate(goals.etaDate) : "Trend not aligned");
  setText("#goal-difference", goals.difference == null ? "—" : `${formatSigned(goals.difference, 1)} kg`);
  const compositionTargetTag = document.querySelector("#goal-composition-target-tag");
  const hasTargetWeight = state.goals.targetWeight !== null && state.goals.targetWeight !== "";
  const targetWeightValue = hasTargetWeight ? Number(state.goals.targetWeight) : NaN;
  if (compositionTargetTag) {
    compositionTargetTag.hidden = !Number.isFinite(targetWeightValue);
    compositionTargetTag.textContent = Number.isFinite(targetWeightValue) ? `Target ${targetWeightValue.toFixed(1)} kg` : "";
  }

  const form = document.querySelector("#goals-form");
  if (!form.contains(document.activeElement)) {
    document.querySelector("#goal-weight-input").value = state.goals.targetWeight ?? "";
    document.querySelector("#goal-deficit-input").value = state.goals.dailyDeficit ?? 300;
    document.querySelector("#goal-date-input").value = state.goals.targetDate ?? "";
  }
}

function renderSettings() {
  const form = document.querySelector("#settings-form");
  if (!form.contains(document.activeElement)) {
    document.querySelector("#setting-theme").value = state.settings.theme;
    document.querySelector("#setting-color-theme").value = state.settings.colorTheme;
    document.querySelector("#setting-animation").value = state.settings.animation;
    document.querySelector("#setting-height").value = state.settings.heightCm;
    document.querySelector("#setting-reference-sex").value = state.settings.referenceSex;
    document.querySelector("#setting-map-metric").value = state.settings.mapMetric;
    document.querySelector("#setting-smoothing").value = String(state.settings.smoothingDays);
    document.querySelector("#setting-trend-window").value = String(state.settings.trendWindowDays);
    document.querySelector("#setting-maintenance-window").value = String(state.settings.maintenanceWindowDays);
    const predictionDays = Number(state.settings.predictionDays) || Math.round((Number(state.settings.predictionMonths) || 3) * 30.4375);
    document.querySelector("#setting-prediction-days").value = String(predictionDays);
    const legacyRangeDays = Number(state.settings.chartRangeDays) || 0;
    const latestChartDate = state.weights[0]?.date ?? todayString();
    const chartStartDate = state.settings.chartStartDate || (legacyRangeDays > 0 ? addDays(latestChartDate, -legacyRangeDays) : "");
    document.querySelector("#setting-chart-start-date").value = chartStartDate;
    document.querySelector("#setting-chart-start-date").max = todayString();
    document.querySelector("#setting-chart-scale-mode").value = state.settings.chartScaleMode;
    document.querySelector("#setting-chart-weight-min").value = state.settings.chartWeightMin ?? "";
    document.querySelector("#setting-chart-weight-max").value = state.settings.chartWeightMax ?? "";
    document.querySelector("#setting-energy-density").value = String(state.settings.energyDensityKcalPerKg);
    document.querySelector("#setting-trend-confidence").value = state.settings.trendConfidenceView === "off" ? "off" : "on";
  }
  document.querySelector("#chart-fixed-range-fields")?.classList.toggle("hidden", state.settings.chartScaleMode !== "fixed");

  setText("#settings-weight-count", state.weights.length.toString());
  setText("#settings-body-count", state.bodyEntries.length.toString());
  setText("#settings-calorie-count", state.calorieEntries.length.toString());
  setText("#settings-app-version", `CalStat ${APP_VERSION}`);
}

function currentSettingsFromForm() {
  return {
    ...state.settings,
    smoothingDays: Number(document.querySelector("#setting-smoothing").value) || state.settings.smoothingDays,
    trendWindowDays: Number(document.querySelector("#setting-trend-window").value) || state.settings.trendWindowDays,
    maintenanceWindowDays: Number(document.querySelector("#setting-maintenance-window").value) || state.settings.maintenanceWindowDays,
    energyDensityKcalPerKg: Number(document.querySelector("#setting-energy-density").value) || state.settings.energyDensityKcalPerKg
  };
}

function useBestMaintenanceWindow() {
  const best = findBestMaintenanceWindow(state.weights, state.calorieEntries, currentSettingsFromForm());
  if (!best) {
    showToast("No reliable window yet", "Add at least four weight entries and four calorie days in the same period.", "error");
    return;
  }

  document.querySelector("#setting-maintenance-window").value = String(best.windowDays);
  setText(
    "#settings-message",
    `Maintenance window set to ${best.windowDays} days (${best.confidenceScore}% quality, ${Math.round(best.calorieCoverage * 100)}% calorie coverage). Saving automatically.`
  );
  scheduleSettingsAutosave(0);
}

function useLowestVolatilityTrendWindow() {
  const best = findBestTrendWindow(state.weights, currentSettingsFromForm());
  if (!best) {
    showToast("No stable trend window yet", "Add at least three weight measurements across several days.", "error");
    return;
  }

  document.querySelector("#setting-trend-window").value = String(best.windowDays);
  setText(
    "#settings-message",
    `Trend window set to ${best.windowDays} days (${best.dataSufficiencyScore}% data sufficiency, ${best.volatilityScore}% volatility). Saving automatically.`
  );
  scheduleSettingsAutosave(0);
}

function bindSettingHelpDismissal() {
  document.addEventListener("pointerdown", event => {
    document.querySelectorAll(".setting-help[open]").forEach(details => {
      if (!details.contains(event.target)) details.removeAttribute("open");
    });
  }, true);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      document.querySelectorAll(".setting-help[open]").forEach(details => details.removeAttribute("open"));
    }
  });
}

function bindTouchSafeAction(selector, handler) {
  const button = document.querySelector(selector);
  if (!button) return;
  let handledByPointer = false;

  button.addEventListener("pointerup", event => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    event.preventDefault();
    handledByPointer = true;
    window.setTimeout(() => { handledByPointer = false; }, 450);
    handler();
  });

  button.addEventListener("click", event => {
    if (handledByPointer) {
      event.preventDefault();
      return;
    }
    handler();
  });
}

function calculateAnalyses() {
  const weight = analyseWeight(state.weights, state.settings);
  const maintenance = analyseMaintenance(state.weights, state.calorieEntries, state.settings);
  const dietPhase = analyseDietPhase(weight, maintenance);
  const body = analyseBody(state.bodyEntries, state.weights, state.settings);
  const goals = analyseGoals(weight, maintenance, state.goals, body);
  const insight = buildInsight(weight, maintenance, body, goals);
  return { weight, maintenance, dietPhase, body, goals, insight };
}

function renderActiveCharts() {
  if (!latestAnalyses || elements.appShell.hidden) return;
  const { weight, maintenance, body } = latestAnalyses;

  if (activeView === "overview") {
    drawWeightChart(document.querySelector("#overview-weight-chart"), weight, {
      compact: true,
      targetWeight: state.goals.targetWeight,
      settings: state.settings
    });
  }

  if (activeView === "trends") {
    drawWeightChart(document.querySelector("#trend-weight-chart"), weight, {
      targetWeight: state.goals.targetWeight,
      settings: state.settings
    });
    drawMaintenanceChart(document.querySelector("#maintenance-chart"), maintenance, {
      dailyDeficit: state.goals.dailyDeficit
    });
  }

  if (activeView === "body") {
    drawBodyCompositionChart(document.querySelector("#body-composition-chart"), body);
    drawPhysiqueMap(document.querySelector("#physique-map-chart"), body, state.settings);
  }

  if (activeView === "goals") {
    drawGoalCompositionProjectionChart(document.querySelector("#goal-composition-chart"), body, state.goals);
  }
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  window.requestAnimationFrame(() => {
    renderScheduled = false;
    latestAnalyses = calculateAnalyses();
    applyAppearance(state.settings);
    updateSyncStatus();
    renderOverview(latestAnalyses);
    renderLog();
    renderTrends(latestAnalyses);
    renderBody(latestAnalyses);
    renderGoals(latestAnalyses);
    renderSettings();
    renderActiveCharts();
  });
}

function exportBackup() {
  const backup = exportState();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `calstat-backup-${todayString()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("Backup exported", "The JSON file contains your measurements, goals and settings.");
}

async function importBackup(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const accepted = await askConfirmation(
      "Import backup?",
      "Matching dates and settings will overwrite existing values. Other records will remain.",
      "Import"
    );
    if (!accepted) return;
    await importState(backup);
    showToast("Backup imported", "Imported records are synchronizing with Firebase.");
  } catch (error) {
    showToast("Import failed", error.message, "error");
  } finally {
    document.querySelector("#import-data-input").value = "";
  }
}

function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  let pendingWorker = null;
  let reloading = false;
  const banner = document.querySelector("#update-banner");
  const updateButton = document.querySelector("#update-button");

  const showUpdate = worker => {
    pendingWorker = worker;
    banner.hidden = false;
  };

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js", {
        updateViaCache: "none"
      });

      if (registration.waiting && navigator.serviceWorker.controller) showUpdate(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
        });
      });

      registration.update().catch(console.error);
    } catch (error) {
      console.error("Service worker registration failed:", error);
    }
  });

  updateButton.addEventListener("click", () => {
    pendingWorker?.postMessage({ type: "SKIP_WAITING" });
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function bindEvents() {
  elements.authForm.addEventListener("submit", signInHandler);
  elements.signOut.addEventListener("click", signOutHandler);

  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => navigateTo(button.dataset.view));
  });
  document.querySelectorAll("[data-go-view]").forEach(button => {
    button.addEventListener("click", () => navigateTo(button.dataset.goView));
  });
  document.querySelectorAll("[data-open-modal]").forEach(button => {
    button.addEventListener("click", () => openModal(button.dataset.openModal));
  });
  document.querySelector("#header-add-weight").addEventListener("click", () => openModal("weight"));
  document.querySelector("#overview-add-weight").addEventListener("click", () => openModal("weight"));
  document.querySelectorAll("[data-close-modal]").forEach(button => button.addEventListener("click", closeModal));

  elements.modalBackdrop.addEventListener("click", event => {
    if (event.target === elements.modalBackdrop && !confirmResolver && !syncChoiceResolver) closeModal();
  });

  document.querySelectorAll("[data-step-target]").forEach(button => {
    button.addEventListener("click", () => stepInput(button.dataset.stepTarget, Number(button.dataset.step)));
  });

  document.querySelector("#weight-date").addEventListener("change", updateWeightModalForDate);
  document.querySelector("#body-date").addEventListener("change", updateBodyModalForDate);
  document.querySelectorAll("[data-calorie-mode]").forEach(button => {
    button.addEventListener("click", () => {
      currentCalorieMode = button.dataset.calorieMode;
      updateCalorieModeUI();
      updateCaloriePreview();
    });
  });
  document.querySelector("#calorie-value").addEventListener("input", updateCaloriePreview);
  document.querySelector("#sync-nutripilot-button")?.addEventListener("click", openNutriPilotSync);
  document.querySelector("#nutripilot-select-all")?.addEventListener("change", event => toggleAllNutriPilotWeeks(event.target.checked));
  document.querySelector("#nutripilot-import-confirm")?.addEventListener("click", importSelectedNutriPilotWeeks);
  document.querySelector("#setting-theme").addEventListener("change", () => {
    applyAppearance({
      ...state.settings,
      theme: document.querySelector("#setting-theme").value,
      colorTheme: document.querySelector("#setting-color-theme").value,
      animation: document.querySelector("#setting-animation").value
    });
    renderActiveCharts();
  });
  document.querySelector("#setting-color-theme").addEventListener("change", () => {
    applyAppearance({
      ...state.settings,
      theme: document.querySelector("#setting-theme").value,
      colorTheme: document.querySelector("#setting-color-theme").value,
      animation: document.querySelector("#setting-animation").value
    });
    renderActiveCharts();
  });
  document.querySelector("#setting-animation").addEventListener("change", () => {
    applyAppearance({
      ...state.settings,
      theme: document.querySelector("#setting-theme").value,
      colorTheme: document.querySelector("#setting-color-theme").value,
      animation: document.querySelector("#setting-animation").value
    });
    renderActiveCharts();
  });
  document.querySelector("#setting-chart-scale-mode").addEventListener("change", event => {
    document.querySelector("#chart-fixed-range-fields")?.classList.toggle("hidden", event.target.value !== "fixed");
  });
  document.querySelector("#settings-form")?.addEventListener("input", event => {
    if (event.target.matches("input, select")) scheduleSettingsAutosave();
  });
  document.querySelector("#settings-form")?.addEventListener("change", event => {
    if (event.target.matches("input, select")) scheduleSettingsAutosave(250);
  });
  bindTouchSafeAction("#optimize-maintenance-window", useBestMaintenanceWindow);
  bindTouchSafeAction("#optimize-trend-window", useLowestVolatilityTrendWindow);
  document.querySelectorAll("[data-history-toggle]").forEach(button => {
    button.addEventListener("click", () => toggleHistoryCard(button));
  });

  document.querySelector("#weight-form").addEventListener("submit", submitWeight);
  document.querySelector("#body-form").addEventListener("submit", submitBody);
  document.querySelector("#calorie-form").addEventListener("submit", submitCalories);
  document.querySelector("#goals-form").addEventListener("submit", submitGoals);
  document.querySelector("#settings-form").addEventListener("submit", submitSettings);

  document.querySelector("#confirm-cancel").addEventListener("click", () => resolveConfirmation(false));
  document.querySelector("#confirm-accept").addEventListener("click", () => resolveConfirmation(true));
  document.querySelector("#sync-choice-merge").addEventListener("click", () => resolveSyncChoice("merge"));
  document.querySelector("#sync-choice-cloud").addEventListener("click", () => resolveSyncChoice("cloud"));
  document.querySelector("#sync-choice-local").addEventListener("click", () => resolveSyncChoice("local"));

  document.querySelector("#sync-now-button")?.addEventListener("click", async () => {
    try {
      await synchronizeUserData(askSyncChoice, { forcePrompt: true });
      showToast("Synchronization complete", "This device and Firebase are aligned.");
    } catch (error) {
      showToast("Synchronization failed", firebaseErrorMessage(error), "error");
    }
  });

  document.querySelector("#export-data-button").addEventListener("click", exportBackup);
  document.querySelector("#import-data-input").addEventListener("change", event => importBackup(event.target.files?.[0]));

  window.addEventListener("online", async () => {
    scheduleRender();
    if (!state.user) return;
    if (state.user.offlineOnly) {
      showToast("Online again", "Sign in to sync this device copy with Firebase.");
      return;
    }
    try {
      await synchronizeUserData(askSyncChoice, { forcePrompt: true });
    } catch (error) {
      showToast("Synchronization failed", firebaseErrorMessage(error), "error");
    }
  });
  window.addEventListener("offline", scheduleRender);
  window.matchMedia(MOBILE_SETTINGS_QUERY).addEventListener("change", () => {
    if (activeView === "settings") resetSettingsDropdowns();
  });
  bindSettingHelpDismissal();
  redrawOnResize(renderActiveCharts);
}

setStoreErrorHandler(error => {
  elements.syncPill.className = "sync-pill error";
  elements.syncLabel.textContent = "Firebase error";
  elements.syncDetail.textContent = firebaseErrorMessage(error);
  showToast("Firebase access failed", firebaseErrorMessage(error), "error");
});

subscribeState(scheduleRender);
applyAppearance(state.settings);
bindEvents();
setupServiceWorker();
initializeAuthentication();
