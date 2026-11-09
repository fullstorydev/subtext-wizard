# Link sessions into existing tools

If the app already uses analytics, error-tracking, or feature-flag tools, attach the Subtext session URL to them. Then anyone looking at a user or error in that tool can jump to the session.

## 1. Find what's installed

Check `package.json` (and script tags) for tools like PostHog, Segment, Amplitude, Mixpanel, Sentry, Datadog, LogRocket, Statsig, LaunchDarkly, GrowthBook, Intercom, Pendo, or Appcues. Also look for a shared analytics wrapper under `lib/`, `utils/`, or `analytics/`. Don't install new tools.

If none are installed, stop here.

## 2. Attach the URL

Get the URL once capture has started:

    const subtextUrl = FS('getSession', { format: 'url.now' });

Send it to each tool under the key `subtext_url`, next to where that tool already identifies the user. For example:

    posthog.identify(user.id, { subtext_url: subtextUrl });
    Sentry.setTag('subtext_url', subtextUrl);

If there's a shared wrapper, attach it there once. Re-attach when the user is re-identified, since the URL changes between sessions.

The exact call for each tool is in its guide: https://subtext.fullstory.com/guides/analytics-linkage/index.md
