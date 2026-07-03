# Firebase setup

## Send/provide these Firebase values
Copy the complete Web app configuration from **Firebase Console → Project settings → General → Your apps → Web app**. The code needs: `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, and `appId`.

This browser configuration is public by design. Do **not** send an Admin SDK private key, service-account JSON, database password, or any secret.

## Console steps
1. Register a Web app. Firebase Hosting is not needed.
2. Enable **Authentication → Sign-in method → Email/Password**.
3. Add your GitHub Pages hostname, such as `02henry20.github.io`, under **Authentication → Settings → Authorized domains**. Add `localhost` for local testing when needed.
4. Create **Cloud Firestore → Standard edition → Production mode**.
5. Copy `firestore.rules` into **Firestore Database → Rules** and publish it.
6. Paste the six Firebase values into `firebase-config.js` in Version 1. Use the exact same file in Version 2.

## Data and offline behavior
Records use `apps/weight-tracker/users/{uid}/weights/{YYYY-MM-DD}`. Firestore keeps a persistent local IndexedDB cache, shows cached records offline, and queues offline writes. A pending write is not safe from browser-data deletion until the app reports **Synced**. After clearing browser data, reconnect and sign into the same Firebase account to restore cloud data.

## Test
Deploy Version 1 at one GitHub Pages URL, create an account, add two entries, and wait for **Synced**. Replace the repository files with Version 2 while keeping the same `firebase-config.js`, repository, URL, and Firebase project. Open the installed PWA and tap **Update now**.
