/**
 * Strict configuration for the image budget guard.
 *
 * The schema is a Zod object with `.strict()`: the Harness loader validates a
 * plugin's exported `Config` through the Standard Schema `~standard` interface
 * (`cordis/lib/index.js` → `resolveConfig` → `runtime.Config["~standard"].validate`),
 * and Zod 4 implements that interface. Unknown keys are therefore rejected at
 * load time, before `apply()` ever runs.
 *
 * @module @ksndjaks/dsh-image-budget-guard/config
 */
import { z } from 'zod';
/** Diagnostics verbosity; the plugin never changes harness logging levels. */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'];
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
/**
 * Exact-route override. A route is identified by the `(provider, model)` pair
 * the request header carries; both fields are required so an override can
 * never silently apply to a different model on the same provider.
 */
export const RouteOverrideSchema = z
    .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    enabled: z.boolean().optional(),
    /** Force a representation when the route directory cannot prove one. */
    representation: z.enum(['inline-base64', 'files']).optional(),
    /** Force image capability when the adapter's modalities are unknown. */
    imageCapable: z.boolean().optional(),
    maxRequestImageBytes: positiveInteger.optional(),
    maxRequestImages: positiveInteger.optional(),
    minRetainImages: nonNegativeInteger.optional(),
    retainSteps: nonNegativeInteger.optional(),
    quanta: positiveInteger.optional(),
})
    .strict();
/** Plugin configuration; every field is optional and defaulted. */
export const ConfigSchema = z
    .object({
    /** Master switch. `false` makes every request hook a no-op. */
    enabled: z.boolean().default(true),
    /** Decide and log, but never append an `image/offload` event. */
    dryRun: z.boolean().default(false),
    /**
     * Representation used when neither the route override nor the route
     * directory resolves one. `inline-base64` is the conservative fallback:
     * the byte budget is an upper bound on what an inline route sends.
     */
    representation: z.enum(['auto', 'inline-base64', 'files']).default('auto'),
    /** Inline base64 route budget: accumulated encoded request bytes (default 6 MiB). */
    maxRequestImageBytes: positiveInteger.default(6 * 1024 * 1024),
    /** Files/reference route budget: represented image occurrences (default 60). */
    maxRequestImages: positiveInteger.default(60),
    /** Newest occurrences that are never omitted (default 6). */
    minRetainImages: nonNegativeInteger.default(6),
    /** Images admitted within the last N steps are never omitted (default 12). */
    retainSteps: nonNegativeInteger.default(12),
    /** Minimum occurrences omitted per decision (default 4). */
    quanta: positiveInteger.default(4),
    /** Exact provider/model overrides; later entries win for the same pair. */
    perRoute: z.array(RouteOverrideSchema).default([]),
    logLevel: z.enum(LOG_LEVELS).default('info'),
})
    .strict();
/**
 * Resolve the effective policy for one exact route.
 *
 * @param config - validated plugin configuration.
 * @param provider - provider route the request header carries.
 * @param model - exact model id the request header carries.
 * @param representationHint - representation inferred from the mounted route
 *   directory, when the adapter proves one; ignored when the operator forced a
 *   representation in config.
 * @returns the frozen per-route budget policy.
 */
export function resolveRouteBudget(config, provider, model, representationHint) {
    let override;
    for (const candidate of config.perRoute) {
        if (candidate.provider === provider && candidate.model === model)
            override = candidate;
    }
    const representation = override?.representation ??
        (config.representation === 'auto' ? (representationHint ?? 'inline-base64') : config.representation);
    const dimension = representation === 'files' ? 'count' : 'bytes';
    return Object.freeze({
        provider,
        model,
        representation,
        dimension,
        maxBytes: dimension === 'bytes' ? (override?.maxRequestImageBytes ?? config.maxRequestImageBytes) : Number.POSITIVE_INFINITY,
        maxImages: dimension === 'count' ? (override?.maxRequestImages ?? config.maxRequestImages) : Number.POSITIVE_INFINITY,
        minRetainImages: override?.minRetainImages ?? config.minRetainImages,
        retainSteps: override?.retainSteps ?? config.retainSteps,
        quanta: override?.quanta ?? config.quanta,
    });
}
/** Whether the operator disabled this exact route through `perRoute[].enabled`. */
export function routeEnabled(config, provider, model) {
    if (!config.enabled)
        return false;
    let enabled = true;
    for (const candidate of config.perRoute) {
        if (candidate.provider === provider && candidate.model === model && candidate.enabled !== undefined) {
            enabled = candidate.enabled;
        }
    }
    return enabled;
}
/** Whether the operator forced image capability for this exact route. */
export function routeCapabilityOverride(config, provider, model) {
    let forced;
    for (const candidate of config.perRoute) {
        if (candidate.provider === provider && candidate.model === model && candidate.imageCapable !== undefined) {
            forced = candidate.imageCapable;
        }
    }
    return forced;
}
//# sourceMappingURL=config.js.map