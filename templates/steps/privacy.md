# Mask sensitive data

Capture records DOM content, and form inputs are masked by default. Tag anything else that shows personal or sensitive data before the user deploys.

## 1. Find sensitive elements

Look at profile, settings, account, billing, checkout, and messaging screens for elements that render:

- emails, phone numbers, addresses, names, usernames, profile photos
- payment data, account numbers, balances
- passwords, MFA codes, recovery phrases
- government IDs, health data
- free-text fields where users might paste any of the above

## 2. Tag them

Add a class to the element:

- `fs-mask`: keep the layout, hide the text. Use for most PII.
- `fs-exclude`: drop the element from capture entirely. Use for payment fields and secrets.
- `fs-unmask`: re-allow capture inside a masked or excluded parent.

If the app has a consent flow, use the `-without-consent` variants (`fs-mask-without-consent`, `fs-exclude-without-consent`) instead.

Show the user the list of elements and the class you picked for each before editing, unless they told you to go ahead. Check the markup still compiles.

These tags only apply to sessions captured after the deploy.

Details: https://subtext.fullstory.com/guides/sensitive-elements.md and https://subtext.fullstory.com/api/privacy-classes.md
