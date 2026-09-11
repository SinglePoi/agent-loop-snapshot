# OpenAI SDK 自动采集（离线）

示例启动本地 HTTP fixture，再以真实 OpenAI `7.15.0` SDK 发送一次 Chat Completions 请求；不需要 API key，也不会向外联网。`telemetry` 在动态加载业务模块前初始化，使用 `metadata-only` 记录模式。

```sh
pnpm build
node examples/sdk-instrumentation/demo.mjs
```

把 `openAIIntegration()` 换成 `anthropicIntegration()` 后，初始化顺序和 `telemetry.run()` 的边界保持相同；Anthropic Messages 也支持非流式与 `stream: true`。
