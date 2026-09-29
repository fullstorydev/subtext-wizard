## Step 1: Pre-check

The Subtext capture snippet should already be installed from the earlier snippet step. Confirm it before doing anything else:

- Read `package.json` for `@fullstory/browser`, `@fullstory/react-native`, or `@fullstory/snippet`, or find the snippet's script tag / `init({ orgId })` call in the entry point.

If you cannot find the snippet, stop and tell the user to run the Subtext snippet install first — do not proceed with the steps below.

## Step 2: Explore existing analytics

Do a read-only pass to find what this enrichment will attach to. Only use data already available on the client — do NOT add server calls, API fetches, or new data loading.

Search package dependencies for the analytics SDKs listed in the "Target integrations" section above. Those are the tools the user told us this app uses — prioritize finding them. Also note any other analytics SDK you encounter along the way, and any custom shared analytics wrapper module under `/lib/`, `/utils/`, `/analytics/`.

For each one found, locate where the client is instantiated and where its identify / setUserProperties / setUserVars call is made. We'll attach the Subtext URL to that tool's user metadata in Step 5. Do NOT add new analytics tools — only work with what's already installed.

Also find the place in the codebase where the authenticated user becomes available — login success handler, auth provider, session bootstrap, `getServerSideProps`, or equivalent — for the identity call in Step 4.

## Step 3: Present plan{{PLAN_GATE}}

Before changing any code, put together a single plan that covers everything below. For each item, name the specific file path and show enough surrounding code context that placement can be verified.

1. **User identification** — the file and call site where the authenticated user becomes available, and the React lifecycle hook to use.
2. **Analytics tool linkage** — which analytics tools you detected and the call sites where you'll attach the Subtext URL.
3. **Privacy tags** — list each sensitive element you found, file path, line, and whether you recommend `.fs-mask` or `.fs-exclude`.
4. **Open questions** — ambiguous auth flows, or places where you couldn't find what Step 2 was looking for.

{{PLAN_GATE_DETAIL}}

## Step 4: Identify users

Sessions are far more useful when they're tied to a specific user. Install the following `FS('setIdentity')` call into the codebase so each captured session is associated with the right person.

```js
// This is an example - don't forget to change it!
FS('setIdentity', {
  uid: '<THE_ID_THAT_YOU_USE_IN_YOUR_APP_FOR_THIS_USER>',
  properties: {
    displayName: '<DISPLAY_NAME_HERE>',
    email: '<EMAIL_HERE>',
    // Add your own custom user variables here, details at
    // https://developer.fullstory.com/browser/identification/set-user-properties/
  }
});
```

1. Find the place in the codebase where the authenticated user becomes available — login success handler, auth provider, session bootstrap, `getServerSideProps`, or equivalent. Do NOT call `setIdentity` for anonymous visitors.
2. **In React-based apps, `setIdentity` MUST be called inside a `useEffect` that fires when the authenticated user changes — not on every render and not at module top-level.** Typical shape:

   ```jsx
   useEffect(() => {
     if (!user) return;
     FS('setIdentity', {
       uid: user.id,
       properties: { displayName: user.name, email: user.email },
     });
   }, [user]);
   ```

   For non-React entry points, call it from the lifecycle hook that fires once auth resolves.
3. Replace the placeholder values:
   - `uid` → the stable user id you use internally (never email; emails change).
   - `displayName` and `email` → the user's display name and email.
   - Add any custom user properties already available on the client.
4. {{IDENTITY_GATE}}
5. Verify the file still type-checks and that the effect's dependencies are correct so it does not re-fire on every render.

## Step 5: Link the Subtext URL into existing analytics

For each analytics tool detected in Step 2, attach the current Subtext URL to that tool's user metadata. This means a teammate looking at a user in that tool can click straight through to the matching Subtext session capture.

1. Get the session URL from Fullstory once a session has started:

   ```js
   const subtextUrl = FS('getSession', { format: 'url.now' });
   ```

   This returns the URL to the current session. It is only available after Fullstory has started capturing — in React, read it inside an effect after the snippet has had a chance to initialize.

2. Send it to each detected tool as a user property. **Use the naming convention that tool already uses in this codebase** (snake_case for PostHog, camelCase for Segment, etc.). Call the field `subtext_url` or `subtextUrl` accordingly. Examples for the tools the user selected:

   ```js
{{INTEGRATION_LINKAGE_EXAMPLES}}
   ```

3. If a shared analytics wrapper module exists, attach the property there once rather than at every call site.
4. The session URL can change across sessions — re-attach whenever a new session starts or when the user is re-identified.
5. Do NOT install new analytics tools. Only attach to tools already present in the app.

## Step 6: Mask sensitive data

Sessions can capture any DOM content by default. Before deploying, identify elements that render sensitive or personally identifying information (PII) and tag them so they are excluded or masked from capture.

### Element data capture classes

Add one of these CSS classes to elements that render sensitive content:

- `.fs-exclude` — exclude the element entirely from capture (DOM tree and events)
- `.fs-mask` — keep the element shape, replace visible text with masked characters
- `.fs-unmask` — opt back in to capture inside an excluded/masked ancestor

If the app supports a consent flow, use the consent-aware variants. They behave the same but apply only until the user grants consent:

- `.fs-exclude-without-consent`
- `.fs-mask-without-consent`
- `.fs-unmask-with-consent`

### What to look for

Scan the codebase for elements that render any of the following and add the appropriate class:

- Email addresses, phone numbers, postal addresses
- Full names, usernames, profile photos
- Payment data — card numbers, CVV, billing details
- Auth secrets — passwords, MFA codes, recovery phrases
- Government IDs — SSN, tax ID, driver's license
- Health data, financial balances, account numbers
- Free-text fields where users may paste any of the above (notes, support messages, chat)

### Process

1. Walk the codebase — form inputs (`<input>`, `<textarea>`), profile and settings pages, account/billing pages, chat or messaging UIs, anywhere PII can render.
2. {{PRIVACY_GATE}}
3. Insert the class, then verify the markup still compiles.
4. **Important:** these changes only take effect after the User deploys them. Code-first rules do not retroactively mask sessions that have already been captured.

## Step 7: Explain

After making these changes, {{EXPLAIN_VERB}}:

"Subtext is now wired into user identity and your analytics tools, and sensitive elements are tagged for masking."

Note that the privacy tags added in Step 6 only take effect on **new sessions captured after the deploy**.
