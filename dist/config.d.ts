/** Request representation a route uses for image occurrences. */
export type RouteRepresentation = 'inline-base64' | 'files';
/** Configured representation resolution; `auto` consults the route directory. */
export type RepresentationSetting = 'auto' | RouteRepresentation;
/** Which budget dimension decides the wire cost. */
export type BudgetDimension = 'bytes' | 'count';
/** Diagnostics verbosity; the plugin never changes harness logging levels. */
export declare const LOG_LEVELS: readonly ["silent", "error", "warn", "info", "debug"];
export type LogLevel = (typeof LOG_LEVELS)[number];
/**
 * Occurrence cap Mistral enforces per request.
 *
 * Mistral answers the 21st image with
 * `400 {"message":"Total number of images exceeds the maximum allowed of 20."}`,
 * so a byte budget alone cannot prevent that failure. {@link ConfigSchema}'s
 * `mistralImageLimit` switch applies this cap to Mistral routes only.
 */
export declare const MISTRAL_IMAGE_LIMIT = 20;
/**
 * Exact-route override. A route is identified by the `(provider, model)` pair
 * the request header carries; both fields are required so an override can never
 * silently apply to a different model on the same provider.
 */
export declare const RouteOverrideSchema: Schemastery<RouteOverride>;
/** Plugin configuration; every field is optional and defaulted. */
export declare const ConfigSchema: Schemastery<ImageBudgetGuardConfig>;
/** Validated plugin configuration. */
export interface ImageBudgetGuardConfig {
    readonly enabled: boolean;
    readonly dryRun: boolean;
    readonly representation: RepresentationSetting;
    readonly maxRequestImageBytes: number;
    readonly maxRequestImages: number;
    readonly mistralImageLimit: boolean;
    readonly minRetainImages: number;
    readonly retainSteps: number;
    readonly quanta: number;
    readonly perRoute: RouteOverride[];
    readonly logLevel: LogLevel;
}
/** One validated `perRoute` entry. */
export interface RouteOverride {
    readonly provider: string;
    readonly model: string;
    readonly enabled?: boolean;
    readonly representation?: RouteRepresentation;
    readonly imageCapable?: boolean;
    readonly maxRequestImageBytes?: number;
    readonly maxRequestImages?: number;
    readonly minRetainImages?: number;
    readonly retainSteps?: number;
    readonly quanta?: number;
}
/** Raw plugin configuration as written by the operator. */
export type ImageBudgetGuardConfigInput = Partial<ImageBudgetGuardConfig>;
/**
 * Reject keys the schema does not declare.
 *
 * Schemastery copies unknown keys into its result rather than failing, so this
 * is the strict half of load-time validation: a typo in the profile patch fails
 * the plugin with the exact path instead of being silently ignored.
 *
 * @param raw - configuration as the loader resolved it.
 * @throws when an unknown top-level or `perRoute` key is present.
 */
export declare function assertKnownConfigKeys(raw: Record<string, unknown>): void;
/**
 * Validate one raw configuration and materialize every default.
 *
 * @param raw - configuration from the loader, the settings form, or a caller.
 * @returns the frozen, fully defaulted configuration.
 * @throws when a value is invalid or an unknown key is present.
 */
export declare function parseConfig(raw: unknown): ImageBudgetGuardConfig;
/** Resolved budget policy for one exact provider/model route. */
export interface RouteBudgetPolicy {
    readonly provider: string;
    readonly model: string;
    readonly representation: RouteRepresentation;
    /** The bound that decides the wire cost; both bounds are still enforced. */
    readonly dimension: BudgetDimension;
    /** Byte budget; `Number.POSITIVE_INFINITY` on a Files route, whose occurrences cost references. */
    readonly maxBytes: number;
    /** Occurrence budget; enforced together with `maxBytes` on an inline route. */
    readonly maxImages: number;
    readonly minRetainImages: number;
    readonly retainSteps: number;
    readonly quanta: number;
}
/**
 * Whether a provider route is a Mistral route.
 *
 * The Mistral optimisation keys on the route id, because that is the only
 * provider fact the request header carries. `mistral`, `mistral-cn`, and
 * `Mistral_EU` all match; a gateway that renames the route does not.
 *
 * @param provider - provider route id from the request header.
 * @returns true for a route named after Mistral.
 */
export declare function isMistralRoute(provider: string): boolean;
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