// Transient notifications — merge announcements and feedback for user actions
// (save, export, import). Timed on the wall clock, not sim time: they narrate
// events for the user, so they must behave the same whether the sim is
// playing, paused or scrubbing.

export interface Toast {
	id: number;
	kind: 'ok' | 'error';
	text: string;
}

let nextId = 1;

export const toasts = $state<Toast[]>([]);

export function toast(kind: Toast['kind'], text: string, duration = 4000) {
	const id = nextId++;
	toasts.push({ id, kind, text });
	setTimeout(() => {
		const i = toasts.findIndex((t) => t.id === id);
		if (i !== -1) toasts.splice(i, 1);
	}, duration);
}
