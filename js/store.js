import {
  collection,
  completeLegacyCacheMigration,
  db,
  deleteDoc,
  doc,
  firestoreStartup,
  getDocFromCache,
  getDocFromServer,
  getDocsFromCache,
  getDocsFromServer,
  needsLegacyCacheMigration,
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
  predictionDays: 91,
  chartStartDate: "",
  chartScaleMode: "auto",
  chartWeightMin: "",
  chartWeightMax: "",
  energyDensityKcalPerKg: 7700,
  trendConfidenceView: "on"
});

export const DEFAULT_GOALS = Object.freeze({
  targetBodyFat: null,
  targetWeight: null,
  dailyDeficit: 300,
  targetDate: ""
});

const LOCAL_STATE_VERSION = 1;
const LOCAL_STATE_PREFIX = "calstat-device-state-v1:";
const DEVICE_ID_KEY = "calstat-device-id-v1";
const LAST_SESSION_KEY = "calstat-last-session-v1";
const TOMBSTONE_COLLECTION = "syncTombstones";
const DATA_COLLECTIONS = ["weights", "bodyComposition", "calories"];

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
  },
  sync: {
    status: "idle",
    detail: "Not connected",
    lastSyncedAt: null
  }
};

const localMeta = {
  settingsUpdatedAtMs: 0,
  goalsUpdatedAtMs: 0,
  tombstones: [],
  hasStoredSnapshot: false
};

const listeners = new Set();
let unsubscribers = [];
let externalErrorHandler = null;
let syncInFlight = null;
let realtimeAttached = false;

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

function foodTrackerCollection(userId, name) {
  return collection(db, "apps", "food-tracker", "users", userId, name);
}

function userDoc(userId, collectionName, documentId) {
  return doc(db, "apps", "weight-tracker", "users", userId, collectionName, documentId);
}

function cleanNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestampToMillis(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && Number.isFinite(value.seconds)) {
    return value.seconds * 1000 + Math.floor((value.nanoseconds ?? 0) / 1_000_000);
  }
  return 0;
}

function documentUpdatedAtMs(data) {
  return Math.max(
    timestampToMillis(data.clientUpdatedAtMs),
    timestampToMillis(data.updatedAt)
  );
}

function normalizeWeight(document) {
  const data = document.data();
  return {
    id: document.id,
    date: data.date ?? document.id,
    weight: cleanNumber(data.weight),
    updatedAtMs: documentUpdatedAtMs(data) || (document.metadata?.hasPendingWrites ? Date.now() : 0),
    pending: Boolean(document.metadata?.hasPendingWrites)
  };
}

function normalizeBody(document) {
  const data = document.data();
  return {
    id: document.id,
    date: data.date ?? document.id,
    bodyFat: cleanNumber(data.bodyFat),
    weight: cleanNumber(data.weight),
    updatedAtMs: documentUpdatedAtMs(data) || (document.metadata?.hasPendingWrites ? Date.now() : 0),
    pending: Boolean(document.metadata?.hasPendingWrites)
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
    dailyAverage: cleanNumber(data.dailyAverage, value),
    updatedAtMs: documentUpdatedAtMs(data) || (document.metadata?.hasPendingWrites ? Date.now() : 0),
    pending: Boolean(document.metadata?.hasPendingWrites)
  };
}

function normalizeTombstone(document) {
  const data = document.data();
  return {
    id: document.id,
    collectionName: data.collectionName,
    documentId: data.documentId,
    updatedAtMs: Math.max(
      timestampToMillis(data.deletedAtMs),
      timestampToMillis(data.updatedAt)
    ) || (document.metadata?.hasPendingWrites ? Date.now() : 0),
    pending: Boolean(document.metadata?.hasPendingWrites)
  };
}

function sortByDateDescending(entries) {
  return entries
    .filter(entry => entry.date)
    .sort((a, b) => b.date.localeCompare(a.date));
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseLocalDate(dateString) {
  return new Date(`${dateString}T00:00:00`);
}

function localDateString(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function addDaysString(dateString, days) {
  const date = parseLocalDate(dateString);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function startOfWeekString(dateString) {
  const date = parseLocalDate(dateString);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return localDateString(date);
}

function currentDateString() {
  return localDateString(new Date());
}

function hasCalorieEntryInWeek(startDate, endDate) {
  return state.calorieEntries.some(entry => entry.date >= startDate && entry.date <= endDate);
}

function normalizeNutriPilotWeeklyCache(document) {
  const data = document.data();
  const idDates = document.id.match(/^week_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/);
  const start = idDates?.[1] ?? null;
  const end = idDates?.[2] ?? null;
  const storedAverageKcal = Number(data.averageKcalPerDay);
  const storedMetricDayCount = Number(data.metricDayCount);
  const storedTotalKcal = Number(data.total?.kcal);
  const activeDates = Array.isArray(data.activeDates)
    ? data.activeDates.filter(date => typeof date === "string" && ISO_DATE_PATTERN.test(date))
    : [];
  const dates = Array.isArray(data.dates)
    ? data.dates.filter(date => typeof date === "string" && ISO_DATE_PATTERN.test(date))
    : [];

  if (!idDates || !start || !end || start > end || data.dirty === true) {
    return null;
  }

  const activeDayCount = Number.isFinite(storedMetricDayCount) && storedMetricDayCount > 0
    ? Math.round(storedMetricDayCount)
    : activeDates.length;
  const calendarDayCount = dates.length || Math.max(1, Number(data.dayCount) || 7);
  const hasStoredAverage = Number.isFinite(storedAverageKcal) && storedAverageKcal > 0;
  const hasLegacyTotal = Number.isFinite(storedTotalKcal) && storedTotalKcal > 0;
  const averageKcal = hasStoredAverage
    ? storedAverageKcal
    : hasLegacyTotal && activeDayCount > 0
      ? storedTotalKcal / activeDayCount
      : null;

  if (!Number.isFinite(averageKcal) || averageKcal <= 0) return null;

  return {
    id: document.id,
    start,
    end,
    date: end,
    totalKcal: hasLegacyTotal ? storedTotalKcal : null,
    averageKcal,
    calendarAverageKcal: hasLegacyTotal ? storedTotalKcal / Math.max(1, calendarDayCount) : null,
    activeDayCount,
    calendarDayCount,
    sourceEntryCount: Number(data.sourceEntryCount) || 0,
    generatedAt: timestampToMillis(data.generatedAt) || Number(data.generatedAt) || 0
  };
}

function migrateSettings(storedSettings = {}) {
  const legacyPredictionDays = Math.round((Number(storedSettings.predictionMonths) || 3) * 30.4375);
  return {
    theme: storedSettings.theme === "light" ? "light" : "dark",
    colorTheme: ["ocean", "forest", "violet", "ember"].includes(storedSettings.colorTheme) ? storedSettings.colorTheme : "ocean",
    animation: storedSettings.animation === "off" ? "off" : "on",
    heightCm: Number.isFinite(Number(storedSettings.heightCm)) ? Number(storedSettings.heightCm) : DEFAULT_SETTINGS.heightCm,
    referenceSex: storedSettings.referenceSex === "female" ? "female" : "male",
    mapMetric: storedSettings.mapMetric === "bmi" ? "bmi" : "ffmi",
    smoothingDays: Math.max(1, Math.round(Number(storedSettings.smoothingDays) || DEFAULT_SETTINGS.smoothingDays)),
    trendWindowDays: Math.max(1, Math.round(Number(storedSettings.trendWindowDays) || DEFAULT_SETTINGS.trendWindowDays)),
    maintenanceWindowDays: Math.max(1, Math.round(Number(storedSettings.maintenanceWindowDays) || DEFAULT_SETTINGS.maintenanceWindowDays)),
    predictionDays: Number.isFinite(Number(storedSettings.predictionDays))
      ? Math.max(1, Math.round(Number(storedSettings.predictionDays)))
      : legacyPredictionDays,
    chartStartDate: typeof storedSettings.chartStartDate === "string" ? storedSettings.chartStartDate : "",
    chartScaleMode: storedSettings.chartScaleMode === "fixed" ? "fixed" : "auto",
    chartWeightMin: storedSettings.chartWeightMin === "" || storedSettings.chartWeightMin == null ? "" : cleanNumber(storedSettings.chartWeightMin, ""),
    chartWeightMax: storedSettings.chartWeightMax === "" || storedSettings.chartWeightMax == null ? "" : cleanNumber(storedSettings.chartWeightMax, ""),
    energyDensityKcalPerKg: Number.isFinite(Number(storedSettings.energyDensityKcalPerKg))
      ? Number(storedSettings.energyDensityKcalPerKg)
      : DEFAULT_SETTINGS.energyDensityKcalPerKg,
    trendConfidenceView: storedSettings.trendConfidenceView === "off" ? "off" : "on"
  };
}

function normalizeGoals(storedGoals = {}) {
  const targetBodyFat = storedGoals.targetBodyFat == null || storedGoals.targetBodyFat === ""
    ? null
    : cleanNumber(storedGoals.targetBodyFat, null);
  const targetWeight = storedGoals.targetWeight == null || storedGoals.targetWeight === ""
    ? null
    : cleanNumber(storedGoals.targetWeight, null);
  return {
    targetBodyFat,
    targetWeight,
    dailyDeficit: cleanNumber(storedGoals.dailyDeficit, DEFAULT_GOALS.dailyDeficit),
    targetDate: typeof storedGoals.targetDate === "string" ? storedGoals.targetDate : ""
  };
}

function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return "unavailable-device-storage";
  }
}

function localStateKey(userId) {
  return `${LOCAL_STATE_PREFIX}${userId}`;
}

function emptySnapshot(userId = null) {
  return {
    format: "calstat-device-state",
    version: LOCAL_STATE_VERSION,
    userId,
    deviceId: getDeviceId(),
    savedAt: 0,
    weights: [],
    bodyEntries: [],
    calorieEntries: [],
    settings: { ...DEFAULT_SETTINGS },
    settingsUpdatedAtMs: 0,
    settingsPending: false,
    goals: { ...DEFAULT_GOALS },
    goalsUpdatedAtMs: 0,
    goalsPending: false,
    tombstones: []
  };
}

function snapshotFromState() {
  return {
    ...emptySnapshot(state.user?.uid ?? null),
    savedAt: Date.now(),
    weights: state.weights.map(entry => ({ ...entry })),
    bodyEntries: state.bodyEntries.map(entry => ({ ...entry })),
    calorieEntries: state.calorieEntries.map(entry => ({ ...entry })),
    settings: { ...state.settings },
    settingsUpdatedAtMs: localMeta.settingsUpdatedAtMs,
    settingsPending: Boolean(state.metadata.settings.pending),
    goals: { ...state.goals },
    goalsUpdatedAtMs: localMeta.goalsUpdatedAtMs,
    goalsPending: Boolean(state.metadata.goals.pending),
    tombstones: localMeta.tombstones.map(entry => ({ ...entry }))
  };
}

function loadLocalSnapshot(userId) {
  try {
    const raw = localStorage.getItem(localStateKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.format !== "calstat-device-state") return null;
    return {
      ...emptySnapshot(userId),
      ...parsed,
      userId,
      settings: migrateSettings(parsed.settings),
      goals: normalizeGoals(parsed.goals),
      weights: Array.isArray(parsed.weights) ? parsed.weights : [],
      bodyEntries: Array.isArray(parsed.bodyEntries) ? parsed.bodyEntries : [],
      calorieEntries: Array.isArray(parsed.calorieEntries) ? parsed.calorieEntries : [],
      tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : []
    };
  } catch (error) {
    console.warn("Could not read CalStat device snapshot:", error);
    return null;
  }
}

function persistLocalState() {
  if (!state.user) return;
  try {
    localStorage.setItem(localStateKey(state.user.uid), JSON.stringify(snapshotFromState()));
    localMeta.hasStoredSnapshot = true;
  } catch (error) {
    console.warn("Could not store CalStat device snapshot:", error);
  }
}

function rememberLocalSession(user) {
  if (!user?.uid) return;
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({
      uid: user.uid,
      email: user.email ?? "",
      savedAt: Date.now()
    }));
  } catch {
    // Local session hints are convenience only; the data snapshot is stored separately.
  }
}

export function getLastLocalSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_SESSION_KEY) ?? "null");
    if (parsed?.uid) {
      return {
        uid: parsed.uid,
        email: parsed.email || parsed.uid,
        savedAt: Number(parsed.savedAt) || 0
      };
    }

    let fallback = null;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(LOCAL_STATE_PREFIX)) continue;
      const snapshot = JSON.parse(localStorage.getItem(key) ?? "null");
      if (snapshot?.format !== "calstat-device-state") continue;
      const uid = snapshot.userId || key.slice(LOCAL_STATE_PREFIX.length);
      const savedAt = Number(snapshot.savedAt) || 0;
      if (!fallback || savedAt > fallback.savedAt) {
        fallback = { uid, email: uid, savedAt };
      }
    }
    return fallback;
  } catch {
    return null;
  }
}

export function clearLastLocalSession() {
  try {
    localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

function applySnapshot(snapshot, { fromCache = false } = {}) {
  state.weights = sortByDateDescending((snapshot.weights ?? []).map(entry => ({ ...entry, pending: Boolean(entry.pending) })));
  state.bodyEntries = sortByDateDescending((snapshot.bodyEntries ?? []).map(entry => ({ ...entry, pending: Boolean(entry.pending) })));
  state.calorieEntries = sortByDateDescending((snapshot.calorieEntries ?? []).map(entry => ({ ...entry, pending: Boolean(entry.pending) })));
  state.settings = migrateSettings(snapshot.settings);
  state.goals = normalizeGoals(snapshot.goals);
  localMeta.settingsUpdatedAtMs = Number(snapshot.settingsUpdatedAtMs) || 0;
  localMeta.goalsUpdatedAtMs = Number(snapshot.goalsUpdatedAtMs) || 0;
  localMeta.tombstones = Array.isArray(snapshot.tombstones) ? snapshot.tombstones.map(entry => ({ ...entry })) : [];

  state.metadata.weights = { fromCache, pending: state.weights.some(entry => entry.pending) };
  state.metadata.bodyEntries = { fromCache, pending: state.bodyEntries.some(entry => entry.pending) };
  state.metadata.calorieEntries = { fromCache, pending: state.calorieEntries.some(entry => entry.pending) };
  state.metadata.settings = { fromCache, pending: Boolean(snapshot.settingsPending) };
  state.metadata.goals = { fromCache, pending: Boolean(snapshot.goalsPending) };
}

function setSyncStatus(status, detail, lastSyncedAt = state.sync.lastSyncedAt) {
  state.sync = { status, detail, lastSyncedAt };
  notify();
}

function comparableEntry(collectionName, entry) {
  if (collectionName === "weights") return [entry.id ?? entry.date, entry.date, Number(entry.weight)];
  if (collectionName === "bodyEntries") return [entry.id ?? entry.date, entry.date, Number(entry.bodyFat), Number(entry.weight)];
  return [entry.id ?? entry.date, entry.date, entry.mode, Number(entry.value), Number(entry.dailyAverage)];
}

function stableComparable(snapshot) {
  return JSON.stringify({
    weights: (snapshot.weights ?? []).map(entry => comparableEntry("weights", entry)).sort(),
    bodyEntries: (snapshot.bodyEntries ?? []).map(entry => comparableEntry("bodyEntries", entry)).sort(),
    calorieEntries: (snapshot.calorieEntries ?? []).map(entry => comparableEntry("calorieEntries", entry)).sort(),
    settings: migrateSettings(snapshot.settings),
    goals: normalizeGoals(snapshot.goals)
  });
}

function snapshotsDiffer(localSnapshot, cloudSnapshot) {
  return stableComparable(localSnapshot) !== stableComparable(cloudSnapshot);
}

function hasUserData(snapshot) {
  return Boolean(
    snapshot.weights?.length ||
    snapshot.bodyEntries?.length ||
    snapshot.calorieEntries?.length ||
    snapshot.goals?.targetBodyFat != null && Number.isFinite(Number(snapshot.goals.targetBodyFat))
  );
}

function syncSummary(localSnapshot, cloudSnapshot) {
  const conflictCount = [
    [localSnapshot.weights, cloudSnapshot.weights],
    [localSnapshot.bodyEntries, cloudSnapshot.bodyEntries],
    [localSnapshot.calorieEntries, cloudSnapshot.calorieEntries]
  ].reduce((total, [localEntries = [], cloudEntries = []]) => {
    const property = localEntries === localSnapshot.weights
      ? "weights"
      : localEntries === localSnapshot.bodyEntries
        ? "bodyEntries"
        : "calorieEntries";
    const localMap = new Map(localEntries.map(entry => [entry.id ?? entry.date, JSON.stringify(comparableEntry(property, entry))]));
    return total + cloudEntries.filter(entry => {
      const local = localMap.get(entry.id ?? entry.date);
      return local && local !== JSON.stringify(comparableEntry(property, entry));
    }).length;
  }, 0);

  return {
    local: {
      weights: localSnapshot.weights?.length ?? 0,
      body: localSnapshot.bodyEntries?.length ?? 0,
      calories: localSnapshot.calorieEntries?.length ?? 0
    },
    cloud: {
      weights: cloudSnapshot.weights?.length ?? 0,
      body: cloudSnapshot.bodyEntries?.length ?? 0,
      calories: cloudSnapshot.calorieEntries?.length ?? 0
    },
    conflicts: conflictCount
  };
}

async function cachedDocumentOrEmpty(reference) {
  try {
    return await getDocFromCache(reference);
  } catch {
    return null;
  }
}

async function fetchLegacyCacheSnapshot(userId) {
  const [weightsSnapshot, bodySnapshot, calorieSnapshot, settingsSnapshot, goalsSnapshot, tombstonesSnapshot] = await Promise.all([
    getDocsFromCache(userCollection(userId, "weights")),
    getDocsFromCache(userCollection(userId, "bodyComposition")),
    getDocsFromCache(userCollection(userId, "calories")),
    cachedDocumentOrEmpty(userDoc(userId, "settings", "preferences")),
    cachedDocumentOrEmpty(userDoc(userId, "goals", "current")),
    getDocsFromCache(userCollection(userId, TOMBSTONE_COLLECTION))
  ]);

  const settingsData = settingsSnapshot?.exists() ? settingsSnapshot.data() : {};
  const goalsData = goalsSnapshot?.exists() ? goalsSnapshot.data() : {};
  const settingsPending = Boolean(settingsSnapshot?.metadata?.hasPendingWrites);
  const goalsPending = Boolean(goalsSnapshot?.metadata?.hasPendingWrites);

  return {
    ...emptySnapshot(userId),
    savedAt: Date.now(),
    weights: sortByDateDescending(weightsSnapshot.docs.map(normalizeWeight)),
    bodyEntries: sortByDateDescending(bodySnapshot.docs.map(normalizeBody)),
    calorieEntries: sortByDateDescending(calorieSnapshot.docs.map(normalizeCalories)),
    settings: migrateSettings(settingsData),
    settingsUpdatedAtMs: documentUpdatedAtMs(settingsData) || (settingsPending ? Date.now() : 0),
    settingsPending,
    goals: normalizeGoals(goalsData),
    goalsUpdatedAtMs: documentUpdatedAtMs(goalsData) || (goalsPending ? Date.now() : 0),
    goalsPending,
    tombstones: tombstonesSnapshot.docs.map(normalizeTombstone)
  };
}

async function fetchCloudSnapshot(userId) {
  const [weightsSnapshot, bodySnapshot, calorieSnapshot, settingsSnapshot, goalsSnapshot, tombstonesSnapshot] = await Promise.all([
    getDocsFromServer(userCollection(userId, "weights")),
    getDocsFromServer(userCollection(userId, "bodyComposition")),
    getDocsFromServer(userCollection(userId, "calories")),
    getDocFromServer(userDoc(userId, "settings", "preferences")),
    getDocFromServer(userDoc(userId, "goals", "current")),
    getDocsFromServer(userCollection(userId, TOMBSTONE_COLLECTION))
  ]);

  const settingsData = settingsSnapshot.exists() ? settingsSnapshot.data() : {};
  const goalsData = goalsSnapshot.exists() ? goalsSnapshot.data() : {};

  return {
    ...emptySnapshot(userId),
    savedAt: Date.now(),
    weights: sortByDateDescending(weightsSnapshot.docs.map(normalizeWeight)),
    bodyEntries: sortByDateDescending(bodySnapshot.docs.map(normalizeBody)),
    calorieEntries: sortByDateDescending(calorieSnapshot.docs.map(normalizeCalories)),
    settings: migrateSettings(settingsData),
    settingsUpdatedAtMs: documentUpdatedAtMs(settingsData),
    goals: normalizeGoals(goalsData),
    goalsUpdatedAtMs: documentUpdatedAtMs(goalsData),
    tombstones: tombstonesSnapshot.docs.map(normalizeTombstone)
  };
}

function tombstoneKey(collectionName, documentId) {
  return `${collectionName}__${encodeURIComponent(documentId)}`;
}

function collectionProperty(collectionName) {
  if (collectionName === "weights") return "weights";
  if (collectionName === "bodyComposition") return "bodyEntries";
  if (collectionName === "calories") return "calorieEntries";
  throw new Error(`Unknown collection: ${collectionName}`);
}

function mergeCollection(localEntries = [], cloudEntries = [], collectionName, tombstones = []) {
  const result = new Map();
  const tombstoneMap = new Map(
    tombstones
      .filter(item => item.collectionName === collectionName)
      .map(item => [item.documentId, item])
  );

  for (const entry of cloudEntries) result.set(entry.id ?? entry.date, { ...entry, pending: false });

  for (const entry of localEntries) {
    const id = entry.id ?? entry.date;
    const cloudEntry = result.get(id);
    const localTime = Number(entry.updatedAtMs) || 0;
    const cloudTime = Number(cloudEntry?.updatedAtMs) || 0;
    if (!cloudEntry || entry.pending || localTime >= cloudTime) result.set(id, { ...entry, id });
  }

  for (const [id, tombstone] of tombstoneMap) {
    const entry = result.get(id);
    const tombstoneTime = Number(tombstone.updatedAtMs) || 0;
    const entryTime = Number(entry?.updatedAtMs) || 0;
    const deletionWins = !entry
      || (tombstone.pending && (!entry.pending || tombstoneTime >= entryTime))
      || (!entry.pending && tombstoneTime >= entryTime);
    if (deletionWins) result.delete(id);
  }

  return sortByDateDescending([...result.values()]);
}

function mergeTombstones(localTombstones = [], cloudTombstones = [], mergedCollections) {
  const map = new Map();
  for (const item of [...cloudTombstones, ...localTombstones]) {
    const key = `${item.collectionName}/${item.documentId}`;
    const previous = map.get(key);
    if (!previous || item.pending || Number(item.updatedAtMs) >= Number(previous.updatedAtMs)) map.set(key, { ...item });
  }

  for (const [collectionName, entries] of Object.entries(mergedCollections)) {
    const entryMap = new Map(entries.map(entry => [entry.id ?? entry.date, entry]));
    for (const [key, tombstone] of map) {
      if (tombstone.collectionName !== collectionName) continue;
      const live = entryMap.get(tombstone.documentId);
      if (live && (live.pending || Number(live.updatedAtMs) > Number(tombstone.updatedAtMs))) map.delete(key);
    }
  }

  return [...map.values()];
}

function mergeSnapshots(localSnapshot, cloudSnapshot) {
  const combinedTombstones = [...(cloudSnapshot.tombstones ?? []), ...(localSnapshot.tombstones ?? [])];
  const weights = mergeCollection(localSnapshot.weights, cloudSnapshot.weights, "weights", combinedTombstones);
  const bodyEntries = mergeCollection(localSnapshot.bodyEntries, cloudSnapshot.bodyEntries, "bodyComposition", combinedTombstones);
  const calorieEntries = mergeCollection(localSnapshot.calorieEntries, cloudSnapshot.calorieEntries, "calories", combinedTombstones);

  const settingsUseLocal = Boolean(localSnapshot.settingsPending)
    || Number(localSnapshot.settingsUpdatedAtMs) >= Number(cloudSnapshot.settingsUpdatedAtMs);
  const goalsUseLocal = Boolean(localSnapshot.goalsPending)
    || Number(localSnapshot.goalsUpdatedAtMs) >= Number(cloudSnapshot.goalsUpdatedAtMs);
  const tombstones = mergeTombstones(localSnapshot.tombstones, cloudSnapshot.tombstones, {
    weights,
    bodyComposition: bodyEntries,
    calories: calorieEntries
  });

  return {
    ...emptySnapshot(localSnapshot.userId ?? cloudSnapshot.userId),
    weights,
    bodyEntries,
    calorieEntries,
    settings: settingsUseLocal ? migrateSettings(localSnapshot.settings) : migrateSettings(cloudSnapshot.settings),
    settingsUpdatedAtMs: settingsUseLocal
      ? Number(localSnapshot.settingsUpdatedAtMs) || 0
      : Number(cloudSnapshot.settingsUpdatedAtMs) || 0,
    settingsPending: settingsUseLocal && Boolean(localSnapshot.settingsPending),
    goals: goalsUseLocal ? normalizeGoals(localSnapshot.goals) : normalizeGoals(cloudSnapshot.goals),
    goalsUpdatedAtMs: goalsUseLocal
      ? Number(localSnapshot.goalsUpdatedAtMs) || 0
      : Number(cloudSnapshot.goalsUpdatedAtMs) || 0,
    goalsPending: goalsUseLocal && Boolean(localSnapshot.goalsPending),
    tombstones
  };
}

function entryToCloudData(collectionName, entry) {
  const common = {
    date: entry.date,
    clientUpdatedAtMs: Number(entry.updatedAtMs) || Date.now(),
    updatedAt: serverTimestamp()
  };
  if (collectionName === "weights") return { ...common, weight: Number(entry.weight) };
  if (collectionName === "bodyComposition") {
    return { ...common, bodyFat: Number(entry.bodyFat), weight: Number(entry.weight) };
  }
  return {
    ...common,
    mode: entry.mode === "weekly" ? "weekly" : "daily",
    value: Number(entry.value),
    dailyAverage: Number.isFinite(Number(entry.dailyAverage)) ? Number(entry.dailyAverage) : Number(entry.value)
  };
}

function settingsToCloudData(settings, updatedAtMs) {
  return {
    theme: settings.theme === "light" ? "light" : "dark",
    colorTheme: ["ocean", "forest", "violet", "ember"].includes(settings.colorTheme) ? settings.colorTheme : "ocean",
    animation: settings.animation === "off" ? "off" : "on",
    heightCm: Number(settings.heightCm),
    referenceSex: settings.referenceSex,
    mapMetric: settings.mapMetric,
    smoothingDays: Number(settings.smoothingDays),
    trendWindowDays: Number(settings.trendWindowDays),
    maintenanceWindowDays: Number(settings.maintenanceWindowDays),
    predictionDays: Math.max(1, Math.round(Number(settings.predictionDays) || 91)),
    chartStartDate: typeof settings.chartStartDate === "string" ? settings.chartStartDate : "",
    chartScaleMode: settings.chartScaleMode === "fixed" ? "fixed" : "auto",
    chartWeightMin: settings.chartWeightMin === "" ? "" : Number(settings.chartWeightMin),
    chartWeightMax: settings.chartWeightMax === "" ? "" : Number(settings.chartWeightMax),
    energyDensityKcalPerKg: Number(settings.energyDensityKcalPerKg),
    trendConfidenceView: settings.trendConfidenceView === "off" ? "off" : "on",
    clientUpdatedAtMs: updatedAtMs,
    updatedAt: serverTimestamp()
  };
}

function goalsToCloudData(goals, updatedAtMs) {
  return {
    targetBodyFat: goals.targetBodyFat == null || goals.targetBodyFat === "" ? null : Number(goals.targetBodyFat),
    targetWeight: goals.targetWeight == null || goals.targetWeight === "" ? null : Number(goals.targetWeight),
    dailyDeficit: Number(goals.dailyDeficit ?? 0),
    targetDate: goals.targetDate ?? "",
    clientUpdatedAtMs: updatedAtMs,
    updatedAt: serverTimestamp()
  };
}

async function commitOperations(operations) {
  const byPath = new Map();
  for (const operation of operations) {
    const key = operation.ref.path;
    if (byPath.has(key)) byPath.delete(key);
    byPath.set(key, operation);
  }
  const deduplicated = [...byPath.values()];
  for (let index = 0; index < deduplicated.length; index += 400) {
    const batch = writeBatch(db);
    for (const operation of deduplicated.slice(index, index + 400)) {
      if (operation.type === "delete") batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data);
    }
    await batch.commit();
  }
}

async function writeSnapshotToCloud(snapshot, cloudSnapshot, { replace = false } = {}) {
  const user = requireUser();
  const operations = [];

  for (const collectionName of DATA_COLLECTIONS) {
    const property = collectionProperty(collectionName);
    const desiredEntries = snapshot[property] ?? [];
    const desiredMap = new Map(desiredEntries.map(entry => [entry.id ?? entry.date, entry]));
    const cloudEntries = cloudSnapshot[property] ?? [];
    const cloudMap = new Map(cloudEntries.map(entry => [entry.id ?? entry.date, entry]));

    for (const [id, entry] of desiredMap) {
      const cloudEntry = cloudMap.get(id);
      const valuesDiffer = !cloudEntry || JSON.stringify(comparableEntry(property, entry)) !== JSON.stringify(comparableEntry(property, cloudEntry));
      if (replace || valuesDiffer || Number(entry.updatedAtMs) > Number(cloudEntry?.updatedAtMs ?? 0)) {
        operations.push({
          type: "set",
          ref: userDoc(user.uid, collectionName, id),
          data: entryToCloudData(collectionName, entry)
        });
      }
      operations.push({
        type: "delete",
        ref: userDoc(user.uid, TOMBSTONE_COLLECTION, tombstoneKey(collectionName, id))
      });
    }

    if (replace) {
      for (const [id, cloudEntry] of cloudMap) {
        if (desiredMap.has(id)) continue;
        const deletedAtMs = Date.now();
        operations.push({ type: "delete", ref: userDoc(user.uid, collectionName, id) });
        operations.push({
          type: "set",
          ref: userDoc(user.uid, TOMBSTONE_COLLECTION, tombstoneKey(collectionName, id)),
          data: {
            collectionName,
            documentId: id,
            deletedAtMs,
            clientUpdatedAtMs: deletedAtMs,
            updatedAt: serverTimestamp()
          }
        });
      }
    }
  }

  for (const tombstone of snapshot.tombstones ?? []) {
    const property = collectionProperty(tombstone.collectionName);
    const live = (snapshot[property] ?? []).find(entry => (entry.id ?? entry.date) === tombstone.documentId);
    if (live && Number(live.updatedAtMs) > Number(tombstone.updatedAtMs)) continue;
    operations.push({ type: "delete", ref: userDoc(user.uid, tombstone.collectionName, tombstone.documentId) });
    operations.push({
      type: "set",
      ref: userDoc(user.uid, TOMBSTONE_COLLECTION, tombstoneKey(tombstone.collectionName, tombstone.documentId)),
      data: {
        collectionName: tombstone.collectionName,
        documentId: tombstone.documentId,
        deletedAtMs: Number(tombstone.updatedAtMs) || Date.now(),
        clientUpdatedAtMs: Number(tombstone.updatedAtMs) || Date.now(),
        updatedAt: serverTimestamp()
      }
    });
  }

  const settingsDiffer = JSON.stringify(migrateSettings(snapshot.settings)) !== JSON.stringify(migrateSettings(cloudSnapshot.settings));
  if (replace || settingsDiffer || Number(snapshot.settingsUpdatedAtMs) > Number(cloudSnapshot.settingsUpdatedAtMs)) {
    operations.push({
      type: "set",
      ref: userDoc(user.uid, "settings", "preferences"),
      data: settingsToCloudData(snapshot.settings, Number(snapshot.settingsUpdatedAtMs) || Date.now())
    });
  }

  const goalsDiffer = JSON.stringify(normalizeGoals(snapshot.goals)) !== JSON.stringify(normalizeGoals(cloudSnapshot.goals));
  if (replace || goalsDiffer || Number(snapshot.goalsUpdatedAtMs) > Number(cloudSnapshot.goalsUpdatedAtMs)) {
    operations.push({
      type: "set",
      ref: userDoc(user.uid, "goals", "current"),
      data: goalsToCloudData(snapshot.goals, Number(snapshot.goalsUpdatedAtMs) || Date.now())
    });
  }

  await commitOperations(operations);
}

function clearPendingFlags(snapshot) {
  return {
    ...snapshot,
    weights: (snapshot.weights ?? []).map(entry => ({ ...entry, pending: false })),
    bodyEntries: (snapshot.bodyEntries ?? []).map(entry => ({ ...entry, pending: false })),
    calorieEntries: (snapshot.calorieEntries ?? []).map(entry => ({ ...entry, pending: false })),
    settingsPending: false,
    goalsPending: false,
    tombstones: (snapshot.tombstones ?? []).map(entry => ({ ...entry, pending: false }))
  };
}

async function reconcileWithCloud(resolveConflict, { forcePrompt = false } = {}) {
  if (!state.user) return;
  if (state.user.offlineOnly) {
    setSyncStatus("offline", "Sign in online to sync this device copy");
    return;
  }
  if (!navigator.onLine) {
    setSyncStatus("offline", "Using this device's saved data");
    return;
  }
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    setSyncStatus("loading", "Comparing this device with Firebase");
    const cloudSnapshot = await fetchCloudSnapshot(state.user.uid);
    const localSnapshot = snapshotFromState();
    const differs = snapshotsDiffer(localSnapshot, cloudSnapshot);
    let choice = "cloud";

    if (localMeta.hasStoredSnapshot && differs && typeof resolveConflict === "function") {
      setSyncStatus("conflict", "Choose how to reconcile device and cloud data");
      choice = await resolveConflict(syncSummary(localSnapshot, cloudSnapshot));
    } else if (forcePrompt && differs && hasUserData(localSnapshot) && typeof resolveConflict === "function") {
      setSyncStatus("conflict", "Choose how to reconcile device and cloud data");
      choice = await resolveConflict(syncSummary(localSnapshot, cloudSnapshot));
    } else if (!localMeta.hasStoredSnapshot || !hasUserData(localSnapshot)) {
      choice = "cloud";
    } else if (differs) {
      choice = "merge";
    }

    if (choice === "local") {
      await writeSnapshotToCloud(localSnapshot, cloudSnapshot, { replace: true });
      const clean = clearPendingFlags({ ...localSnapshot, tombstones: [] });
      applySnapshot(clean);
    } else if (choice === "merge") {
      const merged = mergeSnapshots(localSnapshot, cloudSnapshot);
      await writeSnapshotToCloud(merged, cloudSnapshot);
      applySnapshot(clearPendingFlags(merged));
    } else {
      applySnapshot(clearPendingFlags(cloudSnapshot));
    }

    localMeta.tombstones = [];
    persistLocalState();
    const syncedAt = new Date().toISOString();
    setSyncStatus("synced", "Device and Firebase are aligned", syncedAt);
    attachRealtimeListeners();
  })().catch(error => {
    if (!navigator.onLine || error?.code === "unavailable") {
      setSyncStatus("offline", "Cloud unavailable · using device data");
      return;
    }
    setSyncStatus("error", error?.message ?? "Synchronization failed");
    notifyError(error);
    throw error;
  }).finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}

function hasPendingCollection(collectionName) {
  const property = collectionProperty(collectionName);
  return state[property].some(entry => entry.pending) || localMeta.tombstones.some(item => item.collectionName === collectionName);
}

function attachRealtimeListeners() {
  if (!state.user || realtimeAttached) return;
  realtimeAttached = true;
  const userId = state.user.uid;

  const listenCollection = (collectionName, metadataKey, normalizer) => onSnapshot(
    userCollection(userId, collectionName),
    { includeMetadataChanges: true },
    snapshot => {
      if (snapshot.metadata.fromCache || hasPendingCollection(collectionName)) return;
      state[collectionProperty(collectionName)] = sortByDateDescending(snapshot.docs.map(normalizer));
      state.metadata[metadataKey] = { fromCache: false, pending: false };
      persistLocalState();
      notify();
    },
    error => notifyError(error)
  );

  const weightsUnsubscribe = listenCollection("weights", "weights", normalizeWeight);
  const bodyUnsubscribe = listenCollection("bodyComposition", "bodyEntries", normalizeBody);
  const caloriesUnsubscribe = listenCollection("calories", "calorieEntries", normalizeCalories);

  const settingsUnsubscribe = onSnapshot(
    userDoc(userId, "settings", "preferences"),
    { includeMetadataChanges: true },
    snapshot => {
      if (snapshot.metadata.fromCache || state.metadata.settings.pending) return;
      const data = snapshot.exists() ? snapshot.data() : {};
      state.settings = migrateSettings(data);
      localMeta.settingsUpdatedAtMs = documentUpdatedAtMs(data);
      state.metadata.settings = { fromCache: false, pending: false };
      persistLocalState();
      notify();
    },
    error => notifyError(error)
  );

  const goalsUnsubscribe = onSnapshot(
    userDoc(userId, "goals", "current"),
    { includeMetadataChanges: true },
    snapshot => {
      if (snapshot.metadata.fromCache || state.metadata.goals.pending) return;
      const data = snapshot.exists() ? snapshot.data() : {};
      state.goals = normalizeGoals(data);
      localMeta.goalsUpdatedAtMs = documentUpdatedAtMs(data);
      state.metadata.goals = { fromCache: false, pending: false };
      persistLocalState();
      notify();
    },
    error => notifyError(error)
  );

  const tombstonesUnsubscribe = onSnapshot(
    userCollection(userId, TOMBSTONE_COLLECTION),
    { includeMetadataChanges: true },
    snapshot => {
      if (snapshot.metadata.fromCache || hasPendingWrites()) return;
      localMeta.tombstones = snapshot.docs.map(normalizeTombstone);
      persistLocalState();
    },
    error => notifyError(error)
  );

  unsubscribers = [
    weightsUnsubscribe,
    bodyUnsubscribe,
    caloriesUnsubscribe,
    settingsUnsubscribe,
    goalsUnsubscribe,
    tombstonesUnsubscribe
  ];
}

export async function connectUserData(user, resolveConflict) {
  disconnectUserData();
  state.user = user;
  rememberLocalSession(user);
  await firestoreStartup;

  if (needsLegacyCacheMigration) {
    setSyncStatus("loading", "Preserving this device's existing data before sync");
    const existingSnapshot = loadLocalSnapshot(user.uid);
    const legacySnapshot = await fetchLegacyCacheSnapshot(user.uid);
    const migratedSnapshot = existingSnapshot
      ? mergeSnapshots(existingSnapshot, legacySnapshot)
      : legacySnapshot;
    applySnapshot(migratedSnapshot, { fromCache: true });
    localMeta.hasStoredSnapshot = true;
    persistLocalState();
    setSyncStatus("loading", "Device data preserved · restarting conflict-safe sync");
    completeLegacyCacheMigration();
    return;
  }

  const localSnapshot = loadLocalSnapshot(user.uid);
  localMeta.hasStoredSnapshot = Boolean(localSnapshot);
  if (localSnapshot) applySnapshot(localSnapshot, { fromCache: true });
  else applySnapshot(emptySnapshot(user.uid), { fromCache: true });
  setSyncStatus(navigator.onLine ? "loading" : "offline", navigator.onLine ? "Checking Firebase" : "Using this device's saved data");
  await reconcileWithCloud(resolveConflict);
}

export function connectLocalUserData(session = getLastLocalSession()) {
  if (!session?.uid) return false;
  const localSnapshot = loadLocalSnapshot(session.uid);
  if (!localSnapshot) return false;

  disconnectUserData();
  state.user = {
    uid: session.uid,
    email: session.email || session.uid,
    offlineOnly: true
  };
  localMeta.hasStoredSnapshot = true;
  applySnapshot(localSnapshot, { fromCache: true });
  setSyncStatus("offline", "Opened this device's saved data");
  return true;
}

export async function synchronizeUserData(resolveConflict, { forcePrompt = true } = {}) {
  return reconcileWithCloud(resolveConflict, { forcePrompt });
}

export function disconnectUserData() {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  realtimeAttached = false;
  syncInFlight = null;
  state.user = null;
  state.weights = [];
  state.bodyEntries = [];
  state.calorieEntries = [];
  state.settings = { ...DEFAULT_SETTINGS };
  state.goals = { ...DEFAULT_GOALS };
  state.metadata = {
    weights: { fromCache: true, pending: false },
    bodyEntries: { fromCache: true, pending: false },
    calorieEntries: { fromCache: true, pending: false },
    settings: { fromCache: true, pending: false },
    goals: { fromCache: true, pending: false }
  };
  state.sync = { status: "idle", detail: "Not connected", lastSyncedAt: null };
  localMeta.settingsUpdatedAtMs = 0;
  localMeta.goalsUpdatedAtMs = 0;
  localMeta.tombstones = [];
  localMeta.hasStoredSnapshot = false;
  notify();
}

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

function shouldUseDeviceOnly() {
  return !navigator.onLine || Boolean(state.user?.offlineOnly);
}

function upsertLocalEntry(property, entry) {
  const id = entry.id ?? entry.date;
  state[property] = sortByDateDescending([
    entry,
    ...state[property].filter(item => (item.id ?? item.date) !== id)
  ]);
}

function removeTombstone(collectionName, documentId) {
  localMeta.tombstones = localMeta.tombstones.filter(item => !(item.collectionName === collectionName && item.documentId === documentId));
}

async function saveEntry(collectionName, entry) {
  const user = requireUser();
  const property = collectionProperty(collectionName);
  const now = Date.now();
  const id = entry.id ?? entry.date;
  const localEntry = { ...entry, id, updatedAtMs: now, pending: true };
  upsertLocalEntry(property, localEntry);
  removeTombstone(collectionName, id);
  state.metadata[property] = { fromCache: true, pending: true };
  persistLocalState();
  notify();

  if (shouldUseDeviceOnly()) {
    setSyncStatus("offline", "Saved on this device · cloud sync pending");
    return { queued: true };
  }

  const batch = writeBatch(db);
  batch.set(userDoc(user.uid, collectionName, id), entryToCloudData(collectionName, localEntry));
  batch.delete(userDoc(user.uid, TOMBSTONE_COLLECTION, tombstoneKey(collectionName, id)));
  await batch.commit();

  const current = state[property].find(item => (item.id ?? item.date) === id);
  if (current?.updatedAtMs === now) current.pending = false;
  state.metadata[property] = { fromCache: false, pending: state[property].some(item => item.pending) };
  persistLocalState();
  setSyncStatus("synced", "Saved to Firebase", new Date().toISOString());
  return { queued: false };
}

export function saveWeight({ date, weight }) {
  return saveEntry("weights", { date, weight: Number(weight) });
}

export function saveBodyComposition({ date, bodyFat, weight }) {
  return saveEntry("bodyComposition", { date, bodyFat: Number(bodyFat), weight: Number(weight) });
}

export function saveCalories({ date, mode, value }) {
  const numericValue = Number(value);
  return saveEntry("calories", {
    date,
    mode: mode === "weekly" ? "weekly" : "daily",
    value: numericValue,
    dailyAverage: numericValue
  });
}

export async function fetchNutriPilotWeeklyCalories() {
  const user = requireUser();
  if (shouldUseDeviceOnly()) {
    throw new Error("NutriPilot sync needs an online Firebase session.");
  }

  const currentWeekStart = startOfWeekString(currentDateString());
  const snapshot = await getDocsFromServer(foodTrackerCollection(user.uid, "reportCaches"));

  return snapshot.docs
    .map(normalizeNutriPilotWeeklyCache)
    .filter(Boolean)
    .filter(week => week.end < currentWeekStart)
    .filter(week => !hasCalorieEntryInWeek(week.start, week.end))
    .sort((a, b) => b.end.localeCompare(a.end));
}

export async function saveWeeklyCalorieEntries(entries) {
  const validEntries = (entries ?? [])
    .map(entry => ({
      date: entry.date,
      mode: "weekly",
      value: Number(entry.value)
    }))
    .filter(entry => entry.date && Number.isFinite(entry.value) && entry.value > 0);

  for (const entry of validEntries) {
    await saveCalories(entry);
  }

  return { imported: validEntries.length };
}

export async function saveGoals(goals) {
  const user = requireUser();
  const now = Date.now();
  state.goals = {
    targetBodyFat: goals.targetBodyFat == null || goals.targetBodyFat === "" ? null : Number(goals.targetBodyFat),
    targetWeight: goals.targetWeight == null || goals.targetWeight === "" ? null : Number(goals.targetWeight),
    dailyDeficit: Number(goals.dailyDeficit ?? 0),
    targetDate: goals.targetDate ?? ""
  };
  localMeta.goalsUpdatedAtMs = now;
  state.metadata.goals = { fromCache: true, pending: true };
  persistLocalState();
  notify();
  if (shouldUseDeviceOnly()) {
    setSyncStatus("offline", "Goal saved on this device · cloud sync pending");
    return { queued: true };
  }
  await setDoc(userDoc(user.uid, "goals", "current"), goalsToCloudData(state.goals, now));
  state.metadata.goals = { fromCache: false, pending: false };
  persistLocalState();
  setSyncStatus("synced", "Goal saved to Firebase", new Date().toISOString());
  return { queued: false };
}

export async function saveSettings(settings) {
  const user = requireUser();
  const now = Date.now();
  state.settings = migrateSettings(settings);
  localMeta.settingsUpdatedAtMs = now;
  state.metadata.settings = { fromCache: true, pending: true };
  persistLocalState();
  notify();
  if (shouldUseDeviceOnly()) {
    setSyncStatus("offline", "Settings saved on this device · cloud sync pending");
    return { queued: true };
  }
  await setDoc(userDoc(user.uid, "settings", "preferences"), settingsToCloudData(state.settings, now));
  state.metadata.settings = { fromCache: false, pending: false };
  persistLocalState();
  setSyncStatus("synced", "Settings saved to Firebase", new Date().toISOString());
  return { queued: false };
}

export async function deleteEntry(collectionName, id) {
  const user = requireUser();
  const property = collectionProperty(collectionName);
  const now = Date.now();
  state[property] = state[property].filter(entry => (entry.id ?? entry.date) !== id);
  localMeta.tombstones = [
    ...localMeta.tombstones.filter(item => !(item.collectionName === collectionName && item.documentId === id)),
    { collectionName, documentId: id, updatedAtMs: now, pending: true }
  ];
  state.metadata[property] = { fromCache: true, pending: true };
  persistLocalState();
  notify();

  if (shouldUseDeviceOnly()) {
    setSyncStatus("offline", "Deletion saved on this device · cloud sync pending");
    return { queued: true };
  }

  const batch = writeBatch(db);
  batch.delete(userDoc(user.uid, collectionName, id));
  batch.set(userDoc(user.uid, TOMBSTONE_COLLECTION, tombstoneKey(collectionName, id)), {
    collectionName,
    documentId: id,
    deletedAtMs: now,
    clientUpdatedAtMs: now,
    updatedAt: serverTimestamp()
  });
  await batch.commit();
  removeTombstone(collectionName, id);
  state.metadata[property] = { fromCache: false, pending: false };
  persistLocalState();
  setSyncStatus("synced", "Deletion synchronized", new Date().toISOString());
  return { queued: false };
}

export function hasPendingWrites() {
  return Boolean(
    state.weights.some(entry => entry.pending) ||
    state.bodyEntries.some(entry => entry.pending) ||
    state.calorieEntries.some(entry => entry.pending) ||
    state.metadata.settings.pending ||
    state.metadata.goals.pending ||
    localMeta.tombstones.length
  );
}

export function isUsingCacheOnly() {
  return ["offline", "loading", "conflict"].includes(state.sync.status);
}

export function exportState() {
  return {
    format: "calstat-backup",
    version: 3,
    exportedAt: new Date().toISOString(),
    weights: state.weights.map(({ date, weight }) => ({ date, weight })),
    bodyEntries: state.bodyEntries.map(({ date, bodyFat, weight }) => ({ date, bodyFat, weight })),
    calorieEntries: state.calorieEntries.map(({ date, mode, value, dailyAverage }) => ({ date, mode, value, dailyAverage })),
    settings: { ...state.settings },
    goals: { ...state.goals }
  };
}

export async function importState(backup) {
  requireUser();
  if (!backup || !["calstat-backup", "mass-track-backup"].includes(backup.format)) {
    throw new Error("This is not a valid CalStat backup.");
  }

  const now = Date.now();
  for (const entry of backup.weights ?? []) {
    if (!entry.date || !Number.isFinite(Number(entry.weight))) continue;
    upsertLocalEntry("weights", { id: entry.date, date: entry.date, weight: Number(entry.weight), updatedAtMs: now, pending: true });
  }
  for (const entry of backup.bodyEntries ?? []) {
    if (!entry.date || !Number.isFinite(Number(entry.bodyFat)) || !Number.isFinite(Number(entry.weight))) continue;
    upsertLocalEntry("bodyEntries", {
      id: entry.date,
      date: entry.date,
      bodyFat: Number(entry.bodyFat),
      weight: Number(entry.weight),
      updatedAtMs: now,
      pending: true
    });
  }
  for (const entry of backup.calorieEntries ?? []) {
    const value = Number(entry.value);
    if (!entry.date || !Number.isFinite(value)) continue;
    upsertLocalEntry("calorieEntries", {
      id: entry.date,
      date: entry.date,
      mode: entry.mode === "weekly" ? "weekly" : "daily",
      value,
      dailyAverage: Number.isFinite(Number(entry.dailyAverage)) ? Number(entry.dailyAverage) : value,
      updatedAtMs: now,
      pending: true
    });
  }
  if (backup.settings) {
    state.settings = migrateSettings({ ...DEFAULT_SETTINGS, ...backup.settings });
    localMeta.settingsUpdatedAtMs = now;
    state.metadata.settings.pending = true;
  }
  if (backup.goals) {
    state.goals = normalizeGoals({ ...DEFAULT_GOALS, ...backup.goals });
    localMeta.goalsUpdatedAtMs = now;
    state.metadata.goals.pending = true;
  }
  persistLocalState();
  notify();

  if (shouldUseDeviceOnly()) {
    setSyncStatus("offline", "Backup imported on this device · cloud sync pending");
    return;
  }
  await reconcileWithCloud(async () => "merge", { forcePrompt: false });
}
