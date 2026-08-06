/**
 * Per-key async mutex. Each key gets its own mutex, so operations on
 * different keys run concurrently while operations on the same key serialize.
 *
 * Used by withWriteLock to guard same-process async interleaving on a per-file
 * basis. The cross-process layer (proper-lockfile) handles inter-process
 * coordination; this mutex handles intra-process coordination (JS is
 * single-threaded but await points can interleave).
 *
 * HYBRID-BOARD: mutex — do not reformat
 */

/** A single async mutex — chains promises to serialize access. */
class Mutex {
	private tail: Promise<void> = Promise.resolve();

	/** Run `fn` while holding the mutex. Releases on success or error. */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await next; // wait for the previous holder to release
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

const mutexes = new Map<string, Mutex>();

/** Get or create a Mutex for the given key. */
function getMutex(key: string): Mutex {
	let m = mutexes.get(key);
	if (!m) {
		m = new Mutex();
		mutexes.set(key, m);
	}
	return m;
}

/**
 * Run `fn` while holding the in-process mutex for `key`. Different keys
 * run concurrently; same key serializes. Releases on success or error.
 */
export async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
	return getMutex(key).run(fn);
}
