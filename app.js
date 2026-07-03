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
const latestWeight = document.querySelector("#latest-weight");
const averageWeight = document.querySelector("#average-weight");
const totalChange = document.querySelector("#total-change");
const chart = document.querySelector("#weight-chart");
const chartEmpty = document.querySelector("#chart-empty");

async function deleteWeight(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
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

function updateSummary(entries) {
  if (entries.length === 0) {
    latestWeight.textContent = "—";
    averageWeight.textContent = "—";
    totalChange.textContent = "—";
    return;
  }

  const chronological = [...entries].sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.createdAt ?? 0) - (b.createdAt ?? 0)
  );

  const first = Number(chronological[0].weight);
  const latest = Number(chronological.at(-1).weight);
  const average = chronological.reduce((sum, entry) => sum + Number(entry.weight), 0)
    / chronological.length;
  const change = latest - first;

  latestWeight.textContent = `${latest.toFixed(1)} kg`;
  averageWeight.textContent = `${average.toFixed(1)} kg`;
  totalChange.textContent = `${change > 0 ? "+" : ""}${change.toFixed(1)} kg`;
}

function renderChart(entries) {
  const chronological = [...entries].sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.createdAt ?? 0) - (b.createdAt ?? 0)
  );

  if (chronological.length < 2) {
    chart.hidden = true;
    chartEmpty.hidden = false;
    chart.replaceChildren();
    return;
  }

  chart.hidden = false;
  chartEmpty.hidden = true;
  chart.replaceChildren();

  const width = 600;
  const height = 220;
  const padding = { left: 54, right: 20, top: 18, bottom: 38 };
  const values = chronological.map(entry => Number(entry.weight));
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const margin = Math.max((max - min) * 0.12, 0.5);
  min -= margin;
  max += margin;

  const x = index =>
    padding.left + index * (width - padding.left - padding.right) / (values.length - 1);
  const y = value =>
    padding.top + (max - value) * (height - padding.top - padding.bottom) / (max - min);

  const svgNS = "http://www.w3.org/2000/svg";

  for (let i = 0; i < 3; i++) {
    const gy = padding.top + i * (height - padding.top - padding.bottom) / 2;
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", padding.left);
    line.setAttribute("x2", width - padding.right);
    line.setAttribute("y1", gy);
    line.setAttribute("y2", gy);
    line.setAttribute("class", "chart-grid");
    chart.append(line);

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", 4);
    label.setAttribute("y", gy + 7);
    label.setAttribute("class", "chart-label");
    label.textContent = (max - i * (max - min) / 2).toFixed(1);
    chart.append(label);
  }

  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const polyline = document.createElementNS(svgNS, "polyline");
  polyline.setAttribute("points", points);
  polyline.setAttribute("class", "chart-line");
  chart.append(polyline);

  values.forEach((value, index) => {
    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("cx", x(index));
    dot.setAttribute("cy", y(value));
    dot.setAttribute("r", 7);
    dot.setAttribute("class", "chart-dot");
    chart.append(dot);
  });

  const firstLabel = document.createElementNS(svgNS, "text");
  firstLabel.setAttribute("x", padding.left);
  firstLabel.setAttribute("y", height - 8);
  firstLabel.setAttribute("class", "chart-label");
  firstLabel.textContent = chronological[0].date.slice(5);
  chart.append(firstLabel);

  const lastLabel = document.createElementNS(svgNS, "text");
  lastLabel.setAttribute("x", width - padding.right);
  lastLabel.setAttribute("y", height - 8);
  lastLabel.setAttribute("text-anchor", "end");
  lastLabel.setAttribute("class", "chart-label");
  lastLabel.textContent = chronological.at(-1).date.slice(5);
  chart.append(lastLabel);
}

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

    updateSummary(entries);
    renderChart(entries);

    for (const entry of entries) {
      const item = document.createElement("li");
      item.className = "weight-item";

      const info = document.createElement("div");
      const value = document.createElement("div");
      value.className = "weight-value";
      value.textContent = `${Number(entry.weight).toFixed(1)} kg`;
      const date = document.createElement("div");
      date.className = "weight-date";
      date.textContent = formatDate(entry.date);
      info.append(value, date);

      const actions = document.createElement("div");
      actions.className = "entry-actions";
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete-button";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", async () => {
        const confirmed = window.confirm(
          `Delete ${Number(entry.weight).toFixed(1)} kg from ${formatDate(entry.date)}?`
        );
        if (!confirmed) return;
        await deleteWeight(entry.id);
        await renderWeights();
      });
      actions.append(deleteButton);

      item.append(info, actions);
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
