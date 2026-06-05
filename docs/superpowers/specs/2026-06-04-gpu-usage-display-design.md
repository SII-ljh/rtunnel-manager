# 节点 GPU 使用情况展示 —— 设计文档

日期：2026-06-04

## 目标

在 rtunnel 管理器页面上，为每条「运行中且可达」的隧道展示其远程节点的 GPU 使用情况：
行内一行汇总，点击展开每块卡的详细表格。

## 数据获取

通过本地隧道端口非交互式 SSH 进节点执行 `nvidia-smi`（节点已配置免密公钥）：

```
ssh -p <port> -o BatchMode=yes -o ConnectTimeout=5 \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    <user>@127.0.0.1 \
    "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits"
```

- `BatchMode=yes`：禁止任何密码/交互提示，免密不可用时快速失败而不是挂起。
- `StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null`：隧道连的都是
  `127.0.0.1:<port>`，同一端口被不同节点复用会触发 known_hosts 冲突而连不上；
  localhost 隧道场景下主机密钥校验意义不大，直接绕过。
- `ConnectTimeout=5` + 进程级超时：避免卡死轮询循环。
- CSV `noheader,nounits` 输出，便于解析；每行一块卡。

解析每行得到：`{ index, name, util, memUsed, memTotal, temp, power }`（单位：% / MiB / ℃ / W）。

## 后台轮询

- 新增独立轮询循环，复用现有健康检查的 15s 节奏（`runGpuChecks`，与 `runHealthChecks` 并列）。
- 只查 `status === 'running'` 的隧道；非运行的清掉其 GPU 记录。
- 结果存内存 Map（仿照现有 `health`），**不落盘**：
  `gpuStats: id -> { gpus: [...], queriedAt: iso, error: string|null }`。
- 单节点查询出错（无 nvidia-smi / 连接失败 / 超时）：记 `error`，`gpus` 为空，
  前端行内不展示 GPU 信息，不打扰。
- 并发执行（`Promise.all`），节点数不多，单进程超时兜底。

## 接口

复用现有 `GET /api/tunnels`，在 `publicView` 里给每条隧道加 `gpu` 字段：

```
gpu: {
  gpus: [{ index, name, util, memUsed, memTotal, temp, power }, ...],
  queriedAt: iso,
  error: string|null
} | null   // null = 未查/非运行
```

不新增独立端点：一次 nvidia-smi 查询同时供给行内汇总和展开详情，前端从同一份缓存数据渲染。

## 前端展示

- 在隧道行的 info 区，运行中且有 GPU 数据时，多渲染一行汇总，例如：
  `🎮 8× A100 · 显存 62% · 利用率 30%`（卡数型号 + 总显存占用率 + 平均利用率）。
- 该汇总行可点击展开/收起一个详细表格，每块卡一行：序号 / 型号 / 利用率 / 显存 used/total / 温度 / 功耗。
- 展开状态记在前端（类似 `editingId`），3s 定时刷新时不被覆盖。
- 无 GPU 数据 / error：不显示该行（保持页面干净）。

## 不做（YAGNI）

- 不持久化 GPU 历史、不画时序图。
- 不存任何凭据（依赖已配置的免密公钥）。
- 不为 GPU 单独加按需端口；走现有 `/api/tunnels` 即可。
