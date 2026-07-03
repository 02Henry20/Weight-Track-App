# Corrected visible-input build

This build fixes the blank/title-only page. The email and password fields are visible before JavaScript loads, and a Firebase loading/error panel is displayed. After sign-in, the weight and date input form appears.

# Firebase Weight Tracker — Version 1

Configure `firebase-config.js`, enable Email/Password Authentication, create Firestore, and publish `firestore.rules`. This version supports offline cache, queued writes, cloud synchronization, and visible sync status.
