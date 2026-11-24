import { describe, expect, it } from "bun:test";
import { fetchWithRetry } from "@oh-my-pi/pi-utils/fetch-retry";
import { ProviderAttemptBudget, ProviderAttemptLimitError } from "@oh-my-pi/pi-utils/provider-attempt-budget";

describe("provider attempt budget", () => {
	it("consumes only one send and latches the refusal", () => {
		const budget = new ProviderAttemptBudget();
		expect(budget.attempts).toBe(0);
		budget.consume();
		expect(() => budget.consume()).toThrow(ProviderAttemptLimitError);
		expect(budget.attempts).toBe(1);
		expect(budget.error?.code).toBe("provider_attempt_limit_exceeded");
		expect(budget.error?.status).toBe(409);
	});

	for (const status of [408, 429, 500, 503]) {
		it(`refuses HTTP ${status} retry without backoff`, async () => {
			const budget = new ProviderAttemptBudget();
			let sends = 0;
			const result = fetchWithRetry("https://offline.invalid", {
				providerAttemptBudget: budget,
				defaultDelayMs: 60_000,
				fetch: async () => {
					budget.consume();
					sends++;
					return new Response("retry", { status });
				},
			});
			await expect(result).rejects.toBeInstanceOf(ProviderAttemptLimitError);
			expect(sends).toBe(1);
		});
	}

	it("refuses network retry without backoff", async () => {
		const budget = new ProviderAttemptBudget();
		let sends = 0;
		await expect(
			fetchWithRetry("https://offline.invalid", {
				providerAttemptBudget: budget,
				defaultDelayMs: 60_000,
				fetch: async () => {
					budget.consume();
					sends++;
					throw new Error("connection reset");
				},
			}),
		).rejects.toBeInstanceOf(ProviderAttemptLimitError);
		expect(sends).toBe(1);
	});

	it("keeps the existing retry behavior without a budget", async () => {
		let sends = 0;
		const response = await fetchWithRetry("https://offline.invalid", {
			defaultDelayMs: 0,
			fetch: async () => new Response("ok", { status: ++sends === 1 ? 503 : 200 }),
		});
		expect(response.status).toBe(200);
		expect(sends).toBe(2);
	});
});
