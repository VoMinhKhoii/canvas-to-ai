# Canvas to AI: privacy policy

Last updated: 13 November 2026

Canvas to AI is a Chrome extension that reads a Canvas course you have open and turns the
materials you pick into text you can paste into an AI chat, or files in your Downloads folder.

## What it reads

When you press **I understand** on the terms card and then scan a course, the extension reads,
from the Canvas site in your open tab and with your own login:

- the course's name, modules, pages, announcements, syllabus and file list;
- the assignments, pages, quizzes, discussions and files outside the modules;
- your own submissions in that course, with earlier attempts;
- your grades (the course total, each assignment's grade, rubric marks and teacher comments) and
  quiz scores;
- your groups' files, pages and discussions in that course;
- the files you pick (slides, PDFs, documents, spreadsheets, code and so on), to convert them.

If you use **Download all of Canvas**, it reads the same things from every course you tick. Where a lecturer wrote
notes on a file you submitted, it asks Canvas's document viewer (Canvadocs, on instructure.com) for
a copy of that file with the notes on it. Only if you turn them on, it also reads:

- discussion replies, including what classmates posted;
- your inbox, archived and sent messages, including what other people wrote to you. Reading them
  does not mark them as read.

These are saved to your Downloads folder and nowhere else.

Nothing is read before you agree to the terms card.

## Where it goes

Nowhere except your own computer.

- Everything is converted inside the extension, on your computer.
- The extension makes requests only to Canvas (`*.instructure.com`) and the hosts Canvas serves
  its files from (`*.canvas-user-content.com`, `*.inscloudgate.net`).
- It sends nothing to the developer or to anyone else. There are no analytics, no tracking, no
  ads and no server.
- The text goes to your clipboard when you press **Copy text for AI**, and files go to your
  Downloads folder when you choose to download them. What you then paste into ChatGPT, Claude,
  Gemini or any other service is governed by that service's own terms and privacy policy.

## What it stores

Two things, in the extension's own storage on your computer: that you agreed to the terms card
(and which version of it), so the card is not shown every time; and, while a Download all of Canvas
is unfinished, what it has read so far (the text of the pages, links to the files) and the names of
the files it has saved, so it can continue after the panel closes or the browser quits. That is
deleted once the download finishes, or when you start over. Otherwise the course is held in memory
while the side panel is open and is gone when you close it.

## What it does not do

- It does not collect, sell or share personal information.
- It does not use your data for advertising, credit or any purpose other than the one above.
- It does not read anything from websites other than Canvas.
- It does not change anything in Canvas. One thing to know: Canvas counts a page, assignment or
  discussion the extension reads as one you viewed, as if you had opened it. A module step that
  only asks you to view an item can then show as done, and your lecturer may see it as viewed.
  Unread inbox messages stay unread.

## Not affiliated

Canvas to AI is made by a student. It is not made or endorsed by Instructure (the maker of
Canvas) or by any school.

## Contact

Questions: open an issue at https://github.com/VoMinhKhoii/canvas-to-ai/issues
