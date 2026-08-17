const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(value) {
  const match = String(value ?? '').trim().match(SEMVER);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part));
}

export function isNewerVersion(current, candidate) {
  const a = parseVersion(current);
  const b = parseVersion(candidate);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (b[index] > a[index]) return true;
    if (b[index] < a[index]) return false;
  }
  return false;
}

export function officialCompanionPackage(version) {
  if (!parseVersion(version)) throw new Error('Trevra offered an invalid companion version.');
  return `https://github.com/leanchain/trevra/releases/download/companion-v${version}/trevra-${version}.tgz`;
}
