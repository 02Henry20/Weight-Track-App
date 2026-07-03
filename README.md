# MASS // TRACK

A responsive, installable Firebase web application for tracking body weight,
body composition, calorie intake and goals. It is designed for both desktop and
mobile use and continues to read/write cached Firestore data while offline.

## Firebase project

The included `js/firebase-config.js` already points to:

`weight-track-app-e0e2c`

The browser configuration is public by design. Data access is protected by
Firebase Authentication and Firestore Security Rules.

## Required Firebase change

The older test app's rules allowed only the `weights` collection. This full app
also uses body composition, calories, goals and settings.

Open:

**Firebase Console → Firestore Database → Rules**

Replace the current rules with the contents of `firestore.rules`, then click
**Publish**.

The rules allow a signed-in user to access only documents under their own UID:

```text
apps/weight-tracker/users/{uid}/...
```

## GitHub Pages deployment

1. Extract this ZIP.
2. Put the contents directly in the same GitHub Pages repository root.
3. Commit and push.
4. Keep the same repository name and Pages URL so the installed PWA updates.
5. Open the app while online and press **Update now** when prompted.

Your old weight entries remain compatible because the path is unchanged:

```text
apps/weight-tracker/users/{uid}/weights/{YYYY-MM-DD}
```

## Data model

```text
apps/weight-tracker/users/{uid}/
├── weights/{YYYY-MM-DD}
├── bodyComposition/{YYYY-MM-DD}
├── calories/{YYYY-MM-DD}
├── goals/current
└── settings/preferences
```

There is one weight record per day. Saving another weight for an existing date
requires confirmation and overwrites that day's document.

A calorie entry can be:

- `daily`: calories for the selected day
- `weekly`: total calories for the seven-day period ending on the selected date

Weekly entries are divided by seven for analysis. Explicit daily entries take
precedence over overlapping weekly averages.

## Offline behavior

- Firestore persistent local caching is enabled.
- Previously loaded measurements are available offline.
- Offline writes update the interface immediately and synchronize later.
- Do not clear browser data while an entry still says **Waiting to sync**.
- After browser data is cleared, sign in online to restore the cloud copy.

## Calculations

### Weight trend and forecast

The app applies the configured calendar-day moving average, then fits a linear
least-squares trend over the configured analysis window. The forecast extends
that recent linear trend over the selected prediction horizon.

### Maintenance estimate

The current estimate is calculated from:

```text
estimated maintenance
= average calorie intake
- measured weight slope × configured kcal/kg factor
```

The default factor is 7,700 kcal/kg and can be changed in Settings. This is an
approximation rather than a physiological model. The interface reports a data
quality score and uncertainty range so sparse/noisy data is not presented as
precise.

### Body composition

```text
fat mass  = body weight × body-fat percentage
lean mass = body weight - fat mass
BMI       = body weight / height²
FFMI      = lean mass / height²
normalized FFMI = FFMI + 6.3 × (1.8 - height in metres)
```

BMI classifications follow standard adult screening cutoffs. Body-fat and FFMI
labels are practical reference bands, not diagnoses. Consumer body-fat readings
can vary substantially with hydration and measurement method.

## Included functionality

- Dark blue responsive desktop/mobile design
- Overview dashboard with key metrics
- Weight stepper in 0.1 kg increments
- Overwrite confirmation for duplicate dates
- Separate body-fat weight measurement
- Daily or weekly calorie entries
- Weight goal and calorie-deficit goal
- Smoothed weight chart and future projection
- Maintenance-calorie estimate and quality score
- Weekly averages
- Lean mass, fat mass, BMI and normalized FFMI
- Body-fat/FFMI or body-fat/BMI map
- Configurable smoothing, model windows and prediction horizon
- Local JSON export/import
- Firebase cloud synchronization and offline cache

## Local development

Service workers and Firebase modules require HTTP rather than opening the HTML
file directly.

```bash
python -m http.server 8000
```

Open `http://localhost:8000` and ensure `localhost` is listed under Firebase
Authentication → Settings → Authorized domains.
