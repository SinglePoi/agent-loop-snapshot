# Example Agent

这个示例使用 OpenAI-compatible HTTP 接口接入模型。密钥不会写入代码或提交到仓库，复制环境模板后只在本地 `.env` 中填写。

```powershell
Copy-Item examples/example-agent/.env.example examples/example-agent/.env
# 编辑 examples/example-agent/.env，填写 ALS_MODEL_API_KEY 和 ALS_MODEL_NAME
pnpm build
node --env-file=examples/example-agent/.env packages/example-runtime/dist/cli.js "summarize the current fixture"
```

支持通过 `ALS_MODEL_BASE_URL` 指向其他兼容 `/chat/completions` 的服务。运行结果默认写入 `runs/example-run`，可用 `ALS_SNAPSHOT_DIR` 修改目录。
