import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-unix-"));
	await fs.chmod(dir, 0o700);
	const unix = path.join(dir, "gateway.sock");
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	return {
		dir,
		unix,
		opts: { bind: `unix:${unix}`, bearerTokens: [], storage, resolveModel: () => undefined, version: "test" },
		async close() {
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

test("Unix gateway serves HTTP without a TCP listener and cleans up on shutdown", async () => {
	const f = await fixture();
	const serve = spyOn(Bun, "serve");
	try {
		const gateway = startAuthGateway(f.opts);
		try {
			expect(gateway.transport).toBe("unix");
			expect(gateway.url).toBe(`unix:${f.unix}`);
			expect("port" in gateway).toBe(false);
			expect("hostname" in gateway).toBe(false);
			expect(serve).toHaveBeenCalledTimes(1);
			const options = serve.mock.calls[0][0];
			expect(options).toHaveProperty("unix", f.unix);
			expect(options).not.toHaveProperty("port");
			expect(options).not.toHaveProperty("hostname");
			expect((await fs.stat(f.dir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(f.unix)).mode & 0o777).toBe(0o600);
			const response = await fetch("http://localhost/healthz", { unix: f.unix });
			expect(await response.json()).toEqual({ ok: true, version: "test" });
			const models = await fetch("http://localhost/v1/models", { unix: f.unix });
			expect(models.status).toBe(200);
		} finally {
			await gateway.close();
		}
		await expect(fs.lstat(f.unix)).rejects.toHaveProperty("code", "ENOENT");
	} finally {
		serve.mockRestore();
		await f.close();
	}
});

test("Unix bind refuses relative paths and preserves non-socket files and symlinks", async () => {
	const f = await fixture();
	try {
		expect(() => startAuthGateway({ ...f.opts, bind: "unix:relative.sock" })).toThrow("absolute/path");
		await Bun.write(f.unix, "do not remove");
		expect(() => startAuthGateway(f.opts)).toThrow("non-socket");
		expect(await Bun.file(f.unix).text()).toBe("do not remove");
		await fs.unlink(f.unix);
		const target = path.join(f.dir, "target");
		await Bun.write(target, "keep");
		await fs.symlink(target, f.unix);
		expect(() => startAuthGateway(f.opts)).toThrow("non-socket");
		expect((await fs.lstat(f.unix)).isSymbolicLink()).toBe(true);
	} finally {
		await f.close();
	}
});

test("Unix bind reclaims a stale socket left by a killed listener", async () => {
	const f = await fixture();
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			'Bun.serve({unix: process.argv[1], fetch: () => new Response("ok")}); console.log("ready");',
			f.unix,
		],
		{ stdout: "pipe", stderr: "inherit" },
	);
	try {
		const reader = child.stdout.getReader();
		try {
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toContain("ready");
		} finally {
			reader.releaseLock();
		}
		child.kill("SIGKILL");
		await child.exited;
		expect((await fs.lstat(f.unix)).isSocket()).toBe(true);
		const gateway = startAuthGateway(f.opts);
		try {
			const response = await fetch("http://localhost/healthz", { unix: f.unix });
			expect(response.status).toBe(200);
		} finally {
			await gateway.close();
		}
	} finally {
		child.kill();
		await child.exited;
		await f.close();
	}
});

test("Unix shutdown delegates pathname cleanup to Bun, including unsupported replacements", async () => {
	const f = await fixture();
	const gateway = startAuthGateway(f.opts);
	try {
		try {
			// Replacing the pathname violates the private single-instance
			// directory contract. Bun still unlinks it; do not claim otherwise.
			await fs.unlink(f.unix);
			await Bun.write(f.unix, "replacement outside the service contract");
		} finally {
			await gateway.close();
		}
		await expect(fs.lstat(f.unix)).rejects.toHaveProperty("code", "ENOENT");
	} finally {
		await f.close();
	}
});
