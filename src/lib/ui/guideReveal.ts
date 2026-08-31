/**
 * Scroll a control into view the moment the mission guide points at it. The
 * glow alone isn't enough: the body editor's Mass box mounts below the info
 * readout's fold in the properties panel, and a ring the student can't see
 * points at nothing. `nearest` keeps this a minimal nudge of the enclosing
 * scroller, and an instant one — no animation to fight reduced-motion.
 */
export function revealWhenGuided(node: HTMLElement, guided: boolean) {
  const update = (isGuided: boolean) => {
    if (isGuided) node.scrollIntoView({ block: 'nearest' });
  };
  update(guided);
  return { update };
}
