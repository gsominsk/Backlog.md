import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
	/** fsync the temp file (and its directory) before rename. Default: false.
	 *  Trades latency for crash-safety. Off matches existing Bun.write behavior. */
	fsync?: boolean;
}

/**
 * Write `content` to `path` atomically (POSIX): write a uniquely-named temp
 * file in the SAME directory as `path`, optionally fsync, then rename temp -> path.
 *
 * Guarantees a concurrent reader sees either the previous content or the new
 * content in full, never a partial write. Crash-safety requires fsync:true AND
 * a filesystem where rename is crash-atomic (ext4 data=ordered, APFS). NFS:
 * rename may not be crash-atomic; mkdir-based locks still work there.
 *
 * Temp name encodes PID + random hex so concurrent writers (even in the same
 * process) cannot collide; created with O_EXCL (flag 'wx') so a leftover stale
 * temp with the exact same improbable name surfaces EEXIST instead of clobbering.
 *
 * HYBRID-BOARD: atomic-write — do not reformat
 */

/**
 * Internal implementation holder. Exported so tests can monkeypatch the write
 * function (ES module namespace bindings are sealed in Bun; this mutable
 * object provides an indirection that tests can swap).
 */
export const __testImpl: { atomicWrite: typeof atomicWrite } = { atomicWrite: async () => {} };

async function atomicWriteImpl(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
	const { fsync: doFsync = false } = options;
	const dir = dirname(path);
	const base = basename(path);
	const unique = `${process.pid}-${randomBytes(6).toString("hex")}`;

	// Temp file in the SAME directory (same filesystem → atomic rename).
	// Dot-prefixed so directory watchers with dotfile guards ignore it.
	// ContentStore watchers check file.startsWith(".") before triggering
	// a full refresh, so temp file creation/restoration does not cause
	// expensive rescans.
	const tmpPath = join(dir, `.${base}.${unique}.tmp`);

	// Ensure the target directory exists. (rename requires same-filesystem,
	// and mkdir is idempotent-safe via EEXIST handling.)
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}

	// Open with 'wx' => O_CREAT|O_EXCL. Exclusive create at the kernel level:
	// no TOCTOU, no silent overwrite of a stale temp with a colliding name.
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(tmpPath, "wx");
		await handle.writeFile(content);

		if (doFsync) {
			await handle.sync(); // fsync temp file data + metadata
		}
	} finally {
		if (handle) {
			try {
				await handle.close();
			} catch {
				/* best-effort close; rename still works on an open fd */
			}
		}
	}

	if (doFsync) {
		// fsync the directory so the rename (new dir entry) reaches disk.
		// Best-effort: some platforms/filesystems reject dir fsync.
		let dirHandle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			dirHandle = await open(dir, "r");
			await dirHandle.sync();
		} catch {
			/* ignore — crash-safety is best-effort, not guaranteed */
		} finally {
			if (dirHandle) await dirHandle.close().catch(() => {});
		}
	}

	try {
		// Atomic on POSIX (same filesystem). Overwrites final path atomically.
		await rename(tmpPath, path);
	} catch (error) {
		// Rename failed (cross-device? permissions?). Clean up the temp file
		// and surface the error so callers don't see a dangling .tmp.
		await unlink(tmpPath).catch(() => {});
		throw error;
	}
}

// Initialize the test-impl delegate to the real implementation.
__testImpl.atomicWrite = atomicWriteImpl;

/**
 * Public atomic write function. Delegates to the internal implementation.
 * Tests can monkeypatch __testImpl.atomicWrite to intercept writes.
 */
export async function atomicWrite(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
	return __testImpl.atomicWrite(path, content, options);
}
