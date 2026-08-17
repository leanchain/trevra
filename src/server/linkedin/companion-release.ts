const DEFAULT_COMPANION_RELEASE_VERSION = '0.2.2';
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Production release automation injects the companion version independently of
 * the immutable app image. This lets one tested commit publish a new companion
 * package first and only then make the hosted relay advertise it, without a
 * second source-code/version-bump commit.
 */
const configuredVersion = process.env.TREVRA_COMPANION_RELEASE_VERSION?.trim();
if (configuredVersion && !RELEASE_VERSION.test(configuredVersion)) {
  throw new Error('TREVRA_COMPANION_RELEASE_VERSION must be a semantic version like 0.2.3');
}

export const COMPANION_RELEASE_VERSION = configuredVersion || DEFAULT_COMPANION_RELEASE_VERSION;

export function companionReleasePackage(version: string = COMPANION_RELEASE_VERSION): string {
  return `https://github.com/leanchain/trevra/releases/download/companion-v${version}/trevra-${version}.tgz`;
}
