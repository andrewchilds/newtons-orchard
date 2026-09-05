export const CONTACT_EMAIL = 'hello@newtonsorchard.app';

// Gallery submissions are plain email: a share link plus the three things the
// curator hand-types into `gallery.ts`. The body is a fill-in template so the
// sender doesn't have to remember what to include. The link itself is left for
// them to paste — it can run past 2k characters, which some mail clients
// silently drop from a `mailto:` body.
export const GALLERY_SUBMISSION_MAILTO = `mailto:${CONTACT_EMAIL}?${new URLSearchParams({
  subject: 'Gallery submission',
  body: [
    'Share link: ',
    'Your name: ',
    'System name: ',
    'What makes it interesting: ',
    '',
  ].join('\n'),
})
  .toString()
  .replaceAll('+', '%20')}`;
