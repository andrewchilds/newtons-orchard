import { describe, expect, it } from 'vitest';
import { GALLERY } from './gallery';
import { parseSystemFile } from '../storage/persistence';

// The gallery is three pieces per entry — metadata here, system JSON and
// thumbnail under public/gallery/ — kept in sync by hand (gallery-add plus the
// screenshot script). These tests are what catches a half-added or half-removed
// entry: a metadata row with no JSON 404s at load time, an orphaned JSON ships
// dead weight, and a missing thumbnail renders a placeholder card forever.
//
// Files come in through `import.meta.glob` rather than node's fs: the app
// tsconfig deliberately carries no node types, and Vite resolves the glob in
// vitest the same way it would in a build.

const jsonByPath = import.meta.glob('../../../public/gallery/*.json', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

// Lazy on purpose — only the keys matter, so the JPEGs are never actually read.
const allFiles = import.meta.glob('../../../public/gallery/*');

function stem(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
}

const jsonIds = new Set(Object.keys(jsonByPath).map(stem));
const jpgIds = new Set(
	Object.keys(allFiles)
		.filter((p) => p.endsWith('.jpg'))
		.map(stem)
);

describe('gallery metadata', () => {
	it('has unique, filename-safe ids', () => {
		const ids = GALLERY.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
	});

	it('frames every entry with a playable shot and a blurb', () => {
		for (const entry of GALLERY) {
			expect(entry.shot.days, `${entry.id} shot.days`).toBeGreaterThan(0);
			expect(entry.blurb.trim(), `${entry.id} blurb`).not.toBe('');
		}
	});
});

describe('gallery files', () => {
	it('every entry has a system JSON that passes import validation', () => {
		for (const entry of GALLERY) {
			expect(jsonIds.has(entry.id), `missing public/gallery/${entry.id}.json`).toBe(true);
			// parseSystemFile throws ImportError (naming the field) on anything the
			// app would refuse to load, so a bad checked-in file fails loudly here.
			const text = jsonByPath[`../../../public/gallery/${entry.id}.json`];
			const file = parseSystemFile(text);
			expect(file.bodies.length, `${entry.id} bodies`).toBeGreaterThan(0);
		}
	});

	it('every entry has a thumbnail', () => {
		for (const entry of GALLERY) {
			expect(jpgIds.has(entry.id), `missing public/gallery/${entry.id}.jpg`).toBe(true);
		}
	});

	it('has no orphaned or unexpected files', () => {
		const ids = new Set(GALLERY.map((e) => e.id));
		for (const path of Object.keys(allFiles)) {
			const name = path.slice(path.lastIndexOf('/') + 1);
			expect(name, `unexpected file in public/gallery/: ${name}`).toMatch(/\.(json|jpg)$/);
			expect(ids.has(stem(path)), `orphaned file in public/gallery/: ${name}`).toBe(true);
		}
	});
});
