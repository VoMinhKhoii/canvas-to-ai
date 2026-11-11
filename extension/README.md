# Canvas to AI (Chrome extension)

A side panel for Canvas (`*.instructure.com`). It shows the course as folders (weeks,
then the lecturer's sections such as Pre-class, In-class, Tutorial, Lab), lets a student
pick a week or single files, and:

- **Copy for AI**: one Markdown document of everything picked, ready to paste into
  ChatGPT, Claude or Gemini.
- **Download the files** into `Downloads/Canvas/<course>/<NN week>/`.
- **Save with pictures**: the Markdown plus an `images/` folder with the pictures it
  refers to (slide images, scanned or diagram pages, page images).
- **Download all of Canvas** (Chrome): every course you tick, one folder each, in
  `Downloads/Canvas export <date>/`, with grades, rubric marks, teacher comments, quizzes,
  group files, and a copy of each submitted file with the lecturer's notes on it.
  Files are saved as they are. Pages (Canvas pages, assignments, discussions, grades,
  messages) are saved as PDFs to read, with their pictures. Shows the total size first, can include discussion replies and inbox messages if you turn
  them on, and continues where it stopped after the panel closes, the browser quits, the Wi-Fi
  drops or the Canvas login ends.

It uses the student's own Canvas login in their tab (no API token, no server); files are
converted on their computer.

## What it reads

| Material | Formats |
| --- | --- |
| PDFs | text in reading order with headings, bullets, code, tables; scanned and diagram pages as pictures |
| Slides | `.pptx`, `.ppt` (97-2003), `.odp`: titles, bullets, tables, speaker notes, pictures |
| Documents | `.docx`, `.doc` (97-2003), `.odt`, `.rtf`, `.txt`, `.md`, `.epub` |
| Spreadsheets | `.xlsx`, `.xlsm`, `.xls`, `.ods`, `.csv`, `.tsv`: a table per sheet, formulas kept |
| Code and data | 60+ languages, Jupyter notebooks, `Dockerfile`, `Makefile`, JSON/YAML/XML |
| Archives | `.zip`: the file list and every readable file inside; dependencies, build output and generated boilerplate left out |
| Captions | `.vtt`, `.srt` as a transcript |
| Canvas | pages, assignments, discussions, announcements, syllabus (tables kept), external links, your own submissions |

Video, audio, Apple iWork files and other archives are listed under "Not included" with the
reason.

## Develop

```bash
npm ci          # the versions in package-lock.json
npm test        # node:test, no browser needed
npm run build   # → dist/
```

Load `dist/` in `chrome://extensions` (Developer mode → Load unpacked). After a change,
`npm run build` and reload the extension.

Code map (see `../CONTEXT.md` for the words):

- `src/canvas/`: the **Course scan** (`scan.js`) behind the Canvas seam; `tab-proxy.js`
  runs in the Canvas tab, `tab-adapter.js` is the extension's adapter.
- `src/pack/`: the **pack builder** (`build.js`) and one module per format in
  `formats/`, routed by `formats/index.js`. Heavy libraries load only when needed.
  `page-pdf.js` lays out a page as a PDF for Download all (pdfmake, loaded on the first
  page saved); `src/panel/page-pdfs.js` fetches its pictures and writes the file.
- `src/panel/`: the side panel: `selection.js` (what is picked), `view.js` (what is
  drawn), `panel.js` (wiring).
