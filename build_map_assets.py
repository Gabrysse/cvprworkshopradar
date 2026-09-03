#!/usr/bin/env python3
"""Render venue PDFs and create best-effort, conference-scoped room coordinates.

Exact room aliases vary by venue, so unresolved locations are reported instead of
inventing pins. Add aliases or coordinates to the generated JSON after review.
"""

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

try:
    import fitz
except ImportError as exc:
    raise SystemExit("Missing pymupdf. Install it with: pip install pymupdf") from exc


def normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--conference", required=True)
    parser.add_argument("--events", type=Path, required=True)
    parser.add_argument("--maps", nargs="+", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.events.read_text(encoding="utf-8"))
    locations = {event.get("location", "").strip() for group in (data.get("workshops", []), data.get("tutorials", [])) for event in group if event.get("location", "").strip()}
    root = Path(__file__).parent
    conference_dir = args.events.parent.parent if args.events.parent.name == "data" else args.events.parent
    out_dir = conference_dir / "maps" / "images"
    out_dir.mkdir(parents=True, exist_ok=True)
    words, images = defaultdict(list), {}
    for index, pdf_path in enumerate(args.maps, 1):
        doc = fitz.open(pdf_path)
        page = doc[0]
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        image = out_dir / f"map_{args.conference}_{index}.png"
        pix.save(str(image))
        images[str(index)] = str(image.relative_to(root))
        for x0, y0, x1, y1, text, *_ in page.get_text("words"):
            words[normalise(text)].append((index, x0 * 2, y0 * 2, (x1 - x0) * 2, (y1 - y0) * 2))
        doc.close()
    coords, unresolved = {}, []
    for location in sorted(locations):
        hits = words.get(normalise(location), [])
        if len(hits) == 1:
            page, x, y, width, height = hits[0]
            coords[location] = {"page": page, "x": round(x, 1), "y": round(y, 1), "w": round(width, 1), "h": round(height, 1)}
        else:
            unresolved.append(location)
    maps_dir = conference_dir / "maps"
    maps_dir.mkdir(parents=True, exist_ok=True)
    coords_path = maps_dir / "room_coords.json"
    coords_path.write_text(json.dumps(coords, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    manifest_path = maps_dir / "map_manifest.json"
    manifest_path.write_text(json.dumps({"room_coords_file": str(coords_path.relative_to(root)), "map_images": images}, indent=2) + "\n", encoding="utf-8")
    print(f"Rendered {len(images)} map(s); resolved {len(coords)}/{len(locations)} rooms → {coords_path}")
    print(f"Map config fragment → {manifest_path}")
    if unresolved:
        print("Unresolved rooms (add aliases/coordinates after visual review): " + ", ".join(unresolved))


if __name__ == "__main__":
    main()
