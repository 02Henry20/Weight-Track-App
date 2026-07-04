const DAY_MS = 86_400_000;

export function parseDate(dateString) {
  return new Date(`${dateString}T00:00:00`);
}

export function toDateString(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function todayString() {
  return toDateString(new Date());
}

export function addDays(dateString, days) {
  const date = parseDate(dateString);
  date.setDate(date.getDate() + days);
  return toDateString(date);
}

export function daysBetween(startDate, endDate) {
  return Math.round((parseDate(endDate) - parseDate(startDate)) / DAY_MS);
}

export function formatShortDate(dateString) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(parseDate(dateString));
}

export function formatLongDate(dateString) {
  if (!dateString) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(parseDate(dateString));
}

export function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mean(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  const average = mean(valid);
  return Math.sqrt(valid.reduce((sum, value) => sum + (value - average) ** 2, 0) / (valid.length - 1));
}

function chronologicalWeights(weights) {
  return weights
    .filter(entry => entry.date && Number.isFinite(Number(entry.weight)))
    .map(entry => ({ ...entry, weight: Number(entry.weight) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function movingAverage(weights, windowDays) {
  const entries = chronologicalWeights(weights);
  const window = Math.max(1, Number(windowDays) || 1);

  return entries.map((entry, index) => {
    const startDate = addDays(entry.date, -(window - 1));
    const values = [];

    for (let cursor = index; cursor >= 0; cursor -= 1) {
      if (entries[cursor].date < startDate) break;
      values.push(entries[cursor].weight);
    }

    return {
      date: entry.date,
      value: mean(values),
      count: values.length
    };
  });
}

export function linearRegression(points) {
  const valid = points
    .filter(point => point.date && Number.isFinite(Number(point.value)))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (valid.length < 2) return null;

  const firstDate = valid[0].date;
  const xs = valid.map(point => daysBetween(firstDate, point.date));
  const ys = valid.map(point => Number(point.value));
  const xMean = mean(xs);
  const yMean = mean(ys);
  const sxx = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);

  if (sxx === 0) return null;

  const slope = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0) / sxx;
  const intercept = yMean - slope * xMean;
  const predicted = xs.map(x => intercept + slope * x);
  const ssResidual = ys.reduce((sum, y, index) => sum + (y - predicted[index]) ** 2, 0);
  const ssTotal = ys.reduce((sum, y) => sum + (y - yMean) ** 2, 0);
  const r2 = ssTotal === 0 ? 1 : clamp(1 - ssResidual / ssTotal, 0, 1);
  const residualVariance = valid.length > 2 ? ssResidual / (valid.length - 2) : 0;
  const slopeStandardError = valid.length > 2 ? Math.sqrt(residualVariance / sxx) : 0;

  return {
    firstDate,
    slope,
    intercept,
    r2,
    slopeStandardError,
    count: valid.length,
    spanDays: daysBetween(valid[0].date, valid.at(-1).date),
    predict(dateString) {
      return intercept + slope * daysBetween(firstDate, dateString);
    }
  };
}

export function weeklyAverages(weights) {
  const entries = chronologicalWeights(weights);
  const groups = new Map();

  for (const entry of entries) {
    const date = parseDate(entry.date);
    const day = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - day);
    const monday = toDateString(date);
    if (!groups.has(monday)) groups.set(monday, []);
    groups.get(monday).push(entry.weight);
  }

  return [...groups.entries()]
    .map(([date, values]) => ({ date, value: mean(values), count: values.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function analyseWeight(weights, settings) {
  const raw = chronologicalWeights(weights);
  const smoothingDays = Number(settings.smoothingDays) || 1;
  const smoothed = movingAverage(raw, smoothingDays);

  if (!raw.length) {
    return {
      raw,
      smoothed,
      chartRaw: [],
      chartSmoothed: [],
      forecast: [],
      regression: null,
      current: null,
      latestRaw: null,
      previousRaw: null,
      average7: null,
      weeklyRate: null,
      projectedWeight: null,
      projectedDate: null,
      weekly: [],
      trendConfidence: {
        dataSufficiencyScore: 0,
        volatilityScore: null,
        volatilityKg: null,
        volatilityLabel: "No data",
        measurementCount: 0,
        spanDays: 0
      }
    };
  }

  const latestDate = raw.at(-1).date;
  const chartRangeDays = Number(settings.chartRangeDays) || 0;
  const configuredChartStart = typeof settings.chartStartDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(settings.chartStartDate)
    ? settings.chartStartDate
    : "";
  const chartStart = configuredChartStart || (chartRangeDays > 0 ? addDays(latestDate, -chartRangeDays) : raw[0].date);
  const trendWindowDays = Number(settings.trendWindowDays) || 28;
  const trendStart = addDays(latestDate, -trendWindowDays);
  const trendSource = smoothed.filter(point => point.date >= trendStart);
  const rawTrendSource = raw.filter(point => point.date >= trendStart);
  const regression = linearRegression(trendSource);
  const predictionDays = Math.max(1, Math.round(
    Number(settings.predictionDays) || (Number(settings.predictionMonths) || 3) * 30.4375
  ));
  const projectedDate = addDays(latestDate, Math.round(predictionDays));
  const forecast = [];

  if (regression) {
    forecast.push({ date: latestDate, value: regression.predict(latestDate) });
    for (let days = 7; days < predictionDays; days += 7) {
      const date = addDays(latestDate, days);
      forecast.push({ date, value: regression.predict(date) });
    }
    forecast.push({ date: projectedDate, value: regression.predict(projectedDate) });
  }

  const average7Start = addDays(latestDate, -6);
  const average7 = mean(raw.filter(entry => entry.date >= average7Start).map(entry => entry.weight));

  const measurementCount = rawTrendSource.length;
  const spanDays = measurementCount >= 2
    ? Math.max(1, daysBetween(rawTrendSource[0].date, rawTrendSource.at(-1).date))
    : 0;
  const countTarget = Math.max(7, Math.ceil(trendWindowDays * 0.55));
  const countScore = clamp(measurementCount / countTarget, 0, 1);
  const spanScore = clamp(spanDays / Math.max(7, trendWindowDays * 0.8), 0, 1);
  const consistencyScore = spanDays > 0
    ? clamp((measurementCount / (spanDays + 1)) / 0.65, 0, 1)
    : measurementCount > 0 ? 0.15 : 0;
  const dataSufficiencyScore = Math.round((countScore * 0.5 + spanScore * 0.3 + consistencyScore * 0.2) * 100);

  let volatilityKg = null;
  let volatilityScore = null;
  let volatilityLabel = "Needs more data";
  if (regression && rawTrendSource.length >= 3) {
    const residuals = rawTrendSource.map(entry => entry.weight - regression.predict(entry.date));
    const dailyChanges = [];
    for (let index = 1; index < rawTrendSource.length; index += 1) {
      const dayGap = Math.max(1, daysBetween(rawTrendSource[index - 1].date, rawTrendSource[index].date));
      dailyChanges.push((rawTrendSource[index].weight - rawTrendSource[index - 1].weight) / Math.sqrt(dayGap));
    }
    const residualNoise = standardDeviation(residuals);
    const changeNoise = standardDeviation(dailyChanges);
    volatilityKg = residualNoise;
    const combinedNoise = residualNoise * 0.72 + changeNoise * 0.28;
    volatilityScore = Math.round(clamp(combinedNoise / 0.75, 0, 1) * 100);
    volatilityLabel = volatilityScore < 28 ? "Low" : volatilityScore < 58 ? "Moderate" : "High";
  }

  return {
    raw,
    smoothed,
    chartRaw: raw.filter(point => point.date >= chartStart),
    chartSmoothed: smoothed.filter(point => point.date >= chartStart),
    forecast,
    regression,
    current: smoothed.at(-1)?.value ?? raw.at(-1).weight,
    latestRaw: raw.at(-1),
    previousRaw: raw.at(-2) ?? null,
    average7,
    weeklyRate: regression ? regression.slope * 7 : null,
    projectedWeight: regression ? regression.predict(projectedDate) : null,
    projectedDate,
    weekly: weeklyAverages(raw),
    trendConfidence: {
      dataSufficiencyScore,
      volatilityScore,
      volatilityKg,
      volatilityLabel,
      measurementCount,
      spanDays
    }
  };
}

function regressionRateForRange(smoothed, startDate, endDate) {
  const points = smoothed.filter(point => point.date >= startDate && point.date <= endDate);
  const regression = linearRegression(points);
  return regression ? regression.slope * 7 : null;
}

export function analyseDietPhase(weightAnalysis, maintenanceAnalysis) {
  const currentWeight = weightAnalysis.current;
  const latestDate = weightAnalysis.latestRaw?.date;
  const weeklyRate = weightAnalysis.weeklyRate;
  const sufficiency = weightAnalysis.trendConfidence?.dataSufficiencyScore ?? 0;

  if (currentWeight == null || latestDate == null || weeklyRate == null) {
    return {
      key: "maintain",
      label: "Maintain",
      confidence: "low",
      description: "More weight data is needed before the current phase can be estimated.",
      relativeWeeklyRate: null
    };
  }

  const recentStart = addDays(latestDate, -10);
  const priorStart = addDays(latestDate, -38);
  const priorEnd = addDays(latestDate, -11);
  const recentRate = regressionRateForRange(weightAnalysis.smoothed, recentStart, latestDate) ?? weeklyRate;
  const priorRate = regressionRateForRange(weightAnalysis.smoothed, priorStart, priorEnd);
  const relativeWeeklyRate = currentWeight > 0 ? recentRate / currentWeight * 100 : 0;
  const priorReferenceWeight = weightAnalysis.smoothed.find(point => point.date >= priorStart)?.value ?? currentWeight;
  const priorRelativeRate = priorRate == null || priorReferenceWeight <= 0 ? null : priorRate / priorReferenceWeight * 100;

  const maintenance = maintenanceAnalysis.current?.estimate;
  const averageIntake = maintenanceAnalysis.current?.averageIntake;
  const calorieCoverage = maintenanceAnalysis.current?.calorieCoverage ?? 0;
  const energyGap = Number.isFinite(maintenance) && Number.isFinite(averageIntake)
    ? averageIntake - maintenance
    : null;
  const calorieTimeline = maintenanceAnalysis.calorieTimeline ?? [];
  const recentCalories = calorieTimeline.filter(entry => entry.date >= recentStart && entry.date <= latestDate).map(entry => entry.value);
  const priorCalories = calorieTimeline.filter(entry => entry.date >= priorStart && entry.date <= priorEnd).map(entry => entry.value);
  const recentCalorieAverage = mean(recentCalories);
  const priorCalorieAverage = mean(priorCalories);
  const calorieIncrease = recentCalorieAverage != null && priorCalorieAverage != null
    ? recentCalorieAverage - priorCalorieAverage
    : null;
  const recentCalorieCoverage = recentCalories.length / 11;
  const nearMaintenance = energyGap != null && Math.abs(energyGap) <= 175;
  const stableNow = Math.abs(relativeWeeklyRate) < 0.09;
  const priorCut = priorRelativeRate != null && priorRelativeRate <= -0.12;
  const priorBulk = priorRelativeRate != null && priorRelativeRate >= 0.10;
  const confidence = sufficiency >= 72 ? "high" : sufficiency >= 45 ? "medium" : "low";

  if (
    priorCut
    && stableNow
    && recentCalorieCoverage >= 0.45
    && (nearMaintenance || (calorieIncrease != null && calorieIncrease >= 125))
  ) {
    return {
      key: "diet-break",
      label: "Diet break",
      confidence,
      description: "Weight loss has paused while recent intake moved back toward maintenance after a cutting trend.",
      relativeWeeklyRate
    };
  }

  if ((priorCut || priorBulk) && stableNow && (!nearMaintenance || calorieCoverage < 0.45)) {
    return {
      key: "deload",
      label: "Deload",
      confidence: "low",
      description: "A recent gaining or losing phase has paused. This is only a recovery-pattern estimate because training load is not tracked.",
      relativeWeeklyRate
    };
  }

  if (relativeWeeklyRate <= -0.10 || (energyGap != null && energyGap <= -175)) {
    return {
      key: "cut",
      label: "Cut",
      confidence,
      description: "The recent weight trend and energy balance indicate a calorie-deficit phase.",
      relativeWeeklyRate
    };
  }

  if (relativeWeeklyRate >= 0.09 || (energyGap != null && energyGap >= 175)) {
    return {
      key: "bulk",
      label: "Bulk",
      confidence,
      description: "The recent weight trend and energy balance indicate a calorie-surplus phase.",
      relativeWeeklyRate
    };
  }

  return {
    key: "maintain",
    label: "Maintain",
    confidence,
    description: "Recent weight velocity is close to stable and intake is not clearly above or below maintenance.",
    relativeWeeklyRate
  };
}

export function buildCalorieTimeline(entries) {
  const timeline = new Map();
  const sorted = entries
    .filter(entry => entry.date && Number.isFinite(Number(entry.value)))
    .map(entry => ({ ...entry, value: Number(entry.value) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Weekly entries store a kcal/day average and apply it to the seven days ending on the selected date.
  for (const entry of sorted.filter(item => item.mode === "weekly")) {
    const dailyAverage = Number.isFinite(Number(entry.dailyAverage))
      ? Number(entry.dailyAverage)
      : entry.value;
    for (let offset = 6; offset >= 0; offset -= 1) {
      timeline.set(addDays(entry.date, -offset), {
        date: addDays(entry.date, -offset),
        value: dailyAverage,
        source: "weekly",
        sourceDate: entry.date
      });
    }
  }

  // Explicit daily values take precedence over a weekly average.
  for (const entry of sorted.filter(item => item.mode !== "weekly")) {
    timeline.set(entry.date, {
      date: entry.date,
      value: Number.isFinite(Number(entry.dailyAverage)) ? Number(entry.dailyAverage) : entry.value,
      source: "daily",
      sourceDate: entry.date
    });
  }

  return [...timeline.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function estimateMaintenanceAt(endDate, weights, calorieTimeline, settings) {
  const windowDays = Math.max(7, Number(settings.maintenanceWindowDays) || 28);
  const startDate = addDays(endDate, -(windowDays - 1));
  const rawWindow = chronologicalWeights(weights).filter(entry => entry.date >= startDate && entry.date <= endDate);
  const smoothedWindow = movingAverage(rawWindow, Number(settings.smoothingDays) || 1);
  const regression = linearRegression(smoothedWindow);
  const calories = calorieTimeline.filter(entry => entry.date >= startDate && entry.date <= endDate);
  const calorieValues = calories.map(entry => entry.value);
  const averageIntake = mean(calorieValues);
  const calorieCoverage = calorieValues.length / windowDays;
  const energyDensity = Number(settings.energyDensityKcalPerKg) || 7700;

  if (!regression || rawWindow.length < 4 || calorieValues.length < 4 || averageIntake == null) {
    return {
      date: endDate,
      estimate: null,
      averageIntake,
      calorieCoverage,
      weightCount: rawWindow.length,
      regression,
      confidenceScore: 0,
      confidence: "low",
      uncertainty: null
    };
  }

  const estimate = averageIntake - regression.slope * energyDensity;
  const countScore = clamp(rawWindow.length / Math.max(8, windowDays * 0.6), 0, 1);
  const coverageScore = clamp(calorieCoverage, 0, 1);
  const spanScore = clamp(regression.spanDays / Math.max(14, windowDays * 0.75), 0, 1);
  const fitScore = clamp((regression.r2 + 0.25) / 1.25, 0, 1);
  const confidenceScore = Math.round((countScore * 0.3 + coverageScore * 0.35 + spanScore * 0.2 + fitScore * 0.15) * 100);
  const confidence = confidenceScore >= 75 ? "high" : confidenceScore >= 48 ? "medium" : "low";
  const intakeUncertainty = calorieValues.length > 1
    ? 1.96 * standardDeviation(calorieValues) / Math.sqrt(calorieValues.length)
    : 0;
  const slopeUncertainty = 1.96 * regression.slopeStandardError * energyDensity;
  const uncertainty = Math.max(50, Math.sqrt(intakeUncertainty ** 2 + slopeUncertainty ** 2));

  return {
    date: endDate,
    estimate,
    averageIntake,
    calorieCoverage,
    weightCount: rawWindow.length,
    regression,
    confidenceScore,
    confidence,
    uncertainty
  };
}

export function analyseMaintenance(weights, calorieEntries, settings) {
  const rawWeights = chronologicalWeights(weights);
  const calorieTimeline = buildCalorieTimeline(calorieEntries);

  if (!rawWeights.length) {
    return {
      current: null,
      rolling: [],
      calorieTimeline,
      qualityScore: 0
    };
  }

  const current = estimateMaintenanceAt(rawWeights.at(-1).date, rawWeights, calorieTimeline, settings);
  const rolling = [];
  const firstPossibleDate = addDays(rawWeights[0].date, Math.max(7, Number(settings.maintenanceWindowDays) || 28) - 1);
  const endDate = rawWeights.at(-1).date;

  for (let date = firstPossibleDate; date <= endDate; date = addDays(date, 7)) {
    const estimate = estimateMaintenanceAt(date, rawWeights, calorieTimeline, settings);
    if (estimate.estimate != null) rolling.push(estimate);
  }

  if (rolling.length && rolling.at(-1).date !== endDate && current.estimate != null) {
    rolling.push(current);
  }

  return {
    current,
    rolling,
    calorieTimeline,
    qualityScore: current.confidenceScore ?? 0
  };
}

export function findBestMaintenanceWindow(weights, calorieEntries, settings = {}) {
  const candidates = [14, 21, 28, 35, 42, 56, 70, 90, 120, 180];
  const rawWeights = chronologicalWeights(weights);
  const latestDate = rawWeights.at(-1)?.date;
  if (!latestDate) return null;

  return candidates.reduce((best, windowDays) => {
    const analysis = analyseMaintenance(weights, calorieEntries, { ...settings, maintenanceWindowDays: windowDays });
    const current = analysis.current;
    if (!current || current.estimate == null) return best;

    const uncertaintyPenalty = current.uncertainty == null ? 1 : clamp(current.uncertainty / 600, 0, 1);
    const measurementScore = clamp(current.weightCount / Math.max(6, windowDays * 0.45), 0, 1);
    const coverageScore = clamp(current.calorieCoverage, 0, 1);
    const score = Math.round(
      (current.confidenceScore * 0.52)
      + (coverageScore * 26)
      + (measurementScore * 14)
      - (uncertaintyPenalty * 12)
    );

    const candidate = {
      windowDays,
      score,
      estimate: current.estimate,
      confidenceScore: current.confidenceScore,
      calorieCoverage: current.calorieCoverage,
      weightCount: current.weightCount,
      uncertainty: current.uncertainty
    };
    return !best || candidate.score > best.score ? candidate : best;
  }, null);
}

export function findBestTrendWindow(weights, settings = {}) {
  const candidates = [7, 10, 14, 21, 28, 35, 42, 56, 70, 90, 120, 180];

  return candidates.reduce((best, windowDays) => {
    const analysis = analyseWeight(weights, { ...settings, trendWindowDays: windowDays });
    const confidence = analysis.trendConfidence;
    if (!analysis.regression || !confidence || confidence.measurementCount < 3) return best;

    const volatilityCalm = 100 - confidence.volatilityScore;
    const spanScore = clamp(confidence.spanDays / Math.max(7, windowDays * 0.55), 0, 1) * 100;
    const score = Math.round(
      confidence.dataSufficiencyScore * 0.42
      + volatilityCalm * 0.38
      + spanScore * 0.2
    );

    const candidate = {
      windowDays,
      score,
      dataSufficiencyScore: confidence.dataSufficiencyScore,
      volatilityScore: confidence.volatilityScore,
      volatilityKg: confidence.volatilityKg,
      measurementCount: confidence.measurementCount
    };
    return !best || candidate.score > best.score ? candidate : best;
  }, null);
}

export function bmiCategory(bmi) {
  if (!Number.isFinite(bmi)) return "No value";
  if (bmi < 18.5) return "Underweight range";
  if (bmi < 25) return "Healthy-weight range";
  if (bmi < 30) return "Overweight range";
  if (bmi < 35) return "Obesity class I range";
  if (bmi < 40) return "Obesity class II range";
  return "Obesity class III range";
}

export function bodyFatCategory(bodyFat, referenceSex) {
  if (!Number.isFinite(bodyFat)) return "No value";

  if (referenceSex === "female") {
    if (bodyFat < 14) return "Essential-fat range";
    if (bodyFat <= 20) return "Athletic range";
    if (bodyFat <= 24) return "Fitness range";
    if (bodyFat <= 31) return "Average range";
    return "High body-fat range";
  }

  if (bodyFat < 6) return "Essential-fat range";
  if (bodyFat <= 13) return "Athletic range";
  if (bodyFat <= 17) return "Fitness range";
  if (bodyFat <= 24) return "Average range";
  return "High body-fat range";
}

export function ffmiCategory(ffmi, referenceSex) {
  if (!Number.isFinite(ffmi)) return "No value";
  const bands = referenceSex === "female"
    ? [14, 16, 18, 20, 22]
    : [16, 18, 20, 22, 25];
  const labels = ["Below reference", "Average", "Above average", "Athletic", "Highly muscular", "Exceptional"];
  const index = bands.findIndex(limit => ffmi < limit);
  return labels[index === -1 ? labels.length - 1 : index];
}

export function analyseBody(bodyEntries, weights, settings) {
  const entries = bodyEntries
    .filter(entry => entry.date && Number.isFinite(Number(entry.bodyFat)) && Number.isFinite(Number(entry.weight)))
    .map(entry => ({ ...entry, bodyFat: Number(entry.bodyFat), weight: Number(entry.weight) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const heightM = Number(settings.heightCm) / 100;
  const latest = entries.at(-1) ?? null;

  const series = entries.map(entry => {
    const fatMass = entry.weight * entry.bodyFat / 100;
    const leanMass = entry.weight - fatMass;
    const bmi = heightM > 0 ? entry.weight / heightM ** 2 : null;
    const ffmi = heightM > 0 ? leanMass / heightM ** 2 : null;
    const normalizedFfmi = ffmi == null ? null : ffmi + 6.3 * (1.8 - heightM);
    return {
      ...entry,
      fatMass,
      leanMass,
      bmi,
      ffmi,
      normalizedFfmi
    };
  });

  const latestCalculated = series.at(-1) ?? null;
  const latestDailyWeight = chronologicalWeights(weights).at(-1)?.weight ?? null;
  const currentBmi = latestCalculated?.bmi
    ?? (heightM > 0 && latestDailyWeight != null ? latestDailyWeight / heightM ** 2 : null);

  return {
    entries: series,
    latest: latestCalculated,
    currentBmi,
    bmiCategory: bmiCategory(currentBmi),
    bodyFatCategory: bodyFatCategory(latestCalculated?.bodyFat, settings.referenceSex),
    ffmiCategory: ffmiCategory(latestCalculated?.normalizedFfmi, settings.referenceSex)
  };
}

export function analyseGoals(weightAnalysis, maintenanceAnalysis, goals) {
  const targetWeight = Number(goals.targetWeight);
  const currentWeight = weightAnalysis.current;
  const initialWeight = weightAnalysis.raw[0]?.weight ?? null;
  const slope = weightAnalysis.regression?.slope ?? null;
  const validTarget = Number.isFinite(targetWeight) && targetWeight > 0;

  if (!validTarget || currentWeight == null) {
    return {
      targetWeight: null,
      progress: null,
      difference: null,
      etaDays: null,
      etaDate: null,
      suggestedIntake: null
    };
  }

  const difference = targetWeight - currentWeight;
  let progress = null;

  if (initialWeight != null && Math.abs(targetWeight - initialWeight) > 0.01) {
    progress = targetWeight < initialWeight
      ? (initialWeight - currentWeight) / (initialWeight - targetWeight)
      : (currentWeight - initialWeight) / (targetWeight - initialWeight);
    progress = clamp(progress, 0, 1);
  }

  let etaDays = null;
  let etaDate = null;

  if (slope != null && Math.abs(slope) > 0.001 && Math.sign(difference) === Math.sign(slope)) {
    etaDays = Math.max(0, difference / slope);
    if (etaDays <= 3650) etaDate = addDays(weightAnalysis.latestRaw.date, Math.round(etaDays));
  }

  const maintenance = maintenanceAnalysis.current?.estimate;
  const deficit = Number(goals.dailyDeficit) || 0;
  const suggestedIntake = Number.isFinite(maintenance) ? maintenance - deficit : null;

  return {
    targetWeight,
    progress,
    difference,
    etaDays,
    etaDate,
    suggestedIntake
  };
}

export function buildInsight(weightAnalysis, maintenanceAnalysis, bodyAnalysis, goalsAnalysis) {
  if (weightAnalysis.raw.length < 2) {
    return {
      title: "Build your baseline",
      text: "Log weight regularly. A week of measurements reveals the first useful average; several weeks produce a more stable trend.",
      confidence: "No data"
    };
  }

  if (maintenanceAnalysis.current?.estimate != null) {
    const trend = weightAnalysis.weeklyRate;
    const direction = trend < -0.03 ? "down" : trend > 0.03 ? "up" : "stable";
    return {
      title: `Weight trend is ${direction}`,
      text: `Your current model estimates maintenance near ${Math.round(maintenanceAnalysis.current.estimate)} kcal/day and a weight velocity of ${trend >= 0 ? "+" : ""}${round(trend, 2)} kg/week. Keep calorie coverage high to strengthen the estimate.`,
      confidence: `${maintenanceAnalysis.current.confidence} confidence`
    };
  }

  if (bodyAnalysis.latest) {
    return {
      title: "Composition baseline captured",
      text: `The latest body-composition entry estimates ${round(bodyAnalysis.latest.leanMass, 1)} kg lean mass and ${round(bodyAnalysis.latest.fatMass, 1)} kg fat mass. Add repeated readings under similar conditions to interpret the trend rather than individual readings.`,
      confidence: "Developing"
    };
  }

  if (goalsAnalysis.targetWeight != null) {
    return {
      title: "Goal is active",
      text: "Your target is saved. Add calorie and body-composition entries to connect weight change with intake and lean-mass development.",
      confidence: "Developing"
    };
  }

  return {
    title: "Weight trend detected",
    text: `Your recent rate is ${weightAnalysis.weeklyRate >= 0 ? "+" : ""}${round(weightAnalysis.weeklyRate, 2)} kg/week. Calorie entries are required before maintenance can be estimated.`,
    confidence: "Trend only"
  };
}
