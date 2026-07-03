import { clamp, formatShortDate, round } from "./calculations.js";

const COLORS = {
  grid: "rgba(142, 161, 185, 0.13)",
  text: "rgba(185, 199, 216, 0.78)",
  blue: "#2f87ff",
  blueSoft: "rgba(47, 135, 255, 0.18)",
  cyan: "#32d7e8",
  green: "#35d07f",
  yellow: "#f0bb45",
  red: "#ff5a6f",
  purple: "#9475ff",
  muted: "#8ea1b9",
  white: "#f4f8ff"
};

function refreshColors() {
  const styles = getComputedStyle(document.documentElement);
  COLORS.grid = styles.getPropertyValue("--chart-grid").trim() || COLORS.grid;
  COLORS.text = styles.getPropertyValue("--chart-text").trim() || COLORS.text;
  COLORS.blue = styles.getPropertyValue("--blue").trim() || COLORS.blue;
  COLORS.cyan = styles.getPropertyValue("--cyan").trim() || COLORS.cyan;
  COLORS.green = styles.getPropertyValue("--green").trim() || COLORS.green;
  COLORS.yellow = styles.getPropertyValue("--yellow").trim() || COLORS.yellow;
  COLORS.red = styles.getPropertyValue("--red").trim() || COLORS.red;
  COLORS.purple = styles.getPropertyValue("--purple").trim() || COLORS.purple;
  COLORS.muted = styles.getPropertyValue("--muted").trim() || COLORS.muted;
  COLORS.white = styles.getPropertyValue("--text").trim() || COLORS.white;
}

function prepareCanvas(canvas) {
  refreshColors();
  const rectangle = canvas.getBoundingClientRect();
  const width = Math.max(260, rectangle.width || canvas.parentElement?.clientWidth || 600);
  const height = Math.max(210, rectangle.height || canvas.parentElement?.clientHeight || 300);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineCap = "round";
  context.lineJoin = "round";

  return { context, width, height };
}

function valueExtent(values, paddingRatio = 0.12, minimumPadding = 0.5) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return [0, 1];
  let min = Math.min(...valid);
  let max = Math.max(...valid);
  if (min === max) {
    min -= minimumPadding;
    max += minimumPadding;
  }
  const padding = Math.max((max - min) * paddingRatio, minimumPadding);
  return [min - padding, max + padding];
}

function dateExtent(series) {
  const timestamps = series
    .flat()
    .filter(point => point?.date)
    .map(point => new Date(`${point.date}T00:00:00`).getTime());
  if (!timestamps.length) return [Date.now(), Date.now() + 86_400_000];
  let min = Math.min(...timestamps);
  let max = Math.max(...timestamps);
  if (min === max) max += 86_400_000;
  return [min, max];
}

function chartArea(width, height, options = {}) {
  return {
    left: options.left ?? 50,
    right: width - (options.right ?? 18),
    top: options.top ?? 18,
    bottom: height - (options.bottom ?? 34)
  };
}

function scaleLinear(domainMin, domainMax, rangeMin, rangeMax) {
  const span = domainMax - domainMin || 1;
  return value => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

function formatAxisNumber(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1000) return Math.round(value).toLocaleString();
  if (absolute >= 100) return Math.round(value).toString();
  return Number(value).toFixed(1);
}

function drawGrid(context, area, yMin, yMax, yScale, rows = 4, formatter = formatAxisNumber) {
  context.save();
  context.font = "11px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.strokeStyle = COLORS.grid;
  context.fillStyle = COLORS.text;
  context.lineWidth = 1;

  for (let index = 0; index <= rows; index += 1) {
    const ratio = index / rows;
    const value = yMax - ratio * (yMax - yMin);
    const y = yScale(value);
    context.beginPath();
    context.moveTo(area.left, y);
    context.lineTo(area.right, y);
    context.stroke();
    context.fillText(formatter(value), 4, y);
  }
  context.restore();
}

function drawDateLabels(context, area, minTime, maxTime, xScale, count = 4) {
  context.save();
  context.font = "11px system-ui, sans-serif";
  context.fillStyle = COLORS.text;
  context.textBaseline = "top";

  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0 : index / (count - 1);
    const time = minTime + ratio * (maxTime - minTime);
    const date = new Date(time);
    const dateString = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const x = xScale(time);
    context.textAlign = index === 0 ? "left" : index === count - 1 ? "right" : "center";
    context.fillText(formatShortDate(dateString), x, area.bottom + 10);
  }
  context.restore();
}

function drawLine(context, points, xScale, yScale, style = {}) {
  const valid = points.filter(point => point?.date && Number.isFinite(Number(point.value)));
  if (!valid.length) return [];

  context.save();
  context.strokeStyle = style.color ?? COLORS.blue;
  context.lineWidth = style.width ?? 2.5;
  context.setLineDash(style.dash ?? []);
  context.globalAlpha = style.alpha ?? 1;
  context.beginPath();

  const hitPoints = [];
  valid.forEach((point, index) => {
    const x = xScale(new Date(`${point.date}T00:00:00`).getTime());
    const y = yScale(Number(point.value));
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
    hitPoints.push({ x, y, point, series: style.label ?? "Value", color: style.color ?? COLORS.blue });
  });
  context.stroke();

  if (style.fill && valid.length > 1) {
    const last = hitPoints.at(-1);
    const first = hitPoints[0];
    context.lineTo(last.x, style.fillBaseline);
    context.lineTo(first.x, style.fillBaseline);
    context.closePath();
    const gradient = context.createLinearGradient(0, Math.min(...hitPoints.map(point => point.y)), 0, style.fillBaseline);
    gradient.addColorStop(0, style.fill);
    gradient.addColorStop(1, "rgba(47, 135, 255, 0)");
    context.fillStyle = gradient;
    context.fill();
  }

  if (style.points) {
    for (const hitPoint of hitPoints) {
      context.beginPath();
      context.fillStyle = style.color ?? COLORS.blue;
      context.arc(hitPoint.x, hitPoint.y, style.pointRadius ?? 3.5, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--chart-point-outline").trim() || "rgba(5, 11, 20, 0.8)";
      context.lineWidth = 2;
      context.arc(hitPoint.x, hitPoint.y, style.pointRadius ?? 3.5, 0, Math.PI * 2);
      context.stroke();
    }
  }

  context.restore();
  return hitPoints;
}

function setChartAvailability(canvas, available) {
  const empty = document.querySelector(`[data-empty-for="${canvas.id}"]`);
  empty?.classList.toggle("hidden", available);
  canvas.style.opacity = available ? "1" : "0";
}

function tooltipElement() {
  let tooltip = document.querySelector(".chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    document.body.append(tooltip);
  }
  return tooltip;
}

function attachTooltip(canvas, hitPoints, valueFormatter = value => String(value)) {
  canvas.__hitPoints = hitPoints;
  canvas.__valueFormatter = valueFormatter;

  if (canvas.__tooltipBound) return;
  canvas.__tooltipBound = true;
  const tooltip = tooltipElement();

  canvas.addEventListener("pointermove", event => {
    const points = canvas.__hitPoints ?? [];
    if (!points.length) {
      tooltip.hidden = true;
      return;
    }

    const rectangle = canvas.getBoundingClientRect();
    const x = event.clientX - rectangle.left;
    const y = event.clientY - rectangle.top;
    let nearest = null;
    let distance = Infinity;

    for (const point of points) {
      const candidate = Math.hypot(point.x - x, point.y - y);
      if (candidate < distance) {
        distance = candidate;
        nearest = point;
      }
    }

    if (!nearest || distance > 42) {
      tooltip.hidden = true;
      return;
    }

    const value = Number(nearest.point.value);
    tooltip.innerHTML = `<strong style="color:${nearest.color}">${nearest.series}</strong><span>${formatShortDate(nearest.point.date)} · ${canvas.__valueFormatter(value, nearest)}</span>`;
    tooltip.style.left = `${event.clientX}px`;
    tooltip.style.top = `${event.clientY}px`;
    tooltip.hidden = false;
  });

  canvas.addEventListener("pointerleave", () => {
    tooltip.hidden = true;
  });
}

export function drawWeightChart(canvas, analysis, { compact = false, targetWeight = null, settings = null } = {}) {
  const raw = compact ? analysis.chartRaw : analysis.chartRaw;
  const smoothed = compact ? analysis.chartSmoothed : analysis.chartSmoothed;
  const forecast = analysis.forecast ?? [];
  const available = raw.length >= 2;
  setChartAvailability(canvas, available);
  if (!available) return;

  const { context, width, height } = prepareCanvas(canvas);
  const area = chartArea(width, height, { left: compact ? 46 : 52, bottom: compact ? 30 : 36 });
  const [minTime, maxTime] = dateExtent([raw, forecast]);
  const allValues = [
    ...raw.map(point => point.weight),
    ...smoothed.map(point => point.value),
    ...forecast.map(point => point.value),
    Number(targetWeight)
  ];
  let [yMin, yMax] = valueExtent(allValues, 0.15, 0.4);
  const fixedMin = Number(settings?.chartWeightMin);
  const fixedMax = Number(settings?.chartWeightMax);
  if (settings?.chartScaleMode === "fixed" && Number.isFinite(fixedMin) && Number.isFinite(fixedMax) && fixedMin < fixedMax) {
    yMin = fixedMin;
    yMax = fixedMax;
  }
  const xScale = scaleLinear(minTime, maxTime, area.left, area.right);
  const yScale = scaleLinear(yMin, yMax, area.bottom, area.top);

  drawGrid(context, area, yMin, yMax, yScale, compact ? 3 : 4);
  drawDateLabels(context, area, minTime, maxTime, xScale, compact ? 3 : 4);

  if (Number.isFinite(Number(targetWeight))) {
    const y = yScale(Number(targetWeight));
    context.save();
    context.strokeStyle = "rgba(53, 208, 127, 0.72)";
    context.lineWidth = 1.5;
    context.setLineDash([6, 6]);
    context.beginPath();
    context.moveTo(area.left, y);
    context.lineTo(area.right, y);
    context.stroke();
    context.fillStyle = COLORS.green;
    context.font = "11px system-ui, sans-serif";
    context.textAlign = "right";
    context.fillText(`Goal ${round(Number(targetWeight), 1)} kg`, area.right, y - 7);
    context.restore();
  }

  const rawPoints = drawLine(
    context,
    raw.map(point => ({ date: point.date, value: point.weight })),
    xScale,
    yScale,
    { color: COLORS.blue, width: 1.5, points: true, pointRadius: compact ? 2.5 : 3.4, alpha: 0.65, label: "Measured" }
  );

  const averagePoints = drawLine(context, smoothed, xScale, yScale, {
    color: COLORS.cyan,
    width: compact ? 2.5 : 3.2,
    fill: compact ? "rgba(50, 215, 232, 0.13)" : null,
    fillBaseline: area.bottom,
    label: "Smoothed"
  });

  const forecastPoints = drawLine(context, forecast, xScale, yScale, {
    color: COLORS.purple,
    width: 2.2,
    dash: [7, 7],
    label: "Forecast"
  });

  attachTooltip(canvas, [...rawPoints, ...averagePoints, ...forecastPoints], value => `${value.toFixed(1)} kg`);
}

export function drawWeeklyAverageChart(canvas, weekly) {
  const available = weekly.length >= 2;
  setChartAvailability(canvas, available);
  if (!available) return;

  const { context, width, height } = prepareCanvas(canvas);
  const area = chartArea(width, height, { left: 48, bottom: 34 });
  const [minTime, maxTime] = dateExtent([weekly]);
  const [yMin, yMax] = valueExtent(weekly.map(point => point.value), 0.16, 0.35);
  const xScale = scaleLinear(minTime, maxTime, area.left, area.right);
  const yScale = scaleLinear(yMin, yMax, area.bottom, area.top);

  drawGrid(context, area, yMin, yMax, yScale, 3);
  drawDateLabels(context, area, minTime, maxTime, xScale, 3);
  const points = drawLine(context, weekly, xScale, yScale, {
    color: COLORS.cyan,
    width: 3,
    points: true,
    pointRadius: 4,
    fill: "rgba(50, 215, 232, 0.12)",
    fillBaseline: area.bottom,
    label: "Weekly average"
  });
  attachTooltip(canvas, points, value => `${value.toFixed(1)} kg`);
}

export function drawMaintenanceChart(canvas, maintenanceAnalysis, settings) {
  const calories = maintenanceAnalysis.calorieTimeline ?? [];
  const rolling = maintenanceAnalysis.rolling ?? [];
  const available = calories.length >= 4 || rolling.length >= 1;
  setChartAvailability(canvas, available);
  if (!available) return;

  const { context, width, height } = prepareCanvas(canvas);
  const area = chartArea(width, height, { left: 58, bottom: 36 });
  const [minTime, maxTime] = dateExtent([calories, rolling]);
  const values = [...calories.map(point => point.value), ...rolling.map(point => point.estimate)];
  const [yMinRaw, yMax] = valueExtent(values, 0.12, 150);
  const yMin = Math.max(0, yMinRaw);
  const xScale = scaleLinear(minTime, maxTime, area.left, area.right);
  const yScale = scaleLinear(yMin, yMax, area.bottom, area.top);

  drawGrid(context, area, yMin, yMax, yScale, 4, value => `${Math.round(value)}`);
  drawDateLabels(context, area, minTime, maxTime, xScale, 4);

  const dayWidth = Math.max(2, (area.right - area.left) / Math.max(calories.length, 1) * 0.72);
  const calorieHitPoints = [];
  context.save();
  for (const point of calories) {
    const x = xScale(new Date(`${point.date}T00:00:00`).getTime());
    const top = yScale(point.value);
    const gradient = context.createLinearGradient(0, top, 0, area.bottom);
    gradient.addColorStop(0, "rgba(47, 135, 255, 0.66)");
    gradient.addColorStop(1, "rgba(47, 135, 255, 0.09)");
    context.fillStyle = gradient;
    context.fillRect(x - dayWidth / 2, top, dayWidth, area.bottom - top);
    calorieHitPoints.push({ x, y: top, point: { date: point.date, value: point.value }, series: "Calorie intake", color: COLORS.blue });
  }
  context.restore();

  const maintenancePoints = drawLine(
    context,
    rolling.map(point => ({ date: point.date, value: point.estimate })),
    xScale,
    yScale,
    { color: COLORS.cyan, width: 3, points: true, pointRadius: 4, label: "Maintenance estimate" }
  );

  const target = maintenanceAnalysis.current?.estimate != null && Number.isFinite(Number(settings?.dailyDeficit))
    ? maintenanceAnalysis.current.estimate - Number(settings.dailyDeficit)
    : null;
  if (Number.isFinite(target)) {
    const y = yScale(target);
    context.save();
    context.strokeStyle = "rgba(53, 208, 127, 0.65)";
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(area.left, y);
    context.lineTo(area.right, y);
    context.stroke();
    context.restore();
  }

  attachTooltip(canvas, [...calorieHitPoints, ...maintenancePoints], value => `${Math.round(value)} kcal/day`);
}

export function drawBodyCompositionChart(canvas, bodyAnalysis) {
  const entries = bodyAnalysis.entries ?? [];
  const available = entries.length >= 2;
  setChartAvailability(canvas, available);
  if (!available) return;

  const { context, width, height } = prepareCanvas(canvas);
  const area = chartArea(width, height, { left: 58, right: 70, bottom: 38 });
  const [minTime, maxTime] = dateExtent([entries]);
  const leanValues = entries.map(point => point.leanMass);
  const fatMassValues = entries.map(point => point.fatMass);
  const fatPercentValues = entries.map(point => point.bodyFat);
  const [leanMinRaw, leanMax] = valueExtent(leanValues, 0.22, 0.5);
  const leanMin = Math.max(0, leanMinRaw);
  const [fatMassMinRaw, fatMassMax] = valueExtent(fatMassValues, 0.22, 0.4);
  const fatMassMin = Math.max(0, fatMassMinRaw);
  const [fatPercentMinRaw, fatPercentMax] = valueExtent(fatPercentValues, 0.22, 0.4);
  const fatPercentMin = Math.max(0, fatPercentMinRaw);
  const xScale = scaleLinear(minTime, maxTime, area.left, area.right);
  const leanScale = scaleLinear(leanMin, leanMax, area.bottom, area.top);
  const fatMassScale = scaleLinear(fatMassMin, fatMassMax, area.bottom, area.top);
  const fatPercentScale = scaleLinear(fatPercentMin, fatPercentMax, area.bottom, area.top);

  drawGrid(context, area, leanMin, leanMax, leanScale, 4, value => `${formatAxisNumber(value)}`);
  drawDateLabels(context, area, minTime, maxTime, xScale, 4);

  context.save();
  context.font = "11px system-ui, sans-serif";
  context.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const ratio = index / 4;
    const fatMassValue = fatMassMax - ratio * (fatMassMax - fatMassMin);
    const fatPercentValue = fatPercentMax - ratio * (fatPercentMax - fatPercentMin);
    const y = area.top + ratio * (area.bottom - area.top);
    context.textAlign = "left";
    context.fillStyle = COLORS.yellow;
    context.fillText(`${fatMassValue.toFixed(1)} kg`, area.right + 8, y - 6);
    context.fillStyle = COLORS.purple;
    context.fillText(`${fatPercentValue.toFixed(1)}%`, area.right + 8, y + 7);
  }
  context.textAlign = "left";
  context.fillStyle = COLORS.cyan;
  context.fillText("Lean kg", area.left, area.top - 9);
  context.fillStyle = COLORS.yellow;
  context.fillText("Fat kg", area.right - 44, area.top - 9);
  context.fillStyle = COLORS.purple;
  context.fillText("BF%", area.right + 28, area.top - 9);
  context.restore();

  const leanPoints = drawLine(context, entries.map(point => ({ date: point.date, value: point.leanMass })), xScale, leanScale, {
    color: COLORS.cyan,
    width: 3,
    points: true,
    pointRadius: 3.6,
    label: "Lean mass"
  });
  const fatMassPoints = drawLine(context, entries.map(point => ({ date: point.date, value: point.fatMass })), xScale, fatMassScale, {
    color: COLORS.yellow,
    width: 2.8,
    points: true,
    pointRadius: 3.2,
    label: "Fat mass"
  });
  const fatPercentPoints = drawLine(context, entries.map(point => ({ date: point.date, value: point.bodyFat })), xScale, fatPercentScale, {
    color: COLORS.purple,
    width: 2.2,
    dash: [6, 5],
    label: "Body fat"
  });

  const combined = [
    ...leanPoints.map(point => ({ ...point, unit: "kg" })),
    ...fatMassPoints.map(point => ({ ...point, unit: "kg" })),
    ...fatPercentPoints.map(point => ({ ...point, unit: "%" }))
  ];
  attachTooltip(canvas, combined, (value, point) => point.unit === "%" ? `${value.toFixed(1)}%` : `${value.toFixed(1)} kg`);
}

function bodyFatBands(referenceSex) {
  return referenceSex === "female"
    ? [
        { min: 5, max: 14, color: "rgba(240, 187, 69, 0.09)", label: "Essential" },
        { min: 14, max: 21, color: "rgba(50, 215, 232, 0.08)", label: "Athletic" },
        { min: 21, max: 25, color: "rgba(53, 208, 127, 0.09)", label: "Fitness" },
        { min: 25, max: 32, color: "rgba(47, 135, 255, 0.07)", label: "Average" },
        { min: 32, max: 45, color: "rgba(255, 90, 111, 0.07)", label: "High" }
      ]
    : [
        { min: 2, max: 6, color: "rgba(240, 187, 69, 0.09)", label: "Essential" },
        { min: 6, max: 14, color: "rgba(50, 215, 232, 0.08)", label: "Athletic" },
        { min: 14, max: 18, color: "rgba(53, 208, 127, 0.09)", label: "Fitness" },
        { min: 18, max: 25, color: "rgba(47, 135, 255, 0.07)", label: "Average" },
        { min: 25, max: 40, color: "rgba(255, 90, 111, 0.07)", label: "High" }
      ];
}

function metricBands(metric, referenceSex) {
  if (metric === "bmi") {
    return [
      { min: 15, max: 18.5, label: "Underweight" },
      { min: 18.5, max: 25, label: "Healthy" },
      { min: 25, max: 30, label: "Overweight" },
      { min: 30, max: 40, label: "Obesity" }
    ];
  }

  const limits = referenceSex === "female" ? [12, 14, 16, 18, 20, 23] : [14, 16, 18, 20, 22, 26];
  const labels = ["Below", "Average", "Above avg.", "Athletic", "Highly muscular"];
  return limits.slice(0, -1).map((min, index) => ({ min, max: limits[index + 1], label: labels[index] }));
}

export function drawPhysiqueMap(canvas, bodyAnalysis, settings) {
  const entries = bodyAnalysis.entries ?? [];
  const metric = settings.mapMetric === "bmi" ? "bmi" : "ffmi";
  const points = entries
    .map(entry => ({
      date: entry.date,
      x: entry.bodyFat,
      y: metric === "bmi" ? entry.bmi : entry.normalizedFfmi
    }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  const available = points.length >= 1;
  setChartAvailability(canvas, available);
  if (!available) return;

  const { context, width, height } = prepareCanvas(canvas);
  const area = chartArea(width, height, { left: 88, right: 20, top: 24, bottom: 34 });
  const xBands = bodyFatBands(settings.referenceSex);
  const yBands = metricBands(metric, settings.referenceSex);
  const xMin = xBands[0].min;
  const xMax = xBands.at(-1).max;
  const yMin = yBands[0].min;
  const yMax = yBands.at(-1).max;
  const xScale = scaleLinear(xMin, xMax, area.left, area.right);
  const yScale = scaleLinear(yMin, yMax, area.bottom, area.top);

  context.save();
  for (const band of xBands) {
    const left = xScale(band.min);
    const right = xScale(band.max);
    context.fillStyle = band.color;
    context.fillRect(left, area.top, right - left, area.bottom - area.top);
    context.strokeStyle = "rgba(142, 161, 185, 0.18)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left, area.top);
    context.lineTo(left, area.bottom);
    context.stroke();
    context.fillStyle = COLORS.text;
    context.font = "10px system-ui, sans-serif";
    context.textAlign = "center";
    if (right - left > 47) context.fillText(band.label, (left + right) / 2, area.bottom + 22);
  }
  context.beginPath();
  context.moveTo(area.right, area.top);
  context.lineTo(area.right, area.bottom);
  context.stroke();

  const rowColors = [
    "rgba(50, 215, 232, 0.045)",
    "rgba(53, 208, 127, 0.05)",
    "rgba(240, 187, 69, 0.045)",
    "rgba(47, 135, 255, 0.04)",
    "rgba(148, 117, 255, 0.045)"
  ];
  context.strokeStyle = "rgba(142, 161, 185, 0.2)";
  context.lineWidth = 1;
  yBands.forEach((band, index) => {
    const yTop = yScale(band.max);
    const yBottom = yScale(band.min);
    context.fillStyle = rowColors[index % rowColors.length];
    context.fillRect(area.left, yTop, area.right - area.left, yBottom - yTop);
    context.beginPath();
    context.moveTo(area.left, yTop);
    context.lineTo(area.right, yTop);
    context.stroke();
    context.fillStyle = COLORS.text;
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText(band.label, area.left - 10, (yTop + yBottom) / 2);
  });
  context.beginPath();
  context.moveTo(area.left, area.bottom);
  context.lineTo(area.right, area.bottom);
  context.stroke();

  context.fillStyle = COLORS.text;
  context.font = "11px system-ui, sans-serif";
  context.textAlign = "center";
  context.fillText("Body fat %", (area.left + area.right) / 2, height - 8);
  context.save();
  context.translate(16, (area.top + area.bottom) / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(metric === "bmi" ? "BMI" : "Normalized FFMI", 0, 0);
  context.restore();
  context.restore();

  const hitPoints = [];
  if (points.length > 1) {
    context.save();
    context.strokeStyle = "rgba(148, 117, 255, 0.54)";
    context.lineWidth = 2;
    context.beginPath();
    points.forEach((point, index) => {
      const x = xScale(point.x);
      const y = yScale(point.y);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    context.restore();
  }

  points.forEach((point, index) => {
    const x = xScale(point.x);
    const y = yScale(point.y);
    const latest = index === points.length - 1;
    context.save();
    context.shadowColor = latest ? COLORS.cyan : COLORS.purple;
    context.shadowBlur = latest ? 18 : 7;
    context.fillStyle = latest ? COLORS.cyan : COLORS.purple;
    context.beginPath();
    context.arc(x, y, latest ? 7 : 4, 0, Math.PI * 2);
    context.fill();
    context.restore();
    hitPoints.push({
      x,
      y,
      point: { date: point.date, value: point.y, bodyFat: point.x },
      series: latest ? "Latest" : "Body composition",
      color: latest ? COLORS.cyan : COLORS.purple
    });
  });

  attachTooltip(canvas, hitPoints, (value, hit) => `${hit.point.bodyFat.toFixed(1)}% fat · ${value.toFixed(1)} ${metric.toUpperCase()}`);
}

export function redrawOnResize(callback) {
  let timer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(callback, 120);
  });
}
