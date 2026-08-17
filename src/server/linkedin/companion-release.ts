export const COMPANION_RELEASE_VERSION = '0.2.0';

export function companionReleasePackage(version: string = COMPANION_RELEASE_VERSION): string {
  return `https://github.com/leanchain/trevra/releases/download/companion-v${version}/trevra-${version}.tgz`;
}
