export const INSTALL_STEPS = ['capture', 'csp', 'identify', 'integrations', 'privacy'] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];
