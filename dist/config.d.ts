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
/** Request representation a route uses for image occurrences. */
export type RouteRepresentation = 'inline-base64' | 'files';
/** Configured representation resolution; `auto` consults the route directory. */
export type RepresentationSetting = 'auto' | RouteRepresentation;
/** Which budget dimension a resolved route enforces. */
export type BudgetDimension = 'bytes' | 'count';
/** Diagnostics verbosity; the plugin never changes harness logging levels. */
export declare const LOG_LEVELS: readonly ["silent", "error", "warn", "info", "debug"];
export type LogLevel = (typeof LOG_LEVELS)[number];
/**
 * Exact-route override. A route is identified by the `(provider, model)` pair
 * the request header carries; both fields are required so an override can
 * never silently apply to a different model on the same provider.
 */
export declare const RouteOverrideSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
    enabled: z.ZodOptional<z.ZodBoolean>;
    representation: z.ZodOptional<z.ZodEnum<{
        "inline-base64": "inline-base64";
        files: "files";
    }>>;
    imageCapable: z.ZodOptional<z.ZodBoolean>;
    maxRequestImageBytes: z.ZodOptional<z.ZodNumber>;
    maxRequestImages: z.ZodOptional<z.ZodNumber>;
    minRetainImages: z.ZodOptional<z.ZodNumber>;
    retainSteps: z.ZodOptional<z.ZodNumber>;
    quanta: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
/** Plugin configuration; every field is optional and defaulted. */
export declare const ConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    dryRun: z.ZodDefault<z.ZodBoolean>;
    representation: z.ZodDefault<z.ZodEnum<{
        "inline-base64": "inline-base64";
        files: "files";
        auto: "auto";
    }>>;
    maxRequestImageBytes: z.ZodDefault<z.ZodNumber>;
    maxRequestImages: z.ZodDefault<z.ZodNumber>;
    minRetainImages: z.ZodDefault<z.ZodNumber>;
    retainSteps: z.ZodDefault<z.ZodNumber>;
    quanta: z.ZodDefault<z.ZodNumber>;
    perRoute: z.ZodDefault<z.ZodArray<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        enabled: z.ZodOptional<z.ZodBoolean>;
        representation: z.ZodOptional<z.ZodEnum<{
            "inline-base64": "inline-base64";
            files: "files";
        }>>;
        imageCapable: z.ZodOptional<z.ZodBoolean>;
        maxRequestImageBytes: z.ZodOptional<z.ZodNumber>;
        maxRequestImages: z.ZodOptional<z.ZodNumber>;
        minRetainImages: z.ZodOptional<z.ZodNumber>;
        retainSteps: z.ZodOptional<z.ZodNumber>;
        quanta: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    logLevel: z.ZodDefault<z.ZodEnum<{
        silent: "silent";
        error: "error";
        warn: "warn";
        info: "info";
        debug: "debug";
    }>>;
}, z.core.$strict>;
/** Validated plugin configuration. */
export type ImageBudgetGuardConfig = z.output<typeof ConfigSchema>;
/** Raw plugin configuration as written by the operator. */
export type ImageBudgetGuardConfigInput = z.input<typeof ConfigSchema>;
/** Resolved budget policy for one exact provider/model route. */
export interface RouteBudgetPolicy {
    readonly provider: string;
    readonly model: string;
    readonly representation: RouteRepresentation;
    readonly dimension: BudgetDimension;
    /** Byte budget; `Number.POSITIVE_INFINITY` when the route counts occurrences. */
    readonly maxBytes: number;
    /** Occurrence budget; `Number.POSITIVE_INFINITY` when the route counts bytes. */
    readonly maxImages: number;
    readonly minRetainImages: number;
    readonly retainSteps: number;
    readonly quanta: number;
}
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
export declare function resolveRouteBudget(config: ImageBudgetGuardConfig, provider: string, model: string, representationHint: RouteRepresentation | undefined): RouteBudgetPolicy;
/** Whether the operator disabled this exact route through `perRoute[].enabled`. */
export declare function routeEnabled(config: ImageBudgetGuardConfig, provider: string, model: string): boolean;
/** Whether the operator forced image capability for this exact route. */
export declare function routeCapabilityOverride(config: ImageBudgetGuardConfig, provider: string, model: string): boolean | undefined;
//# sourceMappingURL=config.d.ts.map