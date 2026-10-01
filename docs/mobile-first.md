# Mobile-first product requirement

Capykit's primary human workflow is phone use on the go. Design and validate the
phone experience first, then expand it for tablets and desktops. This applies
to new integrations, capabilities, access management, execution and run history.

## Acceptance bar for every console change

- Start with a usable single-column layout at 320–430 CSS pixels. Expand with
  minimum-width media queries; avoid shrinking a desktop layout onto a phone.
- Keep navigation available while scrolling, with clear active state. Make the
  next action visible and avoid hover-only interactions.
- Give buttons and links styled as buttons at least 44px touch targets. Make
  checkbox labels and disclosure rows comfortably tappable, with enough spacing
  to avoid accidental destructive actions.
- Use at least 16px text in editable controls on phones. Preserve browser zoom,
  native input controls, OTP autofill and appropriate keyboards. Identifiers
  should not autocapitalize or autocorrect.
- Stack form fields and action groups. Long names and error messages must wrap.
  Do not allow horizontal page scrolling. Wide tables and code can scroll within
  their own labeled containers.
- Respect safe areas and the on-screen keyboard. Avoid fixed overlays that hide
  active fields or confirmation controls. Keep explicit consent and destructive
  confirmations accessible.
- Preserve partially completed forms through transient session checks and tab
  changes; show clear retry and recovery states for mobile network interruptions.
- Verify sign-in, capability creation/details, provider repository selection,
  grant approval and revocation at small phone widths and at desktop width.
  Check screenshots, touch dimensions, keyboard focus and page overflow.

Use Chromium and WebKit browser checks where available. Emulated viewport checks
cannot prove physical iPhone Safari behavior, password-manager behavior or the
real on-screen keyboard. Record those limits; do not claim device verification
without using the device.

## Current implementation

The console uses phone styles by default, expands at 641px and 901px, and keeps
workspace navigation sticky on phones. Form controls retain 16px text, actions
stack, and interactive controls have at least 44px height. Existing session,
connection consent and grant authorization rules are unchanged.

Native apps, offline execution and installable PWA behavior require separate
product decisions; mobile-first web use does not depend on those features.
