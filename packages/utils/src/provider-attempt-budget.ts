/** A request-local ceiling on billable generation sends, shared by every recovery path. */
export class ProviderAttemptLimitError extends Error {
	readonly status = 409;
	readonly code = "provider_attempt_limit_exceeded";

	constructor() {
		super("Gateway refused a second provider attempt");
		this.name = "ProviderAttemptLimitError";
	}
}

export class ProviderAttemptBudget {
	#attempts = 0;
	error?: ProviderAttemptLimitError;

	get attempts(): number {
		return this.#attempts;
	}

	consume(): void {
		if (this.#attempts !== 0) this.refuse();
		this.#attempts++;
	}

	refuse(): never {
		this.error ??= new ProviderAttemptLimitError();
		throw this.error;
	}
}
