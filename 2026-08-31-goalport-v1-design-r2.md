# Standalone Coding-Agent Control Plane

## V1 产品与架构设计规范 · r2

- 修订日期：2026-08-31。
- 基线：2026-08-30 的 29 节设计规范；本文件保留其章节组织，并整合后续明确的修订方向。
- 工作名称：`GoalPort`，仅作暂名；本文件不代表商标、域名或公开仓库名称已经核验或获准使用。
- 状态：产品设计修订稿，已进行文档级静态检查；不是已执行的 implementation plan，也不是现行 Goal Harness 的独立 plan/execution audit 通过记录。
- 本轮范围：修订产品设计及开发交付边界，不修改用户的全局规则、Skill、agents、hooks 或原设计文件，不创建 Git 提交或外部资源。

本文中的“必须”是待实现、待验收的产品要求，不是对当前软件能力的声明。Runtime 接口、订阅接入、原生功能覆盖和 Windows 生命周期均须在实际版本上验证；本轮没有运行真实 Runtime。

开发本产品使用开发环境现有的 `goal-autopilot-harness`。该 Skill 是开发方法，不是产品依赖。产品不要求最终用户安装这一 Skill，不解析其私有运行状态，不添加针对个人 Harness 的管理层。

r2 的取舍是：四项产品能力全部保留；减少重复控制、仪式化字段和未经实测固定的部署细节。产品实施里程碑使用 `M0–M5`，与开发 Harness 自身的阶段分开。

---

## 1. 执行摘要

本产品是一个本地优先、纯对话式、订阅感知、可恢复、可验证的 Coding Agent 桌面控制面。它统一管理用户本机已经安装并登录的 Claude Code、Codex 与 Grok Runtime，但不替代这些 Runtime，也不替代 VS Code。

核心对象不是 Provider Chat Thread，而是持续的工程执行：

```text
Campaign → Task → Attempt
```

- `Campaign`：用户希望完成的长期工程目标。
- `Task`：稳定的责任单元及其验收标准。
- `Attempt`：某个 Agent Runtime 对某个 Task 的一次责任承接。
- Provider 原生 thread/session：Attempt 的运行载体，不是任务连续性的权威来源。

产品同时解决四类痛点：

1. `Durability`：GUI、Adapter 或 Runtime 异常后，已经由 Core 确认持久化的任务、证据引用和责任关系仍可恢复；未收到或未提交的信息明确标为缺口，不承诺隐藏会话或任意进程都能无损续跑。
2. `Quality`：区分 Agent 声明、系统观察与已验证结果，不把“Agent 说完成了”伪装成“已验证”。
3. `Routing`：按用户策略、Runtime 能力、历史质量、稳定性、资源压力和容量信号，在多个订阅之间手动、推荐或自动分配角色。
4. `Effort Reduction`：自动处理安全且已授权的推进、恢复、审计和改派，只在真正需要用户裁决时中断。

产品不是 IDE、模型 API 聚合器、第四套 Agent Runtime、通用工作流平台或 Git 管理器。

---

## 2. 问题定义

本设计以用户在多订阅、长程工程任务中的实际痛点为需求来源，不把以下观察当作对所有竞品的已验证结论：

- GUI 或 Runtime 崩溃后，用户需要手工恢复上下文、重启任务或重新解释进度。
- 同一 Agent 经常同时负责执行与自证，结果缺乏独立验证和证据绑定。
- 多个高价订阅之间缺乏基于实际质量、可靠性、容量和资源影响的分工。
- 用户被迫持续充当项目经理：盯日志、续推、重发提示、组织审计、核对测试、处理交接。
- 多 Agent 前端通常只统一聊天外观，没有统一工程任务的连续性、工作区责任、恢复语义和验证状态。
- 一些产品逐渐膨胀为 IDE、终端、Git 客户端、工作流画布和插件平台，反而提高使用摩擦。

本产品的核心命题是：

> 将多个原生 Coding Agent Runtime 置于一个持久、策略驱动、可解释的本地控制面之下，使工程目标跨进程、跨会话和必要时跨 Provider 保持连续，同时保留用户对自动化、数据流动、验证门槛和路由目标的控制权。

---

## 3. 产品责任边界

### 3.1 VS Code

VS Code 是唯一完整的人工代码工作区，负责：

- 人工查看和编辑代码；
- LSP、补全、调试、Git 和扩展生态；
- 用户主动打开文件、diff、终端或项目。

本产品只提供只读 diff、证据摘要和定位跳转：

```text
Open project in VS Code
Open changed file in VS Code
Open file at line
Open diff in VS Code
Open terminal in VS Code
```

### 3.2 Desktop UI 与 Local Control Core

本产品负责：

- Campaign、Task、Attempt、Policy 与状态连续性；
- 多订阅角色分配、路由和故障改派；
- 计划、执行、验证、审计与修复的宏观编排；
- Runtime 和 Adapter 生命周期监督；
- 权限请求展示与用户决策传递；
- 工作区 Lease、外部修改检测和证据 freshness；
- HandoffPacket、ReviewBundle、Evidence 和 Decision 记录；
- 本地持久化、通知、恢复和历史；
- 纯对话式统一界面。

### 3.3 Claude Code、Codex 与 Grok Runtime

原生 Runtime 负责：

- Provider 认证和订阅使用；
- 模型调用与 Agent loop；
- 代码库上下文构建；
- planning、reasoning、subagent 和工具调用；
- plugins、skills、hooks、MCP；
- shell、文件修改、测试执行和原生命令；
- 各自的配置和 Provider session。

### 3.4 不可破坏的责任原则

> Agent Runtime 拥有智能和工具；GUI App 拥有 App 范围内的连续性、协调和控制；VS Code 拥有编辑体验。

因此本产品不得：

- 重新实现 Runtime 的 plugins、skills、hooks、MCP 或工具系统；
- 复制、转换或统一 `CLAUDE.md`、`AGENTS.md` 等原生指令；
- 构建第四套 planner、context manager 或代码工具链；
- 在 UI 或 Core 中直接解释 Provider 原生配置；
- 代替 Runtime 登录、保存或转售 Provider 账户能力。

### 3.5 原生流程不被接管，产品编排仍然保留

App 可按用户选择分配规划、执行、审计和验证等角色，但只对自己明确承接的任务范围进行调度。Runtime 内已经启动的 Skill、subagent 或内部计划仍由 Runtime 管理。App 不创建竞争性控制器、不直接修改其原生状态、不为 GUI 展示伪造 audit pass，也不以提示词要求绕过原生规则。

App 在可确认的阶段边界接收结果、启动获准的下一项责任或提出接管。只有自然语言输出、没有可确认状态时，保留“未确认”而不是假定内部阶段已完成。RoleAssignment 不自动等于 Runtime 内部角色或 subagent。

这是一条通用兼容边界，不引入 `NativeRunBinding`、GAH schema reader、个人 Harness 管理器或强制的“原生 Harness 托管”产品模式。普通用户同样可以使用全部 App 能力，不需要安装开发者的 Goal Skill。

### 3.6 开发流程不等于产品功能

开发代理依据现行 Kernel 与 Goal Skill 生成、审计和执行本项目的实施计划。项目材料只补充产品目标、仓库事实、约束和验收；不复制 Skill 的状态机、角色配置、模型偏好和运行目录。产品是否读取某项运行证据，由用户授权及通用协议决定，不由开发者个人文件布局决定。

---

## 4. 总体设计原则

1. 固定机制，开放策略。计划、审计、路由、恢复、自动推进和完成门槛由用户配置；偏好可覆盖，但当前有效的权限、安全边界及证据真实性不能被普通预设削弱。历史快照不替代动作时授权。
2. Campaign-centric，而非 Thread-centric。Provider thread 不是权威任务状态。
3. Core 是 App 自有 Campaign 控制状态的唯一写入者。Runtime 的会话、Skill 状态与工具结果仍有各自权威来源；App 的观察投影不是第二个原生控制器。
4. 所有自动决策可解释、可覆盖、可追溯。不使用隐藏的黑箱裁决。
5. 原生 Runtime 优先。App 只通过薄 Adapter 使用结构化接口，不复制 Runtime 能力。
6. 证据绑定实际目标与执行范围。验证、审计和完成结论关联 Workspace Snapshot、实际执行结果和适用边界；Mock、退出码或他人叙述不能越级证明真实产品行为。
7. 未知即未知。对无法确认的能力、额度、外部副作用、恢复状态和数据来源不得伪造确定性。
8. Local-first 不等于 local inference。App 自有状态默认本地保存，但 Provider Runtime 仍可能向对应云端发送项目内容。
9. 默认体验简单，底层模型严格。用户首先看到对话、状态和决策；复杂细节按需展开。
10. 从第一次提交起可公开。开发仓库只使用合成数据，不依赖发布前清理敏感信息。
11. 不以“未来可能需要”为理由扩张。新功能必须改善 D/Q/R/E 至少一项。
12. 不做虚假安全承诺。Workspace Lease 不是操作系统沙箱，App 也不承诺任意外部副作用 exactly once。

---

## 5. 核心领域模型

### 5.1 顶层关系

```text
Project
└── Campaign
    ├── Goal
    ├── Constraints
    ├── Policy Snapshots
    ├── Active Plan Revision
    ├── Tasks
    │   └── Attempts
    ├── Decisions
    ├── Evidence
    └── Final Outcome
```

### 5.2 Project、Repository、Workspace

- `Project`：用户在 App 中组织 Campaign 的逻辑容器。
- `Repository`：Git 仓库身份；允许非 Git 目录，但相关能力会降级。
- `Workspace`：某个 Runtime 实际读取和修改的具体目录。
- `WorkspaceBinding`：Campaign 或 Task 与 Workspace 的绑定关系。

App 在 V1 不自动创建、删除、stash、commit、merge 或管理 Git worktree。

### 5.3 Campaign

```text
Campaign
├── goal
├── constraints
├── policy_snapshot_id
├── data_policy_snapshot_id
├── resource_policy_snapshot_id
├── active_plan_revision
├── current_disposition
├── tasks
├── blocking_decisions
└── final_outcome
```

Campaign 不因某个 Runtime、Provider session 或 GUI 终止而消失。

### 5.4 Task

```text
Task
├── objective
├── acceptance_criteria
├── dependencies
├── assurance_requirements
├── task_profile
├── workspace_binding
├── access_intent
├── policy_overrides
├── source
└── current_disposition
```

来源：

```text
USER_CREATED
AGENT_PROPOSED
AUDIT_REQUESTED
RECOVERY_CREATED
PLAN_REVISION
```

### 5.5 Attempt

`Attempt` 表示某个 Runtime 对某个 Task 的一次责任承接，不等于进程、单轮消息或 Provider session。

```text
Attempt
├── task_id
├── role_assignment
├── runtime_binding
├── provider_session_reference
├── process_epochs
├── adapter_connection_epochs
├── capability_snapshot
├── resolved_execution_contract
├── workspace_lease
├── lifecycle
├── assurance_status
└── evidence_refs
```

仍属于同一 Attempt：

- UI 重连；
- Adapter 重连；
- Runtime 重启后成功恢复原生 session；
- 相同责任范围内，审计要求修复且原 session 仍可继续：记录 repair/review 事件，继续同一 Attempt。

创建新 Attempt：

- 原 session 无法恢复，创建新的同 Provider session；
- 切换到另一个 Provider；
- 目标或责任范围发生获准变更，无法作为当前责任的继续；
- 用户明确重新开始该 Task。

审计的 `needs-fix` 不等于故障改派。App 不把 Runtime 内部的 executor generation、subagent ID 或每个 turn 硬映射为自己的 Attempt。原生流程内部的修复和重规划由其原有规则处理；App 仅记录可观察状态。

### 5.6 RoleAssignment

路由对象是角色分配，而不是为整个 Campaign 粗粒度选择一个 Agent。

```text
RoleAssignment
├── role
├── selected_runtime_profile
├── selected_model_or_mode
├── policy_snapshot
├── routing_decision_id
└── task_id
```

角色：

```text
TRIAGE
PLANNER
PLAN_AUDITOR
EXECUTOR
VERIFIER
EXECUTION_AUDITOR
RECOVERY_OWNER
```

模型或模式只有在 Runtime 通过结构化能力明确暴露时才可选。

### 5.7 ProcessEpoch 与 AdapterConnectionEpoch

- `ProcessEpoch`：一次具体 Runtime 进程生命周期。
- `AdapterConnectionEpoch`：一次 Adapter 连接生命周期。

Adapter 崩溃且 Runtime 存活，只能证明进程状态，不能证明旧连接可重新附着。只有该 transport 的重新附着能力已经验证、session 身份一致且副作用已核对时，才只新增 AdapterConnectionEpoch。否则进入 R2、R3 或阻塞。进程 PID 必须与创建身份一起核对，不能仅凭 PID 或“还活着”认定恢复成功。

---

## 6. 状态模型

### 6.1 Attempt 的单一权威生命周期

```text
QUEUED → ACTIVE → AWAITING_REVIEW → CLOSED
            ↑             │
            └── 修复继续 ──┘

执行故障可进入 FAILED；明确取消可进入 CANCELLED。
```

- `ACTIVE`：当前角色仍在执行。一个 turn 结束不自动结束 Attempt。
- `AWAITING_REVIEW`：执行者已交回结果，等待当前策略要求的审阅或接收决定。
- `CLOSED`：本次角色承接已结束；它不自动表示实现正确、审计通过或整个 Campaign 完成。
- 审计要求修复、原 session 可继续且范围未变时，`AWAITING_REVIEW → ACTIVE`，保留责任身份与历史。
- 关闭审计的简单交互可按策略接收结果后进入 `CLOSED`；Assurance 仍可能只是 `CLAIMED`。
- 已关闭 Attempt 不覆盖旧结果。用户后来重开任务、变更责任或无法恢复原 session 时，创建关联的新 Attempt。

Runtime 健康和等待原因是独立维度，不复制生命周期：

```text
Runtime health:
NOT_STARTED / STARTING / CONNECTED / DISCONNECTED / RECOVERING / UNRECOVERABLE

Wait condition:
NONE / PERMISSION / USER_DECISION / REVIEW / RATE_LIMIT / EXTERNAL_DEPENDENCY / PROVIDER_CAPACITY
```

### 6.2 工作状态与可信状态

Task/Campaign 的 `Work Status` 是从当前计划、所需责任及关闭决定推导的读模型，不允许 UI 或 Adapter 单独写入：

```text
IN_PROGRESS / FINISHED / ABANDONED / FAILED
```

`FINISHED` 表示当前工作完成条件已被接受，`FAILED` 需要剩余恢复路径及策略共同判定；一个 Attempt 失败不能直接推出 Campaign 失败。

可信状态单独表达：

```text
UNASSESSED / CLAIMED / PARTIALLY_VERIFIED / VERIFIED / WAIVED / CONTESTED
```

历史 Verdict 不改写；当前 Assurance 投影可因新修改、证据过期或新反证改变。`WAIVED`、`CONTESTED`、`PARTIALLY_VERIFIED` 不是可按整数大小比较的保证等级。依赖条件必须指明要满足的证据、审计和豁免规则。

### 6.3 可选阶段，不是每次消息的强制手续

```text
INTAKE → [TRIAGE] → [PLAN] → [PLAN_AUDIT]
→ EXECUTE → [VERIFICATION] → [EXECUTION_AUDIT] → [REPAIR] → CLOSEOUT
```

Campaign 阶段与运行 disposition 分开。`BLOCKED`、`PAUSED`、`RECOVERING`、`FAILED`、`CANCELLED` 不应与每个阶段做笛卡尔积枚举。

普通问答与微小可逆编辑可以只使用一个 Root Task 和直接交互，不强制启动整套流程。用户选择更强策略时才增加相应阶段；操作权限和证据真实性不随轻量模式降低。

取消请求不等于取消完成。Runtime 未确认停止、工作区可能继续变化或外部效果未知时，保留相应不确定状态，停止新写入者的调度。

---

## 7. 策略模型

### 7.1 不可关闭的不变量

- 关键状态迁移必须持久化；
- 权限不得静默升级；
- Provider 凭据不得进入 App 数据域；
- 自动决策必须留下原因和事件记录；
- Attempt 失败不得破坏 Campaign 和 Task 完整性；
- 缺少证据的结果不得显示为已验证；
- 未知外部副作用不得盲目重放；
- 同一 Workspace 不得存在两个受管 Mutating Lease；
- 未授权跨 Provider 数据不得发送。

### 7.2 PolicyProfile

```text
PolicyProfile
├── autonomy_policy
├── verification_policy
├── routing_policy
├── recovery_policy
├── permission_policy
├── budget_policy
├── notification_policy
├── data_policy
├── concurrency_policy
└── resource_policy
```

### 7.3 分层覆盖与快照

```text
用户默认
    ↓
项目覆盖
    ↓
Campaign 覆盖
    ↓
Task 单次覆盖
```

UI 显示最终生效值及来源。Campaign 启动时保存不可变 `PolicySnapshot`，普通默认偏好的变化不静默重写活动 Campaign 的历史。

偏好覆盖与授权检查不同：下层偏好不能放宽当前有效的 owner、安全、数据或 Runtime 限制。撤销权限、禁用 Provider、缩小可发送数据范围后，下一项受影响动作立即重新判断；旧快照不能作为持续授权凭证。放宽授权必须由具有相应权限的用户明确操作并留痕。

计划批准、审计通过、选择 Autonomous、Runtime 返回 allow 选项均不自动构成某项外部动作的授权。每次受控动作检查当前目标、当前实体版本、现行授权与撤销状态。历史策略仍保留原值，以解释当时的决定。

Profile 字段只在实际影响行为时填写。未启用的审计、无可靠来源的额度或不使用的分流策略，不产生占位证明、虚构数值或必填仪式。

### 7.4 工作方式预设

- `Hands-on`：主要步骤由用户确认。
- `Assisted`：系统推荐，用户确认关键动作。
- `Autonomous`：自动推进安全步骤，仅在 hard stop 中断。
- `High Assurance`：严格计划审计、执行审计和证据门槛。
- `Custom`：开放全部策略字段。

预设只是初始配置，不是独立代码路径。

### 7.5 不做任意工作流 DSL

V1 使用稳定生命周期与正交策略，不提供任意节点、脚本条件、无限循环或可视化工作流画布。

---

## 8. 计划、任务图与自主推进

### 8.1 受约束的 Task DAG

Campaign 可包含扁平 Task DAG：

- 只有显式依赖；
- 禁止循环依赖；
- 禁止无限层级嵌套；
- Runtime 内部 subagent 不提升为 Core Task；
- 修复通过同一 Attempt 的继续和有序修复事件表达；更换责任承接才新建 Attempt，计划变化通过 PlanRevision 表达。

最简单的 Campaign 始终合法：

```text
Campaign
└── Root Task：完成用户目标
```

### 8.2 PlanArtifact 与 WorkGraph 分离

- `PlanArtifact`：人类可读方案、理由、风险和执行顺序。
- `WorkGraph`：Core 可调度的 Task 与依赖。

Agent 可以提交：

```text
PlanProposal
├── narrative
├── proposed_tasks
├── proposed_dependencies
├── assumptions
├── risks
├── unresolved_questions
├── source_attempt
└── schema_version
```

Core 不通过正则或启发式把任意散文偷偷转换为正式 WorkGraph。结构化提案失败时，可退化为单一 Root Task或要求 Runtime 重新输出。

### 8.3 PlanRevision

```text
PlanRevision
├── revision_number
├── based_on_revision
├── plan_artifact
├── task_changes
├── dependency_changes
├── rationale
├── proposed_by
├── approved_by
└── effective_at
```

旧版本不可覆盖。正在运行的 Attempt 目标不得被静默改写。执行方法、调度或拆分在既定验收、scope 和授权边界内变化时，按已选策略自主修订与必要复审，不把每次计划细化都升级为 owner 请求。验收范围、权限、安全或数据边界需要变化时才请求对应裁决。

### 8.4 Plan Audit

```text
APPROVE
APPROVE_WITH_NONBLOCKING_RISKS
REVISION_REQUIRED
REJECT
INCONCLUSIVE
```

Auditor 只能产生 `PlanChangeProposal`，不得直接修改正式 WorkGraph。

### 8.5 Scheduler

Task 可执行必须同时满足：

1. Task 已批准且未被取消或取代；
2. 依赖满足；
3. Policy 允许推进；
4. Workspace Lease 可获得；
5. 至少一个 Runtime 合格；
6. Data Policy 允许数据流动；
7. 不存在阻断 Decision；
8. 未超过预算、重试和修复上限。

所有推进都转换为明确的 Core Command。Adapter 不得自行重试、改派或创建额外 Attempt。

### 8.6 依赖 Assurance 门槛

Task 依赖可以要求：

```text
required_work_condition
required_evidence_or_audit_predicates
accepted_waiver_scope
```

上游证据 stale 后，未开始的下游 Task 如何处理由策略决定，但不得继续假装旧验证有效。

### 8.7 ScopeChangeProposal

Agent 不能自行扩大 Campaign：

```text
ScopeChangeProposal
├── requested_change
├── reason
├── relation_to_goal
├── estimated_impact
├── affected_tasks
├── risk
└── source_attempt
```

策略：

```text
DENY
RECOMMEND
AUTO_WITHIN_BOUNDS
CUSTOM
```

已经发生的未授权扩张记录为 `UnauthorizedScopeDrift`。

### 8.8 修复与重试上限

```text
RepairPolicy
├── max_attempts_per_task
├── max_audit_cycles
├── max_provider_switches
├── max_elapsed_time
├── repeated_failure_threshold
└── exhaustion_behavior
```

同类失败重复且无实质工作区变化时，产生 `RepeatedFailureDetected`，不得无限机械重试。修复次数、审计轮数与 Provider 切换次数分别计数；继续同一 session 的修复仍消耗其修复预算，不能用“不新建 Attempt”绕过上限。

如果当前责任由 Runtime 内部完整流程承担，App 不介入其内部模型选择和子任务重排；只在已委托范围的交回、明确阻塞或获准取消之后安排下一责任。

---

## 9. 持续性、恢复与交接

### 9.1 恢复分级

```text
R0：UI 恢复
R1：进程或 Adapter 重连
R2：原生 Provider Session 恢复
R3：同 Provider 新 Attempt 接管
R4：跨 Provider 新 Attempt 接管
```

自动恢复可达到的层级由实际验证的 transport/session 能力、恢复策略、任务风险、未知副作用和重试上限共同决定。各级单独验收：UI 重开通过不能证明 R1；进程存活不能证明 R2；R4 成功也不表示隐藏上下文无损迁移。

恢复报告至少说明：尝试了哪一级、当前证据、未确认事项、是否创建新责任承接、下一安全选项。Adapter 不能隐式重新发送非幂等 prompt 来伪装恢复。

### 9.2 HandoffPacket

```text
HandoffPacket
├── Campaign goal
├── Task objective
├── Acceptance criteria
├── Applicable constraints
├── Effective policy excerpt
├── Current plan and completed steps
├── Workspace baseline
├── Changed-file manifest
├── Diff/artifact references
├── Commands and exit codes
├── Verified evidence
├── Failed approaches
├── Unresolved risks
├── Pending decisions
└── Resume instruction
```

跨 Session 或跨 Provider 连续性依赖 HandoffPacket，不依赖完整聊天复制。是否向接管 Agent 提供原始 transcript 由 Data Policy 决定。

### 9.3 事实分类

交接和完成结论必须区分：

```text
Core-known facts
Runtime-reported claims
Verified evidence
```

Agent 声明不得自动升级为事实。

### 9.4 外部副作用与 UNKNOWN

对于 `git push`、发布、部署、远端删除、发送消息等，若动作可能发生但无法确认：

```text
EffectStatus = UNKNOWN
```

进入 reconciliation，禁止盲目重试。

### 9.5 Attempt 能力与版本快照

Attempt 启动时保存：Runtime identity/version、Adapter version、protocol version、CapabilitySnapshot、Provider session ID、workspace revision、PolicySnapshot 和 compatibility disposition。

恢复前若版本变化，必须重新 Preflight。历史 CapabilitySnapshot 只解释原运行；真正继续前以当前版本和已验证能力决定，不改写历史。V1 不保存或解释个人 Goal Harness 的状态 schema、executor generation 或内部阶段。

---

## 10. 验证与证据

### 10.1 Claim–Evidence–Verdict

```text
Claim
    ↓ supported / contradicted by
Evidence
    ↓ evaluated under policy
Verdict
```

每项重要结论绑定 Acceptance Criterion、来源和 Workspace Snapshot，并注明它支持的是模拟、协议接入、真实 Runtime 还是实际桌面使用。

命令证据包含实际 cwd、命令身份、启动/结束观察、退出状态及适用时非零执行范围（例如执行用例数、处理记录数或被检查目标）。路径与内容按 DataPolicy 保存和脱敏。仅有 exit 0、零用例或所有相关用例被跳过，不能支持“目标已验证”。协议无法提供执行范围时记为未知，不填推测值。

### 10.2 Evidence 类型

```text
AgentAssertion
RuntimeObservation
WorkspaceObservation
Artifact
AuditFinding
HumanDecision
```

不同来源不得压缩成不透明的统一可信度分数。

### 10.3 Core 的确定性边界

Core 可以：

- 保存 Runtime 报告的命令、工具状态和退出码；
- 获取 Git revision、diff、changed-file manifest 和文件哈希；
- 记录进程退出状态；
- 计算 Artifact 完整性哈希；
- 判断 Evidence 是否属于当前 Snapshot；
- 根据策略检查证据是否齐全。

Core 不可以：

- 自己决定测试方案；
- 自己解释代码正确性；
- 自己执行任意 shell 验证；
- 自己进行静态分析或代码审查；
- 替 Runtime 管理测试、MCP 或工具。

当前策略要求额外验证且该责任尚未由运行中的原生流程承担时，Core 创建获准的 Verification Attempt；不因看到某个工具结果缺口就同时启动竞争性验证流程。

### 10.4 WorkspaceSnapshot 与 stale Evidence

```text
WorkspaceSnapshot
├── repository_identity
├── base_revision
├── dirty_tree_digest
├── changed_file_manifest
├── relevant_artifact_hashes
└── captured_at
```

验证记录应关联测试或审阅实际观察的版本、配置和目标，而不是测试结束后随手获取的最新 HEAD。执行期间受验证内容发生变化、不能取得一致视图时，证据标为不确定或 stale；冻结 Bundle 必须包含实际不可变内容或可校验引用，时间戳本身不等于冻结。

代码、测试、构建配置或其他已声明验证输入变化后，相关旧证据默认 `STALE`。只有策略允许且作用域可证明不受影响时才复用。关闭 watcher、没有收到事件或仓库为 dirty 都不能被误读为“没有变化”。

### 10.5 ReviewBundle

```text
ReviewBundle
├── Task objective
├── Acceptance criteria
├── Constraints
├── Target workspace snapshot
├── Baseline revision
├── Final diff
├── Changed-file manifest
├── Agent claims
├── Verification commands and exit codes
├── Known failures
├── Unresolved risks
└── Audit questions
```

审计目标变化后，原 AuditFinding 自动 stale。

### 10.6 Audit 模式

```text
OFF
SELF_CHECK
NEW_SESSION_SAME_PROVIDER
DIFFERENT_PROVIDER
HUMAN_REVIEW
RISK_BASED
```

独立性、阻断性和审计者选择由 Verification Policy 决定，但不能低于当前已适用的规则。不同 Provider 只是可选的一种来源多样性，不自动构成独立证明；同 Provider 的独立上下文审阅也不能被误标为自审。

审计记录其输入 Bundle、身份和上下文来源、结论、复核范围及未执行检查。执行者自行改角色标签不满足独立审计。Core 只核对这些确定性条件，不能代替审计者理解代码正确性。对于需要最终语义判断的结论，由所选责任主体或用户复核决定性证据。

### 10.7 Verification 预设

- `Record Only`：记录声明、diff 与已有结果，不阻止完成。
- `Standard`：要求完成声明、changed-file manifest 和验收说明；缺失项显示未验证。
- `Verified`：关键标准均有当前证据、验证成功、失败项已处理，可选独立审计。
- `High Assurance`：计划审计、独立执行审计、完整验证、最终 Snapshot 一致、风险和外部副作用均得到处理。

### 10.8 EvidenceWaiver

```text
EvidenceWaiver
├── waived_requirement
├── reason
├── decided_by
├── scope
├── expires_at_or_permanent
└── timestamp
```

豁免后的 Assurance 显示为 `WAIVED`，不得伪装成 `VERIFIED`。

---

## 11. 智能路由与订阅容量

### 11.1 TaskProfile

```text
TaskProfile
├── task_type
├── role
├── risk_level
├── expected_duration
├── context_scale
├── mutation_scope
├── external_effect_risk
├── required_capabilities
├── acceptance_criteria
└── user_constraints
```

字段来源必须记录为用户输入、Agent triage 建议或 Core 已知事实。

### 11.2 两阶段路由

先做硬资格筛选，再做软排序。

硬排除包括：Runtime 未安装/未登录/不健康、用户禁用、缺少关键能力、不满足独立审计要求、明确 rate limit、故障冷却、Data Policy 或安全策略不允许。

软排序维度：

```text
Quality Fit
Reliability
Latency
Human Effort
Capacity
User Preference
Switching Cost
Resource Impact
Uncertainty
```

分数只用于排序；UI 展示原因、风险和替代项。

### 11.3 路由目标预设

```text
Quality First
Reliability First
Fastest Completion
Low Intervention
Subscription Balance
User Preference First
Custom
```

`Subscription Balance` 只在质量、可靠性和硬约束满足后参与，不为消耗额度制造任务。

### 11.4 控制模式

```text
MANUAL
RECOMMEND
AUTOMATIC
```

覆盖必须明确作用域：Task、Campaign、Project 或 Global。

### 11.5 容量状态与来源

```text
AVAILABLE
DEGRADED
RATE_LIMITED
COOLDOWN
EXHAUSTED
AUTH_REQUIRED
UNKNOWN
```

来源：

```text
PROVIDER_REPORTED
RUNTIME_OBSERVED
LOCAL_ESTIMATE
USER_DECLARED
UNKNOWN
```

不得伪造精确剩余额度，不逆向抓取私有后台，不把本 App 观察到的活动当作整个账户总使用量。容量 `UNKNOWN` 不是默认拒绝运行的理由：在没有明确限流和其他硬障碍时，可以依据用户偏好与实际可用性推荐。

历史质量、剩余额度和资源画像均为可选信号，不是冷启动或任务启动前必须收集的材料。身份认证失败、进程不健康、真实额度耗尽应保留原始分类，不能统称“没额度”。V1 不硬编码开发者的模型名称、effort 或个人保留额度。

### 11.6 本地表现画像

按 Runtime × task type × role 统计：

```text
sample_count
first_pass_verified_rate
audit_reversal_rate
mean_repair_attempts
interruption_rate
successful_recovery_rate
completion_duration
human_intervention_count
resource_impact
data_freshness
```

样本不足显示 `Insufficient local evidence`。用户可关闭历史学习、查看来源、重置或删除数据。运行版本、任务类型、验证强度与选择偏差要保留；未经审计的 claimed completion 不与 verified completion 混为同一成功标签。样本不足时回到显式偏好和能力匹配，不因为统计门槛把所有 Runtime 排空。

### 11.7 RoutingDecision

```text
RoutingDecision
├── decision_scope
├── role
├── task_profile_snapshot
├── policy_snapshot
├── candidates
├── exclusions
├── score_components
├── capacity_signals
├── local_history_snapshot
├── selected_runtime
├── alternatives
├── explanation
├── confirmation_mode
├── decided_by
└── timestamp
```

故障改派必须先完成恢复判断、Handoff、Data Policy、Workspace Lease 和外部副作用安全检查，并具有防抖、熔断和切换上限。

---

## 12. 工作区并发与外部修改

### 12.1 WorkspaceAccessIntent

```text
READ_ONLY
MUTATING
UNKNOWN
```

`UNKNOWN` 按 `MUTATING` 处理。

### 12.2 WorkspaceLease

```text
WorkspaceLease
├── workspace_id
├── holder_attempt_id
├── access_mode
├── acquired_at
├── last_heartbeat
├── process_epoch
├── lease_status
└── release_reason
```

状态：

```text
PENDING
ACTIVE
RELEASING
RELEASED
UNCERTAIN
```

同一 Workspace 最多一个受管写入责任；旧 Lease 为 `ACTIVE` 或 `UNCERTAIN` 时均阻止新 mutating lease。重新核对并释放后才能接管。不能把旧 Lease 改名为 UNCERTAIN 后就绕过单写者约束。

`READ_ONLY` 是声明，不是隔离机制。只有 Runtime 可验证地遵守只读约束或使用不可变/隔离目标时，才按只读并发；仅凭“这是审计任务”或一段 prompt 不能保证不写入。测试也可能修改工作区，无法证明只读时按 MUTATING/UNKNOWN 处理。

Workspace 身份需考虑规范化路径、junction、符号链接和重叠目录；两个别名不能绕过同一写入责任限制。该 Lease 约束 App 的受管动作，不控制用户外部启动的进程。

### 12.3 Dirty Workspace

Attempt 前记录：

```text
WorkspaceBaseline
├── repository_identity
├── head_revision
├── branch_or_detached_state
├── dirty_state
├── changed_file_manifest
├── relevant_content_digest
├── captured_at
└── acknowledged_by
```

策略为 `ALLOW`、`ASK` 或 `DENY`。App 不自动 stash、reset、clean、commit 或创建 branch。

### 12.4 WorkspaceDrift

允许用户在 VS Code 中修改，但外部变化必须记录：

```text
ACTIVE_ATTEMPT
EXTERNAL_EDITOR
EXTERNAL_PROCESS
UNKNOWN
```

策略：`Observe`、`Notify`、`Pause Agent` 或 `Strict`。来源只能记录实际可证实的归因；无法识别时保留 UNKNOWN，不能因为事件发生在 Attempt 期间就都归给 Agent。Pause/Strict 只在 Runtime 有已验证停止能力时兑现；否则说明无法确认暂停，并阻止新的冲突动作。

### 12.5 Snapshot 性能

采用：文件 watcher → Git 状态复核 → 变化文件摘要 → 关键边界冻结 Snapshot。不持续全仓哈希。

### 12.6 审计目标稳定性

```text
Frozen Bundle
Quiescent Workspace
Isolated Workspace
```

默认使用 Frozen Bundle；直接读取同一目录时必须进入静止状态。

### 12.7 并行调度与 Lease Transfer

并行必须同时满足 Task 依赖、访问模式、Workspace Lease 和 Concurrency Policy。V1 不自动创建 worktree 或合并结果。

跨 Agent 接管必须先释放或确认旧 Lease，再冻结 Snapshot、生成 Handoff、创建新 Attempt、取得新 Lease，最后发送接管 prompt。旧 Lease 为 `UNCERTAIN` 时，不得自动在同一 Workspace 启动新写入者。

---

## 13. 外部副作用与动作授权

```text
EffectObservation
├── effect_id / attempt_id
├── reported_kind / target
├── status / source
├── idempotency_reference（仅实际存在时）
└── reconciliation_state
```

状态包括 `PROPOSED`、`STARTED`、`SUCCEEDED`、`FAILED`、`UNKNOWN` 和已核对结果。reconciliation 记录证据，不用一个“已核对”标签掩盖核对后的具体状态。

计划批准、审计通过、Automatic 路由和 Full Access 均不授权外部动作。commit、push、PR、merge、release、deploy、公开发布、删除及其他受限操作按当前生效规则分别授权；允许其中一项不隐含其他项。产品可以保存用户明确授予的适用范围，但每次动作必须核对目标和是否已撤销。

Core 对自己发起的调度、权限回应和数据传输负责。任意 Runtime shell/MCP 行为未必全部可观察，不能据此声称所有外部副作用都已被 App 阻断。Runtime 自身的权限机制与用户规则继续生效；无法满足用户所需保证时，预先降级或拒绝该 Runtime 的相关任务。

效果未知不得自动重放。Outbox 和 command ID 可防止 App 内部重复决定，却不能赋予任意 CLI 工具 exactly-once 语义。动作已发送但回执缺失时先核对；不能把超时直接解释为“未执行”。核对由获准的 Runtime 操作或用户提供证据，App 不增加任意 shell 执行器。

无合格证据或目标已经变化时，停止受影响动作链，保留已完成的安全工作。既不自动清理用户仓库，也不因内部审计通过而自动提交或外发。

---

## 14. 数据、隐私与信任边界

### 14.1 三个数据所有权域

```text
用户工作区
App 自有数据
Provider Runtime 自有数据
```

App 只能承诺如何处理 App 自有数据。删除 Campaign 不等于删除 Provider 服务端或 Runtime 原生会话。

### 14.2 DataPolicyProfile

```text
DataPolicyProfile
├── content_capture
├── transcript_retention
├── terminal_capture
├── artifact_retention
├── cross_provider_transfer
├── provider_allowlist
├── export_policy
├── diagnostics_policy
└── telemetry_policy
```

支持分层偏好并保存历史快照；适用当前授权和撤销状态，不能用旧 DataPolicySnapshot 延续被撤回的访问。

### 14.3 跨 Provider 数据传输

路由和接管同时受 RoutingPolicy 与 DataPolicy 约束：

```text
DENY
ASK
ALLOW_PROJECT
ALLOW_CAMPAIGN
ALLOW_BY_CLASSIFICATION
```

授权界面显示接收 Provider、目的、App 将发送的数据类别及其控制范围。默认不转发完整原始 transcript。

必须区分“App 发送的 Handoff 内容”和“目标 Runtime 获准自行读取的 Workspace”。如果新 Runtime 可以读取工作区，不能承诺另一个 Provider 只会收到摘要或四个 diff；运行时的后续读取仍遵循原生权限和 Provider 行为。没有真实隔离就不作目录白名单或完整数据外发防护承诺。

### 14.4 数据预设

- `Private`：最小状态、默认禁止跨 Provider、无完整终端输出、无遥测。
- `Balanced`：保存完整对话和结构化事件，跨 Provider 每次询问。
- `Multi-Agent`：允许用户批准的 Provider 参与路由和交接，默认使用 HandoffPacket。
- `Audit`：保存 ReviewBundle、diff、命令结果和审计历史。
- `Ephemeral`：完成后按策略删除正文，并明确功能退化。

### 14.5 凭据绝对边界

App 不主动读取、复制或持久化 OAuth token、API key、cookie、Provider credential cache、完整环境变量集合和值、登录输出敏感字段或本地密钥正文，也不把它们作为运行证据。

Runtime 输出可能意外夹带秘密，因此内容捕获要有已知敏感字段过滤、限制和导出前核查；未知格式不能靠模式扫描保证完全识别。失败记录只包含必要分类，不回显被过滤内容。加密不等于脱敏，内容正文默认不进入 diagnostics 或遥测。

App 仅启动用户已安装并登录的官方 Runtime，不创建自己的 Provider 账户系统。

### 14.6 本地存储与加密

- SQLite 保存最小索引、状态、事件元数据和 Artifact 引用；
- 消息正文、路径、Handoff、ReviewBundle、diff、终端输出和文件片段作为加密敏感 payload；
- Windows V1 使用当前用户身份保护主密钥；
- 默认无云同步和自动上传。

### 14.7 日志、诊断和遥测

普通日志不记录 prompt、代码、diff、命令正文、绝对路径和环境变量值。

Diagnostic bundle 必须本地生成、自动清理、展示清单和预览，并由用户明确导出。

Telemetry 默认关闭。以后启用须显式选择且仅限可查看 schema 的无内容指标；V1 不设置默认为开的上传通道。用户可查看、导出或清空 App 自有统计。

### 14.8 IPC 与 Adapter 信任边界

Desktop–Core 使用当前 Windows 用户访问约束、本地握手、request ID 和实体版本；Named Pipe 为首选承载，机制在 M0/M1 验证。Core 不以管理员权限运行，不监听远程 TCP。

用户级 ACL 和本地握手用于减少错误连接与其他账户访问，不宣称能防御已经控制同一用户会话、读取其秘密或注入进程的恶意程序。UI 文案和安全测试必须匹配该威胁边界。

Adapter 事件视为不可信输入，必须执行 schema validation、大小限制、序列检查、路径规范化、backpressure 和富文本转义。未知 Provider Extension 可保存但不得驱动 Core 动作。

### 14.9 不声称 Runtime 沙箱

App 可以显示权限、限定 cwd、记录动作和以后集成隔离环境，但没有真实隔离技术时不得声称 Agent 只能访问某目录或网络已完全阻断。

---

## 15. Runtime 接入与能力协商

### 15.1 Provider、Runtime、Adapter 分离

- `Provider`：Anthropic、OpenAI、xAI。
- `Runtime`：本机 Claude Code、Codex、Grok CLI。
- `Adapter`：App 与 Runtime 之间的结构化协议桥。

### 15.2 RuntimeProfile

```text
RuntimeProfile
├── id
├── display_name
├── provider
├── adapter_type
├── executable_location
├── execution_target
├── launch_arguments
├── working_directory_policy
├── environment_policy
├── update_policy
└── enabled_projects
```

用户可定义多个 Profile；V1 只正式实现本机 Windows execution target。

### 15.3 AgentAdapter 契约

```text
基础边界：
probe / runtime_identity / negotiate / create_session / send_prompt / stream_events / close

条件能力：
auth_state / resume / permission_response / cancel_turn / interrupt / model_or_mode_action
```

Adapter 只负责连接、握手、session、消息、原生权限与取消、事件映射和故障报告，不做 planning、路由、隐式业务重试、上下文构建或工具执行。未支持的条件能力明确返回 unsupported，不创建空成功结果。

一次 Runtime 请求可由底层库按协议处理连接细节，但不得在未知执行结果时自动重发非幂等 prompt/permission。业务级重试、恢复和改派只能经过 Core 的获准决定。

### 15.4 Canonical AgentEvent

```text
AgentEventEnvelope
├── event_id
├── campaign_id
├── task_id
├── attempt_id
├── process_epoch_id
├── sequence
├── occurred_at
├── received_at
├── provider_event_reference
├── event_type
└── payload
```

通用事件只覆盖 Core 必须理解的控制面语义。Provider 特性通过版本化 `ProviderExtensionPayload` 保留，不迫使其他 Provider 实现空壳能力。

### 15.5 Capability

```text
Capability
├── support
├── semantics
├── limitations
└── source
```

支持状态：`SUPPORTED`、`PARTIAL`、`UNSUPPORTED`、`UNKNOWN`、`DEGRADED`。  
来源：`RUNTIME_DECLARED`、`PROTOCOL_NEGOTIATED`、`ADAPTER_INFERRED`、`USER_CONFIGURED`。

### 15.6 ResolvedExecutionContract

```text
ResolvedExecutionContract
├── requested_policy
├── runtime_capabilities
├── satisfied_requirements
├── degraded_requirements
├── rejected_requirements
├── approved_fallbacks
└── user_decisions
```

策略能力不匹配时不得静默降级。产品“使用现有订阅”的要求不能靠默认换成 API key 或付费 API 调用满足。认证、实际计费途径、接入允许范围和原生行为需分开验证；仅检测可执行文件或看到登录状态不足以证明订阅可用。

### 15.7 Preflight

首次使用、版本变化和恢复前检查：executable、版本、Adapter 兼容、协议握手、登录、Workspace、关键能力、Policy 解析和降级项。

结果：

```text
READY
READY_WITH_WARNINGS
AUTH_REQUIRED
RUNTIME_MISSING
VERSION_UNTESTED
INCOMPATIBLE
POLICY_UNSATISFIED
CONNECTION_FAILED
```

兼容策略：`Strict`、`Compatible`、`Permissive`。

### 15.8 正式 Adapter 禁止 CLI 文本解析

正式接入必须基于 ACP、官方 App Server、官方 SDK 或明确版本化结构化协议。解析 ANSI/TUI/stdout 文本只能作为明确实验性 Legacy Adapter，且不得宣称完整恢复、权限或证据保证。

### 15.9 Provider session 所有权

Provider session 始终属于 Runtime。恢复前 reconcile：

```text
FOUND
MISSING
INACCESSIBLE
DIVERGED
UNKNOWN
```

分叉时不得静默覆盖任何一侧。

### 15.10 故障分类与背压

至少区分 Runtime exit、Adapter exit、协议断开/违规、认证失败、rate limit、event stall、App backpressure、unsupported version。

在 DataPolicy 允许捕获的范围内，正文的流式 chunk 可合并但不能因此丢字或改变次序；UI 刷新可节流，持久证据不能被当作可丢弃进度。工具进度可合并，终端输出按策略进入 Artifact Store。达到上限时显式记录缺口；未知 ProviderExtension 同样执行脱敏、保留与大小限制，不能成为秘密或无限输出的旁路。

### 15.11 原生行为兼容验收

每条正式接入路径在真实 Runtime、合成项目上检查适用的原生指令、Skill、hook、权限、subagent 和工具行为是否保持。测试使用公开可复现的合成规则，不复制用户的真实全局配置。功能不一致时标注能力缺口并比较其他受支持结构化入口；不得通过删除规则、禁用 hook、改用 API 或伪造输出来让测试通过。

SDK/ACP/App Server 只是接入候选，不因名称相同就认定与完整 CLI 行为等价。此处不预先指定三家的实际路径或支持版本。


---

## 16. 资源治理与性能隔离

### 16.1 资源主体

分别观察 Desktop UI、Local Core、Adapter Host 和 Managed Runtime Tree。只观察 App 启动或明确绑定的进程树，不做全系统进程监控。资源归因标注为近似值。

### 16.2 进程监督模式

```text
OBSERVE
MANAGED
STRICT
```

默认使用经过兼容验证的 `MANAGED`。进程分组只用于生命周期、取消、残留检测和资源聚合，不管理 Runtime 内部插件或工具。

### 16.3 Core 故障语义

- UI 消失：Core 与 Runtime 可继续。
- Core 正常重启：协调暂停或结束 Runtime，再安全重启。
- Core 非正常退出：尽量终止受管 Runtime Tree；Attempt 中断；Lease 进入 `UNCERTAIN`；下次启动 reconciliation。

Core 失效后的停止能力分 RuntimeProfile 声明并实测，不能对 OBSERVE 模式作完整停止保证。对需要强停止语义的 mutating 任务，只有验证了相应进程及已知后代约束的 Profile 才可准入；否则阻塞该保证要求，或由用户在明确风险下选择较弱执行契约。

观察模式不能假定 Core 退出时仍能及时写入中断事件；重启后根据最后已提交记录、进程身份和实际工作区进行核对。在确认旧写入者静止前，不再发放写入 Lease。已脱离可控进程树的工作如无法确认，保留 UNKNOWN。

### 16.4 Admission Control

默认优先在启动前做接纳控制，不对活跃 Runtime 粗暴施加 CPU/内存硬限制。

检查：系统可用内存、活跃 Attempt、Runtime Tree 资源、事件积压、Artifact 空间、持久化健康和用户并发上限。

压力处理顺序：停止启动新任务、降低 UI 更新、聚合事件、按策略暂停低优先级只读任务、通知用户，最后才在明确授权下取消活跃 Attempt。

### 16.5 ResourcePolicy 预设

```text
Protect Desktop
Balanced
Maximum Throughput
Custom
```

资源影响可进入 Router，但是否影响选择由用户策略决定。

### 16.6 事件优先级

```text
P0 控制与安全事件：在可用持久化边界内优先接收与提交，不按采样策略丢弃
P1 内容与关键证据：按 DataPolicy 捕获，语义内容按序保存
P2 高频可替代状态：允许合并，但不可包含被丢弃的正文或决定性证据
P3 大体积输出：按配额写入 Artifact Store，缺口显式报告
```

UI 卡顿或断开不得直接控制 Runtime 的 stdout 消费。Core 需持续消费、增量持久化并独立发送 UI 投影。无穷输出、磁盘满和缓冲耗尽不能同时获得“有限资源、零丢失、永不阻塞”的保证；到达不可持久化边界时，阻止新调度与自动批准，按已验证控制能力中断或报告缺口。

优先级只决定资源分配，不随意重排同一 session 的因果事件。重复事件去重与顺序缺口必须保留可解释处理记录。

### 16.7 Artifact 配额与持久化失败

配额按 Artifact、Attempt、Campaign 和全局划分。输出状态显式区分 `COMPLETE`、`TRUNCATED`、`DROPPED_BY_POLICY`、`UNAVAILABLE`、`CORRUPTED`。

Event Journal 或状态写入失败时，Core 停止新的派发、自动批准及其自有副作用操作，按协议请求暂停或取消 Runtime。`PERSISTENCE_UNSAFE` 是对外健康状态；当数据库已经不可写时，不能假定该状态本身成功落盘，也不能声称已阻止 Runtime 内全部工具。重启时核对未完成 intent、已发送操作和结果缺口。

### 16.8 Stall Detection 与休眠恢复

Stall 结合协议、进程、心跳、CPU/IO、子进程、权限、rate limit 和最近结构化进度判断，状态为：

```text
ACTIVE
QUIET
WAITING
SUSPECTED_STALL
CONFIRMED_STALL
UNOBSERVABLE
```

Windows 休眠恢复后必须先 reconcile Runtime、协议、Workspace、Lease、Provider session 和外部副作用，再恢复 Mutating Attempt。

---

## 17. UI 与交互

### 17.1 三个固定区域

```text
┌──────────────────────────────────────────────┐
│ Project / Campaign · Status · Runtime · Mode │
├──────────────┬───────────────────────────────┤
│ Projects and │ Unified structured timeline   │
│ Campaigns    │                               │
│              │ Message / Plan / Attempt      │
│              │ Tool / Permission / Evidence  │
│              │ Audit / Handoff / Recovery    │
│              │                               │
│              │ Message composer              │
├──────────────┴───────────────────────────────┤
│ Core status · Running · Blocking decisions   │
└──────────────────────────────────────────────┘
```

不设置永久文件树、代码编辑区、终端、Git 面板或 DAG 画布。

### 17.2 结构化时间线

卡片类型：`Message`、`Plan`、`Attempt`、`Tool Activity`、`Permission`、`Decision`、`Evidence`、`Audit`、`Handoff`、`Recovery`、`Completion`。

工具和日志默认聚合折叠；长历史使用虚拟化、分页和 Artifact 延迟加载。

### 17.3 Campaign 连续性

同一 Campaign 可依次显示：

```text
Claude · Planner
Codex · Executor
System · Recovery
Grok · Auditor
User
```

Provider session ID 仅在诊断详情出现。

### 17.4 新建 Campaign

默认只需：选择项目目录、输入目标、开始。Working Style 与 Routing/Runtime 使用当前可见预设，可在开始前修改；高级策略折叠在 `Customize policy`。普通提问不要求先填 TaskProfile、额度或审计配置。只有用户意图或适用策略要求时，才展开计划与审计阶段。

输入消息默认发给当前承担责任的 Runtime。系统不通过另一套隐藏 planner 把每条消息重新包装成完整工程任务。

### 17.5 自动化可见性与 Decision Inbox

顶部始终显示自动化模式。自动路由、恢复、审计和改派必须在时间线留下解释。

Decision Inbox 只收阻断项，例如权限升级、未知外部副作用、策略冲突、跨 Provider 数据授权、不可恢复 session、Lease 不确定和需求冲突。每项 DecisionRequest 必须包含事实、安全选项、后果、推荐和未答复默认行为。

### 17.6 Provider 切换语义

不使用“同一聊天随意切模型”的误导性控件。使用：

```text
Assign next step to…
Request independent audit from…
Create fallback attempt with…
```

切换意味着新 RoleAssignment 或 Attempt，并可能触发 Handoff、Data Policy 和 Workspace Lease。

### 17.7 原生能力与 VS Code

Runtime 结构化暴露的 model、mode、resume、native command 可按需显示。plugins、skills、hooks、MCP 继续由原生 Runtime 管理。

检测到 VS Code 外部修改时，明确显示 WorkspaceDrift 并将相关 Evidence 标记 stale，不把人工修改归因给 Agent。

### 17.8 后台行为与完成卡片

关闭窗口时用户可选择继续后台运行或停止，并决定是否记住设置；“暂停”仅在该 Runtime 确实支持对应语义时提供，否则解释为“发出停止请求，之后尝试恢复”。确认继续后台时，只授予当前运行所需的后台生命周期，不等于开机启动、默认永久常驻或额外动作授权。

Desktop 被强杀而非正常关闭也必须独立测试。托盘和自启分别配置；UI 重新打开从 Core 投影恢复，不重发用户 prompt。

完成卡片优先显示 Outcome、Changes、Verification、Audit、Residual Risks、Assurance Status 及 Open in VS Code/查看 Evidence/接受风险/继续 Campaign。

---

## 18. 技术架构

### 18.1 已选择的技术方向与待证实实现

```text
Desktop Shell     Tauri
UI                React + TypeScript
Local Core        Rust
Persistence       SQLite + local Artifact Store
Primary OS        Windows x64
Editor            VS Code
```

保留此技术方向。它是实施选择，不是“肯定比其他桌面客户端更快”的既成事实。具体依赖版本、系统接口与 API 用法由开发代理在实际环境核查并记录，本文不捏造版本或性能数值。

结构上必须保证 UI 生命周期与持久执行核心解耦。协议桥可使用已有合规结构化 Adapter；是否单独启动 Adapter Host、按进程还是按 session 隔离，由 M0/M1 的连接所有权、故障与资源实验决定。不强制所有桥接库使用 Rust，不为了形式统一重写成熟协议库。

### 18.2 进程责任，不固定进程数量

```text
Desktop UI
    ↕ 本地版本化 IPC
Durable Local Core
    ↕ 薄 Adapter / 必要时的隔离 Host
Native Runtime
```

必须明确由谁持有 Runtime 连接、由谁持续读取输出、谁拥有子进程句柄以及哪个进程退出会影响谁。进程名称不同或树形图分层不等于故障隔离。

- 实际 Desktop 退出或被强杀，不应终止已获准后台运行的 Core；通过真实进程测试证明。
- 协议异常不能破坏 Core 已提交的状态。解析器隔离采用进程、严格边界或其他获验证措施，不预先把“每 Attempt 一个 Host”当唯一解。
- Host 退出后的旧 Runtime 是否可附着，按实际 transport 能力处理，不用 restart 包装失去状态的问题。
- 所有受管进程创建请求经过统一监督责任。协议桥必须自行 spawn Runtime 时，由监督责任批准启动描述并接收句柄/身份记录；不同时规定“只有 Core 能 spawn”又让 Adapter 隐式创建不受管进程。
- 不新增远程 worker、消息中间件或常驻 watchdog 平台。

### 18.3 IPC 与协议边界

Windows Desktop–Core 首选当前用户 Named Pipe；Core–独立 Host 可以使用版本化 framed JSON。内部 framing 与 Provider 的 ACP/App Server framing 分开，不能把本产品封装直接写入原生协议。

```text
protocol_version
request_id
entity_version
message_type
payload_or_artifact_reference
```

大输出分块并通过引用查询，机器协议与诊断通道分离。命令校验当前实体版本；重复 request ID 只在明确幂等语义内复用结果。连接恢复不能自动重放非幂等业务命令。

### 18.4 Wire Contract 与 Domain 分离

UI/Core 和 Adapter 的 wire DTO 使用显式版本并从单一 schema 生成跨语言类型。Domain 不直接依赖传输或 Provider 结构。未知字段/事件保留有限兼容信息，但不改变 Core 状态或生成自动动作。

### 18.5 代码边界与仓库布局

逻辑职责保持为 Domain、Application/Core、Infrastructure、Contracts、Adapters、Scenario test support 和 Desktop。它们可以先是少量 crate 内的受控模块；不为了凑齐六个目录建立空接口、空实现和中转层。

需要独立编译边界、不同发布生命周期或实际依赖隔离时再拆 crate，并以架构测试约束依赖方向。UI 不读数据库或 Provider SDK；Core 不出现 Provider 专属字段判断；Infrastructure 不成为第二个业务决策入口。

最终目录布局在实测准入后由实施计划确定。职责边界已明确，不意味着内部文件名或 crate 数不可调整。

### 18.6 单一 Command 路径与 Outbox

```text
Command
→ 检查当前实体版本和动作授权
→ 解析历史策略及当前撤销/约束
→ 校验领域条件
→ 同一事务写 Event + Projection + 必要的 Outbox intent
→ 提交后执行获准动作
→ 记录观察结果或 UNKNOWN
→ 发布 UI 投影
```

UI、Router、Recovery 和 Scheduler 不各自写权威状态。Outbox 解决 App 决策的可靠安排，不保证 Runtime 端去重。发送后无回执的非幂等动作必须核对，不能“重新投递直到成功”。

### 18.7 SQLite 与 Artifact Store

首选 SQLite WAL 与单写入责任，业务事件和状态投影同事务。大对象不可变地写入 Artifact Store，引用对齐实际 hash、大小与捕获完整度。

Artifact 写入与数据库事务不是天然同一原子操作：使用先写临时对象、验证完成、发布引用的顺序，并在启动时核对未引用对象和缺失引用。日志缺失、磁盘满、数据库迁移失败的结果明确，不自动删除活跃恢复与验收所需证据。

只有实际观察或故障测试需要的事件才进入耐久日志。UI 渲染节流不是第二套事件源；正文、快照和决定性证据不能用可重建缓存代替。

### 18.8 前端状态与 OS 边界

前端只拥有页面、输入草稿、展开、滚动和待确认的请求状态。Attempt 成败、路由、恢复、可信度均以 Core 投影为准。

Process supervision、Local IPC、Secret Store、File Watcher、Editor Launcher 和 Notification 的 OS 实现留在基础设施边界。V1 实现 Windows，不提前写 macOS/Linux/WSL/SSH/容器空壳。是否拆成公共 Port 取决于真实替换/测试需求，不为所有函数制造接口。

### 18.9 分发、升级与版本握手

App 不捆绑、安装或升级用户的 Claude Code、Codex、Grok Runtime；外部桥接依赖的来源、版本和许可需要明确。App 更新也不修改用户 Skill、hooks、MCP 或原生配置。

自有通信端点交换产品/protocol/schema 版本与 build identity，拒绝不兼容混用。升级不静默终止活动任务；数据库迁移前创建一致性备份并验证恢复路径。自动更新器不属于 V1 必需功能。

---

## 19. 测试、仿真与架构防腐

### 19.1 三层证据，不互相冒充

| 层 | 执行环境 | 能支持的结论 |
|---|---|---|
| Deterministic/Scenario | 合成 Runtime、协议 fixture、故障注入 | 状态机、已模拟分支、协议和隐私不变量 |
| Real Runtime | 真实已登录 CLI、合成工作区、获准资源预算 | 指定版本的接入、原生行为、权限、取消、恢复与输出 |
| Real Desktop | 实际 Windows 桌面程序及适用的真实 Runtime | 关闭/重开、交互、通知、VS Code 配合、长历史和资源表现 |

CI 可主要依赖第一层；宣称某层能力时必须有该层证据。真实调用仍使用合成任务，不把账户、私有项目或真实对话带进源码仓库。未执行、跳过、零范围、全部跳过或被策略截断的检查各自记录，不能一律写 PASS。

### 19.2 Scenario Runtime 与声明式场景

ScenarioRuntime 按已确定的 Adapter 契约支持当前纵向切片，并逐步覆盖 capability、session、消息、权限、文件变化、命令结果、限流、断连、停滞、异常事件、崩溃和恢复。不先实现想象中的完整万能 Mock 再让真实 Adapter 迁就它。

每个场景包含 Initial State、Inputs、Injected Faults、Expected Events、Expected Final State 和 Forbidden Effects。至少覆盖：UI restart、原生 session 缺失、跨 Provider 接管、待批准权限重启、重复/乱序事件、持久化失败、外部编辑、未知副作用、重复失败和输出配额。

### 19.3 性质与状态机测试

持续检查：

- `ACTIVE` 或 `UNCERTAIN` 的写入责任均阻止同一/重叠 Workspace 的新写入者；
- 不合格 Runtime 不会被评分重新选中，撤销授权后不继续发送；
- stale、截断、缺失或模拟证据不能无理由升级为真实验证；
- repair continuation 保留责任身份而不绕过修复预算；
- Policy 历史不被覆盖，当前授权又不会被旧快照覆盖；
- 重复 Command 不重复改变 App 状态，未知外部结果不盲目重放；
- 崩溃恢复的投影与已提交事件一致，不把未提交数据当作已保存。

### 19.4 崩溃与负面控制

在 Attempt 启动、原生 session 建立、权限回应、Lease、Handoff、Artifact 引用、计划激活、完成和 Outbox 发送边界注入故障。

重点检查“intent 已写但未发送”“已发送无回执”“结果已收到未提交”“Artifact 已写无数据库引用”等窗口。恢复必须区分未发生、已发生和 UNKNOWN，不因缺少成功事件直接认定失败。

负面控制至少包括：权限撤销、重复批准、零用例 exit 0、原生规则被接入路径忽略、adapter 重启无法附着旧 stdio、只读声明却产生写入、同一路径别名、Core 退出但存在残留进程。不能只验证一次理想完成路径。

### 19.5 Adapter Contract Test

使用模拟 ACP/App Server 与合成结构化 fixture，检查 probing、身份、能力、auth 状态、create/resume、prompt、事件次序、权限、取消、断连、协议违规、大输出与关闭。

必需能力和可选能力分别验证；不支持的接口返回明确缺口。协议 fixture 不保存真实模型全文。不能以解析人类日志补足未支持的权限或完成语义。

### 19.6 真实 Runtime 准入与回归

真实验证在 M0 前移，不等到完整 Core 实现后。使用本地获准的已登录 Runtime，进行范围、时长与资源可控的合成任务，记录当前 runtime/adapter/protocol 版本及真实结果。

除了握手 smoke，还要验证影响产品架构的关键行为：原生指令与合成 Skill/hook 是否生效、权限拒绝是否被遵守、取消和恢复是否如实、输出是否完整、选定接入路径是否实际使用预期订阅。无法观察的项目明确标未知，不读取凭据或使用无授权付费后备路径。

适用范围内验证 SDK/结构化桥与原生入口的行为差异。测试配置位于独立合成环境或经授权的项目作用域，不覆盖用户全局配置。开发者个人 Harness 不是产品契约 fixture。

### 19.7 桌面操作、Soak、隐私和迁移

日常 UI 自动测试使用 Mock Core；产品级 UI 验收操作实际 Desktop，覆盖首次运行、空/长历史、窄窗口、权限拒绝、Core 断连、后台完成与重开。真实 Runtime 链路与 UI 链路均有直接记录，不能拼接两张 Mock 截图宣称全链路通过。

虚拟时钟用于超时与调度逻辑；真实墙钟 soak 用于内存、句柄、IPC、磁盘与长历史性能。二者分开报告实际时长、事件量和输出范围；虚拟推进 72 小时不称作真实稳定运行 72 小时。数值预算按 M0/M1 基线冻结，未达标则修复或如实降级。

安全测试覆盖路径穿越、junction/symlink、恶意富文本、巨型/乱序事件、过期 permission、正文中合成凭据、跨 Provider 授权、诊断导出、内容保留和删除。安全结论不超出同用户威胁模型。

数据库 fixture 使用人工合成旧状态，验证迁移、备份恢复、活动责任、历史策略和事件不丢失。迁移失败不对唯一副本继续半升级运行。

### 19.8 Architecture Fitness Functions

执行实际边界检查：Domain 不依赖 UI/Provider/数据库；UI 不直接启动 Runtime 或写库；App 自有状态只有一个修改路径；Provider 字段不进入公共 Domain；协议桥不管理 Skill/hooks/MCP；场景数据不引用真实账户或项目；未知协议输入不触发自动动作。

检查跟随实际代码布局，不把 crate 数、文件数或空接口数量当成架构质量。改变已固定契约时，枚举其代码、测试、CI、文档和发布检查中的所有使用点，同一修订完成同步。

### 19.9 开发验收与产品运行机制分开

每项需求映射到实际验收命令/操作、退出状态、执行范围和产物。用户可见改动在计划门前明确 `gui`、`cli` 或 `api-behavior` 等适用证据与边界状态；内部/docs 等按当前开发 Skill 要求处理。

开发使用现行 Goal Harness 的风险、委派、独立审计和 closeout，不在仓库再建一套同职能 Harness。模板文件存在不代表 live 注册，普通角色标签不代表独立上下文。没有实际执行的独立审计不得写“已通过”；本轮文档自检不能替代它。

---

## 20. V1 范围

### 20.1 必须包含

- Windows x64 单用户本地运行；
- Tauri Desktop、生命周期独立的 Rust Core、薄结构化 Adapter；协议桥的具体隔离拓扑按 M0/M1 证据冻结；
- Project、Campaign、Task、Attempt、PolicySnapshot；
- 受约束 Task DAG 与版本化 Plan；
- Manual、Recommend、Automatic 路由；
- RuntimeProfile、Preflight、CapabilitySnapshot；
- UI 重连，以及按实际能力提供的进程附着、原生 session 恢复和新 Attempt 接管；不支持的级别显式显示；
- HandoffPacket 和跨 Provider Data Policy；
- Claim–Evidence–Verdict；
- WorkspaceSnapshot、stale Evidence 与 ReviewBundle；
- 多种 Audit 模式；
- Workspace Lease、Dirty baseline 和外部修改检测；
- Decision Inbox；
- Admission Control、事件背压、Artifact 配额和 Stall Detection；
- VS Code 打开项目、文件、行号和 diff；
- Claude Code、Codex、Grok 的正式结构化 RuntimeProfile；
- Scenario Runtime、故障注入、Adapter Contract、真实 Runtime/桌面使用验收和迁移测试；
- 本地加密、无凭据捕获、诊断预览和 synthetic-only 仓库门禁。

### 20.2 明确排除

```text
IDE 或代码编辑器
文件树和常驻 terminal workspace
Git 客户端
自动 worktree、branch、commit、merge、rebase、push 或 PR
Runtime plugins / skills / hooks / MCP 管理
模型 API 聚合或代理
Provider 账户、凭据和订阅后台系统
通用工作流 DSL 或 DAG 画布
团队项目管理和云同步
远程、SSH、WSL、容器或分布式执行
动态第三方 Adapter 插件市场
任意 CLI 文本解析
黑箱 LLM Router
全系统进程或 GPU 管理
Runtime 沙箱承诺
自动抓取私有额度接口
个人 Goal Harness 管理器、状态 schema reader 或内置 v4 副本
```

任一排除项未来作为 App 自有功能进入产品，必须启动新的设计评估。这里排除的是 App 自己建设这些子系统，不是禁止用户通过原生 Runtime 使用已授权的 Git、插件或工具能力。

---

## 21. 实施里程碑与验收门

这些是产品交付里程碑，不是开发 Harness 阶段。实施代理依据实际仓库、当前规则和证据生成具体任务计划；不是用户逐项管理里程碑或手动搬运审计包。

### M0：真实接入与关键架构假设准入

先调查三家结构化路径、Windows 启动环境、原生行为覆盖、订阅使用方式、授权和公开分发边界。公开机制核查与本机真实测试分开保存来源；本文不预判三家均已支持。

在获准资源内，用合成工作区进行短的真实接入实验，优先验证足以推翻架构的假设：UI/Core 生命周期、连接所有权、权限、取消、session 恢复、原生配置生效和残留写入者。至少确认一个可继续的真实接入路径，尽早探测第二家的差异；三家未验证项不得填“支持”。

输出精简的能力/假设矩阵与关键实现决定。没有证据支持的 Host 拓扑、进程组和恢复保证不进入强契约。无必要授权时停止相关实验，仍可继续互不依赖的合成验证；不能偷偷改用付费 API。

### M1：一个真实 Runtime 的持久对话纵向切片

实现最小 Desktop → Core → Adapter → 真实 Runtime 链路，同时以 Scenario Runtime 注入故障。Campaign/Task/Attempt、策略引用、证据与路由决定从模型上存在，但只实现本切片需要的行为，不先建满所有 Profile/Engine。

验收：发送与结构化显示、权限往返、取消或明确能力缺口、输出增量存储；强杀实际 UI 后获准的后台任务继续；重开不重发 prompt；持久化故障与重复事件不制造虚假完成；受管进程及已保存状态可以核对。敏感配置与运行记录留在仓库外。

### M2：两个 Runtime 的最小四项价值闭环

接入第二个 Runtime，完成同一 Campaign 的交接或重新承接、一个由不同独立上下文完成的审计、证据与目标绑定，以及 Manual/Recommend/Automatic 的最薄规则路由。

路由可只依赖用户偏好、能力、健康和明确可用性，额度未知仍可使用；不要求积累统计历史才能演示价值。自动化在已授权范围内推进，接管遵守 Workspace Lease 和 DataPolicy。

验收：两家真实能力差异得到准确表达；不产生 Provider 专属 Domain 类型或第二套可写状态；`needs-fix` 可继续同一责任，真正改派才新建 Attempt；GUI 内完成无需用户复制上下文的交接。第二家暴露抽象错误时，依据证据修正通用契约并复审，不机械要求“Domain 零变化”而暗藏特判。

### M3：策略、受约束任务图与安全自动推进

补齐用户可调策略、版本化计划、扁平 Task DAG、阻断决策、重复失败上限、独立审计配置、证据 freshness、外部编辑识别、资源接纳和可选本地历史路由。

验收：边界内计划细化可自主推进；范围/授权变更进入明确裁决；权限撤销优先于旧快照；未知外部副作用不重放；依赖条件不错误排序 Assurance；单写入责任不被别名或 UNCERTAIN 绕过。四项产品价值不削减为未来版本；高级策略只在本阶段扩展深度。

### M4：第三个 Runtime 与完整接入范围

按相同契约加入第三家，验证真实原生行为、数据授权与路由。对每个宣称支持的 RuntimeProfile 记录适用版本、权限、取消/恢复、证据覆盖与降级项。

若某项能力缺失，显示缺口并按用户政策选择可用路径；若连核心订阅接入都不可用，该 Provider 标为未支持，产品只能以范围明确的预览版交付，不能虚构三家 Stable V1。

### M5：产品硬化与 Stable V1

完成安装/卸载、数据保留、迁移/备份恢复、长历史性能、真实墙钟 soak、资源压力、恶意输入、诊断脱敏与文档。每项证据绑定实际源码/构建身份、运行环境、命令或操作、范围和限制。

三个 Runtime 的核心接入与四项产品能力均达到本规范验收后，才达到 Stable V1。实现完成、测试通过、安装包已生成、对外发布是不同状态；Git commit、push、公开仓库、PR 和 release 等仍按当前授权分别处理，不因本里程碑自动获准。

---

## 22. 产品级验收场景

下表定义产品结果与最低证据层级，不代替实施计划中的实际命令。使用合成项目与合成副作用目标；不能为测试便利向真实公共系统发布或删除。`S` 为 Scenario/契约测试，`R` 为真实 Runtime，`D` 为实际 Desktop。需要 R/D 的能力不能只有 S 就宣称通过。

| ID | 可验收结果 | 最低证据 |
|---|---|---|
| DUR-01 | 活动任务期间强杀实际 UI，Core 继续接收已获准运行的真实事件；重开后恢复、不重发 prompt | S + R + D |
| DUR-02 | Runtime 修改合成文件后异常退出；旧写入 Lease 保持不确定，核对前无第二个写入者 | S + R |
| DUR-03 | Core 异常退出后按该 Profile 声明处理受管进程；无法证明终止时保留 UNKNOWN，重启核对已提交记录 | S + 受支持监督模式的 R |
| DUR-04 | Adapter/transport 失效不能被当作可无条件附着；R1 不可用时准确进入 R2/R3 或阻塞 | S + R |
| QUA-01 | 验证后外部编辑使当前证据 stale；历史结果保留但当前状态不再显示 VERIFIED | S + R + D |
| QUA-02 | 独立上下文审阅冻结 Bundle；要求修复后重新验证目标，记录审计身份和未验证范围 | S + R |
| QUA-03 | 命令 exit 0 但零用例/相关用例全跳过/只运行 Mock 时，不越级宣称真实功能通过 | S + 合成命令结果 |
| QUA-04 | 冻结/测试期间目标变化或报告来源未知时，证据不被误绑定到最新 HEAD | S + 合成 Workspace |
| ROU-01 | 推荐展示原因、风险与备选；用户覆盖只作用于明确范围 | S + D |
| ROU-02 | 旧责任停止并核对后才交接，数据授权与 Lease 同时满足，新 Attempt 不覆盖旧历史 | S + 两家 R + D |
| ROU-03 | 额度未知、无历史时仍可按用户偏好和能力运行；没有虚构剩余额度、固定个人模型或必填侧车 | S + D |
| EFF-01 | 已授权的普通步骤在 UI 关闭时继续；只把真正需要裁决的事项加入 Inbox | S + R + D |
| EFF-02 | 普通问答不强制走完整计划/审计链；高级策略仍可选择启用 | S + R + D |
| EFF-03 | 相同范围修复继续当前 Attempt；修复预算继续计数；原生内部 generation 不被 App 操作 | S + R |
| SEC-01 | Provider 被项目策略排除时，即使排序更高也不接收数据；授权 UI 说明 Runtime 后续可能读 Workspace | S + D |
| SEC-02 | Campaign 创建后撤销数据或动作授权，旧策略快照不能继续放行下一动作 | S + D |
| SAF-01 | 合成目标的外部动作发送后失去回执，结果为 UNKNOWN，不自动重放；Outbox 不伪造 exactly-once | S + 本地合成效果目标 |
| SAF-02 | 计划批准或审计 pass 不转换为 commit/push/发布/删除等授权；不改动用户原生规则 | S + D |
| COM-01 | Runtime/Adapter 版本变化后重做 Preflight；历史能力与当前兼容状态分开 | S + R |
| COM-02 | 原生合成 instructions/Skill/hook/权限在选定接入路径中按适用能力生效；缺口明确且不通过关闭规则解决 | S + 每家 R |
| RES-01 | 资源压力超过策略阈值时新 Attempt 排队，不误杀既有 Runtime 或 VS Code；仅授权范围内可覆盖 | S + D |
| RES-02 | 大输出和长历史下 UI 按需渲染；有限缓冲/磁盘满时有明确缺口或中断，不声称无限保真 | S + 实际进程 + D |
| DAT-01 | 诊断与导出排除合成敏感值；删除只处理 App 自有数据，不改源码、原生 session 或配置 | S + D |

场景记录所测 build/revision、Runtime/Adapter 版本、真实操作、命令退出值、非零范围（适用时）、artifact 引用、缺口及审阅结论。真实 Provider 暂不可用时，记录受影响声明，不把整个项目全部当作无法推进，也不把未验证支持写入 Stable 清单。

---

## 23. 成功指标

### Durability

Campaign 丢失次数、UI 重连成功率、原生 session 恢复率、同/跨 Provider 接管率、UNKNOWN reconciliation 比例。

硬指标：已持久化 Campaign 不得因 UI 崩溃或普通应用重启丢失。

### Quality

Acceptance Criterion 证据覆盖率、首次验证通过率、审计反转率、平均修复轮数、stale Evidence 误显示次数、风险豁免率。

### Routing

推荐接受率、覆盖率及原因、无合格 Runtime 频率、按任务类型/角色的验证表现、改派成功率、多订阅使用分布和样本不足比例。

API-equivalent 美元和 token 数不是首要成功指标。原生内部 turn/subagent 数、App Attempt 数和修复轮数分别统计；不能因为会话被拆分就人为提高成功/失败或资源利用指标。历史质量比较保留验证强度与未执行范围。

### Effort Reduction

每个完成 Campaign 的人工干预次数、手工复制上下文次数、Decision Inbox 阻塞时间、故障到继续执行时间、手工重启 Runtime 次数。

早期 dogfooding 目标：

- 不再从旧对话手工整理接管 prompt；
- 不再持续盯 Runtime 是否崩溃；
- 不再因 CLI 交互摩擦避免使用某订阅；
- 不再把 Agent 的“测试通过”直接当成事实；
- 不再因关闭 GUI 失去任务连续性。

---

## 24. 开源复用边界

优先复用经过来源、版本与许可证核查的协议 SDK/schema、结构化桥、Tauri/React 基础组件、虚拟列表、SQLite/迁移、diff/Markdown、OS IPC、进程监督和密钥存储库。可以借鉴现有客户端的 UI、权限交互、进程清理和输出处理。

不把“全部自己写”当差异化。产品差异在持续性、证据、可解释路由与低干预流程；基础连接与展示能可靠复用就复用。

选择依赖、局部移植或 fork 必须基于实际代码、许可证、测试、删除成本与核心模型匹配程度；不预先对未读取的项目宣布成熟、合适或必然不合适。优先局部复用，避免为得到一个 chat UI 继承整套 IDE/Git/workflow 平台。较大的底座变更需要说明架构影响与迁移成本。

不能继承 UI 直接拥有长期 Runtime 生命周期、前端作为状态权威、CLI 人类文本解析和 Provider 特判扩散等问题。外部桥维持明确 Adapter 边界；是否放在独立 Host 由已验证故障模型决定。

不将开发者上传的 Skill/agents/hooks 全包、备份、缓存、真实路径或配置快照 vendor 进产品。只记录必要的公开契约、合成兼容测试、依赖来源与许可证，不把开发环境变成产品安装依赖。

---

## 25. 架构治理与开发流程

### 25.1 不再建立第二套开发 Harness

开发环境已有的 Kernel/Goal Skill 负责当前任务的 triage、计划、委派、独立审计、状态维护和收口。产品设计只给目标、约束、证据要求和非目标。项目级 AGENTS.md 只放当前仓库事实与边界，不复制全局规则、固定模型路由或临时本机信息。

开发代理依据任务形状自主拆分和选择合适工具；只在需要的风险/授权门停下，不把每个实现选择、内部模块和已批准范围内的子任务再次交给用户审批。v4 的兼容字段不构成 quota、sidecar、模型状态或 fan-out 仪式。

### 25.2 按影响记录 ADR，不按文件数制造门禁

改变产品范围、权威状态源、跨进程协议、恢复保证、自动动作权限、数据/安全边界、公开依赖责任或长期迁移契约时，形成简短 ADR 并按实际风险审阅。

既定边界内的函数提取、普通测试、必要表/索引、已批准依赖用法或模块拆分，不每次新增 ADR 或 owner 请求。它们由实施计划、代码审阅和架构测试覆盖；不能用“只是内部调整”掩盖真实边界变化。

任何新增能力需说明对应痛点、现有边界为何不够、验收如何变化及长期成本。改善 D/Q/R/E 是必要的相关性检查，不是无限扩张许可证。

### 25.3 契约变更一次同步

修改已经钉扎的状态、字段、错误分类或保证时，先定位其代码、测试、CI、文档、迁移与验收断言，再在同一受控变更中同步。不能永久保留两个可写状态源，不能让旧保证继续出现在发布文案里。

拒绝因“以后可能用到、顺手做了、别的产品有、Agent 已经写了一半”而加入新核心。也不为了保持早期错误抽象而堆适配特判；真实反例应触发必要的最小重设计。

### 25.4 授权与完成状态

本设计是工程输入，不授权 commit、push、PR、merge、release、deploy、公开发布、删除、凭据或显著资源消耗。实际操作遵循本轮授权与当前规则。生成文档、静态自检、独立审计、代码实现、真实运行和公开发布分别报告，不能相互冒充。

---

## 26. 主要风险与验证责任

| 风险或假设 | 验证/控制方式 | 不能宣称什么 |
|---|---|---|
| 三家结构化接入都能使用现有订阅 | M0 核查当前公开机制与获准本机调用，记录真实路径 | 登录成功就等于订阅可用于该桥接 |
| 结构化桥保留全部 CLI 原生行为 | 合成配置的原生入口对照与 COM-02 | ACP/SDK 名称相同就功能完全一致 |
| UI/Core 分离可持续运行 | 杀掉实际 UI，验证 Runtime 和事件推进 | 仅画两个进程就证明后台持续性 |
| Host 崩溃可接回原进程 | transport/session 身份与 R1/R2 实验 | 重启 Adapter 就等于接回旧 stdio |
| Core 退出能清理全部后代 | 受支持 Profile 的残留进程/写入故障测试 | Observe 模式也有完整停止保证 |
| 单写入责任与只读审计可靠 | Lease、UNCERTAIN、路径别名、只读负面控制 | 任务标题为 auditor 就不会修改 |
| 验证结论对应最终目标 | 不可变 Bundle、测试输入身份、执行范围、stale 处理 | 旧 exit 0 可证明新代码或真实 GUI |
| 本地数据与外发边界清楚 | 捕获/导出策略、授权撤销、真实 Runtime 读取范围提示 | 本地优先等于推理不出设备 |
| 桌面性能优于当前入口 | 实际 build 的内存、长历史、输出与响应性基线 | 采用 Rust/Tauri 即已证明低开销 |
| 四项价值变成平台膨胀 | 小纵向切片、按影响 ADR、单状态源、原生职责边界 | 每增一种引擎或策略都等于价值提高 |

本轮没有完成这些真实实验。实施计划须将关键假设安排在受其影响的代码冻结之前；未知不等于失败，但不能当作已验证前提。

---

## 27. 有意延期的实施决策

以下是需要证据决定的实现选择，不是留给执行者猜测的产品需求。实施计划应在对应里程碑给出候选、判断方法、结果和复审影响。

| 决策 | 最迟解决边界 | 判断依据 |
|---|---|---|
| 正式产品名 | 创建公开资源、安装标识固定或发布前 | 用户定名与必要名称核验；当前 GoalPort 只是工作名 |
| 三家结构化路径、首家及第二家顺序 | M0 | 真实订阅接入、Windows 可运行、原生兼容、协议/许可与实际失败面 |
| Adapter Host 拓扑及连接所有权 | M0/M1 首条持久链路冻结前 | UI/Core/桥故障实验、可附着性、资源与依赖边界 |
| 进程监督模式 | 启用自动 mutating 任务前 | 实际后代与残留处理、停止能力、不可控范围 |
| crate/模块布局及基础库 | 初始实施计划和必要 ADR | 真实依赖、可测试隔离、最少有效边界，不按固定数量搭空壳 |
| IPC 版本与 schema 生成 | M1 | 可重连、明确错误、跨语言一致、未知事件与大输出处理 |
| 加密格式、主密钥和迁移 | 第一次捕获真实敏感运行数据前 | 成熟实现、完整性、失钥/备份/迁移、诊断不泄露 |
| 性能/配额/真实 soak 数值门槛 | M0/M1 建基线，M5 前固定验收目标 | 指定机器、build、数据量、真实墙钟及可复现操作 |
| UI 组件库与布局细节 | M1 首屏交互实现前 | 虚拟化、键盘/无障碍、依赖成本、纯对话体验 |

既定技术方向不因普通实现偏好随意更换；关键证据推翻假设时，以最小设计修订处理。不得为了守住未经验证的细节继续堆补丁。

---

## 28. Stable V1 定义

Stable V1 是产品验收状态，不是“页面齐全”或“生成了安装包”。它要求：

> Windows 上，一个不替代 VS Code 的纯对话 App 可以使用三家已经验证可用的原生 Runtime/订阅路径，提供持续任务记录、实际可用的恢复或明确安全接管、来源清楚的验证结果、可解释的多订阅分配与可调自主流程。已确认持久化状态不随普通 UI 故障丢失；原生权限、配置和 Skill 不被复制、覆盖或绕过。每个无法证明的恢复级别、数据范围、外部效果与能力缺口均明确显示。

验收以 §22 的结果与层级为准，不能用 Scenario 通过替代真实 Runtime/桌面操作，不能把虚拟时间替代真实 soak，也不能把审批/审计通过替代外部动作授权。

如果仅一两家可用或某项必需能力未验证，交付可使用的预览版本与准确限制，但不称三家 Stable V1。四项产品目标不是被删减，只是分别说明已经证明与尚未证明的范围。

```text
三个 Provider 是目标接入范围
四项痛点是产品价值
Campaign 是持续责任容器
Policy 是用户控制机制
Local Core 是 App 持久控制状态的权威
Runtime 是智能、原生流程、工具与会话的所有者
VS Code 是人工编辑器
Goal Skill 是开发方法，不是最终用户依赖
```

---

## 29. 设计约束与 r2 修订结论

1. 四项产品价值、纯对话界面、多订阅目标、Windows 首发与 VS Code 外部编辑全部保留。
2. `Campaign → Task → Attempt` 保留；修复轮次、原生内部 generation、进程生命周期与 App 责任身份不硬映射。
3. Core 只拥有 App 自有控制状态；不新增个人 Harness 管理器、不读写 v4 私有状态、不复制原生配置或争夺内部推进权。
4. 固定真实性和权限边界、开放产品行为策略；历史快照不能覆盖当前授权撤销和动作时事实。
5. UI/Core 生命周期解耦是要求；Host 数量、crate 数和具体监督方式由证据确定，不把设计示意图当验证结果。
6. 真实 Runtime 可行性与原生兼容在 M0 前移；Scenario 与实际桌面验收并行建立，证据分层且有非零执行范围。
7. 同范围、同可继续 session 的修复默认继续同一 Attempt；真正接管或责任改变才新建，修复预算仍计数。
8. 多订阅路由先用可得事实；未知额度和缺少历史不触发仪式化采集，也不强制升级到 API 计费。
9. 应用边界由实际依赖测试和风险对应的审阅维护，不为每个模块、表或可选字段再造开发流程。
10. 本稿是经过文档自检的设计修订，不表示本地仓库已存在、Hook 已激活、独立计划/执行审计已通过、软件已构建或真实测试已运行。实施继续复用现行 Goal Skill，在实际仓库事实基础上推进。

原 29 节基线文件及上传 Kernel、Skill、agents、hooks 本轮均保持不变。独立修订记录说明来源、具体变更和检查范围；没有把用户的私有配置或压缩包内容复制进产品设计交付物。
