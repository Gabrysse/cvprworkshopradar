#!/usr/bin/env python3
"""
generate_map.py – Extract room label positions from the CVPR 2026 map PDFs
and render the floor-plan pages as PNG images.

Inputs (under `conferences/cvpr2026/source/`):
  ballroom_level.pdf   – Ballroom Level (Mile High 1-4, Four Seasons 1-4)
  Meeting_Room.pdf     – Meeting Room Level (rooms 101-799)
  Exhibit_Halls.pdf    – Exhibit Halls (rendered for reference only)

Outputs (under `conferences/cvpr2026/maps/`):
  images/map_ballroom.png – rendered floor plan (Ballroom Level)
  images/map_meeting.png  – rendered floor plan (Meeting Room)
  images/map_exhibit.png  – rendered floor plan (Exhibit Halls, reference)
  room_coords.json        – location string → {page, x, y, w, h} in pixels at ZOOM

Usage:
    python3 conferences/cvpr2026/scripts/generate_map.py
"""

import json
import re
from collections import defaultdict
from pathlib import Path

try:
    import fitz  # pymupdf
except ImportError:
    import sys

    sys.exit("pymupdf not found. Run:\n  pip install pymupdf")

# ─── Config ───────────────────────────────────────────────────────────────────
CVPR_DIR = Path(__file__).resolve().parents[1]
JSON_PATH = CVPR_DIR / "data" / "workshops_tutorials.json"

ZOOM = 2.0  # render magnification (1 PDF pt → 2 px)
PAD_X = 18  # horizontal padding around each label bbox (PDF pts)
PAD_Y = 10  # vertical   padding around each label bbox (PDF pts)

# Each floor map: (pdf_filename, page_key, output_image_name)
FLOOR_MAPS = [
    ("ballroom_level.pdf", 1, "map_ballroom.png"),
    ("Meeting_Room.pdf", 2, "map_meeting.png"),
    ("Exhibit_Halls.pdf", 3, "map_exhibit.png"),
]


# ─── Helpers ──────────────────────────────────────────────────────────────────


def extract_word_map(page) -> dict[str, list[tuple]]:
    """
    Return a dict mapping word-text → list of (x0, y0, x1, y1) bboxes,
    one entry per occurrence of that word on the page.
    """
    d: dict[str, list[tuple]] = defaultdict(list)
    for x0, y0, x1, y1, text, *_ in page.get_text("words"):
        d[text].append((x0, y0, x1, y1))
    return d


def merge_bboxes(bboxes: list[tuple]) -> tuple:
    """Merge a list of (x0,y0,x1,y1) tuples into one enclosing bbox."""
    return (
        min(b[0] for b in bboxes),
        min(b[1] for b in bboxes),
        max(b[2] for b in bboxes),
        max(b[3] for b in bboxes),
    )


def bbox_to_coord(bbox: tuple, page_key: int) -> dict:
    """
    Convert a PDF-space bbox (in pts) to a pixel-space coord record.
    Adds PAD_X/PAD_Y on each side and multiplies by ZOOM.
    """
    x0, y0, x1, y1 = bbox
    return {
        "page": page_key,
        "x": round((x0 - PAD_X) * ZOOM, 1),
        "y": round((y0 - PAD_Y) * ZOOM, 1),
        "w": round((x1 - x0 + 2 * PAD_X) * ZOOM, 1),
        "h": round((y1 - y0 + 2 * PAD_Y) * ZOOM, 1),
    }


def pick_best_bbox(bboxes: list[tuple]) -> tuple | None:
    """Return the first bbox (these focused PDFs have no stray duplicates)."""
    return bboxes[0] if bboxes else None


# ─── Location string parser ───────────────────────────────────────────────────


def parse_location_tokens(location: str) -> list[tuple[int, str]]:
    """
    Parse a location string into a list of (page_key, label) tuples.

    Supported formats:
      "505"             → [(2, "505")]           single meeting room
      "102/104"         → [(2, "102"), (2, "104")]  compound meeting rooms
      "Mile High 2B"    → [(1, "2b")]            single MH sub-room
      "Mile High 4AB"   → [(1, "4a"), (1, "4b")] compound MH sub-rooms
      "Four Seasons 2"  → [(1, "2")]             Four Seasons sub-room
      "Fours Seasons 2" → [(1, "2")]             same (typo in source data)
    """
    loc = location.strip()

    # Four Seasons (handle "Fours Seasons" typo)
    m = re.fullmatch(r"Fours?\s+Seasons\s+(\d)", loc, re.IGNORECASE)
    if m:
        return [(1, m.group(1))]

    # Mile High: "Mile High <digit><letters…>"
    # Examples: "Mile High 2B", "Mile High 4AB", "Mile High 1EF"
    m = re.fullmatch(r"Mile\s+High\s+([1-4])([A-Fa-f]+)", loc, re.IGNORECASE)
    if m:
        digit = m.group(1)
        letters = m.group(2).lower()
        return [(1, digit + letter) for letter in letters]

    # Compound meeting rooms separated by "/"
    if "/" in loc:
        rooms = [r.strip() for r in loc.split("/")]
        return [(2, room) for room in rooms]

    # Simple 3-digit meeting room
    if re.fullmatch(r"\d{3}", loc):
        return [(2, loc)]

    return []


# ─── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    mat = fitz.Matrix(ZOOM, ZOOM)

    # ── Render each floor map PDF to PNG and build word maps ─────────────
    page_words: dict[int, dict] = {}
    for pdf_name, page_key, out_name in FLOOR_MAPS:
        pdf_path = CVPR_DIR / "source" / pdf_name
        doc = fitz.open(pdf_path)
        page = doc[0]
        pix = page.get_pixmap(matrix=mat, alpha=False)
        out = CVPR_DIR / "maps" / "images" / out_name
        pix.save(str(out))
        print(f"  Rendered {out_name}  ({pix.width} × {pix.height} px)")
        page_words[page_key] = extract_word_map(page)
        doc.close()

    # ── Collect all unique location strings from the JSON ────────────────
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    all_locations: set[str] = set()
    for lst in (data.get("workshops", []), data.get("tutorials", [])):
        for ev in lst:
            loc = ev.get("location", "").strip()
            if loc:
                all_locations.add(loc)

    # ── Resolve each location → pixel bbox ──────────────────────────────
    coords: dict[str, dict] = {}
    missing: list[str] = []

    for loc in sorted(all_locations):
        tokens = parse_location_tokens(loc)
        if not tokens:
            missing.append(loc)
            continue

        found_bboxes: list[tuple] = []
        page_key = tokens[0][0]  # all tokens for a single location share the page

        for pk, label in tokens:
            wmap = page_words[pk]
            # Try exact match first, then lowercase/uppercase variant
            blist = (
                wmap.get(label)
                or wmap.get(label.lower())
                or wmap.get(label.upper())
                or []
            )
            best = pick_best_bbox(blist) if blist else None
            if best:
                found_bboxes.append(best)

        if found_bboxes:
            merged = merge_bboxes(found_bboxes)
            coords[loc] = bbox_to_coord(merged, page_key)
        else:
            missing.append(loc)

    # ── Write conference-scoped room coordinates ─────────────────────────
    out_json = CVPR_DIR / "maps" / "room_coords.json"
    out_json.write_text(
        json.dumps(coords, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(
        f"\nResolved {len(coords)} / {len(all_locations)} locations  →  {out_json}"
    )
    if missing:
        print(f"  Could not resolve ({len(missing)}): {', '.join(sorted(missing))}")


if __name__ == "__main__":
    main()
