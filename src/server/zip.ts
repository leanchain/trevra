/**
 * The smallest ZIP writer that can hold a ledger export.
 *
 * WHY NOT A LIBRARY. `jszip` and `archiver` are both already resolved in
 * node_modules through unrelated development dependencies, and neither is a
 * declared runtime dependency of this project.
 * Promoting one means editing package.json and regenerating package-lock.json,
 * and the lock file is the single most conflict-prone file in a repo with more
 * than one session open on it. What is actually needed here is the ZIP
 * CONTAINER: the compression itself is `node:zlib`, which ships with the
 * runtime. That is a header format, not an algorithm, and it is written out in
 * full below rather than pulled in.
 *
 * The format is APPNOTE.TXT 6.3.3, sections 4.3.7 (local file header), 4.3.12
 * (central directory) and 4.3.16 (end of central directory).
 *
 * lc-debt: no Zip64, so this tops out at 4 GiB per entry, 4 GiB per archive and
 * 65535 entries -- far above the row ceiling in ledger-export.ts, which is what
 * keeps the limit unreachable rather than merely unlikely. It also buffers the
 * whole archive in memory. Upgrade path: stream entries through
 * `zlib.createDeflateRaw` into the response and emit Zip64 end-of-central
 * -directory records once any counter passes 0xffffffff.
 */

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive. Forward slashes, no leading slash, UTF-8. */
  name: string;
  data: Buffer;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_DIRECTORY_SIGNATURE = 0x06054b50;

/** 2.0, the version that introduced deflate. Nothing here needs anything newer. */
const VERSION_NEEDED = 20;

/**
 * General purpose bit 11: the name and comment are UTF-8.
 *
 * Set unconditionally. Without it a reader is entitled to decode names as
 * CP437, and this archive's names come from table names that are ASCII today
 * and need not stay that way.
 */
const UTF8_NAMES = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** CRC-32/ISO-HDLC, the checksum every ZIP entry carries. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ data[index]!) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS date and time, which is what a ZIP header stores.
 *
 * Two-second resolution and a 1980 epoch are the format's, not ours. UTC
 * throughout: the archive is downloaded by whoever asked for it, from a server
 * whose zone is nobody's business, and a local-time stamp would make the same
 * export look like it was made at different moments on different boxes.
 */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  const time =
    (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return { time, date };
}

/**
 * One archive, in order, as a single Buffer.
 *
 * Each entry is deflated and then kept only if deflating actually helped --
 * NDJSON compresses hard, but a one-line file usually grows, and an archive
 * that stores those verbatim is smaller and decodes faster. Both methods are
 * universally supported, so the choice is free.
 */
export function zipArchive(entries: ZipEntry[], now: Date): Buffer {
  const { time, date } = dosDateTime(now);
  const body: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const shrank = deflated.length < entry.data.length;
    const method = shrank ? METHOD_DEFLATE : METHOD_STORE;
    const stored = shrank ? deflated : entry.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    body.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += local.length + name.length + stored.length;
  }

  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...body, centralDirectory, end]);
}
