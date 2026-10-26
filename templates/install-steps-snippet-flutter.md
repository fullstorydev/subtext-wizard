## About this install

This is a Flutter app, so capture comes from Fullstory's native mobile SDK plus the `fullstory_flutter` package. There is no `<script>` snippet and no Content-Security-Policy to change. Ignore any web install instructions in the reference docs. Flutter Web is not supported; only touch the Android and iOS targets.

Use these values. They are specific to this organization; use them exactly as given:

- Org id: `{{ORG_ID}}`
- Server URL: `{{SERVER_URL}}`

The Server URL only needs to be set when it differs from the default `https://fullstory.com`.

Mobile capture requires the Fullstory Mobile add-on on the org. You can't check this from the codebase; just mention it in Step 5.

## Step 1: Pre-check

Determine whether capture is *actually* installed. Stop at the first positive match:

1. `pubspec.yaml` lists `fullstory_flutter` under `dependencies`.
2. `lib/main.dart` calls `runFullstoryApp` or `FullstoryBinding.ensureInitialized`.
3. `android/app/build.gradle` (or `.kts`) applies the `fullstory` plugin, or `ios/Runner/Info.plist` has a `Fullstory` (or `FullStory`) dictionary with an `OrgId`.

Do NOT broad-grep for "fullstory"; it matches copy and comments.

If capture is already installed, report "Subtext capture already installed at {file}" and stop.

## Step 2: Explore the codebase

Do a read-only pass:

- **Flutter version**: the `environment.flutter` / `sdk` constraint in `pubspec.yaml` (and `flutter --version` if available). `fullstory_flutter` needs Flutter 3.32 or newer; flag it in the plan if the project is older.
- **Entry point**: where `runApp(...)`, `runWidget(...)`, and `WidgetsFlutterBinding.ensureInitialized()` are called (usually `lib/main.dart`, but check for flavor entry points like `main_dev.dart`).
- **Android**: whether plugin repositories are managed in `android/settings.gradle` or the root `android/build.gradle`; Groovy vs. Kotlin DSL; whether the app already declares a custom `Application` class in `android/app/src/main/AndroidManifest.xml`; the `minSdkVersion`.
- **iOS**: the `ios/Podfile` `Runner` target and `ios/Runner/Info.plist`.
- **Obfuscation**: whether build scripts or CI pass `--obfuscate` to `flutter build`.
- **SDK version**: look up the latest `fullstory_flutter` on pub.dev. The native Android plugin version must match it: Flutter package `0.X.Y` pairs with Android `1.X.Y` (e.g. `0.70.1` to `1.70.1`).

## Step 3: Present plan{{PLAN_GATE}}

Put together a single plan with file paths and enough surrounding context that placement can be verified:

1. **Package**: the `fullstory_flutter` version.
2. **Dart changes**: each `runApp` / binding call to replace.
3. **Android**: Gradle repo, classpath, plugin and `fullstory {}` block, and the `Application` subclass.
4. **iOS**: `Info.plist` and the build phase.
5. **Obfuscation**: if the app builds with `--obfuscate`, the extra flags it needs (below). Don't change CI yourself; list them.
6. **Open questions**: anything ambiguous.

{{PLAN_GATE_DETAIL}}

## Step 4: Install

Reference: https://help.fullstory.com/hc/en-us/articles/27461129353239-Getting-Started-with-Fullstory-for-Flutter-Mobile-Apps

### 4a. Package and Dart

1. Run `flutter pub add fullstory_flutter` (or add it to `pubspec.yaml` and run `flutter pub get`). This also pulls in the iOS CocoaPod.
2. In every app entry point, `import 'package:fullstory_flutter/fullstory_flutter.dart';` and:
   - replace `runApp(...)` with `runFullstoryApp(...)`
   - replace `runWidget(...)` with `runFullstoryWidget(...)`
   - replace `WidgetsFlutterBinding.ensureInitialized()` with `FullstoryBinding.ensureInitialized()`

### 4b. Android

The default Flutter Android setup does not work with Fullstory; the app needs its own `Application` subclass (https://help.fullstory.com/hc/en-us/articles/360040596093, Step 5).

1. Add the Fullstory Maven repo `https://maven.fullstory.com`. If `android/settings.gradle` has `pluginManagement`/`dependencyResolutionManagement` blocks, add it to both `repositories` lists; otherwise add it to `buildscript.repositories` in `android/build.gradle`.
2. Add `classpath 'com.fullstory:gradle-plugin-local:<MATCHING 1.X.Y VERSION>'` to the root build script's dependencies.
3. In `android/app/build.gradle`, apply the `fullstory` plugin and configure it:

   ```groovy
   fullstory {
       org '{{ORG_ID}}'{{GRADLE_SERVER_LINE}}
       enabledVariants 'all'
   }
   ```

   `enabledVariants 'all'` lets the user see a captured session from a debug build; the default is release only. Mention in Step 5 that they may want to narrow it later.
4. Translate to Kotlin DSL if the files are `.kts`.
5. If the app has no custom `Application` class, create one in the app's package (matching the language of `MainActivity`: Kotlin `class App : Application()` or Java `public class App extends Application {}`) and set `android:name=".App"` on `<application>` in `AndroidManifest.xml`. If `minSdkVersion` is below 21, extend `androidx.multidex.MultiDexApplication` instead. If one already exists, leave it.
6. Make sure the manifest has the `INTERNET` and `ACCESS_NETWORK_STATE` permissions.

### 4c. iOS

The Flutter package already added the `FullStory` pod; do not add it again and skip the iOS "Add the Plugin" step.

1. Add a `Fullstory` dictionary to `ios/Runner/Info.plist`:

   ```xml
   <key>Fullstory</key>
   <dict>
       <key>OrgId</key>
       <string>{{ORG_ID}}</string>{{PLIST_SERVER_ENTRY}}
   </dict>
   ```

2. Add a Run Script build phase named `Run FullStory Asset Uploader` to the Runner target, after the default phases, by editing `ios/Runner.xcodeproj/project.pbxproj` carefully (or tell the user to add it in Xcode if you can't do it safely):

   ```sh
   "${PODS_ROOT}/FullStory/tools/FullStoryCommandLine" "${CONFIGURATION_BUILD_DIR}/${WRAPPER_NAME}"
   ```

3. Run `pod install` in `ios/` if CocoaPods is available. If it isn't, or it fails, tell the user to run it.

### 4d. Obfuscated builds

Only if the app builds with `--obfuscate`: without a saved obfuscation map, unmasking breaks. The build needs `--extra-gen-snapshot-options=--save-obfuscation-map=/path/to/map.json`, and iOS builds also need `export FS_FLUTTER_OBFUSCATION_MAP=/path/to/map.json` (an absolute path) beforehand. List this for the user; don't rewrite their CI.

Do not attempt a full native build; it takes minutes and needs simulators and signing the user controls.

## Step 5: Explain

Once capture is in place, {{EXPLAIN_VERB}}:

"Subtext capture is installed. Rebuild the app (a full restart, not hot reload) and launch it on a simulator or device. Sessions start capturing on launch."

Also mention: the Fullstory Mobile add-on must be enabled on the org, and any `pod install` or obfuscation step you couldn't do.

This install covered capture only. Identifying users, linking the session URL into your analytics tools, and masking sensitive data are a separate follow-up step; the Subtext setup wizard will offer it next.
