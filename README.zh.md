
# dsh-image-budget-guard

中文 · [English](README.md)

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的主动式图片预算守卫。**
在模型请求组装**之前**裁剪会话表层上最旧的图片，让内联 base64 请求体不会长到
拖慢请求、引发失败甚至被适配器拒绝的规模。

- [为什么需要这个插件](#为什么需要这个插件) - [特性](#特性) - [安装](#安装) - [配置](#配置) - [工作原理](#工作原理) - [与压缩插件的关系](#与压缩插件的关系)
- [持久记录](#持久记录) - [调优](#调优) - [已知限制](#已知限制) - [实测](#实测) - [开发](#开发) - [许可证](#许可证)

## 为什么需要这个插件

你是否遇到过这种情况：deepseek官方的API在进行长任务、多图片处理时，能够一直保持较低的延迟执行  
而接入第三方供应商(如commandcode)时，随着模型处理的图片越来越多，延迟(首token平均)会持续升高、频繁出现连接失败乃至出现503错误？  
本插件主要围绕该问题进行修复

接入协议决定了图片怎么到达模型，与模型质量无关。同一个上游模型，走官方路由和走第三方网关是两条完全不同的传输路径：

- **官方路由**（`deepseek-official`，`@deepseek-ai/dsh-llm-deepseek`）：图片先上传到 `/v1/files` 换成 file id，请求只携带 id 引用。预算是“字节 + 数量”双高水位（`maxRequestFilesBytes` 默认 128 MiB、`maxImagesPerRequest` 默认 600）。代价是每张新图首次出现要付一次上传（单图 `filesApiTimeoutMs` 60 s），file id 默认 7 天过期，刷新上传会更换 id 并中断该图之后的前缀缓存。
- **第三方网关**（如 `commandcode`，`@deepseek-ai/dsh-llm-pi-ai`）：没有 Files API，图片以 base64 内联在 `messages` 里，每个请求都要把历史中所有保留图片重新编码、重新上传。预算只有单图的 `requestImagePixelBudget`（默认 4 MP）、`requestImageMaxBytes`（默认 1 MiB）和整请求的 `maxRequestImageBytes`（默认 20 MiB base64），而且超限是失败驱动的：先组装、先判定超限、抛出 `IMAGE_OFFLOAD_REQUIRED`，再由 `compaction-image-offload` 省略最老图片并重试。

| 维度 | 官方路由（Files） | 第三方网关（内联） |
| --- | --- | --- |
| 图片如何到达模型 | 上传一次，请求带 file id | 每轮 base64 内联 |
| 单请求上行字节 | 与图片数量基本无关 | 随保留图片数线性增长 |
| 预算 | 128 MiB + 600 张 | 20 MiB base64（默认） |
| 超限处理 | 高水位成批省略 | 先失败一次，再省略重试 |
| 单图成本 | 首次上传（60 s/图）、7 天过期刷新 | 每轮重编码 + 重传 |
| 失败表现 | 上传超时或过期后回退内联 | 大 POST → 502/504/连接重置 → `SERVER`/`TRANSPORT` 重试 |

由此产生四类问题：

1. **历史只追加、每步全量重发。** 图片的代价是“每一步都要多传一份”，而不只是“多存一份”。一张 1920×1080 截图的请求版本约 0.7 MB，20 张就是约 14 MB 原始数据、base64 后约 19 MB。
2. **token 与字节是两套尺度。** 单图视觉 token 上限 1024，而压缩按 token 压力触发（例如 1M 上下文、38.4 万输出上限的典型配置下阈值约为 55 万 token）。token 远未到阈值时，请求体已经 10–20 MB。
3. **缓存解决不了上行。** 即使网关复用了服务端前缀，base64 仍要重新上传；官方 Files 模式也只是把“传字节”换成“传 id”。
4. **重试会放大问题。** 网关的请求体上限与代理超时会把几十 MB 的 POST 变成 502/504/连接重置，DSH 记为 `SERVER`/`TRANSPORT`，`llm/retry` 用同一条历史重试——字节不变、耗时叠加，表现就是“越到后面越慢、越容易断”。

官方路由也有退化路径：Files 解析失败或超时时，它会按内联预算用 base64 重建整份请求，此时它与第三方模式一样受上述问题影响。因此本插件同时覆盖两种路由：内联路由按字节预算主动省略，Files 路由退化为数量守卫，两者共用同一套 `image/offload` 事件与回放语义。

作为参考：一段 213 步的图片密集会话在该网关上第 50 步后累计 19 次重试（8×`TRANSPORT`、11×`SERVER`）；把单图收紧到 1 MP / 256 KiB、整请求收紧到 6 MiB 后，20 张图的图片载荷从约 19 MB 降到约 4.6 MB——代价是每张图都被降采样并重新编码，历史保真度下降，而本插件不动单图质量，只省略最旧的那些图片。

## 特性

- **请求前裁剪**：挂在 `agent/request` waterfall 上，测量本次请求将要使用的表层，
  为最旧的若干图片出现位置写入一条持久的 `image/offload` 事件，直到载荷回到预算内。
- **保留下限**：最新 `minRetainImages` 张图片、以及最近 `retainSteps` 步内出现的图片
  永远不会被省略；即使因此无法满足预算，也只报告、不破坏下限。
- **按路由选择预算维度**：内联 base64 路由用字节预算；Files/引用式路由用数量预算；
  不具备图片能力的路由直接 no-op。
- **精确计量**：尺寸取自适配器实际发送的同一套请求图片投影
  （`llm.imageRequestTarget()` + `attachments.readImageRequest()`），并按请求版本缓存，
  热态下不会重复编码历史。
- **持久且可回放**：没有隐藏的裁剪状态，决策就是一条由既有 `image/offload` 投影解释的
  日志事件；重启、恢复、分叉都会重现同样的占位结果。
- **对缓存友好**：只从最旧端整段裁剪，第一个被修改消息之前的内容在请求之间逐字节不变。
- **绝不把轮次变成失败**：估算失败、投影缺失、表层已变化、适配器拒绝，全部安全降级为
  结构化 no-op。

## 安装

### npm 源安装(暂不可用)
```sh
dsh plugin --profile web add dsh-image-budget-guard
```

### 从github仓库安装
```
dsh plugin --profile web add github:ksndjaks/dsh-image-budget-guard
```

或直接在dsh 插件界面中添加插件，输入本仓库地址安装即可

桌面端暂未经过测试

安装后重启对应 profile。`<package-spec>` 可以是 npm 包名、git 引用
（`github:<owner>/<repo>`）或本地路径（`link:/absolute/path`）。本地 checkout 需要先构建
一次;
支持 DeepSeek Harness `0.2.1-rc.1` 与 `0.2.1-rc.2`（peer 范围 `>=0.2.1-rc.1 <=0.2.1`），需要 Node.js `>=22`。

## 配置

所有字段都可选；下表为 schema 默认值。bundle 自带的配置行显式设置了 `enabled`、
`dryRun`、`maxRequestImageBytes`、`minRetainImages`、`retainSteps`、`quanta` 与
`logLevel`，见 [`cordis.patch.yml`](cordis.patch.yml)。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时所有请求钩子为 no-op。 |
| `dryRun` | `false` | 只决策与记录，不写会话事件。 |
| `representation` | `auto` | `auto` \| `inline-base64` \| `files`，决定预算维度。 |
| `maxRequestImageBytes` | `6291456` | 内联 base64 路由预算：单次请求累计编码字节。 |
| `maxRequestImages` | `60` | Files/引用式路由预算：图片出现位置数量。 |
| `minRetainImages` | `6` | 永远不省略的最新出现位置数量。 |
| `retainSteps` | `12` | 最近 N 步内出现的图片不省略（`0` 关闭该窗口）。 |
| `quanta` | `4` | 单次决策至少省略的出现位置数；候选不足时例外。 |
| `perRoute` | `[]` | 精确 `(provider, model)` 覆盖；同一对以最后一条为准。 |
| `logLevel` | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug`。 |

`perRoute[]` 可包含 `provider`、`model`，以及 `enabled`、`representation`、
`imageCapable`、`maxRequestImageBytes`、`maxRequestImages`、`minRetainImages`、
`retainSteps`、`quanta` 中任意字段。

推荐在 profile 层按 id 覆盖已安装的行，而不是改包内文件：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: image-budget-guard
  config:
    dryRun: true
```

未知字段会在加载时被拒绝：导出的 `Config` 是严格的 Zod schema，启动器通过
Standard Schema 接口校验它。

## 工作原理

1. **挂钩**：守卫以 `prepend` 监听 `agent/request` waterfall，并先 `await next()`。
   这是唯一能看到**最终** `(provider, model)` 的公开接缝（模型切换就在同一个 waterfall
   内改写它），而且它仍早于 `buildRequest()` 派生表层，因此在此追加的事件会进入
   本次请求。
2. **采集出现位置**：按请求顺序遍历当前表层，收集 `user/message` 与 `tool/result`
   节点上的每个图片出现位置，深度优先编号，且把已经投影为占位符的位置也计入。
   assistant 节点被排除：`image/offload` 只以输入节点为目标，且当前适配器声明只输出文本。
3. **计量**：对每个仍保留的出现位置，解析路由的 `imageRequestTarget`，再通过附件服务
   读出精确的请求版本，按内联 base64 长度（或 Files 路由的数量）累计。
4. **选择**：从最旧端开始按前缀删除符合条件的出现位置，一次至少 `quanta` 个，
   一旦预算满足立即停止。最新 `minRetainImages` 个与 `retainSteps` 窗口内的位置受保护；
   已被省略的位置绝不会被重复选中。
5. **记录**：写入一条 `image/offload` 事件 `{ targets: [{ seq, imageIndexes }] }`。
   随后所有路由对这些位置发送标准占位文本；消息标识与节点 id 保持不变。

除此之外不写任何东西：请求头仍由 agent loop 负责，守卫也不会改写适配器自身的图片策略。

## 与压缩插件的关系

| 插件 | 触发时机 | 行为 |
| --- | --- | --- |
| `compaction-basic` | step 前的 token 压力或上下文溢出 | 总结并替换一段表层。 |
| `compaction-image-offload` | 适配器以 `IMAGE_OFFLOAD_REQUIRED` 失败后 | 为最旧的出现位置记录 `image/offload` 并重试。 |
| **本插件** | 每次请求、组装之前 | 主动完成同一个 `image/offload` 决策。 |

它们是组合关系而非竞争关系：

- 守卫写入相同的事件类型，并复用 `compaction-image-offload` 注册的投影；若该插件未挂载，
  守卫会在首次使用时自行注册同一份定义——`dsh-session` 在没有解释器时会拒绝折叠
  `image/offload`。
- 已经投影为占位符的出现位置会被跳过，两条路径不会重复省略同一位置。
- 压缩事务进行中（存在未闭合的 `compaction/start`）时，守卫不选图也不写事件，
  先让压缩改变表层。

## 持久记录

```jsonc
// image/offload —— 仅日志事件，无表层操作
{ "targets": [ { "seq": 1497, "imageIndexes": [0] } ] }
```

- `seq` 是一个当前的消息产出事件（`user/message` 或 `tool/result`）。
- `imageIndexes` 是该消息内严格递增的深度优先图片序号，包含已被省略的位置。
- 消息节点与其 id 不变，只有投影后的内容改变。
- 事件在写入前会先校验；在表层未变时重复运行不会写入新事件（幂等）。回放、恢复与分叉
  都通过已注册的投影应用它，因此重启后的进程会重新派生出同样的占位符。

## 调优

- **预算要低于适配器上限。** `maxRequestImageBytes` 应不高于适配器自身的限制。
  `llm-pi-ai` 默认每请求 20 MiB；因此 6 MiB 的守卫预算会在适配器拒绝之前很早就生效。
- **保留下限要对照单图成本。** 经验公式：
  `maxRequestImageBytes >= minRetainImages × 单图 base64 字节`，再加上 `retainSteps`
  窗口纳入的图片。内联路由若按每图约 1 MiB 重新编码，单图约 1.33 MiB base64，
  六张就约 8 MiB——此时应抬高预算或降低下限。
- **`retainSteps` 以整条消息为单位保护。** 最近若干步内出现的图片会随其所属消息一起受保护，
  所以一次粘贴 N 张就会一次性钉住 N 个位置。若预算仍无法满足，先降 `retainSteps`
  （`0` 只保留 `minRetainImages` 下限），再降 `minRetainImages`，最后才抬高预算。
- **Files 路由**（`dsh-llm-deepseek` 的 `/v1/files`）按数量而非字节；若自动探测无法证明
  表示形式，可显式设置 `perRoute[].representation: files`。
- 预算确实不可达时，守卫会按 route/model 记录一次 `budget-unsatisfiable`，并保留下限：
  它永远不会省略受保护的图片。

## 已知限制

- **省略不可逆。** 被省略的出现位置在本会话余下部分一直是占位符；附件本身未被改动，
  仍可通过占位文本里的规范化路径读取。
- **提示缓存复用终止于首个被改消息。** 从最旧端裁剪能让前缀保持稳定，但第一个被裁剪的
  节点之后不再逐字节相等。
- **每步开销与表层节点数成正比。** 读取表层是线性的，且内容代数变化时派生消息缓存会重建
  ——决策本身就会触发这种变化。相对序列化数 MB 图片可以忽略，但在极长会话中并非为零。
- **Files 路由按数量而非字节**，因为 provider 收到的是引用而不是内联数据。
- **表示形式的自动探测是启发式的。** 适配器 API 暴露请求几何与计价，但不暴露字节是内联
  还是走 Files 端点；`auto` 会读取可配置 provider 目录，并回退到保守的内联字节预算。
  `perRoute` 是逃生口。
- **单条消息本身就超预算时无法在保留下限内修复。** 例如 `minRetainImages: 6` 会按设计
  保留六张最大尺寸图片；此时应降低下限或抬高预算。
- **它不处理与图片无关的失败。** 传输与服务器重试不在范围内。

## 实测

对一段已记录的 213 步会话（66 个图片出现位置、53 个唯一附件、8 次压缩事务）在 6 MiB
守卫预算下做离线回放：

| 场景 | 峰值（前） | 峰值（后） | `image/offload` | 适配器拒绝 |
| --- | --- | --- | --- | --- |
| 内联路由，单图目标 256 KiB，适配器上限 6 MiB | 5.98 MiB | 5.98 MiB（no-op） | 0 | 0 |
| 内联路由，单图目标 1 MiB，适配器上限 20 MiB，`retainSteps 12` | 17.06 MiB | 11.49 MiB¹ | 8 | 0 |
| 内联路由，单图目标 1 MiB，适配器上限 20 MiB，`retainSteps 0` | 17.06 MiB | **5.96 MiB** | 8 | 0 |

¹ 在这段图片密集的会话里，起约束作用的是保留下限而不是预算：`minRetainImages 6` 加上
12 步窗口后，仅受保护部分就有 11.49 MiB。所有守卫过的回放中，投影出的
`IMAGE_OFFLOAD_REQUIRED` 计数都为 0。

把真实 `llm-pi-ai` 适配器接到本地假网关也能复现同样行为：适配器使用默认值时，24 张截图
会产生 22.27 MiB 载荷并在没有守卫时以 `IMAGE_OFFLOAD_REQUIRED` 被拒；有守卫时峰值为
5.84 MiB。完整报告与逐步序列见 [`docs/reports/replay.md`](docs/reports/replay.md)。

## 开发

```sh
pnpm install          # 开发依赖（typescript、@types/node）
pnpm build            # 先软链 harness 依赖，再 tsc -> dist/
pnpm test             # 打包契约 + 选择算法 + 守卫 + 集成测试（node:test）
pnpm replay           # 离线回放 -> docs/reports/
pnpm verify:profile   # bundle 注册、层组合、真实挂载
```

`scripts/link-peers.mjs` 会从已安装的 `@deepseek-ai/dsh` 把 harness 依赖软链到本包的
`node_modules`，使 `link:` 安装的插件与运行中的 harness 共享同一个模块实例，而不是加载
第二份副本。可用 `DSH_PACKAGE_DIR` 覆盖探测到的安装位置。

```
src/config.ts       严格 Zod schema、按路由解析策略
src/select.ts       纯函数选择算法
src/projection.ts   image/offload 管线与会话表层读取
src/index.ts        agent/request 钩子与插件入口
```

## 许可证

MIT

