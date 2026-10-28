# /// script
# requires-python = ">=3.11"
# dependencies = ["requests", "questionary", "python-dotenv"]
# ///
"""List every file you can download from a Canvas course, grouped by module
(week), announcement and syllabus, then pick which ones to download.

Usage:
    uv run canvas_dl.py 181252            # interactive picker
    uv run canvas_dl.py 181252 --list     # just print what's available
    uv run canvas_dl.py 181252 --all      # download everything

Config (env vars or a .env file next to this script):
    CANVAS_TOKEN=...                      # Account > Settings > New access token
    CANVAS_URL=https://rmit.instructure.com
"""

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import questionary
import requests
from dotenv import load_dotenv

FILE_LINK = re.compile(r"/files/(\d+)")
# Module item types whose body can embed links to course files.
HTML_ITEM_TYPES = {"Page", "Assignment", "Discussion"}


@dataclass
class CanvasFile:
    id: int
    name: str
    size: int = 0
    url: str = ""
    unavailable: str = ""  # reason it can't be downloaded, if any


@dataclass
class Group:
    title: str
    files: list[CanvasFile] = field(default_factory=list)


class Canvas:
    def __init__(self, base_url: str, token: str):
        self.base = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"
        self._files: dict[int, CanvasFile] = {}

    def get(self, path: str, **params):
        url = path if path.startswith("http") else f"{self.base}/api/v1{path}"
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        return resp

    def get_all(self, path: str, **params) -> list:
        """Follow Canvas pagination (Link: rel="next") and return every item."""
        resp = self.get(path, per_page=100, **params)
        items = resp.json()
        while "next" in resp.links:
            resp = self.get(resp.links["next"]["url"])
            items.extend(resp.json())
        return items

    def file(self, file_id: int) -> CanvasFile:
        if file_id not in self._files:
            try:
                data = self.get(f"/files/{file_id}").json()
                f = CanvasFile(file_id, data["display_name"], data.get("size", 0), data.get("url", ""))
                if data.get("locked_for_user") or not f.url:
                    f.unavailable = data.get("lock_explanation") or "locked"
            except requests.HTTPError as e:
                f = CanvasFile(file_id, f"file {file_id}", unavailable=f"HTTP {e.response.status_code}")
            self._files[file_id] = f
        return self._files[file_id]

    def files_in(self, html: str | None, attachments: list | None = None) -> list[CanvasFile]:
        ids = [a["id"] for a in attachments or []]
        ids += [int(m) for m in FILE_LINK.findall(html or "")]
        return [self.file(i) for i in dict.fromkeys(ids)]  # dedupe, keep order


def collect(canvas: Canvas, course_id: str) -> tuple[str, list[Group]]:
    course = canvas.get(f"/courses/{course_id}", **{"include[]": "syllabus_body"}).json()
    groups: list[Group] = []

    for module in canvas.get_all(f"/courses/{course_id}/modules"):
        print(f"  scanning module: {module['name']}", file=sys.stderr)
        group = Group(module["name"])
        for item in canvas.get_all(f"/courses/{course_id}/modules/{module['id']}/items"):
            if item["type"] == "File":
                group.files.append(canvas.file(item["content_id"]))
            elif item["type"] in HTML_ITEM_TYPES and item.get("url"):
                try:
                    data = canvas.get(item["url"]).json()
                except requests.HTTPError:
                    continue  # locked or hidden item
                html = data.get("body") or data.get("description") or data.get("message")
                group.files += canvas.files_in(html, data.get("attachments"))
        groups.append(group)

    print("  scanning announcements", file=sys.stderr)
    for ann in canvas.get_all(f"/courses/{course_id}/discussion_topics", only_announcements="true"):
        date = (ann.get("posted_at") or "")[:10]
        groups.append(Group(f"Announcement {date} · {ann['title']}", canvas.files_in(ann.get("message"), ann.get("attachments"))))

    groups.append(Group("Syllabus", canvas.files_in(course.get("syllabus_body"))))

    for g in groups:  # same file linked twice in one group
        g.files = list({f.id: f for f in g.files}.values())
    return course["name"], [g for g in groups if g.files]


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip(" .")[:150]


def pick(groups: list[Group]) -> list[tuple[int, Group, CanvasFile]]:
    choices = []
    for gi, g in enumerate(groups):
        choices.append(questionary.Separator(f"\n── {g.title} ──"))
        for f in g.files:
            label = f"{f.name}  ({human_size(f.size)})"
            disabled = f"unavailable: {f.unavailable}" if f.unavailable else None
            choices.append(questionary.Choice(label, value=(gi, g, f), disabled=disabled))
    return questionary.checkbox(
        "Select files (space = toggle, a = all, i = invert, enter = download)",
        choices=choices,
    ).ask() or []


def download(canvas: Canvas, picks, out_dir: Path) -> None:
    for gi, g, f in picks:
        folder = out_dir / f"{gi + 1:02d} {safe(g.title)}"
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / safe(f.name)
        if dest.exists() and dest.stat().st_size == f.size:
            print(f"  skip (exists) {dest}")
            continue
        print(f"  ↓ {dest}")
        with canvas.session.get(f.url, stream=True, timeout=120) as resp:
            resp.raise_for_status()
            with open(dest, "wb") as fh:
                for chunk in resp.iter_content(1 << 16):
                    fh.write(chunk)


def main() -> None:
    load_dotenv(Path(__file__).with_name(".env"))
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("course_id")
    parser.add_argument("--list", action="store_true", help="print available files and exit")
    parser.add_argument("--all", action="store_true", help="download every available file")
    parser.add_argument("--out", default="downloads", help="output folder (default: downloads)")
    args = parser.parse_args()

    token = os.environ.get("CANVAS_TOKEN")
    if not token:
        sys.exit("Set CANVAS_TOKEN (env var or .env file). See .env.example.")
    canvas = Canvas(os.environ.get("CANVAS_URL", "https://rmit.instructure.com"), token)

    course_name, groups = collect(canvas, args.course_id)
    total = sum(len(g.files) for g in groups)
    print(f"\n{course_name}: {total} files in {len(groups)} groups\n")

    if args.list:
        for g in groups:
            print(f"── {g.title}")
            for f in g.files:
                note = f"  [unavailable: {f.unavailable}]" if f.unavailable else ""
                print(f"   {f.name}  ({human_size(f.size)}){note}")
        return

    if args.all:
        picks = [(gi, g, f) for gi, g in enumerate(groups) for f in g.files if not f.unavailable]
    else:
        picks = pick(groups)
    if not picks:
        print("Nothing selected.")
        return
    download(canvas, picks, Path(args.out) / safe(course_name))
    print(f"\nDone: {len(picks)} files → {Path(args.out) / safe(course_name)}")


if __name__ == "__main__":
    main()
