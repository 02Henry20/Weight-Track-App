import {
  collection,
  db,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch
} from "./firebase.js";

export const DEFAULT_SETTINGS = Object.freeze({
  theme: "dark",
  colorTheme: "ocean",
  animation: "on",
  heightCm: 171,
  referenceSex: "male",
  mapMetric: "ffmi",
  smoothingDays: 7,
  trendWindowDays: 28,
  maintenanceWindowDays: 28,
  predictionMonths: 3,
  chartRangeDays: 180,
  chartScaleMode: "auto",
  chartWeightMin: "",
  chartWeightMax: "",
  energyDensityKcalPerKg: 7700,
  trendConfidenceView: "on"
});

export const DEFAULT_GOALS = Object.freeze({
  targetWeight: null,
  dailyDeficit: 300,
  targetDate: ""
});

export const state = {
  user: null,
  weights: [],
  bodyEntries: [],
  calorieEntries: [],
  settings: { ...DEFAULT_SETTINGS },
  goals: { ...DEFAULT_GOALS },
  metadata: {
    weights: { fromCache: true, pending: false },
    bodyEntries: { fromCache: true, pending: false },
    calorieEntries: { fromCache: true, pending: false },
    settings: { fromCache: true, pending: false },
    goals: { fromCache: true, pending: false }
  }
};

const listeners = new Set();
let unsubscribers = [];

function notify() {
  for (const listener of listeners) listener(state);
}

export function subscribeState(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function userCollection(userId, name) {
  return collection(db, "apps", "weight-tracker", "users", userId, name);
}

function userDoc(userId, collectionName, documentId) {
  return doc(db, "apps", "weight-tracker", "users", userId, collectionName, documentId);
}

function cleanNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeWeight(document) {
  const data = document.data();
  return {
    id: document.id,
    date: data.date ?? document.id,
    weight: cleanNumber(data.weight),
    pending: document.metadata.hasPendingWrites
  };
}

function normalizeBody(document) {
  const data = document.data();
  return {
    id: document.id,
    date: data.date ?? document.id,
    bodyFat: cleanNumber(data.bodyFat),
    weight: cleanNumber(data.weight),
    pending: document.metadata.hasPendingWrites
  };
}

function normalizeCalories(document) {
  const data = document.data();
  const mode = data.mode === "weekly" ? "weekly" : "daily";
  const value = cleanNumber(data.value, 0);
  return {
    id: document.id,
    date: data.date ?? document.id,
    mode,
    value,
    dailyAverage: cleanNumber(data.dailyAverage, mode === "weekly" ? value / 7 : value),
    pending: document.metadata.hasPendingWrites
  };
}

function sortByDateDescending(entries) {
  return entries
    .filter(entry => entry.date)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function setMetadata(key, snapshot) {
  state.metadata[key] = {
    fromCache: snapshot.metadata.fromCache,
    pending: snapshot.metadata.hasPendingWrites
  };
}

export function connectUserData(user) {
  disconnectUserData();
  state.user = user;

  const weightsUnsubscribe = onSnapshot(
    userCollection(user.uid, "weights"),
    { includeMetadataChanges: true },
    snapshot => {
      state.weights = sortByDateDescending(snapshot.docs.map(normalizeWeight));
      setMetadata("weights", snapshot);
      notify();
    },
    error => notifyError(error)
  );

  const bodyUnsubscribe = onSnapshot(
    userCollection(user.uid, "bodyComposition"),
    { includeMetadataChanges: true },
    snapshot => {
      state.bodyEntries = sortByDateDescending(snapshot.docs.map(normalizeBody));
      setMetadata("bodyEntries", snapshot);
      notify();
    },
    error => notifyError(error)
  );

  const caloriesUnsubscribe = onSnapshot(
    userCollection(user.uid, "calories"),
    { includeMetadataChanges: true },
    snapshot => {
      state.calorieEntries = sortByDateDescending(snapshot.docs.map(normalizeCalories));
      setMetadata("calorieEntries", snapshot);
      notify();
    },
    error => notifyError(error)
  );

  const settingsUnsubscribe = onSnapshot(
    userDoc(user.uid, "settings", "preferences"),
    { includeMetadataChanges: true },
    snapshot => {
      state.settings = {
        ...DEFAULT_SETTINGS,
        ...(snapshot.exists() ? snapshot.data() : {})
      };
      state.metadata.settings = {
        fromCache: snapshot.metadata.fromCache,
        pending: snapshot.metadata.hasPendingWrites
      };
      notify();
    },
    error => notifyError(error)
  );

  const goalsUnsubscribe = onSnapshot(
    userDoc(user.uid, "goals", "current"),
    { includeMetadataChanges: true },
    snapshot => {
      state.goals = {
        ...DEFAULT_GOALS,
        ...(snapshot.exists() ? snapshot.data() : {})
      };
      state.metadata.goals = {
        fromCache: snapshot.metadata.fromCache,
        pending: snapshot.metadata.hasPendingWrites
      };
      notify();
    },
    error => notifyError(error)
  );

  unsubscribers = [
    weightsUnsubscribe,
    bodyUnsubscribe,
    caloriesUnsubscribe,
    settingsUnsubscribe,
    goalsUnsubscribe
  ];

  notify();
}

export function disconnectUserData() {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  state.user = null;
  state.weights = [];
  state.bodyEntries = [];
  state.calorieEntries = [];
  state.settings = { ...DEFAULT_SETTINGS };
  state.goals = { ...DEFAULT_GOALS };
  notify();
}

let externalErrorHandler = null;

export function setStoreErrorHandler(handler) {
  externalErrorHandler = handler;
}

function notifyError(error) {
  console.error(error);
  externalErrorHandler?.(error);
}

function requireUser() {
  if (!state.user) throw new Error("You must be signed in.");
  return state.user;
}

export function saveWeight({ date, weight }) {
  const user = requireUser();
  return setDoc(userDoc(user.uid, "weights", date), {
    date,
    weight: Number(weight),
    updatedAt: serverTimestamp()
  });
}

export function saveBodyComposition({ date, bodyFat, weight }) {
  const user = requireUser();
  return setDoc(userDoc(user.uid, "bodyComposition", date), {
    date,
    bodyFat: Number(bodyFat),
    weight: Number(weight),
    updatedAt: serverTimestamp()
  });
}

export function saveCalories({ date, mode, value }) {
  const user = requireUser();
  const numericValue = Number(value);
  return setDoc(userDoc(user.uid, "calories", date), {
    date,
    mode,
    value: numericValue,
    dailyAverage: numericValue,
    updatedAt: serverTimestamp()
  });
}

export function saveGoals(goals) {
  const user = requireUser();
  return setDoc(userDoc(user.uid, "goals", "current"), {
    targetWeight: goals.targetWeight == null || goals.targetWeight === "" ? null : Number(goals.targetWeight),
    dailyDeficit: Number(goals.dailyDeficit ?? 0),
    targetDate: goals.targetDate ?? "",
    updatedAt: serverTimestamp()
  });
}

export function saveSettings(settings) {
  const user = requireUser();
  return setDoc(userDoc(user.uid, "settings", "preferences"), {
    theme: settings.theme === "light" ? "light" : "dark",
    colorTheme: ["ocean", "forest", "violet", "ember"].includes(settings.colorTheme) ? settings.colorTheme : "ocean",
    animation: settings.animation === "off" ? "off" : "on",
    heightCm: Number(settings.heightCm),
    referenceSex: settings.referenceSex,
    mapMetric: settings.mapMetric,
    smoothingDays: Number(settings.smoothingDays),
    trendWindowDays: Number(settings.trendWindowDays),
    maintenanceWindowDays: Number(settings.maintenanceWindowDays),
    predictionMonths: Number(settings.predictionMonths),
    chartRangeDays: Number(settings.chartRangeDays),
    chartScaleMode: settings.chartScaleMode === "fixed" ? "fixed" : "auto",
    chartWeightMin: settings.chartWeightMin === "" ? "" : Number(settings.chartWeightMin),
    chartWeightMax: settings.chartWeightMax === "" ? "" : Number(settings.chartWeightMax),
    energyDensityKcalPerKg: Number(settings.energyDensityKcalPerKg),
    trendConfidenceView: settings.trendConfidenceView === "off" ? "off" : "on",
    updatedAt: serverTimestamp()
  });
}

export function deleteEntry(collectionName, id) {
  const user = requireUser();
  return deleteDoc(userDoc(user.uid, collectionName, id));
}

export function hasPendingWrites() {
  return Object.values(state.metadata).some(metadata => metadata.pending);
}

export function isUsingCacheOnly() {
  const activeMetadata = [
    state.metadata.weights,
    state.metadata.bodyEntries,
    state.metadata.calorieEntries
  ];
  return activeMetadata.every(metadata => metadata.fromCache);
}

export function exportState() {
  return {
    format: "calstat-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    weights: state.weights.map(({ date, weight }) => ({ date, weight })),
    bodyEntries: state.bodyEntries.map(({ date, bodyFat, weight }) => ({ date, bodyFat, weight })),
    calorieEntries: state.calorieEntries.map(({ date, mode, value, dailyAverage }) => ({ date, mode, value, dailyAverage })),
    settings: { ...state.settings },
    goals: { ...state.goals }
  };
}

export async function importState(backup) {
  const user = requireUser();
  if (!backup || !["calstat-backup", "mass-track-backup"].includes(backup.format)) {
    throw new Error("This is not a valid CalStat backup.");
  }

  const operations = [];

  for (const entry of backup.weights ?? []) {
    if (!entry.date || !Number.isFinite(Number(entry.weight))) continue;
    operations.push({
      ref: userDoc(user.uid, "weights", entry.date),
      data: { date: entry.date, weight: Number(entry.weight), updatedAt: serverTimestamp() }
    });
  }

  for (const entry of backup.bodyEntries ?? []) {
    if (!entry.date || !Number.isFinite(Number(entry.bodyFat)) || !Number.isFinite(Number(entry.weight))) continue;
    operations.push({
      ref: userDoc(user.uid, "bodyComposition", entry.date),
      data: {
        date: entry.date,
        bodyFat: Number(entry.bodyFat),
        weight: Number(entry.weight),
        updatedAt: serverTimestamp()
      }
    });
  }

  for (const entry of backup.calorieEntries ?? []) {
    const value = Number(entry.value);
    if (!entry.date || !Number.isFinite(value)) continue;
    const mode = entry.mode === "weekly" ? "weekly" : "daily";
    const dailyAverage = Number(entry.dailyAverage);
    operations.push({
      ref: userDoc(user.uid, "calories", entry.date),
      data: {
        date: entry.date,
        mode,
        value,
        dailyAverage: Number.isFinite(dailyAverage) ? dailyAverage : (mode === "weekly" ? value / 7 : value),
        updatedAt: serverTimestamp()
      }
    });
  }

  const chunks = [];
  for (let index = 0; index < operations.length; index += 400) {
    chunks.push(operations.slice(index, index + 400));
  }

  for (const chunk of chunks) {
    const batch = writeBatch(db);
    for (const operation of chunk) batch.set(operation.ref, operation.data);
    await batch.commit();
  }

  if (backup.settings) await saveSettings({ ...DEFAULT_SETTINGS, ...backup.settings });
  if (backup.goals) await saveGoals({ ...DEFAULT_GOALS, ...backup.goals });
}
