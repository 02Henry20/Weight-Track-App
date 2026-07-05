const DAY_MS = 86400000;

function toDateString(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function buildTutorialData() {
  const today = new Date();
  const updatedBase = Date.now() - 70 * DAY_MS;
  const weights = [];
  const calorieEntries = [];
  const bodyEntries = [];

  for (let offset = 69; offset >= 0; offset -= 1) {
    const date = toDateString(addDays(today, -offset));
    const progress = (69 - offset) / 69;
    const trend = 74.3 - progress * 2.7;
    const wave = Math.sin(progress * Math.PI * 8) * 0.28 + Math.cos(progress * Math.PI * 5) * 0.12;
    if (offset % 2 === 0 || offset < 12 || offset % 5 === 0) {
      weights.push({
        id: date,
        date,
        weight: Math.round((trend + wave) * 10) / 10,
        updatedAtMs: updatedBase + (70 - offset) * DAY_MS,
        pending: false
      });
    }

    if (offset % 7 === 0) {
      const kcal = Math.round(2260 + Math.sin(progress * Math.PI * 7) * 110 + (progress < 0.22 ? 190 : 0));
      calorieEntries.push({
        id: date,
        date,
        mode: "weekly",
        value: kcal,
        dailyAverage: kcal,
        updatedAtMs: updatedBase + (70 - offset) * DAY_MS + 3000,
        pending: false
      });
    } else if (offset % 3 !== 1) {
      const kcal = Math.round(2180 + Math.sin(progress * Math.PI * 11) * 170 + (offset % 10 === 0 ? 260 : 0));
      calorieEntries.push({
        id: date,
        date,
        mode: "daily",
        value: kcal,
        dailyAverage: kcal,
        updatedAtMs: updatedBase + (70 - offset) * DAY_MS + 5000,
        pending: false
      });
    }

    if (offset % 9 === 0 || offset === 2) {
      const bodyFat = 17.3 - progress * 2.2 + Math.sin(progress * Math.PI * 4) * 0.18;
      const weight = 74.3 - progress * 2.7 + Math.cos(progress * Math.PI * 5) * 0.14;
      bodyEntries.push({
        id: date,
        date,
        bodyFat: Math.round(bodyFat * 10) / 10,
        weight: Math.round(weight * 10) / 10,
        updatedAtMs: updatedBase + (70 - offset) * DAY_MS + 7000,
        pending: false
      });
    }
  }

  weights.sort((a, b) => b.date.localeCompare(a.date));
  calorieEntries.sort((a, b) => b.date.localeCompare(a.date));
  bodyEntries.sort((a, b) => b.date.localeCompare(a.date));

  return {
    weights,
    bodyEntries,
    calorieEntries,
    settings: {
      theme: "dark",
      colorTheme: "ocean",
      animation: "on",
      heightCm: 171,
      referenceSex: "male",
      mapMetric: "ffmi",
      smoothingDays: 7,
      trendWindowDays: 35,
      maintenanceWindowDays: 28,
      predictionDays: 120,
      chartStartDate: "",
      chartScaleMode: "auto",
      chartWeightMin: "",
      chartWeightMax: "",
      energyDensityKcalPerKg: 7700,
      trendConfidenceView: "on"
    },
    goals: {
      targetWeight: 69.5,
      dailyDeficit: 350,
      targetDate: toDateString(addDays(today, 110))
    }
  };
}

export const tutorialData = buildTutorialData();
