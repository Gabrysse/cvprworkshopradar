# Technical Details

## Data Pipeline

The data displayed on Workshop Radar is produced by a multi-stage pipeline that goes from a PDF programme or official web listing to a structured JSON file with extracted schedules.

## Conference registry

`conferences.json` selects the active conference and lists archived ones. A record has an ID, display metadata, status, theme, official source links, and—once ready—a data file. Conference-specific artefacts live under `conferences/<conference-id>/`: `data/` for programme JSON and extraction diagnostics, `source/` for supplied PDFs, and `maps/` for floor plans, images, and coordinates. Map fields are optional. The site loads this registry first, so an `upcoming` conference can show a waiting state without incomplete event data.

Browser state is namespaced by conference ID. Date filters, calendar days, and map assets are derived from the selected conference rather than fixed CVPR values.

### Stage 1 — Initial extraction

For CVPR-style PDFs, `conferences/cvpr2026/scripts/extract.py --pdf PROGRAM.pdf --output conference.json` uses `pdfplumber` to parse column-aware listings. For official web listings, `extract_web_listing.py` creates an initial event list from public event-site links. `ingest_conference.py` is the interactive entry point and chooses the appropriate path.

### Stage 2 — Schedule extraction (`ollama_extract.py`)

For every event that has a website, `ollama_extract.py --input conference.json` attempts to extract the workshop or tutorial schedule and write it back to that JSON. The algorithm runs in two sequential passes:

**Text pass**

1. The event's website is rendered using Playwright (headless Chromium) to execute JavaScript and obtain the fully-rendered HTML. If `networkidle` times out (common with Squarespace or SPA sites), the script waits a few extra seconds and retries.
2. If the rendered body is shorter than 500 characters, JS may still be running; the script waits 4 seconds and re-fetches the content.
3. Special embedded content is extracted separately:
   - **Google Sheets iframes**: detected by `spreadsheets` + `pub` in the frame URL, then fetched as CSV and appended to the page text.
   - **`about:blank` frames**: used by Google Sites/Docs to inject document content via `gapi.rpc`; the inner `innerText` is captured and prepended.
4. Navigation, script, and footer noise is stripped with BeautifulSoup. Short `<nav>` and `<footer>` blocks are removed, but large ones (e.g. Squarespace content sections) are kept to avoid discarding schedule content.
5. Same-domain links whose text or path matches keywords like *schedule*, *program*, *agenda*, *sessions*, or *talks* are collected as **schedule subpage candidates** and probed in the same way.
6. The cleaned text (capped at 10 000 characters) is sent to a local [Ollama](https://ollama.com/) model (default: `qwen3.5:9b`) with a structured prompt that asks for a Markdown table with columns `Time | Title | Session | Speaker`. If no schedule is found the model returns `NO_SCHEDULE`.

**Vision fallback**

If the text pass fails to find a schedule (or `--vision` is passed), the script collects images from the page:

1. Playwright scrolls the page to trigger lazy-loaded content, then collects image URLs from `<img>` tags (including `data-src` and other lazy-load attributes), `<embed>`/`<object>` elements, `<a>` links pointing to image files, and CSS `background-image` properties.
2. Images whose keyword (*schedule*, *agenda*, *program*) appears in the URL path are prioritised. Up to 3 images are kept.
3. Each image is resized to at most 1024 px on the longest side and JPEG-compressed before being sent inline (base64) to the vision-language model with the same structured prompt.

**Quality assessment**

After extraction the result is stored back to the JSON with `program_text` (the Markdown table, capped at 4 000 characters), `program_found` (boolean), and metadata from the event website. The metadata pass records the complete organizer list and an explicit abstract/description when available, but preserves already-curated CVPR summaries and organizers. Entries marked `manually_adjusted` are never overwritten by subsequent runs.

**CLI options**

```
python3 ollama_extract.py                          # skip already-found, text + vision fallback
python3 ollama_extract.py --force                  # re-extract everything
python3 ollama_extract.py --only-failed            # retry program_found=False entries
python3 ollama_extract.py --no-fallback            # text only, no vision fallback
python3 ollama_extract.py --vision                 # vision only
python3 ollama_extract.py --debug                  # dry-run, write to debug_extract.json
python3 ollama_extract.py --model qwen3.5:0.8b     # override text model
python3 ollama_extract.py --vision-model qwen3-vl:8b  # override vision model
python3 ollama_extract.py --max 5                  # limit to N entries (testing)
python3 ollama_extract.py --url https://...        # single URL (ad-hoc testing)
python3 ollama_extract.py --input conference.json  # update a selected conference
```

Ollama must be running locally (`ollama serve`) and the chosen model must be pulled (`ollama pull qwen3.5:9b`).

### Optional map processing

`build_map_assets.py` renders supplied venue PDFs to `conferences/<id>/maps/images/` and attempts exact room-label matching. It reports unresolved rooms rather than creating misleading pins, and writes a map-config fragment alongside the generated coordinate JSON; review both before adding the fields to `conferences.json`.

---

## Website

The front-end is a **single-page application** with no build step or external framework dependencies. Everything runs from `index.html` + `assets/js/app.js` + `assets/css/styles.css` and is served as a static site (hosted on Vercel).

### Data loading

On startup `app.js` fetches `conferences.json`, then the selected conference's event data and optional room coordinates. All filtering and rendering is done client-side in memory.

### Views

| Tab | Description |
|-----|-------------|
| Browse Events | Card/list grid with live search, date, time slot, type, track, and program-availability filters. Cards link to a modal with full details including the extracted schedule rendered as an HTML table. Upcoming conferences instead show a dedicated waiting state. |
| My Schedule | Saved events stored in `localStorage`; viewable as a flat list or in a calendar-style day view. |
| Settings | Theme toggle and cache-bust reload. |

A **Swipe mode** lets users triage events quickly with keyboard or swipe gestures.

### Map support

Room locations are defined in each conference’s `maps/room_coords.json` as pixel coordinates on its floor-plan images. Clicking a room name in the event detail modal opens the corresponding map with a pin.

### Program rendering

Schedule text stored in `program_text` is rendered by `renderProgram()`: Markdown tables are converted to `<table>` elements with proper `<thead>`/`<tbody>` and time ranges are wrapped in a non-breaking `<span>` so they never wrap mid-range. Plain text (no table syntax) is rendered inside a `<pre>` block.

### Offline support

A service worker (`sw.js`) caches the shell assets, registry, and conference JSON for offline use.

### QR code

`assets/js/qrcode.min.js` (a bundled QR-code library) is used to generate shareable QR codes for individual events directly in the browser.
