# CalStat

CalStat is a private weight, nutrition, and body-composition tracker built as a fast installable web app. It turns daily weigh-ins, calorie entries, and body-fat measurements into readable trend signals: current weight, smoothed averages, maintenance estimates, goal forecasts, physique metrics, and charted progress over time.

The app is designed for people who want more than a scale log, but less friction than a spreadsheet. You enter the data you already track, and CalStat helps you understand the direction, pace, and confidence behind the numbers.

## What It Does

- Tracks scale weight, calorie intake, and body-composition entries.
- Shows current weight, 7-day averages, weekly velocity, and projected weight.
- Estimates maintenance calories from logged intake and measured weight change.
- Scores trend quality with sufficiency, volatility, and confidence signals.
- Forecasts goal progress using target weight, deficit, and recent trend data.
- Calculates body-fat mass, lean mass, BMI, and normalized FFMI.
- Includes a physique map for body-fat percentage against FFMI or BMI.
- Supports JSON export and import for portable backups.
- Syncs user data with Firebase Auth and Firestore.
- Keeps a local cache so the app can start quickly and recover gracefully.
- Installs as a PWA with a web manifest and service worker.

## Screens And Workflows

CalStat is organized around the way tracking actually happens:

- **Overview** gives a quick read on today: current weight, average weight, trend, maintenance, goal status, and the main weight chart.
- **Log data** keeps daily input simple with separate flows for scale weight, body composition, and calorie intake.
- **Trends** focuses on the model: smoothed weight, velocity, maintenance calories, calorie coverage, and forecast quality.
- **Body** shows composition analytics, lean mass, fat mass, BMI, FFMI, and the physique map.
- **Goals** estimates time to target and suggested intake based on your latest data.
- **Settings** controls themes, height, reference profile, chart windows, smoothing, prediction horizon, imports, exports, and sync.

## How It Works

This repository is intentionally simple: no build step, no framework, and no package install required for the app itself.

```text
index.html              App shell and markup
styles/                 Base, component, layout, and responsive styles
js/app.js               UI wiring, views, forms, modals, and service worker setup
js/store.js             Local state, persistence, sync, import/export
js/calculations.js      Weight, nutrition, body composition, goals, and statistics
js/charts.js            Canvas chart rendering
js/firebase.js          Firebase Auth and Firestore integration
js/firebase-config.js   Firebase project configuration
manifest.webmanifest    PWA install metadata
service-worker.js       App shell and Firebase module caching
firestore.rules         Firestore access rules for the Firebase project
```

## Running Locally

Because the app uses ES modules, serve the folder over HTTP instead of opening `index.html` directly.

```bash
python -m http.server 8080
```

Then open:

```text
http://127.0.0.1:8080
```

The checked-in Firebase config points at the existing CalStat Firebase project. If you fork the app, create your own Firebase project, enable Email/Password Auth and Firestore, then replace the values in `js/firebase-config.js`.

## Data And Privacy

CalStat stores personal tracking data under the signed-in Firebase user. It also uses browser storage and Firestore offline behavior so the app can keep working smoothly between sessions. The JSON export button gives you a portable backup that can be imported again later.

The app is for personal tracking and exploratory estimates. It is not a medical device, and its projections should not replace professional advice.

## Calculation Notes

CalStat favors transparent, conservative estimates:

- Maintenance calories are estimated from average calorie intake and measured weight trend.
- Weight projections extrapolate recent trend data and become less certain over longer horizons.
- Body-composition metrics depend on the quality of the body-fat measurement you enter.
- The kcal-per-kg energy setting defaults to a common approximation and can be adjusted in settings.
- BMI and FFMI ranges are reference tools, not diagnoses.

Useful background sources:

- Firebase offline persistence: https://firebase.google.com/docs/firestore/manage-data/enable-offline
- Firebase Authentication with Firestore Security Rules: https://firebase.google.com/docs/firestore/security/get-started
- CDC adult BMI categories: https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html
- Original FFMI definition and height normalization: https://pubmed.ncbi.nlm.nih.gov/7496846/
- Why fixed kcal/kg weight conversion is an approximation: https://pmc.ncbi.nlm.nih.gov/articles/PMC4035446/
- NIDDK dynamic Body Weight Planner: https://www.niddk.nih.gov/health-information/weight-management/body-weight-planner

## Why CalStat Exists

Body weight is noisy. Water, digestion, training stress, sodium, sleep, and measurement timing can all hide the real signal. CalStat tries to make that signal easier to see by combining simple logging with smoothing, trend windows, confidence checks, and plain-language summaries.

The result is a tracker that feels calm: quick enough for daily use, detailed enough for serious progress analysis, and private enough to be your personal dashboard.
