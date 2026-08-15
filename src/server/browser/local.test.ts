import { describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseStaleProfileLock } from './local.js';

/**
 * THE OUTAGE THIS PREVENTS, and why it is worth a file of its own.
 *
 * A persistent profile outlives the process that made it -- that is the point
 * of one. Chromium marks it with `SingletonLock -> <host>-<pid>` and refuses to
 * open a profile whose lock names a machine that is not this one, because from
 * inside it cannot tell a rebuilt container from a second computer reaching the
 * same volume. So a rebuild -- the ordinary deploy here -- left the LinkedIn
 * seat permanently unopenable, with "the profile appears to be in use by
 * another Chromium process (403) on another computer" on every launch until a
 * human deleted a file.
 *
 * The two directions are both load-bearing: clearing a dead lock ends the
 * outage, and NOT clearing a live one is what keeps two browsers from writing
 * the same profile.
 */
describe('releaseStaleProfileLock', () => {
  // `existsSync` FOLLOWS the link, and every one of these locks points at a
  // target that does not exist -- Chromium's does too. The question here is
  // whether the link itself is still there.
  function present(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  }

  function profile(lock: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'trevra-profile-'));
    if (lock) {
      symlinkSync(lock, join(dir, 'SingletonLock'));
      symlinkSync('/tmp/org.chromium.Chromium.abcdef/SingletonSocket', join(dir, 'SingletonSocket'));
      symlinkSync('4203079792409707644', join(dir, 'SingletonCookie'));
    }
    return dir;
  }

  it('clears a lock left on another machine, which is what a rebuilt container looks like', () => {
    const dir = profile('a8411041ec48-403');
    const said: string[] = [];

    expect(releaseStaleProfileLock(dir, (message) => said.push(message), { hostname: 'b1b7e10a1758' })).toBe(true);

    // All three, because Chromium writes all three together.
    expect(present(join(dir, 'SingletonLock'))).toBe(false);
    expect(present(join(dir, 'SingletonSocket'))).toBe(false);
    expect(present(join(dir, 'SingletonCookie'))).toBe(false);
    // The operator is told, because a lock disappearing silently is a thing
    // nobody can debug later.
    expect(said.join(' ')).toContain('403');
    expect(said.join(' ')).toContain('a8411041ec48');
  });

  it('clears a lock whose process is gone on this machine', () => {
    const dir = profile('this-host-4242');
    expect(releaseStaleProfileLock(dir, () => {}, { hostname: 'this-host', alive: () => false })).toBe(true);
    expect(present(join(dir, 'SingletonLock'))).toBe(false);
  });

  /** A RUNNING BROWSER KEEPS ITS PROFILE. Taking this lock corrupts it. */
  it('leaves a live lock on this machine exactly where it is', () => {
    const dir = profile(`this-host-${process.pid}`);
    const said: string[] = [];

    expect(releaseStaleProfileLock(dir, (message) => said.push(message), { hostname: 'this-host' })).toBe(false);

    expect(present(join(dir, 'SingletonLock'))).toBe(true);
    expect(said).toEqual([]);
  });

  it('says nothing and does nothing for a profile with no lock', () => {
    const said: string[] = [];
    expect(releaseStaleProfileLock(profile(null), (message) => said.push(message))).toBe(false);
    expect(said).toEqual([]);
  });

  it('does not mistake a regular file for a lock it can read', () => {
    // `readlink` on a plain file throws EINVAL; that is not a reason to fail a
    // launch, and it is not a reason to delete somebody's file either.
    const dir = mkdtempSync(join(tmpdir(), 'trevra-profile-'));
    writeFileSync(join(dir, 'SingletonLock'), 'not a symlink');
    expect(releaseStaleProfileLock(dir, () => {})).toBe(false);
    expect(present(join(dir, 'SingletonLock'))).toBe(true);
  });
});
