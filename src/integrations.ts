import * as p from '@clack/prompts';
import type { WizardOptions } from './config.js';

export interface Integration {
  id: string;
  label: string;
  /** npm packages whose presence indicates the tool is installed. */
  packages: string[];
  /** window globals for script-tag installs (no npm package). */
  globals?: string[];
  /** Step 6 example: attach the Subtext URL to this tool's user metadata. */
  linkageExample: string;
}

export const INTEGRATIONS: Integration[] = [
  {
    id: 'posthog',
    label: 'PostHog',
    packages: ['posthog-js', 'posthog-js-lite'],
    globals: ['posthog'],
    linkageExample: `// PostHog
posthog.identify(user.id, { subtext_url: subtextUrl });`,
  },
  {
    id: 'amplitude',
    label: 'Amplitude',
    packages: ['@amplitude/analytics-browser', 'amplitude-js'],
    globals: ['amplitude'],
    linkageExample: `// Amplitude
const identifyEvent = new amplitude.Identify().set('subtext_url', subtextUrl);
amplitude.identify(identifyEvent);`,
  },
  {
    id: 'mixpanel',
    label: 'Mixpanel',
    packages: ['mixpanel-browser'],
    globals: ['mixpanel'],
    linkageExample: `// Mixpanel
mixpanel.people.set({ subtext_url: subtextUrl });`,
  },
  {
    id: 'statsig',
    label: 'Statsig',
    packages: ['@statsig/js-client', '@statsig/react-bindings', 'statsig-js', 'statsig-react'],
    linkageExample: `// Statsig — include in the StatsigUser custom fields wherever the user object is built
statsigClient.updateUserSync({ ...statsigUser, custom: { ...statsigUser.custom, subtext_url: subtextUrl } });`,
  },
  {
    id: 'sentry',
    label: 'Sentry',
    packages: ['@sentry/browser', '@sentry/react', '@sentry/nextjs', '@sentry/vue', '@sentry/svelte'],
    globals: ['Sentry'],
    linkageExample: `// Sentry — set as a tag so every captured error event carries the URL.
// Tags are indexable and searchable in the Sentry UI; cap is 200 chars.
Sentry.setTag('subtext_url', subtextUrl);`,
  },
  {
    id: 'logrocket',
    label: 'LogRocket',
    packages: ['logrocket'],
    globals: ['LogRocket'],
    linkageExample: `// LogRocket
LogRocket.identify(user.id, { subtextUrl });`,
  },
  {
    id: 'datadog',
    label: 'Datadog',
    packages: ['@datadog/browser-rum', '@datadog/browser-logs'],
    globals: ['DD_RUM'],
    linkageExample: `// Datadog RUM
datadogRum.setGlobalContextProperty('subtext_url', subtextUrl);`,
  },
  {
    id: 'launchdarkly',
    label: 'LaunchDarkly',
    packages: ['launchdarkly-js-client-sdk', 'launchdarkly-react-client-sdk'],
    linkageExample: `// LaunchDarkly — add to the context used when identifying
ldClient.identify({ ...context, subtextUrl });`,
  },
  {
    id: 'growthbook',
    label: 'GrowthBook',
    packages: ['@growthbook/growthbook', '@growthbook/growthbook-react'],
    linkageExample: `// GrowthBook
growthbook.setAttributes({ ...growthbook.getAttributes(), subtext_url: subtextUrl });`,
  },
  {
    id: 'intercom',
    label: 'Intercom',
    packages: ['@intercom/messenger-js-sdk', 'react-use-intercom'],
    globals: ['Intercom'],
    linkageExample: `// Intercom
Intercom('update', { subtext_url: subtextUrl });`,
  },
  {
    id: 'pendo',
    label: 'Pendo',
    packages: ['@pendo/agent'],
    globals: ['pendo'],
    linkageExample: `// Pendo
pendo.updateOptions({ visitor: { subtext_url: subtextUrl } });`,
  },
  {
    id: 'appcues',
    label: 'Appcues',
    packages: [],
    globals: ['Appcues'],
    linkageExample: `// Appcues
Appcues.identify(user.id, { subtextUrl });`,
  },
  {
    id: 'userpilot',
    label: 'Userpilot',
    packages: ['user-pilot', 'userpilot'],
    globals: ['userpilot'],
    linkageExample: `// Userpilot
userpilot.identify(user.id, { subtext_url: subtextUrl });`,
  },
  {
    id: 'sprig',
    label: 'Sprig',
    packages: ['@sprig-technologies/sprig-browser'],
    globals: ['Sprig'],
    linkageExample: `// Sprig
Sprig('setAttributes', { subtext_url: subtextUrl });`,
  },
  {
    id: 'segment',
    label: 'Segment',
    packages: ['@segment/analytics-next', 'analytics-node'],
    globals: ['analytics'],
    linkageExample: `// Segment
analytics.identify(user.id, { subtextUrl });`,
  },
];

export interface IntegrationSelection {
  integrations: Integration[];
  /** Free-text tool names entered via "Other". */
  other: string[];
}

/**
 * Ask which analytics/product tools the app uses so the agent knows what to
 * look for during the install. Pre-seeded via --integrations for CI runs.
 */
export async function selectIntegrations(
  options: WizardOptions,
): Promise<IntegrationSelection> {
  if (options.integrations) {
    const known = new Map(INTEGRATIONS.map((i) => [i.id, i]));
    const integrations: Integration[] = [];
    const other: string[] = [];
    for (const raw of options.integrations) {
      const id = raw.trim().toLowerCase();
      if (!id) continue;
      const match = known.get(id);
      if (match) integrations.push(match);
      else other.push(raw.trim());
    }
    return { integrations, other };
  }

  const OTHER = '__other__';
  const picked = await p.multiselect({
    message:
      'Which analytics or product tools does this app use? Subtext will link session URLs into each one. (space to select, enter to confirm)',
    options: [
      ...INTEGRATIONS.map((i) => ({ value: i.id, label: i.label })),
      { value: OTHER, label: 'Other', hint: 'name a tool not listed' },
    ],
    required: false,
  });
  if (p.isCancel(picked)) {
    throw new CancelledError();
  }

  const ids = picked as string[];
  const other: string[] = [];
  if (ids.includes(OTHER)) {
    const typed = await p.text({
      message: 'Which other tools? (comma-separated)',
      placeholder: 'e.g. Heap, FullStory Anywhere',
    });
    if (p.isCancel(typed)) throw new CancelledError();
    other.push(
      ...String(typed ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  return {
    integrations: INTEGRATIONS.filter((i) => ids.includes(i.id)),
    other,
  };
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}
