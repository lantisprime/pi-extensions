// Resolve @earendil-works/pi-ai to the local shim for plain-node test runs.
// Under pi, the same specifier is served by pi's jiti virtualModules.
// Synchronous by contract: module.registerHooks() resolve hooks must not
// return promises.
export function resolve(specifier, context, next) {
	if (specifier === "@earendil-works/pi-ai") {
		return { url: new URL("./pi-ai-shim.mjs", import.meta.url).href, shortCircuit: true };
	}
	return next(specifier, context);
}
