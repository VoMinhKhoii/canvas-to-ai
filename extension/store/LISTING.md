# Chrome Web Store submission: Canvas to AI 0.8.0

Everything the developer dashboard asks for, in the order it asks. Paste each block as is.

## Package

- Upload `canvas-to-ai-0.8.0.zip`, built from this commit:
  ```bash
  cd extension && npm ci && npm test && npm run build && (cd dist && zip -X -r ../canvas-to-ai-0.8.0.zip .)
  ```
  The zip holds `dist/` only: `manifest.json` at its root, no source maps, tests or `node_modules`.

## Store listing

**Name** (from the manifest): Canvas to AI

**Summary** (132 characters at most; this is the manifest description):

> Weeks of Canvas course materials, ready to paste into ChatGPT, Claude or Gemini. Slides, PDFs, docs and code, read on your computer.

**Description**:

```
Weeks of course materials, ready to paste into AI.

Open a Canvas course, pick a week or single files, and press Copy text for AI. Your lecture slides, documents and course pages become one text you can paste into an AI chat to study, ask questions or make notes.

You can also download the files you pick, one folder per week.

Your own submissions are listed too, so you can copy or download the work you handed in.

A scan also lists your grades, rubric marks, teacher comments, quizzes, your group's files, pages and discussions, and the course pages and files that aren't in a module, so you can copy those too.

If your school runs Canvas on its own address, add that address in the panel and it works the same way.

OneDrive and Teams: open your class's Teams files, or the lecture recordings shared with you, and copy each recording's transcript for AI.

Download all of Canvas saves every course you tick, current and past, into its own folder: files, pages as PDFs, grades, teacher comments and your lecturers' notes on your work. You see the size first, and it carries on where it stopped. Inbox messages and classmates' discussion replies only if you turn them on.

Everything runs on your computer with your own Canvas or Microsoft login. Nothing is sent anywhere else.

Made by a student. Not made or endorsed by Instructure or any school.
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

> Turns the course materials a student picks (from Canvas, or the class files and lecture recordings in their school's OneDrive and Teams) into text for an AI chat, or downloads them (with the student's own Canvas messages and discussions, if they opt in), on the student's own computer.

**Permission justifications**:

| Permission | Justification |
| --- | --- |
| `sidePanel` | The extension's whole interface is a side panel beside the Canvas course. |
| `scripting` | Injects one small script into the student's open Canvas course tab so the panel can read the course through the Canvas API with the student's own login. It only reads: GET requests to that Canvas site's /api/v1/, plus read-only GraphQL queries (never mutations) for the replies to anonymous discussions, which /api/v1/ does not give. It answers only this extension. |
| `downloads` | Saves the files the student picks, the "Save with pictures" text and images, and Download all of Canvas, into their Downloads folder. |
| `clipboardWrite` | "Copy text for AI" puts the converted course text on the clipboard. |
| Host `https://*.instructure.com/*` | Canvas sites are hosted on instructure.com: the panel finds the course tab, reads the course and downloads the picked files there. Download all of Canvas also opens the student's own submitted files in Canvas's document viewer (Canvadocs, also on instructure.com) to save a copy with the lecturer's notes on it. |
| Host `https://*.canvas-user-content.com/*`, `https://*.inscloudgate.net/*` | Canvas serves course files from these hosts; downloads of picked files are redirected to them. |
| Optional host `https://*/*` | Not granted at install. Some schools run Canvas on their own address (canvas.school.edu). The student types that address in the panel and Chrome asks them to allow that one site. The extension then checks that it is Canvas and gives the permission back if it is not. It is used there exactly as instructure.com is above. It is also how OneDrive and Teams is turned on (from the panel's ⋯ › OneDrive and Teams): Chrome asks the student to allow `https://*.sharepoint.com/*`, where Microsoft keeps OneDrive and Teams files, plus `https://*.teams.microsoft.com/*` and `https://*.teams.cloud.microsoft/*`, only so the panel can recognise a Teams tab and say where its files are. The panel then reads the files shared with the student and the folder open in their SharePoint tab, with the student's own Microsoft login. |

The dashboard has one **Host permission justification** field (1,000 characters at most), which holds the host rows above in short:

> https://*.instructure.com/* is where Canvas sites are hosted: the panel finds the course tab, reads the course and downloads the picked files there. Download all also opens the student's own submitted files in Canvadocs (on instructure.com) to save a copy with the lecturer's notes. https://*.canvas-user-content.com/* and https://*.inscloudgate.net/* serve Canvas course files. Optional https://*/*, never granted at install: (1) a school's own Canvas address, which the student types and allows as that one site; if it isn't Canvas the permission is given back; (2) from ⋯ › OneDrive and Teams, https://*.sharepoint.com/* to read the student's OneDrive and Teams class files with their own Microsoft login, plus https://*.teams.microsoft.com/* and https://*.teams.cloud.microsoft/* only to recognise a Teams tab and point to its files. No other sites are accessed.

**Remote code**: No, I am not using remote code. (All code, including pdf.js and SheetJS, is bundled in the package.)

**Data usage**: tick **Website content** ("text, images, and files on websites": the course pages and files the student picks) and **Personal communications** (the Canvas inbox messages a student opts in to saving). Leave every other category unticked. Then certify all three statements:

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
