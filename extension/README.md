# Canvas to AI (Chrome extension prototype)

Side panel for Canvas (`*.instructure.com`) that lists every file in a course,
grouped by module/week, announcements and syllabus. Tick what you want, then:

- **Download**: saves the files to `Downloads/Canvas/<course>/<NN module>/`.
- **Copy as Markdown**: converts PDF, PPTX, DOCX, HTML, notebooks, code files
  and page/announcement text into one compact Markdown document on your clipboard.
- **Save**: writes the same Markdown to `Downloads/Canvas/<course> - AI/course.md`
  with an `images/` folder (slide images, page images, image files) that the
  Markdown references. Drag both into your AI chat.

It uses your normal Canvas login (no API token) and everything runs locally.

## Install (developer mode)

```bash
npm install
npm run build
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick the `dist/` folder.
3. Open a Canvas course, click the extension icon. The side panel opens and scans.

After code changes: `npm run build`, then click the reload icon on the extension card.

## Not converted yet

- `.zip` and other binary files (listed under "Not included" at the end of the Markdown).
- Images inside PDFs (PDF text is extracted; slide images come from PPTX only).
- Scanned PDFs without a text layer.
