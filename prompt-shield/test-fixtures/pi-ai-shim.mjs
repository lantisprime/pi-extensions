// Test stand-in for @earendil-works/pi-ai, mirroring what pi's extension
// loader (jiti virtualModules) provides at runtime. Only named runtime
// imports used by prompt-shield/index.ts are stubbed; llmReview never reaches
// complete() in tests (ctx.model is unset), so a throwing stub is enough.
export const complete = async () => {
	throw new Error("pi-ai shim: complete() must not be called in tests");
};
