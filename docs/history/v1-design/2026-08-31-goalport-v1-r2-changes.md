# GoalPort V1 · r2 修订记录

> **Historical design record** (2026-08-31, pre-implementation). Index: [history](../README.md).

日期：2026-08-31。范围：修订产品设计，不修改开发者的 Kernel、Goal Skill、agents、hooks，不实现或发布产品。

## 交付文件

- [完整 r2 产品设计](2026-08-31-goalport-v1-design-r2.md)：保留原 29 节组织，整合修订，不需要另叠一份覆盖规则。
- [本地开发目标入口](goalport-v1-goal.md)：单次项目目标，交给本地当前 Goal Skill，不是 Skill 或 AGENTS.md 替换稿。
- [文档检查记录](2026-08-31-goalport-v1-r2-validation.json)：结构、覆盖、关键旧表述移除、链接、基础敏感模式和输入文件完整性检查；不是产品测试报告。

## 不变的产品目标

持续性、结果质量、多订阅路由和低干预工程流程全部保留。产品仍是纯对话桌面 App，首发 Windows，编辑交给 VS Code；使用各家原生 Runtime/订阅能力，不替代 CLI 的 plugins、skills、hooks、MCP、工具与上下文管理。Tauri、React/TypeScript、Rust Core、SQLite 继续作为已选择的技术方向。

四项价值不是四选一；缩减的是重复控制、无证据的强保证和提前钉死的实现细节，不是功能目标。

## 修订清单

| 编号 | 原设计的问题 | r2 的具体处理 | 对应章节 |
|---|---|---|---|
| C01 | 开发 Harness 与产品运行控制权混淆 | v4 只作为开发方法；产品不依赖个人 Harness、schema 或模型配置；原生流程保持所有权 | 3、4、15、25、29 |
| C02 | Core“唯一权威”范围过宽 | 限定为 App 自有控制状态；原生状态只有带来源观察，不形成第二写入者 | 3–6、18 |
| C03 | 一般修复被当成新 Attempt | 原责任和原 session 可继续时恢复同一 Attempt；修复、审计与切换预算分别计数 | 5、6、8、22 |
| C04 | Attempt lifecycle 与 work status 双重可写 | Attempt 保留单一生命周期；Task/Campaign work status 为推导投影；关闭角色不等于工作正确 | 5、6 |
| C05 | 快照可能继续放行已撤销的权限 | 历史策略不可改，但动作时重新判断目标、授权和撤销；偏好覆盖不削弱当前边界 | 7、13、14、18 |
| C06 | exit 0、Mock 或审计 PASS 可能被过度解释 | 证据记录实际命令/操作、cwd、退出结果、适用非零范围及证据层级；独立性不等于换模型 | 10、19、22 |
| C07 | 完整 Mock Core 先于真实可行性验证 | M0 先做真实 CLI＋合成项目的关键实验，Scenario 与真实链路并行推进 | 15、19、21 |
| C08 | Adapter 重启就默认能接回旧进程 | 分别证明 transport 附着与 session 恢复；缺口转 R2/R3 或阻塞，不伪装 R1 | 5、9、15、18、22 |
| C09 | Observe 与 Core 崩溃后强停止承诺冲突 | 按 RuntimeProfile 声明已验证监督能力；残留和失联保持 UNKNOWN/UNCERTAIN | 12、16、18、22 |
| C10 | 只读声明、路径或快照可能被当作强隔离/原子视图 | 只读按真实能力准入；处理路径别名、重叠目录、UNCERTAIN 写入屏障与执行期间漂移 | 10、12、19 |
| C11 | 精确额度、完整画像可能成为必填门槛 | UNKNOWN 可路由；先用用户偏好、能力、健康，后用可靠历史；不复制个人模型或 quota 仪式 | 7、11、21 |
| C12 | 三种二进制、六个 crate、每 Attempt 一个 Host 被先验固定 | 保留职责与故障隔离要求，实际拓扑由实验决定，不预先搭空壳 | 18、20、27 |
| C13 | 每个表、模块和依赖都要求额外 ADR/审批 | 按权威、权限、协议、恢复、数据与长期责任的真实变化触发评估；常规细化归现有开发流程 | 25 |
| C14 | 内部流水线被描述成无限保真或 exactly-once | Outbox 不替代 Runtime 幂等；有限缓冲、磁盘满、无法写故障状态和 Artifact 发布窗口明确处理 | 13、16、18 |
| C15 | Handoff 摘要可能掩盖新 Provider 的完整工作区读取 | 授权说明 App 发送范围与 Runtime 后续访问范围，不声称未实现的沙箱 | 14、22 |
| C16 | Stable 声明比证据范围更强 | 原 12 项验收扩展为 23 项结果场景，声明具体层级；虚拟时钟不代替真实 soak | 19、22、26、28 |
| C17 | 产品 Phase 与 Goal Skill 阶段重名 | 产品交付统一为 M0–M5，不复制 Skill 的阶段和运行状态 | 21 |
| C18 | 开源复用被笼统限制 | 优先复用基础设施；依实际代码和许可选择依赖/移植/fork，不继承不合适的产品状态模型 | 24 |

## 材料支持与设计判断的区分

以下是本轮直接核读的当前文件，不使用备份文件、缓存或旧代际材料替代现行条款：

| 来源 | 材料实际支持的要点 |
|---|---|
| 上传的 AGENTS.md，常驻原则及默认路由、owner-only 边界 | 当前证据优先；项目事实/Skill/机械门禁归位；动作分别授权；执行范围与结论层级对应 |
| goal-autopilot-harness.zip 内 SKILL.md | 主代理拥有范围与最终结论；任务形状驱动委派；风险对应审计；不强制 fan-out/模型/额度仪式 |
| 同包 references/goal-contract.md | Schema 兼容字段不要求填造观察；needs-fix 与 needs-replan 不同；需要使用证据和真实运行结果 |
| 同包 references/three-agent-loop.md | 独立上下文而非角色标签；auditor 不自审；同范围修复保持 canonical executor；边界内可自主重规划 |
| 同包 references/execution-standards.md | 最小完整变更；固定契约的所有执行点要同步；界面行为有直接证据；长任务需可恢复和可核对 |
| agents.zip 的 controller/executor/plan-auditor/execution-auditor 配置 | 执行所有权、独立审计、边界内自主性；模板存在不证明当前宿主实际注册 |
| hooks.zip 中 goal gate、stop validation 和 lifecycle logger 的当前入口静态说明 | hook 各有触发范围和旁路；生命周期观察不等于全工具隔离或正确性证明 |

“v4”沿用用户对所上传开发框架的称呼，不把持久状态 schema 号当成产品版本号。上述材料不会被复制为产品自带的运行配置。

C01/C03/C05/C06/C11/C13/C17 的修订直接响应开发材料的职责、授权、修复与证据要求。Host 拓扑、状态投影、UNCERTAIN lease、Artifact 原子性和跨 Provider 暴露范围的具体方案属于对原产品设计的工程推导，不冒充 v4 中现成定义的实现。

## 本轮验证与未做事项

已生成完整 r2 设计、修订清单和单次项目目标。程序化文档检查核对 29 个主章节、M0–M5、23 个验收 ID、相对文件链接、代码围栏、关键修订以及基础敏感模式；重新计算五个原始输入的哈希以确认未修改。

未执行真实 Claude/Codex/Grok、未构建 Windows App、未运行上传包的完整 hooks/validator 测试、未启动独立审计 agent、未创建产品仓库、未 commit/push 或修改任何持久用户配置。文档自检不等于正式 Goal run 的 plan/execution gate 通过。

下一执行输入是 r2 设计和单次目标；本地执行代理读取真实仓库及当前 Skill 后形成可执行计划。普通细化自主完成，只有实质范围/授权/安全边界变化或无法消除的真实阻塞才需所有者裁决。
