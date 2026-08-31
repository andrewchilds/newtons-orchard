#!/usr/bin/env python3
"""Generate the preset thumbnails shown in the "Load a system" dialog.

For each preset that declares a `shot` config (see `presets/examples.ts`), this
loads the app in a real browser, hands the preset to the app's capture hook —
which loads it, runs the sim forward, frames the camera and hides the UI chrome
— then photographs the canvas into `public/presets/<id>.jpg`.

    npm run preset-screenshots              # every preset
    npm run preset-screenshots -- solar-system binary-stars
    npm run preset-screenshots -- --missions             # mission card portraits
    npm run preset-screenshots -- --missions full-stop   # one mission
    npm run preset-screenshots -- --gallery              # user-gallery thumbnails
    npm run preset-screenshots -- --gallery seed-figure-eight

`--missions` shoots the mission cards instead (see `presets/missions.ts`,
each mission's `shot`) into `public/missions/<id>.jpg`. `--gallery` shoots the
user-submitted gallery (see `presets/gallery.ts`, each entry's `shot`) into
`public/gallery/<id>.jpg`, next to the entry's system JSON.

The framing lives in `examples.ts` next to each preset, not here: this file only
knows how to drive a browser. To retune a thumbnail, change that preset's `shot`
and re-run it by id.

Needs a dev or preview server on :5317 (`npm run dev`) — pass --url for another.
Run it with the Playwright-equipped Python env, as with driver.py:

    /Users/andrew/Projects/local-python-env/bin/python scripts/preset-screenshots.py

Exits non-zero if any preset fails or the page logs a console error, so it can
gate a commit.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from playwright.sync_api import Error as PlaywrightError, sync_playwright

DEFAULT_URL = "http://localhost:5317"
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "public" / "presets"
MISSIONS_OUT = REPO_ROOT / "public" / "missions"
GALLERY_OUT = REPO_ROOT / "public" / "gallery"

# The dialog's cards are 16:10 and at most ~300 px wide; shooting at 1200×750
# leaves room for a 2× display without carrying a full-viewport image per card.
SHOT_WIDTH = 1200
SHOT_HEIGHT = 750

# Same flags as driver.py: headless Chrome has no working WebGL without them and
# the scene silently never mounts. See driver.py's docstring.
CHROME_ARGS = [
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
]

# SwiftShader renders the scene on the CPU; a swarm preset at full trail length
# takes far longer per frame than a GPU would, and the capture hook waits on
# animation frames.
SHOOT_TIMEOUT_MS = 180_000


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("presets", nargs="*", help="preset ids to shoot (default: all)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--missions",
        action="store_true",
        help="shoot mission card portraits into public/missions/ instead of presets",
    )
    group.add_argument(
        "--gallery",
        action="store_true",
        help="shoot user-gallery thumbnails into public/gallery/ instead of presets",
    )
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--out", default=None, help="output directory")
    parser.add_argument("--width", type=int, default=SHOT_WIDTH)
    parser.add_argument("--height", type=int, default=SHOT_HEIGHT)
    parser.add_argument("--quality", type=int, default=82, help="JPEG quality")
    parser.add_argument("--headed", action="store_true", help="show the browser window")
    return parser.parse_args(argv)


def capture_url(url: str) -> str:
    """Add `capture=1`, which keeps the first-visit welcome dialog shut.

    This browser profile is throwaway, so every run is a first visit and the
    welcome would otherwise cover the scene in every thumbnail.
    """
    parts = urlsplit(url)
    query = parse_qsl(parts.query)
    if not any(key == "capture" for key, _ in query):
        query.append(("capture", "1"))
    return urlunsplit(parts._replace(query=urlencode(query)))


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    args.url = capture_url(args.url)
    default_out = MISSIONS_OUT if args.missions else GALLERY_OUT if args.gallery else DEFAULT_OUT
    out = Path(args.out) if args.out else default_out
    out.mkdir(parents=True, exist_ok=True)

    console_errors: list[str] = []
    failures: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",  # system Chrome; no download needed
            headless=not args.headed,
            args=CHROME_ARGS,
        )
        page = browser.new_page(
            viewport={"width": args.width, "height": args.height},
            device_scale_factor=1,
        )
        # `shoot` waits on animation frames while the sim integrates years of
        # trajectory; under SwiftShader that outruns the 30 s default.
        page.set_default_timeout(SHOOT_TIMEOUT_MS)
        page.on(
            "console",
            lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
        )
        page.on("pageerror", lambda err: console_errors.append(str(err)))

        print(f"loading {args.url}")
        try:
            page.goto(args.url, wait_until="networkidle")
            page.wait_for_selector("canvas", timeout=10_000)
            # The hook is installed on mount; the scene needs a beat past that.
            page.wait_for_function("() => !!window.__capture", timeout=10_000)
            page.wait_for_timeout(1_000)
        except PlaywrightError as err:
            print(f"FAILED to load the app: {err}")
            print("is a dev server running on :5317? (npm run dev)")
            browser.close()
            return 1

        ids_fn = "missionIds" if args.missions else "galleryIds" if args.gallery else "ids"
        shoot_fn = "shootMission" if args.missions else "shootGallery" if args.gallery else "shoot"
        ids = args.presets or page.evaluate(f"() => window.__capture.{ids_fn}()")
        kind = "mission" if args.missions else "gallery entry" if args.gallery else "preset"
        print(f"shooting {len(ids)} {kind}(s) at {args.width}×{args.height}")

        for preset_id in ids:
            print(f"  {preset_id} … ", end="", flush=True)
            before = len(console_errors)
            try:
                # Playwright awaits the returned promise, so this blocks until
                # the scene has settled into the shot.
                page.evaluate(f"id => window.__capture.{shoot_fn}(id)", preset_id)
            except PlaywrightError as err:
                print(f"FAILED: {err}")
                failures.append(preset_id)
                continue

            path = out / f"{preset_id}.jpg"
            page.screenshot(path=str(path), type="jpeg", quality=args.quality)
            new_errors = console_errors[before:]
            note = f" ({len(new_errors)} console errors)" if new_errors else ""
            print(f"{path.relative_to(REPO_ROOT)}{note}")

        browser.close()

    if console_errors:
        print(f"console errors ({len(console_errors)}):")
        for text in console_errors[:10]:
            print(f"  {text}")
    if failures:
        print(f"failed: {', '.join(failures)}")

    return 1 if (failures or console_errors) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
