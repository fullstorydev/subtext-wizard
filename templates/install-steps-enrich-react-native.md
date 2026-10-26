## About this app

This is a React Native app using Fullstory's native mobile SDK through `@fullstory/react-native`. Use the React Native API below, not the web `FS('setIdentity')` API or CSS classes. API reference: https://help.fullstory.com/hc/en-us/articles/360052419133-Getting-Started-with-Fullstory-React-Native-Capture

## Step 1: Pre-check

Capture should already be installed from the earlier step. Confirm `@fullstory/react-native` is in `package.json` and its Babel plugin is configured. If it isn't, stop and tell the user to run the Subtext capture install first; do not proceed.

## Step 2: Explore existing analytics

Do a read-only pass. Only use data already available in the app; do NOT add server calls, API fetches, or new data loading.

Search `package.json` for the analytics SDKs listed in the "Target integrations" section above, and note any other analytics SDK or shared analytics wrapper module you find. For each, locate where the client is initialized and where it identifies the user.

Also find where the authenticated user becomes available: auth context/provider, login success handler, or a session store (Redux, Zustand, etc.).

## Step 3: Present plan{{PLAN_GATE}}

Put together a single plan with file paths and enough surrounding context that placement can be verified:

1. **User identification**: the call site where the authenticated user becomes available.
2. **Analytics tool linkage**: the tools you found and where you'll attach the Subtext URL.
3. **Privacy tags**: each sensitive view, file, line, and the `fsClass` you'll add.
4. **Open questions**.

{{PLAN_GATE_DETAIL}}

## Step 4: Identify users

```js
import FullStory from '@fullstory/react-native';

// This is an example - don't forget to change it!
FullStory.identify('<THE_ID_THAT_YOU_USE_IN_YOUR_APP_FOR_THIS_USER>', {
  displayName: '<DISPLAY_NAME_HERE>',
  email: '<EMAIL_HERE>',
});
```

1. Call it once auth resolves with a signed-in user, inside a `useEffect` keyed on the user (not on every render, not at module top level). Do NOT identify anonymous users.
2. `uid` → the stable internal user id (never email). Add custom properties already available in the app. Array values are not supported.
3. On sign-out, call `FullStory.anonymize()`.
4. {{IDENTITY_GATE}}

## Step 5: Link the Subtext URL into existing analytics

1. Get the session URL once capture has started. It's a Promise that resolves to `null` before a session exists:

   ```js
   const subtextUrl = await FullStory.getCurrentSessionURL();
   ```

   `FullStory.onReady()` also resolves with `{ replayStartUrl, replayNowUrl, sessionId }` once the session starts; prefer it when linking at startup.
2. Send it to each detected tool as a user property, using the naming convention the tool already uses in this codebase (`subtext_url` or `subtextUrl`). Use that tool's React Native SDK API. Examples (adapt to the RN SDK):

   ```js
{{INTEGRATION_LINKAGE_EXAMPLES}}
   ```

3. If a shared analytics wrapper exists, attach it there once.
4. Do NOT install new analytics tools.

## Step 6: Mask sensitive data

Tag sensitive views in code so they stay protected regardless of the org's privacy settings. Add an `fsClass` prop to views that render sensitive content:

- `fsClass="fs-exclude"`: drop the view entirely from capture
- `fsClass="fs-mask"`: keep the shape, mask the text
- `fsClass="fs-unmask"`: opt back in inside a masked ancestor
- Consent-aware variants: `fs-exclude-without-consent`, `fs-mask-without-consent`, `fs-unmask-with-consent`

`fsClass` works on core components (`View`, `Text`, `TextInput`, `Image`...). For custom components, pass it through to an inner `View`. For Fabric native components, wrap them in a `<View fsClass="...">`.

Look for: `TextInput`s for passwords, payment details, government IDs, and free text; screens showing email, phone, address, names, avatars, balances, account numbers, or health data; chat/messaging UIs.

1. {{PRIVACY_GATE}}
2. Insert the prop, then verify the file still type-checks.
3. These tags only apply to builds shipped after this change.

## Step 7: Explain

After making these changes, {{EXPLAIN_VERB}}:

"Subtext is now wired into user identity and your analytics tools, and sensitive views are tagged for masking."

Note that the tags added in Step 6 only take effect in **new builds** of the app.
