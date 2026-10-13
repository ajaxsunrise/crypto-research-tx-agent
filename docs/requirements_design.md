**Pi** 可以作为云端 Agent 的 harness，而且不必通过终端运行：官方支持 TypeScript SDK、RPC、JSON 等集成方式。对于你要构建的后端 Agent，关键不是“能不能上云”，而是选择哪一层 Pi，以及把会话持久化、任务恢复、工具执行隔离放在哪里。 [github](https://github.com/earendil-works/pi)

我的初步建议：先做“Linux 云服务器 + Pi TypeScript SDK + 独立 sandbox gateway”的原型；如果你希望云平台直接承担任务唤醒和故障恢复，也值得评估新推出的 Pi Durable + Cloudflare Agents SDK，但这条路线目前仍是实验性/Beta。 [github](https://github.com/earendil-works/pi)

## 1. Pi 是什么，适合承担哪些职责？

这里调研的是 `earendil-works/pi` 项目的 Pi agent harness，而不是同名第三方封装。它是一个最小化、可扩展的 Agent 工具包，核心包的职责如下： [github](https://github.com/earendil-works/pi)

| 组件                              | 负责什么                                        | 云端使用场景                       |
| --------------------------------- | ----------------------------------------------- | ---------------------------------- |
| `@earendil-works/pi-ai`           | 统一多家模型提供商的 API                        | 模型接入层                         |
| `@earendil-works/pi-agent-core`   | Tool calling、Agent runtime、状态管理           | 自定义业务 Agent 内核              |
| `@earendil-works/pi-coding-agent` | Coding Agent 产品层，提供 CLI 和 SDK 等集成方式 | 文件操作、代码执行、开发任务 Agent |
| `@earendil-works/pi-durable`      | 持久化 conversation、task、document runtime     | 需要任务恢复和长期运行的 Agent     |

以上职责来自官方仓库的包说明。 [github](https://github.com/earendil-works/pi)

它的设计方向是“提供内核，把具体工作方式交给扩展”。支持 extensions、skills、prompt templates，但传统 Pi 默认并不内置 subagents 和 plan mode。也就是说，它适合做可定制的 harness，但不能直接等同于完整的工作流编排平台。 [github](https://github.com/earendil-works/pi)

## 2. 云端部署主要路线

### 路线 ：Linux VPS / VM 上自托管

官方支持 Linux，当前 Node.js 要求为 22.19 或更新版本，并明确支持通过 TypeScript SDK 构建应用、通过 RPC 控制 Pi，因此可以把它放进后端服务，而不依赖交互式 TUI。 [github](https://github.com/earendil-works/pi)

架构：

```text
前端 / API 调用者
       │ HTTP / SSE
       ▼
API 层
  ├── 身份认证、租户鉴权
  ├── conversation / run 管理
  └── 事件流转发
       │
       ▼
Pi Worker（TypeScript）
  ├── 模型调用
  ├── Agent loop
  ├── 业务工具
  └── sandbox 工具适配器
       │
       ▼
Sandbox Gateway
  ├── 文件读写
  ├── 命令 / Python 执行
  ├── 网络策略
  └── 租户隔离、资源限制、审计
```

这是我的部署建议，不是 Pi 自带的完整服务架构。根据官方各包的职责，我会这样选： [github](https://github.com/earendil-works/pi)

- 通用研究、业务 API 工具型 Agent：优先评估 `pi-agent-core`，避免不必要的 coding 产品层。
- 需要文件工作区、修改代码、执行命令的 Agent：优先评估 `pi-coding-agent` SDK。
- 现有后端是 Python：可以把 Pi 做成独立 TypeScript worker，由 Python API 层调用；不必为了换 harness 重写所有业务工具。

这条路线的优势是部署和执行环境由你控制；代价是需要自行设计服务级任务生命周期，不能把“有 Agent 状态”当作“已具备可靠的分布式任务恢复”。

## 3. 最关键的边界：Pi 不是安全沙箱

官方明确说明：Pi 没有内置用于限制文件系统、进程、网络或凭证访问的权限系统；默认继承启动它的用户和进程权限。官方给出的隔离方向包括 Docker、Gondolin microVM 工具路由和 OpenShell。 [github](https://github.com/earendil-works/pi)

因此，你的云端方案应区分：

- Harness：模型调用、上下文、工具循环、事件。
- 执行边界：文件、命令、网络和凭证访问。
- 服务控制：租户鉴权、审批、配额、任务调度与审计。

尤其不要仅通过设置不同 `cwd` 来实现多租户隔离。我的建议是：不注册可直接访问宿主机的高权限工具，所有不可信代码执行和工作区访问都经过 gateway；模型凭证留在控制层，sandbox 只获得任务必要的能力。这个设计是针对官方所声明的权限边界做出的工程建议。 [github](https://github.com/earendil-works/pi)

## 4. 持久化不等于工具“恰好执行一次”

这是选型时值得单独验证的一点。

Cloudflare 集成发生恢复时，标为 `replay: "safe"` 的中断工具会再次运行；其他工具不会自动重跑，而是把 interrupted result 交给模型决定下一步。因此，`operationId` 可以避免重复提交输入，但不能自动保证所有外部副作用 exactly-once。 [developers.cloudflare](https://developers.cloudflare.com/agents/harnesses/pi/)

建议按工具类型处理：

- 查询、读取：通常可以允许重试。
- 保存文件：确认重复写入是否安全。
- 发邮件、创建记录、付款等：业务侧需要幂等键、执行记录和审批。
- 长时间代码任务：应明确取消信号、超时和结果回收行为。

这些不是额外的“框架功能装饰”，而是云端 Agent 在重启、超时和用户重试时能否可靠工作的核心。
