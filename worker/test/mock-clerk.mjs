/* Loader hook: redirect the '@clerk/backend' specifier to clerk-stub.mjs so
   the worker's ESM import resolves to the mock (Node >= 20.6 module.register). */
export function resolve(specifier, context, nextResolve) {
  if (specifier === '@clerk/backend') {
    return { url: new URL('./clerk-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
