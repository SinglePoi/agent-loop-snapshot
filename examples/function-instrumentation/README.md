# 通用函数包装（离线）

此示例不访问网络或模型服务；它包装一个内存模型函数和只读工具，并在最后显式 checkpoint，从而生成带真实状态 hash 的快照。

```sh
pnpm build
node examples/function-instrumentation/demo.mjs
```

设置 `ALS_SNAPSHOT_DIR=./runs/function-example` 可指定快照父目录。每次 `run()` 仍会创建唯一子目录。
