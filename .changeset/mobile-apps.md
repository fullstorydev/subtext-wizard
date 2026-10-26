---
'@subtextdev/subtext-wizard': minor
---

Support React Native, Expo, and Flutter apps. The wizard detects mobile projects from `package.json` or `pubspec.yaml`, skips the web snippet, and hands your coding agent platform-specific steps for Fullstory's native mobile SDK (Babel plugin, Expo config plugin, Gradle, Info.plist, and the Flutter entry point), with EU orgs routed to the EU server. The follow-up extras use the mobile identify, session URL, and masking APIs, and analytics detection now recognizes React Native and Flutter SDKs. Also fixes the old React Native instruction, which pointed agents at a web-style `init()` call.
