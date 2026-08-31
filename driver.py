#!/usr/bin/env python3
"""Drive the running app in a real browser and screenshot it.

Most changes here have manual acceptance criteria, so `npm run check` and
`npm test` aren't enough — the app has to be clicked. This is the harness for
that.

Run it with the Playwright-equipped Python env (see CLAUDE.md):

    /Users/andrew/Projects/local-python-env/bin/python driver.py

By default it loads the app, waits for the canvas, and writes one screenshot.
Pass a *script* — a file of one-command-per-line steps — to drive further:

    /Users/andrew/Projects/local-python-env/bin/python driver.py steps.txt

Step commands (blank lines and `#` comments ignored):

    click SELECTOR          click the first match
    dblclick SELECTOR       double-click the first match
    drag X1 Y1 X2 Y2        press, move (trusted mouse events), release
    shiftdrag X1 Y1 X2 Y2   same, with Shift held throughout (camera pan)
    mousedown X Y           press and hold at (X, Y) — pair with mouseup
    mousemove X Y           move the held (or free) mouse
    mouseup                 release; in-gesture UI needs shots between these
    fill SELECTOR VALUE     type into an input
    select SELECTOR VALUE   pick an <option> by value
    key KEYNAME             press a key, e.g. Escape
    keydown KEYNAME         hold a key (e.g. Shift across a split drag)
    keyup KEYNAME           release it
    wait MS                 pause
    shot NAME               screenshot to OUT/NAME.png
    box SELECTOR            print the element's bounding rect
    text SELECTOR           print the element's text content
    eval JS                 run JS in the page and print it; `return` the value

Options: --url, --out, --width, --height, --headed, --keep-open, --welcome.

Two things about this environment cost real time to rediscover, so they're
baked in here: the launch uses the *system* Chrome (Playwright's own Chromium
isn't installed and downloading it is slow/blocked), and headless Chrome needs
the SwiftShader flags below or WebGL silently fails — the Svelte UI renders but
`document.querySelector('canvas')` is null and the scene never mounts, which
looks like an app bug and isn't.
"""

from __future__ import annotations

import argparse
import shlex
import sys
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError, sync_playwright

DEFAULT_URL = "http://localhost:5317"

# Without these, headless Chrome has no working WebGL and the scene never mounts.
CHROME_ARGS = [
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("script", nargs="?", help="file of driver steps (see module docstring)")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--out", default="screenshots", help="screenshot directory")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--headed", action="store_true", help="show the browser window")
    parser.add_argument("--keep-open", action="store_true", help="hold the browser open until Enter")
    parser.add_argument("--welcome", action="store_true", help="keep the first-visit welcome dialog")
    return parser.parse_args(argv)


def unquote(text: str) -> str:
    """Drop one wrapping quote pair, as shlex would for a selector argument.

    JS bodies can't go through shlex — it would eat the quotes *inside* the
    snippet too — but they still get wrapped like every other step argument.
    """
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def read_steps(path: str | None) -> list[str]:
    if not path:
        return []
    lines = Path(path).read_text().splitlines()
    return [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]


def run_step(page, step: str, out: Path, shot_index: list[int]) -> None:
    """Execute one step line. Selector/value args are shell-quoted."""
    command, _, rest = step.partition(" ")
    rest = rest.strip()

    if command == "wait":
        page.wait_for_timeout(int(rest))
    elif command == "key":
        page.keyboard.press(rest)
    elif command == "keydown":
        page.keyboard.down(rest)
    elif command == "keyup":
        page.keyboard.up(rest)
    elif command == "eval":
        # Wrapped in an arrow so multi-statement bodies work; Playwright treats
        # a bare statement list as a string literal and hands it straight back.
        body = unquote(rest)
        print(f"  eval → {page.evaluate(f'() => {{ {body} }}')!r}")
    elif command == "shot":
        shot_index[0] += 1
        name = rest or f"step-{shot_index[0]:02d}"
        path = out / f"{name}.png"
        page.screenshot(path=str(path))
        print(f"  shot → {path}")
    elif command in {"mousedown", "mousemove"}:
        # The atomic drag can't photograph mid-gesture UI (the rotation pivot,
        # drag previews); these split it so a `shot` fits between press and
        # release. Trusted events for the same reason as drag.
        x, y = (float(v) for v in rest.split())
        page.mouse.move(x, y, steps=5 if command == "mousemove" else 1)
        if command == "mousedown":
            page.mouse.down()
    elif command == "mouseup":
        page.mouse.up()
    elif command in {"drag", "shiftdrag"}:
        # Real mouse events, not dispatched ones — camera controls call
        # setPointerCapture, which throws on a synthetic pointerId.
        x1, y1, x2, y2 = (float(v) for v in rest.split())
        # Shift is held down across the whole gesture: the pan modifier is read
        # on keydown and again on every move, so pressing it mid-drag or
        # releasing it early gives a different result than a real user's drag.
        if command == "shiftdrag":
            page.keyboard.down("Shift")
        page.mouse.move(x1, y1)
        page.mouse.down()
        page.mouse.move(x2, y2, steps=10)
        page.mouse.up()
        if command == "shiftdrag":
            page.keyboard.up("Shift")
    elif command in {"click", "dblclick", "box", "text"}:
        selector = shlex.split(rest)[0]
        locator = page.locator(selector).first
        if command == "click":
            locator.click()
        elif command == "dblclick":
            locator.dblclick()
        elif command == "text":
            print(f"  text {selector} → {locator.inner_text()!r}")
        else:
            print(f"  box {selector} → {locator.bounding_box()}")
    elif command in {"fill", "select"}:
        selector, value = shlex.split(rest)[:2]
        locator = page.locator(selector).first
        if command == "fill":
            locator.fill(value)
        else:
            locator.select_option(value)
    else:
        raise ValueError(f"unknown step: {step!r}")

    # Steps drive an animating WebGL scene; a beat after each one keeps
    # screenshots from catching a half-applied transition.
    if command not in {"wait", "box", "text", "eval"}:
        page.wait_for_timeout(250)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    steps = read_steps(args.script)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    console_errors: list[str] = []
    failed = False

    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",  # system Chrome; no download needed
            headless=not args.headed,
            args=CHROME_ARGS,
        )
        page = browser.new_page(viewport={"width": args.width, "height": args.height})
        page.on(
            "console",
            lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
        )
        page.on("pageerror", lambda err: console_errors.append(str(err)))

        # Playwright launches a fresh profile, so every run reads as a first
        # visit and the welcome dialog covers the UI — clicks on anything
        # behind it time out. Pre-seed the app's welcomed flag (the value
        # `markWelcomed` in storage/persistence.ts writes) unless the welcome
        # itself is what's being tested.
        if not args.welcome:
            page.add_init_script("localStorage.setItem('space-sim:welcomed', 'true')")

        print(f"loading {args.url}")
        page.goto(args.url, wait_until="networkidle")

        # The canvas is the signal that the scene actually mounted — a null one
        # here means WebGL failed, not that the app is broken.
        try:
            page.wait_for_selector("canvas", timeout=10000)
            page.wait_for_timeout(1500)  # let the first frames render
            print("canvas: mounted")
        except PlaywrightError:
            print("canvas: MISSING — WebGL likely failed to initialize")
            failed = True

        page.screenshot(path=str(out / "00-load.png"))
        print(f"  shot → {out / '00-load.png'}")

        shot_index = [0]
        for step in steps:
            print(f"step: {step}")
            try:
                run_step(page, step, out, shot_index)
            except Exception as err:  # keep going; a later step may still be informative
                print(f"  FAILED: {err}")
                failed = True

        if console_errors:
            print(f"console errors ({len(console_errors)}):")
            for text in console_errors[:10]:
                print(f"  {text}")
            failed = True
        else:
            print("console errors: none")

        if args.keep_open:
            input("press Enter to close the browser… ")

        browser.close()

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
