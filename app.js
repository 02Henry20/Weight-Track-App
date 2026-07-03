const DB_NAME = "weight-tracker-db";
const DB_VERSION = 1;
const STORE_NAME = "weights";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("date", "date", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function addWeight(entry) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).add(entry);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function getWeights() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .getAll();

    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

function getTodayString() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(date);
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
      const registration = await navigator.serviceWorker.register(
        "./service-worker.js",
        { updateViaCache: "none" }
      );

      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdate(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;

        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdate(worker);
          }
        });
      });

      // Ask for a fresh update check whenever the app is opened.
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

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return;
  try {
    await navigator.storage.persist();
  } catch (error) {
    console.warn("Persistent storage request was not granted:", error);
  }
}

const form = document.querySelector("#weight-form");
const weightInput = document.querySelector("#weight");
const dateInput = document.querySelector("#date");
const message = document.querySelector("#form-message");
const list = document.querySelector("#weight-list");
const emptyState = document.querySelector("#empty-state");
const entryCount = document.querySelector("#entry-count");

async function renderWeights() {
  try {
    const entries = await getWeights();
    entries.sort((a, b) =>
      b.date.localeCompare(a.date) ||
      (b.createdAt ?? 0) - (a.createdAt ?? 0)
    );

    list.replaceChildren();
    emptyState.hidden = entries.length > 0;
    entryCount.textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;

    for (const entry of entries) {
      const item = document.createElement("li");
      item.className = "weight-item";

      const date = document.createElement("span");
      date.className = "weight-date";
      date.textContent = formatDate(entry.date);

      const value = document.createElement("strong");
      value.className = "weight-value";
      value.textContent = `${Number(entry.weight).toFixed(1)} kg`;

      item.append(date, value);
      list.append(item);
    }
  } catch (error) {
    console.error(error);
    message.textContent = "Could not read the local database.";
    message.classList.add("error");
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  message.textContent = "";
  message.classList.remove("error");

  const weight = Number(weightInput.value);
  const date = dateInput.value;

  if (!Number.isFinite(weight) || weight < 20 || weight > 500 || !date) {
    message.textContent = "Enter a valid date and a weight between 20 and 500 kg.";
    message.classList.add("error");
    return;
  }

  try {
    await addWeight({
      weight,
      date,
      createdAt: Date.now()
    });
    weightInput.value = "";
    message.textContent = "Weight saved locally.";
    await renderWeights();
    weightInput.focus();
  } catch (error) {
    console.error(error);
    message.textContent = "Saving failed.";
    message.classList.add("error");
  }
});

dateInput.value = getTodayString();
setupServiceWorker();
requestPersistentStorage();
renderWeights();
