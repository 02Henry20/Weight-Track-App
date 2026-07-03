# Weight Tracker — Version 2

Version 2 uses exactly the same IndexedDB database as Version 1:

- Database: `weight-tracker-db`
- Object store: `weights`
- PWA ID and start URL: unchanged

## Apply the update

1. Delete or overwrite the Version 1 source files in your local Git repository.
2. Copy the **contents** of this Version 2 folder into the same repository root.
3. Commit and push.
4. Wait until GitHub Pages finishes deploying.
5. Open the already-installed app on your Pixel while online.
6. It should show an update banner. Tap **Update now**.
7. The app reloads as Version 2.
8. Your old entries should still appear, now with summary cards and a chart.

Do not uninstall the app, clear Chrome site data, rename the repository, or move
the deployment to a different URL during the test.
