# Canvas to AI

Tools for getting Canvas LMS course materials into AI chats.

- **[extension/](extension/)**: Chrome extension (side panel). Lists every file in a course by week, downloads the ones you pick, or converts them to one Markdown file (+ images) for AI. Uses your normal Canvas login. **Quick install:** download `canvas-to-ai.zip` from the [latest release](../../releases/latest), unzip, then `chrome://extensions` → Developer mode → Load unpacked.
- **canvas_dl.py**: Python CLI that does the listing/downloading with a personal access token (`uv run canvas_dl.py <course_id>`; see `.env.example`).
