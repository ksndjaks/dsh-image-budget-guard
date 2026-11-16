/**
 * Client half: the plugin's own settings card.
 *
 * A third-party plugin gets no configuration UI from its Config schema alone.
 * The Plugins page treats a row as configurable only when the row's key is
 * registered on the `plugins.row.config` slot (`configLedgerSource()` in
 * `@deepseek-ai/dsh-client-ui-plugin-manager` collects exactly those keys), and
 * the row page renders that slot. So the card below is what puts the switches —
 * including the Mistral-only one — on the plugin's page.
 *
 * The key is `<package name>#<row id>` with the row id as `cordis.patch.yml`
 * declares it. The host hands the card `{view, form}`: `form.state` is the live
 * configuration and `form.mutate(ops, revision)` writes it.
 *
 * Plain JavaScript on purpose: the browser loads this file as-is through
 * `window.__ModuleLoader__`, so it needs no build step and no bundler.
 */
window.__ModuleLoader__.load({
  id: '@ksndjaks/dsh-image-budget-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'image-budget-guard';
    /** `<package name>#<row id>` — the row id is the one in cordis.patch.yml. */
    const ROW_KEY = '@ksndjaks/dsh-image-budget-guard#image-budget-guard';
    const MIB = 1024 * 1024;

    const en = {
      summary: 'Trims the oldest request images before a request is assembled.',
      title: 'Image budget guard',
      intro:
        'Replaces the oldest images with placeholder text before a model request is assembled, so an inline base64 body stays inside its budget. Changes apply to the next request.',
      loading: 'Loading the current configuration…',
      unavailable: 'This entry is not configurable right now.',
      readOnly: 'Read-only in this profile.',
      groupLimits: 'Budgets',
      groupRetention: 'Retention',
      groupAdvanced: 'Advanced',
      enabled: 'Enable the guard',
      enabledHint: 'Off makes every request hook a no-op.',
      mistralImageLimit: 'Mistral image cap (20)',
      mistralImageLimitHint:
        'Mistral rejects the 21st image even when the body is only a few MiB. On: routes whose provider is named mistral cap at 20 images. Other providers are unaffected.',
      dryRun: 'Dry run',
      dryRunHint: 'Decide and log only; write no session event.',
      maxRequestImageBytes: 'Byte budget',
      maxRequestImageBytesHint: 'Inline base64 routes: accumulated encoded bytes per request.',
      maxRequestImages: 'Occurrence budget',
      maxRequestImagesHint: 'Counted on every route; the stricter bound wins.',
      minRetainImages: 'Newest images kept',
      minRetainImagesHint: 'Never omitted, even when that leaves the budget unsatisfied.',
      retainSteps: 'Verbatim step window',
      retainStepsHint: 'Images admitted in the last N steps are never omitted. 0 keeps only the count above.',
      quanta: 'Minimum per decision',
      quantaHint: 'Occurrences omitted at once; larger rewrites the prefix less often.',
      representation: 'Budget dimension',
      representationHint: 'auto infers it from the mounted adapter.',
      logLevel: 'Log level',
      logLevelHint: 'warn records travel on the info channel.',
      saveFailed: 'Could not save. Reload the page and try again.',
      unitMiB: 'MiB',
    };

    const zh = {
      summary: '在请求组装前裁剪最旧的图片。',
      title: '图片预算守卫',
      intro:
        '在模型请求组装之前把最旧的图片替换为占位文本，让内联 base64 请求体保持在预算内。改动在下一个请求生效。',
      loading: '正在读取当前配置…',
      unavailable: '该条目当前不可配置。',
      readOnly: '本 profile 中为只读。',
      groupLimits: '预算',
      groupRetention: '保留',
      groupAdvanced: '高级',
      enabled: '启用守卫',
      enabledHint: '关闭后所有请求钩子直接返回。',
      mistralImageLimit: 'Mistral 图片数量上限（20 张）',
      mistralImageLimitHint:
        'Mistral 在请求体只有几 MiB 时也会拒绝第 21 张图。开启后，provider 名为 mistral 的路由图片上限固定为 20 张，其他供应商不受影响。',
      dryRun: '演练模式',
      dryRunHint: '只决策与记录，不写会话事件。',
      maxRequestImageBytes: '字节预算',
      maxRequestImageBytesHint: '内联 base64 路由：单次请求累计的编码字节。',
      maxRequestImages: '图片数量上限',
      maxRequestImagesHint: '所有路由都按数量统计，与字节预算取更严者。',
      minRetainImages: '保留最新图片',
      minRetainImagesHint: '永不省略，即使因此无法满足预算。',
      retainSteps: '逐字保留步数',
      retainStepsHint: '最近 N 步内出现的图片不省略。0 表示只保留上面的张数。',
      quanta: '单次最少省略',
      quantaHint: '一次省略的出现位置数；值越大，请求前缀被重写的次数越少。',
      representation: '预算维度判定',
      representationHint: 'auto 依据已挂载的适配器推断。',
      logLevel: '日志级别',
      logLevelHint: 'warn 记录走 info 通道。',
      saveFailed: '保存失败，请刷新页面后重试。',
      unitMiB: 'MiB',
    };

    const label = { color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: '20px' };
    const hint = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' };
    const rowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      padding: '10px 0',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
    };
    const textStyle = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 };
    const controlStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flex: '0 0 auto',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
    };
    const inputStyle = {
      width: 96,
      padding: '4px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      fontFamily: 'inherit',
    };
    const groupStyle = { marginTop: 12 };
    const groupTitleStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.02em',
      margin: '0 0 2px',
    };

    /** One label/description pair beside a control. */
    function Field(props) {
      return h(
        'div',
        { style: rowStyle },
        h(
          'span',
          { style: textStyle },
          h('span', { style: label }, props.label),
          props.hint === undefined ? null : h('span', { style: hint }, props.hint),
        ),
        h('span', { style: controlStyle }, props.children),
      );
    }

    /** A checkbox that writes on change. */
    function Toggle(props) {
      return h(Field, { label: props.label, hint: props.hint }, [
        h('input', {
          key: 'input',
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled,
          onChange: (event) => props.onChange(event.target.checked),
          style: { width: 16, height: 16, accentColor: 'var(--dsw-alias-brand-primary)' },
        }),
      ]);
    }

    /** A number input that writes on blur, so typing does not spam the host. */
    function NumberField(props) {
      const [text, setText] = React.useState(String(props.value));
      React.useEffect(() => setText(String(props.value)), [props.value]);
      const commit = () => {
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed !== props.value) props.onCommit(parsed);
      };
      return h(Field, { label: props.label, hint: props.hint }, [
        h('input', {
          key: 'input',
          type: 'number',
          value: text,
          min: props.min,
          step: props.step ?? 1,
          disabled: props.disabled,
          onChange: (event) => setText(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit();
          },
          style: inputStyle,
        }),
        props.suffix === undefined ? null : h('span', { key: 'suffix', style: hint }, props.suffix),
      ]);
    }

    /** A select for an enumerated field. */
    function SelectField(props) {
      return h(Field, { label: props.label, hint: props.hint }, [
        h(
          'select',
          {
            key: 'select',
            value: props.value,
            disabled: props.disabled,
            onChange: (event) => props.onChange(event.target.value),
            style: inputStyle,
          },
          props.options.map((option) => h('option', { key: option, value: option }, option)),
        ),
      ]);
    }

    /** The card the Plugins page renders for this row. */
    function ImageBudgetGuardCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? key;
      if (props.view === 'summary') return t('summary');

      const form = props.form;
      if (form === undefined) return h('p', { style: hint }, t('unavailable'));

      const state = form.state;
      if (state.status === 'unavailable') return h('p', { style: hint }, t('unavailable'));
      if (state.status !== 'ready') return h('p', { style: hint }, t('loading'));

      const value = state.value ?? {};
      const disabled = state.writable === false;
      const write = (field, next) => {
        form.mutate([{ op: 'set', path: [field], value: next }], state.revision);
      };
      const bytesToMib = (bytes) => Math.round((bytes / MIB) * 100) / 100;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('p', { style: { ...hint, margin: 0 } }, t('intro')),
        disabled ? h('p', { style: { ...hint, margin: 0 } }, t('readOnly')) : null,

        h(
          'div',
          { style: groupStyle },
          h('p', { style: groupTitleStyle }, t('groupLimits')),
          h(Toggle, {
            label: t('enabled'),
            hint: t('enabledHint'),
            checked: value.enabled,
            disabled,
            onChange: (next) => write('enabled', next),
          }),
          h(Toggle, {
            label: t('mistralImageLimit'),
            hint: t('mistralImageLimitHint'),
            checked: value.mistralImageLimit,
            disabled,
            onChange: (next) => write('mistralImageLimit', next),
          }),
          h(NumberField, {
            label: t('maxRequestImageBytes'),
            hint: t('maxRequestImageBytesHint'),
            value: bytesToMib(value.maxRequestImageBytes ?? 0),
            min: 0.01,
            step: 0.5,
            suffix: t('unitMiB'),
            disabled,
            onCommit: (mib) => write('maxRequestImageBytes', Math.round(mib * MIB)),
          }),
          h(NumberField, {
            label: t('maxRequestImages'),
            hint: t('maxRequestImagesHint'),
            value: value.maxRequestImages ?? 0,
            min: 1,
            disabled,
            onCommit: (next) => write('maxRequestImages', next),
          }),
        ),

        h(
          'div',
          { style: groupStyle },
          h('p', { style: groupTitleStyle }, t('groupRetention')),
          h(NumberField, {
            label: t('minRetainImages'),
            hint: t('minRetainImagesHint'),
            value: value.minRetainImages ?? 0,
            min: 0,
            disabled,
            onCommit: (next) => write('minRetainImages', next),
          }),
          h(NumberField, {
            label: t('retainSteps'),
            hint: t('retainStepsHint'),
            value: value.retainSteps ?? 0,
            min: 0,
            disabled,
            onCommit: (next) => write('retainSteps', next),
          }),
        ),

        h(
          'div',
          { style: groupStyle },
          h('p', { style: groupTitleStyle }, t('groupAdvanced')),
          h(NumberField, {
            label: t('quanta'),
            hint: t('quantaHint'),
            value: value.quanta ?? 1,
            min: 1,
            disabled,
            onCommit: (next) => write('quanta', next),
          }),
          h(SelectField, {
            label: t('representation'),
            hint: t('representationHint'),
            value: value.representation ?? 'auto',
            options: ['auto', 'inline-base64', 'files'],
            disabled,
            onChange: (next) => write('representation', next),
          }),
          h(SelectField, {
            label: t('logLevel'),
            hint: t('logLevelHint'),
            value: value.logLevel ?? 'info',
            options: ['silent', 'error', 'warn', 'info', 'debug'],
            disabled,
            onChange: (next) => write('logLevel', next),
          }),
          h(Toggle, {
            label: t('dryRun'),
            hint: t('dryRunHint'),
            checked: value.dryRun,
            disabled,
            onChange: (next) => write('dryRun', next),
          }),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'image-budget-guard: locale');
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: ROW_KEY,
              locale: NS,
            },
            ImageBudgetGuardCard,
          ),
        );
      },
    };
  },
});
