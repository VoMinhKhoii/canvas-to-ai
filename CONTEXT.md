# Canvas to AI · domain glossary

Words used in code, tests and the interface. Keep them exact.

- **Course**: one Canvas course as the extension sees it: its name and code, its folders, and the pictures its pages display.
- **Folder**: one card in the side panel. A Canvas module ("Week 1/Topic 1 - …", "Getting Started"), or the course's announcements, or its syllabus.
- **Section**: a run of items inside a folder, under one of the lecturer's Canvas sub-headers ("Pre-class", "In-class", "Tutorial", "Lab"). Items before the first sub-header form a section with no title.
- **Item**: one thing a student can pick:
  - a **file** (PDF, slides, Word, web page, code, image, zip…), known by its Canvas file id;
  - a **page**: Canvas page, assignment, discussion, announcement or syllabus text, held as HTML;
  - a **link**: an external URL the lecturer listed (lecture recording, reading).
- **Locked**: an item Canvas will not give this student yet (an unlock date, a prerequisite). It is shown but cannot be picked.
- **Selection**: what the student has picked. Picking a folder or a section picks every unlocked item in it; a folder is "on", "off" or "some".
- **Pack**: what "Copy for AI" produces from a selection: one Markdown document, the pictures it refers to, and the items that could not be read (with the reason).
- **Readable**: a file whose text the pack can extract (PDF, PowerPoint, Word, HTML, notebooks, code, plain text). Other files (zip, video) can be downloaded but are listed under "Not included" in the pack.
- **Page image**: a picture a page displays (`<img>`). It belongs to its page and appears in the pack where the page shows it; it is not listed as an item.

## Seams

- **Canvas seam** (`src/canvas`): everything the extension asks Canvas goes through one `get(url)` adapter. In the panel the adapter asks a tiny script in the Canvas tab, which fetches with the student's own session; in tests it serves recorded responses.
- **File seam** (`src/pack`): the pack reads file details, bytes and page renders through adapters, so the whole pack can be built in Node.
