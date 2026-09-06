# Trace Loader 100k 基线

更新时间：2026-09-06

基准脚本：`packages/trace/benchmarks/loader-100k.js`

运行命令：

```bash
pnpm benchmark:trace
```

脚本先生成临时的 100,000 事件线性快照，再只测量 `loadTraceSnapshot()` 的加载、schema/结构诊断和索引构建时间；临时目录会在运行结束后删除。artifact 内容读取不在本基准范围内。

本机环境：

- Node.js `v24.20.0`
- pnpm `11.19.0`
- Windows `win32-x64`

三次连续运行结果：

| Run |   加载耗时 |           吞吐 |  RSS 增量 | Heap 增量 |
| --- | ---------: | -------------: | --------: | --------: |
| 1   | 2961.04 ms | 33772 events/s |  47.20 MB |  84.88 MB |
| 2   | 2073.94 ms | 48217 events/s | 133.89 MB | 128.02 MB |
| 3   | 2446.90 ms | 40868 events/s | 134.57 MB | 127.42 MB |

当前记录基线为中位加载耗时 `2446.90 ms`、约 `40868 events/s`。RSS 和 Heap 增量受 Node.js GC、进程启动状态及系统负载影响，仅用于后续回归比较，不作为跨机器硬阈值。

M2 收尾后的最终工作区复测结果为 `1906.66 ms`、约 `52448 events/s`；该结果用于确认基准脚本仍可运行，不替换上面的三次基线记录。
