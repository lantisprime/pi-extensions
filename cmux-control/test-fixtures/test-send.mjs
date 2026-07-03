// P5d-S3: cmux-control send operation tests.
import assert from "node:assert/strict";
import { sendKey, sendText } from "../lib/send.ts";
import { FakeCmuxExecutor } from "./fake-cmux-executor.ts";

// SendTextArgs
{
	const fake = new FakeCmuxExecutor();

	const result = await sendText(fake, "surface:1", "text");
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(fake.calls[0].args, ["send", "--surface", "surface:1", "text"]);

	const tooLargeFake = new FakeCmuxExecutor();
	const tooLargeResult = await sendText(tooLargeFake, "surface:1", "x".repeat(4097));
	assert.deepEqual(tooLargeResult, { ok: false, error: "text exceeds 4096 byte limit" });
	assert.equal(tooLargeFake.calls.length, 0);
}

// SendTextPressEnter
{
	const fake = new FakeCmuxExecutor();

	const result = await sendText(fake, "surface:1", "text", { pressEnter: true });
	assert.deepEqual(result, { ok: true });
	assert.equal(fake.calls.length, 2);
	assert.deepEqual(fake.calls[0].args, ["send", "--surface", "surface:1", "text"]);
	assert.deepEqual(fake.calls[1].args, ["send-key", "--surface", "surface:1", "enter"]);
}

// SendKeySingle
{
	const fake = new FakeCmuxExecutor();

	const result = await sendKey(fake, "surface:1", "C-c");
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(fake.calls[0].args, ["send-key", "--surface", "surface:1", "C-c"]);
}
