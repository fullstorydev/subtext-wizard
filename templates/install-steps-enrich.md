## Step 1: Pre-check

The capture snippet should already be installed. Confirm it: check `package.json` for `@fullstory/browser`, `@fullstory/react-native`, or `@fullstory/snippet`, or find `_fs_script` / `window['_fs_org'] =` / `init({ orgId` in the entry point.

If you can't find it, stop and tell the user to run the Subtext snippet install first.

## Step 2: Explore

Read-only. Use only data already on the client; don't add API calls or new data loading.

- **Signed-in user**: where the authenticated user becomes available on the client: login handler, auth provider, session bootstrap, or similar.
- **Existing tools**: check `package.json` (and script tags) for analytics, error-tracking, or feature-flag tools, starting with any listed under "Target integrations" above. Common ones: PostHog, Segment, Amplitude, Mixpanel, Sentry, Datadog, LogRocket, Statsig, LaunchDarkly, GrowthBook, Intercom, Pendo, Appcues. Also look for a shared analytics wrapper under `lib/`, `utils/`, or `analytics/`. For each tool, find where it already identifies the user. Don't install new tools.
- **Sensitive elements**: profile, settings, account, billing, checkout, and messaging screens that render personal or sensitive data (see Step 6).

## Step 3: Present plan{{PLAN_GATE}}

Before changing any code, write one plan that names each file and shows enough surrounding code to check placement:

1. **User identification**: the call site where the signed-in user is known.
2. **Analytics linkage**: the tools you found and where you'll attach the Subtext URL.
3. **Privacy tags**: each sensitive element, its file and line, and the class you'll add.
4. **Open questions**: anything ambiguous, or anything Step 2 couldn't find.

{{PLAN_GATE_DETAIL}}

## Step 4: Identify users

Tie each session to the signed-in user so sessions can be found by user.

1. Call `FS('setIdentity')` where the signed-in user becomes available, only for signed-in users:

   ```js
   FS('setIdentity', {
     uid: user.id,
     properties: { displayName: user.name, email: user.email },
   });
   ```

   - `uid` is the stable internal user id, never the email.
   - Add other user properties the client already has, if useful.
2. In React, call it inside a `useEffect` keyed on the user, not on every render or at module top level:

   ```jsx
   useEffect(() => {
     if (!user) return;
     FS('setIdentity', { uid: user.id, properties: { displayName: user.name, email: user.email } });
   }, [user]);
   ```

3. {{IDENTITY_GATE}}

If you can't find where the user is known, or the app has no sign-in, skip this step and say so.

## Step 5: Link sessions into existing tools

If the app already uses analytics, error-tracking, or feature-flag tools, attach the Subtext session URL to them. Then anyone looking at a user or error in that tool can jump to the session.

If none are installed, skip this step.

1. Get the URL once capture has started:

   ```js
   const subtextUrl = FS('getSession', { format: 'url.now' });
   ```

2. Send it to each tool under the key `subtext_url` (or `subtextUrl` where the tool uses camelCase, as in the examples), next to where that tool already identifies the user. For the tools in this app:

   ```js
{{INTEGRATION_LINKAGE_EXAMPLES}}
   ```

3. If there's a shared wrapper, attach it there once. Re-attach when the user is re-identified, since the URL changes between sessions.

## Step 6: Mask sensitive data

Capture records DOM content, and form inputs are masked by default. Tag anything else that shows personal or sensitive data before the user deploys.

### Find sensitive elements

Look at profile, settings, account, billing, checkout, and messaging screens for elements that render:

- emails, phone numbers, addresses, names, usernames, profile photos
- payment data, account numbers, balances
- passwords, MFA codes, recovery phrases
- government IDs, health data
- free-text fields where users might paste any of the above

### Tag them

Add a class to the element:

- `fs-mask`: keep the layout, hide the text. Use for most PII.
- `fs-exclude`: drop the element from capture entirely. Use for payment fields and secrets.
- `fs-unmask`: re-allow capture inside a masked or excluded parent.

If the app has a consent flow, use the `-without-consent` variants (`fs-mask-without-consent`, `fs-exclude-without-consent`) instead.

In React Native, use the `FSMask` / `FSExclude` components from `@fullstory/react-native` instead of classes.

{{PRIVACY_GATE}} Check the markup still compiles.

These tags only apply to sessions captured after the deploy.

## Step 7: Explain

After making these changes, {{EXPLAIN_VERB}}:

"Subtext is now wired into user identity and your analytics tools, and sensitive elements are tagged for masking."

Note that the privacy tags only take effect on **new sessions captured after the deploy**.
