/**
 * Strict configuration for the image budget guard.
 *
 * The schema is a **schemastery** object, not a Zod object, because that is the
 * only shape the Harness plugin settings page can render: `isNativeConfigSchema()`
 * in `@deepseek-ai/dsh-app-boot` requires `Symbol.for('schemastery')` on the
 * exported `Config`, and a schema that fails that check is reported as
 * `unsupported`, leaving the plugin with no form at all. Schemastery also
 * implements the Standard Schema `~standard` interface cordis validates through,
 * so load-time validation is unchanged.
 *
 * Schemastery merges unknown keys instead of rejecting them, so
 * {@link parseConfig} adds the strict check the loader cannot express: an unknown
 * key fails the plugin at load time with the offending path.
 *
 * @module @ksndjaks/dsh-image-budget-guard/config
 */
import z from '@deepseek-ai/schemastery';
/** Diagnostics verbosity; the plugin never changes harness logging levels. */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'];
/**
 * Occurrence cap Mistral enforces per request.
 *
 * Mistral answers the 21st image with
 * `400 {"message":"Total number of images exceeds the maximum allowed of 20."}`,
 * so a byte budget alone cannot prevent that failure. {@link ConfigSchema}'s
 * `mistralImageLimit` switch applies this cap to Mistral routes only.
 */
export const MISTRAL_IMAGE_LIMIT = 20;
const representationSetting = z
    .union([z.const('auto'), z.const('inline-base64'), z.const('files')])
    .default('auto')
    .volatile()
    .description('预算维度判定方式。auto 依据已挂载的适配器目录推断：llm-pi-ai 视为内联 base64（按字节），llm-deepseek 视为 Files（按数量）；推断不出时保守按字节。');
/**
 * Exact-route override. A route is identified by the `(provider, model)` pair
 * the request header carries; both fields are required so an override can never
 * silently apply to a different model on the same provider.
 */
export const RouteOverrideSchema = z.object({
    provider: z.string().min(1).required().description('供应商路由 id，精确匹配。'),
    model: z.string().min(1).required().description('模型 id，精确匹配。'),
    enabled: z.boolean().description('该路由是否参与裁剪；false 时完全跳过。'),
    representation: z
        .union([z.const('inline-base64'), z.const('files')])
        .description('强制该路由的表示形式，覆盖自动探测。'),
    imageCapable: z.boolean().description('强制该路由是否具备图片能力，覆盖适配器声明的模态。'),
    maxRequestImageBytes: z.natural().min(1).description('该路由的字节预算，覆盖全局值。'),
    maxRequestImages: z.natural().min(1).description('该路由的数量预算，覆盖全局值。'),
    minRetainImages: z.natural().description('该路由保留的最新图片张数，覆盖全局值。'),
    retainSteps: z.natural().description('该路由的逐字保留步数窗口，覆盖全局值。'),
    quanta: z.natural().min(1).description('该路由单次决策至少省略的出现位置数，覆盖全局值。'),
});
/**
 * Plugin configuration; every field is optional and defaulted.
 *
 * The scalar fields are `.volatile()` because the Harness plugin settings page
 * only renders volatile fields (`volatileForm()` in dsh-settings drops a plain
 * scalar), and a volatile field is what the settings service is allowed to
 * rewrite live. `perRoute` stays ordinary config: it is an advanced list edited
 * in the profile patch, and `settings.write` preserves ordinary fields.
 *
 * A volatile field resolves to a `{ get() }` wrapper, so the schema's output
 * type is not {@link ImageBudgetGuardConfig}; {@link parseConfig} unwraps it.
 */
export const ConfigSchema = z.object({
    enabled: z
        .boolean()
        .default(true)
        .volatile()
        .description('总开关。关闭后所有请求钩子直接返回，不写任何事件。'),
    dryRun: z
        .boolean()
        .default(false)
        .volatile()
        .description('只决策与记录，不写会话事件。用于先观察将省略哪些图片。'),
    representation: representationSetting,
    maxRequestImageBytes: z
        .natural()
        .min(1)
        .default(6 * 1024 * 1024)
        .volatile()
        .description('内联 base64 路由的字节预算：单次请求累计的编码字节。应不高于适配器自身的 maxRequestImageBytes（llm-pi-ai 默认 20 MiB）。'),
    maxRequestImages: z
        .natural()
        .min(1)
        .default(60)
        .volatile()
        .description('出现位置数量预算。内联路由与字节预算同时生效（取更严者），Files 路由只按数量。DeepSeek 的 /v1/files 允许 600 张，可按需调高。'),
    mistralImageLimit: z
        .boolean()
        .default(false)
        .volatile()
        .description('针对 Mistral 供应商的单独优化：启用后，Mistral 路由的图片数量上限固定为 20 张（Mistral 会拒绝第 21 张图，即使请求体只有几 MiB）。只影响 provider 名为 mistral 的路由，其他供应商不受影响。'),
    minRetainImages: z
        .natural()
        .default(6)
        .volatile()
        .description('永远不省略的最新图片张数。保留下限 = 该值 × 单图请求字节，且优先于预算：无法满足预算时只记录 budget-unsatisfiable，不破坏下限。'),
    retainSteps: z
        .natural()
        .default(12)
        .volatile()
        .description('最近 N 步内出现的图片不省略（0 表示只保留 minRetainImages 下限）。注意它以整条消息为单位保护，一次粘贴 N 张会一次性钉住 N 个位置。'),
    quanta: z
        .natural()
        .min(1)
        .default(4)
        .volatile()
        .description('单次决策至少省略的出现位置数；候选不足时例外。值越大，请求前缀被重写的次数越少。'),
    perRoute: z
        .array(RouteOverrideSchema)
        .default([])
        .description('按 (provider, model) 精确覆盖；同一对以最后一条为准。'),
    logLevel: z
        .union(LOG_LEVELS.map((level) => z.const(level)))
        .default('info')
        .volatile()
        .description('日志级别。注意 warn 记录走 info 通道（DSH 默认只收集 error/info）。'),
});
/** Top-level keys the schema accepts. */
const CONFIG_KEYS = new Set([
    'enabled',
    'dryRun',
    'representation',
    'maxRequestImageBytes',
    'maxRequestImages',
    'mistralImageLimit',
    'minRetainImages',
    'retainSteps',
    'quanta',
    'perRoute',
    'logLevel',
]);
/** Keys one `perRoute` entry accepts. */
const ROUTE_KEYS = new Set([
    'provider',
    'model',
    'enabled',
    'representation',
    'imageCapable',
    'maxRequestImageBytes',
    'maxRequestImages',
    'minRetainImages',
    'retainSteps',
    'quanta',
]);
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
export function assertKnownConfigKeys(raw) {
    for (const key of Object.keys(raw)) {
        if (!CONFIG_KEYS.has(key))
            throw new Error(`image-budget-guard: unknown config key "${key}"`);
    }
    const routes = raw['perRoute'];
    if (!Array.isArray(routes))
        return;
    routes.forEach((route, index) => {
        if (typeof route !== 'object' || route === null || Array.isArray(route))
            return;
        for (const key of Object.keys(route)) {
            if (!ROUTE_KEYS.has(key)) {
                throw new Error(`image-budget-guard: unknown config key "perRoute[${index}].${key}"`);
            }
        }
    });
}
/** Cordis marks a volatile reference with this write symbol. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
/**
 * Read one field, unwrapping a volatile reference.
 *
 * @param value - a resolved field, possibly a cordis volatile reference.
 * @returns the plain value.
 */
function unwrapVolatile(value) {
    if (value === null || typeof value !== 'object')
        return value;
    const candidate = value;
    if (typeof candidate.get !== 'function')
        return value;
    if (!(VOLATILE_WRITE in value))
        return value;
    return candidate.get();
}
/**
 * Unwrap every top-level field of a resolved configuration.
 *
 * @param raw - a configuration object, possibly holding volatile references.
 * @returns a plain object; `{}` for a non-object input.
 */
function unwrapRecord(raw) {
    if (raw === null || typeof raw !== 'object')
        return {};
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
        result[key] = unwrapVolatile(value);
    }
    return result;
}
/**
 * Read the live configuration without re-validating it.
 *
 * The loader hands `apply()` a resolved configuration in which every volatile
 * field is a `{ get() }` reference, and a settings change updates that reference
 * in place rather than remounting the plugin (cordis tutorial, "Volatile
 * fields"). Reading through this function on each request is what makes the
 * settings page take effect without a restart.
 *
 * @param raw - the resolved configuration the guard was mounted with.
 * @returns the current plain configuration.
 */
export function readConfig(raw) {
    return unwrapRecord(raw);
}
/**
 * Validate one raw configuration and materialize every default.
 *
 * Accepts both shapes callers actually pass: a raw object (tests, embedded
 * hosts) and the loader's resolved object whose volatile fields are references.
 * References are unwrapped *before* validation, because a reference is not the
 * scalar its schema expects.
 *
 * @param raw - configuration from the loader, the settings form, or a caller.
 * @returns the fully defaulted configuration with plain values.
 * @throws when a value is invalid or an unknown key is present.
 */
export function parseConfig(raw) {
    const input = unwrapRecord(raw === undefined || raw === null ? {} : raw);
    assertKnownConfigKeys(input);
    let value;
    try {
        // A schemastery schema is callable: it returns the resolved value or throws.
        value = ConfigSchema(input);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`image-budget-guard: invalid config: ${detail}`);
    }
    // Validation re-wraps volatile fields, so unwrap the result once more.
    return unwrapRecord(value);
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
export function isMistralRoute(provider) {
    return /^mistral(?:[-_]|$)/i.test(provider);
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
export function resolveRouteBudget(config, provider, model, representationHint) {
    let override;
    for (const candidate of config.perRoute) {
        if (candidate.provider === provider && candidate.model === model)
            override = candidate;
    }
    const representation = override?.representation ??
        (config.representation === 'auto' ? (representationHint ?? 'inline-base64') : config.representation);
    // `dimension` names the bound that decides the wire cost: inline routes pay
    // bytes, Files routes pay a reference per occurrence. It does NOT switch the
    // other bound off. A provider can cap the body size and the image count
    // independently — Mistral answers 21 occurrences with "Total number of images
    // exceeds the maximum allowed of 20" while the body is still a few MiB — so an
    // inline route enforces both bounds and the stricter one wins. A Files route
    // keeps `maxBytes` unbounded because its occurrences cost ids, not bytes.
    const dimension = representation === 'files' ? 'count' : 'bytes';
    const configuredMaxImages = override?.maxRequestImages ?? config.maxRequestImages;
    // The Mistral switch only lowers the cap; an explicit perRoute value above it
    // still cannot lift the provider's own limit.
    const maxImages = config.mistralImageLimit && isMistralRoute(provider)
        ? Math.min(configuredMaxImages, MISTRAL_IMAGE_LIMIT)
        : configuredMaxImages;
    return Object.freeze({
        provider,
        model,
        representation,
        dimension,
        maxBytes: representation === 'files'
            ? Number.POSITIVE_INFINITY
            : (override?.maxRequestImageBytes ?? config.maxRequestImageBytes),
        maxImages,
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