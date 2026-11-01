# Canvas to AI for Safari

A Mac app that installs the same extension in Safari. Generated with
`xcrun safari-web-extension-converter` and kept as is; the extension's files
are not copied in: the project uses `../extension/dist-safari`, built by
`npm run build`.

Safari has no side panel and no downloads API, so there the toolbar button
opens the panel in a narrow window of its own, and downloads save one zip
with the same week folders (see `extension/src/background.js` and `saver()`
in `extension/src/panel/panel.js`).

## Try it on your Mac

```bash
cd extension && npm ci && npm run build && cd ..
xcodebuild -project "safari/Canvas to AI/Canvas to AI.xcodeproj" -scheme "Canvas to AI" \
  -configuration Release -archivePath /tmp/cta.xcarchive -allowProvisioningUpdates archive
cp -R "/tmp/cta.xcarchive/Products/Applications/Canvas to AI.app" ~/Applications/
open ~/Applications/"Canvas to AI.app"
```

Then in Safari: **Settings › Extensions**, tick **Canvas to AI**, and allow it
on your Canvas site (**Edit Websites…**, or the prompt on the toolbar button).

## Release to the Mac App Store

1. Set the version: `MARKETING_VERSION` in the project (Xcode › target ›
   General › Version) to `extension/package.json`'s, and raise the build
   number (`CURRENT_PROJECT_VERSION`) on every upload.
2. Archive as above, then upload (uses the Apple account signed in to Xcode):
   ```bash
   xcodebuild -exportArchive -archivePath /tmp/cta.xcarchive \
     -exportOptionsPlist safari/ExportOptions.plist -exportPath safari/export -allowProvisioningUpdates
   ```
3. In App Store Connect, pick the build for the version and submit it for review.
