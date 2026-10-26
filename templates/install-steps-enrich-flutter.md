## About this app

This is a Flutter app using Fullstory's native mobile SDK through `fullstory_flutter`. Use the Dart API below, not the web `FS('setIdentity')` API or CSS classes. API reference: https://developer.fullstory.com/mobile/flutter/

## Step 1: Pre-check

Capture should already be installed from the earlier step. Confirm `fullstory_flutter` is in `pubspec.yaml` and the entry point calls `runFullstoryApp`. If it isn't, stop and tell the user to run the Subtext capture install first; do not proceed.

## Step 2: Explore existing analytics

Do a read-only pass. Only use data already available in the app; do NOT add server calls, API fetches, or new data loading.

Search `pubspec.yaml` for the analytics SDKs listed in the "Target integrations" section above (their Flutter packages, e.g. `posthog_flutter`, `amplitude_flutter`, `mixpanel_flutter`, `sentry_flutter`, `segment_analytics`, `firebase_analytics`), and note any other analytics package or shared analytics service class you find. For each, locate where it's initialized and where it identifies the user.

Also find where the authenticated user becomes available: auth state stream (`FirebaseAuth.authStateChanges`, a Bloc/Cubit, Riverpod provider, `ChangeNotifier`), or the login success handler.

## Step 3: Present plan{{PLAN_GATE}}

Put together a single plan with file paths and enough surrounding context that placement can be verified:

1. **User identification**: where the authenticated user becomes available.
2. **Analytics tool linkage**: the tools you found and where you'll attach the Subtext URL.
3. **Privacy tags**: each sensitive widget, file, line, and the wrapper you'll add.
4. **Open questions**.

{{PLAN_GATE_DETAIL}}

## Step 4: Identify users

```dart
import 'package:fullstory_flutter/fs.dart';

// This is an example - don't forget to change it!
FS.identify('<THE_ID_THAT_YOU_USE_IN_YOUR_APP_FOR_THIS_USER>', {
  'displayName': '<DISPLAY_NAME_HERE>',
  'email': '<EMAIL_HERE>',
});
```

1. Call it once when auth resolves with a signed-in user (e.g. in the auth state listener), not in a `build` method. Do NOT identify anonymous users. It's rate limited, so don't call it repeatedly.
2. `uid` → the stable internal user id (never email). Add custom properties already available in the app.
3. On sign-out, call `FS.anonymize()`.
4. {{IDENTITY_GATE}}

## Step 5: Link the Subtext URL into existing analytics

1. Get the session URL once capture has started. It's a `Future<String?>` that resolves to `null` before a session exists:

   ```dart
   final subtextUrl = await FS.currentSessionURL();
   ```

2. Send it to each detected tool as a user property, using the naming convention the tool already uses in this codebase (`subtext_url` or `subtextUrl`). Use that tool's Flutter package API. These JavaScript examples show the property to set; translate them to Dart:

   ```js
{{INTEGRATION_LINKAGE_EXAMPLES}}
   ```

3. If a shared analytics service exists, attach it there once.
4. Do NOT install new analytics packages.

## Step 6: Mask sensitive data

Wrap widgets that render sensitive content:

- `FSExclude(child)`: drop the subtree from capture entirely
- `FSMask(child)`: keep the layout and events, mask text and images
- `FSUnmask(child)`: opt back in inside a masked ancestor
- `FSCustomAttributes(classes: [...], child: ...)` for other classes, e.g. consent-aware `fs-mask-without-consent`

```dart
FSMask(Text(user.email))
```

Classes stack and can't be removed by a descendant, so wrap the smallest subtree that holds the sensitive content.

Look for: `TextField`/`TextFormField`s for passwords, payment details, government IDs, and free text; screens showing email, phone, address, names, avatars, balances, account numbers, or health data; chat/messaging UIs. WebViews need `controller.setJavaScriptMode(JavaScriptMode.unrestricted)` to be captured; don't change this, just note it if relevant.

1. {{PRIVACY_GATE}}
2. Insert the wrapper, then run `dart analyze` (or `flutter analyze`) on the changed files if available.
3. These tags only apply to builds shipped after this change.

## Step 7: Explain

After making these changes, {{EXPLAIN_VERB}}:

"Subtext is now wired into user identity and your analytics tools, and sensitive widgets are tagged for masking."

Note that the tags added in Step 6 only take effect in **new builds** of the app.
