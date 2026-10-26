import fs from 'node:fs';
import path from 'node:path';
import { captureHosts, type Region } from './config.js';

/**
 * Web apps get the inline capture snippet. Mobile apps get Fullstory's native
 * SDK instead, which is configured with just the org id and a server URL in
 * Gradle, Info.plist, or the Expo config plugin.
 */
export type Platform = 'web' | 'react-native' | 'expo' | 'flutter';

export type MobilePlatform = Exclude<Platform, 'web'>;

export const PLATFORM_LABEL: Record<Platform, string> = {
  web: 'Web',
  'react-native': 'React Native',
  expo: 'Expo',
  flutter: 'Flutter',
};

export function isMobile(platform: Platform): platform is MobilePlatform {
  return platform !== 'web';
}

/** Never throws: an unreadable manifest just means "not that platform". */
export function detectPlatform(dir: string): Platform {
  const pubspec = readText(path.join(dir, 'pubspec.yaml'));
  // Plain Dart packages have a pubspec too; only apps that depend on the Flutter SDK count.
  if (pubspec && /^\s+sdk:\s*flutter\b/m.test(pubspec)) return 'flutter';

  const pkgText = readText(path.join(dir, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      // Expo apps also depend on react-native, so check expo first.
      if ('expo' in deps) return 'expo';
      if ('react-native' in deps) return 'react-native';
    } catch {
      // malformed package.json: let the web path deal with it
    }
  }
  return 'web';
}

export interface MobileCaptureConfig {
  platform: MobilePlatform;
  orgId: string;
  /** Goes in Gradle `serverUrl`, Info.plist `ServerUrl`, or the Expo plugin `host`. */
  serverUrl: string;
}

// The org id ends up inside an agent prompt that runs with auto-approved edits,
// so refuse anything that isn't shaped like one.
const ORG_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function mobileCaptureConfig(platform: MobilePlatform, orgId: string, region: Region): MobileCaptureConfig {
  if (!ORG_ID_PATTERN.test(orgId)) throw new Error(`Unexpected org id format: ${JSON.stringify(orgId)}`);
  return { platform, orgId, serverUrl: `https://${captureHosts(region).host}` };
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
