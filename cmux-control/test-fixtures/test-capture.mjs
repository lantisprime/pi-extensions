// P5d-S3: cmux-control capture operation tests.
import assert from "node:assert/strict";
import { captureSurface } from "../lib/capture.ts";
import { FakeCmuxExecutor } from "./fake-cmux-executor.ts";

// CaptureReturnsOutput
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: true, stdout: "hello\nworld\n" });

	const result = await captureSurface(fake, "surface:1", 10);
	assert.deepEqual(result, { ok: true, output: "hello\nworld\n" });
	assert.deepEqual(fake.calls[0].args, ["read-screen", "--surface", "surface:1", "--lines", "10"]);
}

// CaptureDefaultLines
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: true, stdout: "" });

	const result = await captureSurface(fake, "surface:1");
	assert.equal(result.ok, true);
	assert.deepEqual(fake.calls[0].args, ["read-screen", "--surface", "surface:1", "--lines", "50"]);
}

// CaptureError
{
	const fake = new FakeCmuxExecutor();
	fake.enqueueResponse({ ok: false, stderr: "surface not found", exitCode: 1 });

	const result = await captureSurface(fake, "surface:1");
	assert.deepEqual(result, { ok: false, error: "surface not found" });

	const cappedFake = new FakeCmuxExecutor();

	const cappedResult = await captureSurface(cappedFake, "surface:1", 5001);
	assert.deepEqual(cappedResult, { ok: false, error: "lines must be an integer from 1 to 5000" });
	assert.equal(cappedFake.calls.length, 0);
}
