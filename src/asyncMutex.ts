/** Runs async tasks strictly one after another, in call order — a failure in one never blocks the next. */
export class AsyncMutex {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(() => task());
		this.tail = result.catch(() => undefined);
		return result;
	}
}
