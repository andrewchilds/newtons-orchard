// Which chrome layout is on screen, and (in the compact one) which sheet is up.
//
// The desktop chrome is a set of floating panels that assume a window: a
// 260 px column down the left, a toolbar row across the top right, a 720 px
// time panel at the bottom. On a phone those overlap the scene more than they
// leave of it, so below a threshold the app swaps to a single icon toolbar
// whose buttons each open one sheet at a time.
//
// This is a *layout* decision, not a device one: it keys off viewport size and
// pointer coarseness, so a narrow desktop window gets the compact chrome too
// (and it can be driven in a headless browser without emulating a touchscreen).

/** Viewport widths at or below this get the compact chrome. */
export const COMPACT_MAX_WIDTH = 720;

/**
 * Short viewports get it as well — a landscape phone is wide enough for the
 * desktop toolbar but has nowhere to put two stacked panels.
 */
export const COMPACT_MAX_HEIGHT = 500;

/**
 * The panels the compact toolbar opens. `null` is "no sheet up", which is the
 * point of the layout: the default state is the bare scene plus one icon row.
 */
export type CompactPanel =
  | 'objects'
  | 'properties'
  | 'time'
  | 'camera'
  | 'history'
  | 'display';

const QUERY = `(max-width: ${COMPACT_MAX_WIDTH}px), (max-height: ${COMPACT_MAX_HEIGHT}px)`;

class LayoutState {
  /**
   * True when the compact chrome is in force. Seeded synchronously so the first
   * render already picks the right layout — mounting the desktop chrome and
   * swapping it on the next tick flashes a full-width column on a phone.
   */
  compact = $state(matchesCompact());

  /** The sheet currently up in the compact chrome, or null for the bare scene. */
  panel = $state<CompactPanel | null>(null);

  /** Toggle a sheet. Opening one closes whatever was up — only one fits. */
  toggle(panel: CompactPanel): void {
    this.panel = this.panel === panel ? null : panel;
  }

  close(): void {
    this.panel = null;
  }

  /**
   * Track the viewport. Called once from App's setup; the returned teardown is
   * what the effect hands back to Svelte.
   */
  watch(): () => void {
    if (typeof matchMedia !== 'function') return () => {};
    const list = matchMedia(QUERY);
    const onChange = () => {
      this.compact = list.matches;
      // A sheet is meaningless in the desktop chrome, and leaving one "open"
      // would re-show it on the next rotation back into compact.
      if (!list.matches) this.panel = null;
    };
    list.addEventListener('change', onChange);
    onChange();
    return () => list.removeEventListener('change', onChange);
  }
}

/** Guarded for the non-DOM test environment, like `ui/motion.ts`. */
function matchesCompact(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
}

export const layout = new LayoutState();
