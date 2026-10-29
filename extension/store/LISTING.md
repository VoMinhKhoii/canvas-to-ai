# Chrome Web Store submission: Canvas to AI 0.4.0

Everything the developer dashboard asks for, in the order it asks. Paste each block as is.

## Package

- Upload `canvas-to-ai-0.4.0.zip`, built from this commit:
  ```bash
  cd extension && npm ci && npm test && npm run build && (cd dist && zip -X -r ../canvas-to-ai-0.4.0.zip .)
  ```
  The zip holds `dist/` only: `manifest.json` at its root, no source maps, tests or `node_modules`.

## Store listing

**Name** (from the manifest): Canvas to AI

**Summary** (132 characters at most; this is the manifest description):

> Weeks of Canvas course materials, ready to paste into ChatGPT, Claude or Gemini. Slides, PDFs, docs and code, read on your computer.

**Description**:

```
Weeks of course materials, ready to paste into AI.

Open your Canvas course, open the Canvas to AI side panel, and your course appears as its weeks and modules. Pick a week, a section such as Tutorial or Lab, or single files. Press Copy text for AI and paste into ChatGPT, Claude or Gemini to study, ask questions or make revision notes.

What it reads
• PDFs: text in reading order with headings, bullets, code and tables; scanned and diagram pages as pictures
• Slides: PowerPoint (.pptx and old .ppt) and .odp, with speaker notes
• Documents: Word (.docx and old .doc), .odt, .rtf, .txt, Markdown and EPUB
• Spreadsheets: Excel, .ods, .csv, with formulas kept
• Code, Jupyter notebooks, captions (.vtt, .srt), calendar invites and .zip archives
• Canvas pages, assignments, discussions, announcements and the syllabus

Also in the ⋯ menu
• Download the files you picked, or the whole course, into Downloads › Canvas › your course, one folder per week
• Save with pictures: the text plus the slide and page pictures it refers to, ready to drag into a chat

Private by design
Everything is read and converted on your own computer, with your own Canvas login. Nothing is sent to the developer or anyone else: no account, no server, no analytics. Nothing is read until you agree to the short terms card.

Use it fairly
Course materials belong to your school and lecturers: use them for your own study. Some courses don't allow AI tools; check each course's rules.

Canvas to AI is made by a student. It is not made or endorsed by Instructure or by any school. Canvas is a trademark of Instructure, Inc.
```

**Category**: Education

**Language**: English

**Graphics** (all in `extension/store/`):

- Store icon: `store-icon-128.png` (128 × 128, 96 × 96 artwork with 16 px transparent padding)
- Screenshot: `screenshot-1280x800.png` (rebuild with `python3 store/make-screenshot.py` after replacing `panel.png`)
- Small promo tile: `promo-440x280.png`

**Official URL**: none. **Homepage URL**: https://github.com/VoMinhKhoii/canvas-to-ai
**Support URL**: https://github.com/VoMinhKhoii/canvas-to-ai/issues

## Privacy practices tab

**Single purpose**:

> Turns the Canvas course materials a student picks into text for an AI chat, or downloads them, on the student's own computer.

**Permission justifications**:

| Permission | Justification |
| --- | --- |
| `sidePanel` | The extension's whole interface is a side panel beside the Canvas course. |
| `scripting` | Injects one small script into the student's open Canvas course tab so the panel can read the course through the Canvas API with the student's own login. It only makes GET requests to that Canvas site's /api/v1/ and answers only this extension. |
| `downloads` | Saves the files the student picks, and the "Save with pictures" text and images, into their Downloads folder. |
| `clipboardWrite` | "Copy text for AI" puts the converted course text on the clipboard. |
| Host `https://*.instructure.com/*` | Canvas sites are hosted on instructure.com: the panel finds the course tab, reads the course and downloads the picked files there. |
| Host `https://*.canvas-user-content.com/*`, `https://*.inscloudgate.net/*` | Canvas serves course files from these hosts; downloads of picked files are redirected to them. |

**Remote code**: No, I am not using remote code. (All code, including pdf.js and SheetJS, is bundled in the package.)

**Data usage**: tick **Website content** only ("text, images, and files on websites": the course pages and files the student picks). Leave every other category unticked. Then certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**: https://github.com/VoMinhKhoii/canvas-to-ai/blob/main/PRIVACY.md

## Distribution

- Visibility: **Public** lets any student find it in the store; **Unlisted** installs only from the link you share. Both go through the same review.
- Regions: all regions.

## Before you press Submit

1. On a real course, load `dist/` unpacked (chrome://extensions › Developer mode › Load unpacked) and try: scan, pick a week, Copy text for AI, Download picked, Save with pictures.
2. Check the toolbar and the side panel header show the new icon.
3. Expect a manual review of a few days: the host permissions and `scripting` always get one.
