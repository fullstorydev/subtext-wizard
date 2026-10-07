import { hasDep } from '../project.js';
import { type Framework, fail } from './types.js';

/** Recognized so we can say why, but always handed to the agent. */
function unsupported(name: string, packages: string[], reason = `${name} isn't covered by the automatic install`): Framework {
  return {
    name,
    matches: (project) => hasDep(project, ...packages),
    detect: () => fail(reason, name),
  };
}

// Native apps need the native SDK, not a <script> tag.
export const reactNative = unsupported('React Native', ['react-native', 'expo'], 'React Native needs the native SDK');

// These render <head> in ways we don't edit statically.
export const unsupportedFrameworks: Framework[] = [
  unsupported('TanStack Start', ['@tanstack/react-start', '@tanstack/start']),
  unsupported('SolidStart', ['@solidjs/start']),
  unsupported('Qwik City', ['@builder.io/qwik-city']),
  unsupported('RedwoodJS', ['@redwoodjs/core']),
  unsupported('Ember', ['ember-source']),
];
