import {
  auth,
  createUserWithEmailAndPassword,
  initializeAuthPersistence,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut
} from "./firebase.js";
import {
  DEFAULT_GOALS,
  DEFAULT_SETTINGS,
  connectUserData,
  deleteEntry,
  disconnectUserData,
  exportState,
  hasPendingWrites,
  importState,
  isUsingCacheOnly,
  saveBodyComposition,
  saveCalories,
  saveGoals,
  saveSettings,
  saveWeight,
  setStoreErrorHandler,
  state,
  subscribeState
} from "./store.js";
import {
  analyseBody,
  analyseGoals,
  analyseMaintenance,
  analyseWeight,
  buildInsight,
  formatLongDate,
  round,
  todayString
} from "./calculations.js";
import {
  drawBodyCompositionChart,
  drawMaintenanceChart,
  drawPhysiqueMap,
  drawWeeklyAverageChart,
  drawWeightChart,
  redrawOnResize
} from "./charts.js";

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
  createAccount: document.querySelector("#create-account-button"),
  resetPassword: document.querySelector("#reset-password-button"),
  signOut: document.querySelector("#sign-out-button"),
  userChip: document.querySelector("#user-chip"),
  settingsUserEmail: document.querySelector("#settings-user-email"),
  syncPill: document.querySelector("#sync-pill"),
  syncLabel: document.querySelector("#sync-label"),
  syncDetail: document.querySelector("#sync-detail"),
  viewKicker: document.querySelector("#view-kicker"),
  viewTitle: document.querySelector("#view-title"),
  modalBackdrop: document.querySelector("#modal-backdrop"),
  toastContainer: document.querySelector("#toast-container")
};

let activeView = "overview";
let currentCalorieMode = "daily";
let confirmResolver = null;
let activeModalType = null;
let confirmPreviousModal = null;
let latestAnalyses = null;
let renderScheduled = false;

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

function queueWrite(promise, title, offlineCopy = "Saved locally and queued for Firebase synchronization.") {
  showToast(title, navigator.onLine ? offlineCopy : "Saved locally. It will synchronize when you are online.");
  promise.catch(error => {
    showToast("Save failed", firebaseErrorMessage(error), "error");
  });
}

async function initializeAuthentication() {
  try {
    await initializeAuthPersistence();
    elements.bootStatus.classList.add("ready");
    elements.bootText.textContent = "Firebase ready · offline cache enabled";
  } catch (error) {
    elements.bootStatus.classList.add("error");
    elements.bootText.textContent = firebaseErrorMessage(error);
  }

  onAuthStateChanged(auth, user => {
    if (user) {
      elements.authShell.hidden = true;
      elements.appShell.hidden = false;
      elements.userChip.textContent = user.email ?? user.uid;
      elements.settingsUserEmail.textContent = user.email ?? user.uid;
      connectUserData(user);
      navigateTo("overview");
    } else {
      disconnectUserData();
      elements.authShell.hidden = false;
      elements.appShell.hidden = true;
      elements.authPassword.value = "";
    }
  });
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

async function createAccountHandler() {
  setAuthBusy(true);
  setFormMessage(elements.authMessage, "");
  try {
    await createUserWithEmailAndPassword(auth, elements.authEmail.value.trim(), elements.authPassword.value);
  } catch (error) {
    setFormMessage(elements.authMessage, firebaseErrorMessage(error), true);
  } finally {
    setAuthBusy(false);
  }
}

async function resetPasswordHandler() {
  const email = elements.authEmail.value.trim();
  if (!email) {
    setFormMessage(elements.authMessage, "Enter your email address first.", true);
    return;
  }
  setAuthBusy(true);
  try {
    await sendPasswordResetEmail(auth, email);
    setFormMessage(elements.authMessage, "Password reset email sent.");
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
  document.querySelector(".content-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  window.requestAnimationFrame(renderActiveCharts);
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
  if (confirmResolver) return;
  activeModalType = null;
  elements.modalBackdrop.hidden = true;
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
    document.body.style.overflow = "";
  }

  resolver(value);
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
    ? "Total calories for the 7-day period"
    : "Calories for this day";
  document.querySelector("#calorie-value").placeholder = currentCalorieMode === "weekly" ? "16800" : "2400";
}

function updateCaloriePreview() {
  const value = Number(document.querySelector("#calorie-value").value);
  const daily = currentCalorieMode === "weekly" ? value / 7 : value;
  document.querySelector("#calorie-daily-preview").textContent = Number.isFinite(daily) && daily > 0
    ? `${Math.round(daily).toLocaleString()} kcal/day`
    : "— kcal/day";
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
  const maximum = currentCalorieMode === "weekly" ? 50_000 : 10_000;

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

  queueWrite(saveGoals({ targetWeight, dailyDeficit, targetDate }), "Goals saved");
  setFormMessage(message, "Goals saved locally and queued for synchronization.");
}

function submitSettings(event) {
  event.preventDefault();
  const settings = {
    heightCm: document.querySelector("#setting-height").value,
    referenceSex: document.querySelector("#setting-reference-sex").value,
    mapMetric: document.querySelector("#setting-map-metric").value,
    smoothingDays: document.querySelector("#setting-smoothing").value,
    trendWindowDays: document.querySelector("#setting-trend-window").value,
    maintenanceWindowDays: document.querySelector("#setting-maintenance-window").value,
    predictionMonths: document.querySelector("#setting-prediction-months").value,
    chartRangeDays: document.querySelector("#setting-chart-range").value,
    energyDensityKcalPerKg: document.querySelector("#setting-energy-density").value
  };
  const message = document.querySelector("#settings-message");

  if (Number(settings.heightCm) < 120 || Number(settings.heightCm) > 230) {
    setFormMessage(message, "Height must be between 120 and 230 cm.", true);
    return;
  }

  queueWrite(saveSettings(settings), "Settings saved");
  setFormMessage(message, "Settings saved locally and queued for synchronization.");
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
  const cacheOnly = isUsingCacheOnly();

  if (!navigator.onLine) {
    elements.syncPill.className = "sync-pill offline";
    elements.syncLabel.textContent = pending ? "Offline · pending" : "Offline cache";
    elements.syncDetail.textContent = pending ? "Will synchronize later" : "Local data available";
  } else if (pending) {
    elements.syncPill.className = "sync-pill";
    elements.syncLabel.textContent = "Synchronizing";
    elements.syncDetail.textContent = "Local changes pending";
  } else if (cacheOnly) {
    elements.syncPill.className = "sync-pill";
    elements.syncLabel.textContent = "Connected";
    elements.syncDetail.textContent = "Checking Firebase";
  } else {
    elements.syncPill.className = "sync-pill synced";
    elements.syncLabel.textContent = "Synced";
    elements.syncDetail.textContent = "Firebase up to date";
  }
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
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
  setText("#overview-trend-note", weight.regression ? `${state.settings.trendWindowDays}-day model · R² ${weight.regression.r2.toFixed(2)}` : "Needs at least two measurements");
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

  setText("#goal-progress", goals.progress == null ? "—" : `${Math.round(goals.progress * 100)}%`);
  setText("#goal-target-weight", goals.targetWeight == null ? "—" : `${goals.targetWeight.toFixed(1)} kg`);
  setText("#goal-eta", goals.etaDate ? formatLongDate(goals.etaDate) : "Not enough trend");
  document.querySelector("#goal-ring").style.setProperty("--goal-progress-angle", `${Math.round((goals.progress ?? 0) * 360)}deg`);

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
    subtitle: entry.mode === "weekly" ? "7-day total" : "Daily intake",
    value: entry.mode === "weekly" ? `${Math.round(entry.value).toLocaleString()} kcal/wk` : `${Math.round(entry.value).toLocaleString()} kcal`,
    pending: entry.pending,
    collectionName: "calories",
    id: entry.id
  }));
}

function renderTrends(analyses) {
  const { weight, maintenance } = analyses;
  setText("#trend-window-badge", `${state.settings.trendWindowDays}-day model · ${state.settings.predictionMonths}mo forecast`);
  setText("#trend-current", weight.current == null ? "—" : `${weight.current.toFixed(1)} kg`);
  setText("#trend-rate", weight.weeklyRate == null ? "—" : `${formatSigned(weight.weeklyRate, 2)} kg/week`);
  setText("#trend-projected", weight.projectedWeight == null ? "—" : `${weight.projectedWeight.toFixed(1)} kg`);
  setText("#trend-fit", weight.regression == null ? "—" : `R² ${weight.regression.r2.toFixed(2)}`);

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

  document.querySelector("#quality-meter-fill").style.width = `${maintenance.qualityScore}%`;
  setText("#quality-score", `${maintenance.qualityScore}%`);
  setText("#quality-copy", maintenance.qualityScore >= 75
    ? "Good coverage. The estimate is still an approximation, but the recent data is internally consistent."
    : maintenance.qualityScore >= 48
      ? "Moderate coverage. More calorie days and consistent morning weights will improve confidence."
      : "Low coverage. Add measurements across multiple weeks before relying on the maintenance estimate.");
}

function renderBody(analyses) {
  const body = analyses.body;
  setText("#body-latest-fat", body.latest ? `${body.latest.bodyFat.toFixed(1)}%` : "—");
  setText("#body-fat-category", body.latest ? body.bodyFatCategory : "No composition data");
  setText("#body-lean-mass", body.latest ? `${body.latest.leanMass.toFixed(1)} kg` : "—");
  setText("#body-bmi", body.currentBmi == null ? "—" : body.currentBmi.toFixed(1));
  setText("#body-bmi-category", body.currentBmi == null ? "Set height and add weight" : body.bmiCategory);
  setText("#body-ffmi", body.latest?.normalizedFfmi == null ? "—" : body.latest.normalizedFfmi.toFixed(1));
  setText("#body-ffmi-category", body.latest?.normalizedFfmi == null ? "Needs body-fat data" : body.ffmiCategory);
  setText("#map-metric-name", state.settings.mapMetric === "bmi" ? "BMI" : "normalized FFMI");
}

function renderGoals(analyses) {
  const goals = analyses.goals;
  setText("#goal-forecast-title", goals.targetWeight == null ? "Set a target to begin" : `Trajectory toward ${goals.targetWeight.toFixed(1)} kg`);
  setText("#goal-days-remaining", goals.etaDays == null ? "—" : Math.round(goals.etaDays).toLocaleString());
  setText("#goal-current-trend", analyses.weight.weeklyRate == null ? "—" : `${formatSigned(analyses.weight.weeklyRate, 2)} kg/week`);
  setText("#goal-suggested-intake", goals.suggestedIntake == null ? "—" : `${Math.round(goals.suggestedIntake).toLocaleString()} kcal/day`);
  setText("#goal-predicted-date", goals.etaDate ? formatLongDate(goals.etaDate) : "Trend not aligned");
  setText("#goal-difference", goals.difference == null ? "—" : `${formatSigned(goals.difference, 1)} kg`);

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
    document.querySelector("#setting-height").value = state.settings.heightCm;
    document.querySelector("#setting-reference-sex").value = state.settings.referenceSex;
    document.querySelector("#setting-map-metric").value = state.settings.mapMetric;
    document.querySelector("#setting-smoothing").value = String(state.settings.smoothingDays);
    document.querySelector("#setting-trend-window").value = String(state.settings.trendWindowDays);
    document.querySelector("#setting-maintenance-window").value = String(state.settings.maintenanceWindowDays);
    document.querySelector("#setting-prediction-months").value = String(state.settings.predictionMonths);
    document.querySelector("#setting-chart-range").value = String(state.settings.chartRangeDays);
    document.querySelector("#setting-energy-density").value = String(state.settings.energyDensityKcalPerKg);
  }

  setText("#settings-weight-count", state.weights.length.toString());
  setText("#settings-body-count", state.bodyEntries.length.toString());
  setText("#settings-calorie-count", state.calorieEntries.length.toString());
}

function calculateAnalyses() {
  const weight = analyseWeight(state.weights, state.settings);
  const maintenance = analyseMaintenance(state.weights, state.calorieEntries, state.settings);
  const body = analyseBody(state.bodyEntries, state.weights, state.settings);
  const goals = analyseGoals(weight, maintenance, state.goals);
  const insight = buildInsight(weight, maintenance, body, goals);
  return { weight, maintenance, body, goals, insight };
}

function renderActiveCharts() {
  if (!latestAnalyses || elements.appShell.hidden) return;
  const { weight, maintenance, body } = latestAnalyses;

  if (activeView === "overview") {
    drawWeightChart(document.querySelector("#overview-weight-chart"), weight, {
      compact: true,
      targetWeight: state.goals.targetWeight
    });
  }

  if (activeView === "trends") {
    drawWeightChart(document.querySelector("#trend-weight-chart"), weight, {
      targetWeight: state.goals.targetWeight
    });
    drawMaintenanceChart(document.querySelector("#maintenance-chart"), maintenance, {
      dailyDeficit: state.goals.dailyDeficit
    });
    drawWeeklyAverageChart(document.querySelector("#weekly-average-chart"), weight.weekly);
  }

  if (activeView === "body") {
    drawBodyCompositionChart(document.querySelector("#body-composition-chart"), body);
    drawPhysiqueMap(document.querySelector("#physique-map-chart"), body, state.settings);
  }
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  window.requestAnimationFrame(() => {
    renderScheduled = false;
    latestAnalyses = calculateAnalyses();
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
  anchor.download = `mass-track-backup-${todayString()}.json`;
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
  elements.createAccount.addEventListener("click", createAccountHandler);
  elements.resetPassword.addEventListener("click", resetPasswordHandler);
  elements.signOut.addEventListener("click", () => signOut(auth));

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
    if (event.target === elements.modalBackdrop && !confirmResolver) closeModal();
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

  document.querySelector("#weight-form").addEventListener("submit", submitWeight);
  document.querySelector("#body-form").addEventListener("submit", submitBody);
  document.querySelector("#calorie-form").addEventListener("submit", submitCalories);
  document.querySelector("#goals-form").addEventListener("submit", submitGoals);
  document.querySelector("#settings-form").addEventListener("submit", submitSettings);

  document.querySelector("#confirm-cancel").addEventListener("click", () => resolveConfirmation(false));
  document.querySelector("#confirm-accept").addEventListener("click", () => resolveConfirmation(true));

  document.querySelector("#export-data-button").addEventListener("click", exportBackup);
  document.querySelector("#import-data-input").addEventListener("change", event => importBackup(event.target.files?.[0]));

  window.addEventListener("online", scheduleRender);
  window.addEventListener("offline", scheduleRender);
  redrawOnResize(renderActiveCharts);
}

setStoreErrorHandler(error => {
  elements.syncPill.className = "sync-pill error";
  elements.syncLabel.textContent = "Firebase error";
  elements.syncDetail.textContent = firebaseErrorMessage(error);
  showToast("Firebase access failed", firebaseErrorMessage(error), "error");
});

subscribeState(scheduleRender);
bindEvents();
setupServiceWorker();
initializeAuthentication();
