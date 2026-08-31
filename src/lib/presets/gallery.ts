// The user-submitted systems gallery: hand-curated, static, and split in two.
//
// This module is the eager-loaded half — id, name, attribution, a curator's
// blurb and the screenshot framing. The systems themselves live at
// `public/gallery/<id>.json`, fetched only when an entry is loaded and parsed
// through `parseSystemFile` like any untrusted import, so the cold page load
// carries a few strings per entry rather than every submitted roster.
//
// Nothing lands here directly from a submission: entries are hand-reviewed and
// added with `npm run gallery-add`, which validates the JSON, writes the file
// and appends the metadata entry below. Thumbnails at `public/gallery/<id>.jpg`
// come from `npm run preset-screenshots -- --gallery`, framed by each entry's
// `shot` exactly as preset thumbnails are (see `PresetShot` in `examples.ts`).
// `gallery.test.ts` keeps the three pieces — entry, JSON, thumbnail — in sync.

import type { PresetShot } from "./examples";

export const GALLERY_FORM_URL = "https://forms.gle/HdE52KXWQtwvGTze9";

export interface GalleryEntry {
	/** Filename stem of `public/gallery/<id>.json` and `<id>.jpg`. */
	id: string;
	/** System name shown on the card (the JSON carries its own; this one wins in the UI). */
	name: string;
	/** Submitter's display name, hand-typed by the curator. */
	by?: string;
	/** Submitter's location or school, ditto. */
	from?: string;
	/** One or two curator's sentences on what's physically interesting here. */
	blurb: string;
	/** Thumbnail framing for `npm run preset-screenshots -- --gallery`. */
	shot: PresetShot;
}

export const GALLERY: GalleryEntry[] = [
	// A seed entry so the gallery has a valid card before any real submission
	// lands. Replace freely.
	{
		id: "seed-still-point",
		name: "24x7 Daylight",
		by: "Andrew",
		from: "NYC",
		blurb:
			"Can you imagine a world where, just as one sun is setting, a second sun is rising? This system can only work with the planet perfectly centered. Even a tiny bit of velocity will throw it out of its placement.",
		shot: { days: 75, exaggeration: 300, zoom: 1.5e11, parentRelativeTrails: false }
	},
	{
		id: "verith-system",
		name: "The Verith System",
		by: "Eliot",
		from: "PS 34",
		blurb:
			"A complex star system with inner planets, a ringed gas giant with a set of moons, an asteroid belt full of satellites, and a super-Jupiter with its own miniature planetary system of more than a dozen moons.",
		shot: { days: 1650, exaggeration: 400, zoom: 8.5e11, center: "Verith" }
	}
	// gallery-add inserts new entries above this line — keep this comment.
];

export function galleryEntryById(id: string): GalleryEntry | undefined {
	return GALLERY.find((e) => e.id === id);
}
