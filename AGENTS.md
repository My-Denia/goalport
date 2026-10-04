# AGENTS.md — 本项目最高行为准则

> 这份文件对所有在本仓库工作的 Agent 具有最高优先级。
> 它与代码不一致时，以这份文件为准。它的每一条都来自真实返工的血泪，不是风格建议。

---

## 0. 一句话铁律

**用户喜欢使用，高于一切。**

任何产出，如果回答不了"用户在这一步的感受是什么"，无论它多么正确、测试多么全、架构多么严谨，都是失败。

判断顺序永远是这样的：

1. 用户这一步爽不爽、懂不懂、信不信？
2. 功能对不对？
3. 测试过不过？

旧的工作流把 3 当成了终点，于是产出了"安全上无懈可击、界面上没人能忍"的产品。这套准则就是来终结那个激励结构的。

---

## 1. 这个产品是什么

GoalPort 是一个**人坐在前面的桌面窗口**。它不是库、不是服务、不是管道。

- UI/UX 不是功能的外衣，**UI/UX 就是产品本身**。
- 用户是工程师，装了 Codex / Claude Code / Grok CLI。他们要的东西用三句话说完：我关窗口后活儿还活着；有权限请求我能答；回来时我知道发生了什么。
- 用户不是来欣赏 Campaign→Task→Attempt 状态机的。内部模型存在的唯一理由是让上面三句话成立。

## 2. 验收方式（新规矩，替代旧的"可验证正确"标准）

旧病：只奖励 Agent 能自己证明对的东西（测试数、哈希、收据、epoch），于是 Agent 疯狂产出可证明的东西、回避不可证明的东西（体验、品味），用"安全"当挡箭牌。

**每个涉及界面的任务，完成时必须交付：**

1. **截图验收。** 自己把界面打开看（`vite build` + 静态服务走 browser-preview 模式，或实机）。关键状态各截一张，附在结果里。没看过截图，不算做完。
2. **新用户走查。** 以第一次用这个软件的人的身份，把关键路径走一遍：首次启动 → New goal → 发送 → 权限决策 → 关闭窗口。每一步问自己：我第一次见到这个会怎么理解？
3. **多宽度验收。** 至少看 3 个宽度：≤860px、约 1020px、≥1440px。曾因 860px 以下抽屉无遮罩压住首启表单而整个新用户路径残缺——这种问题只有亲眼看过才会存在。
4. **测试照写，但测试通过 ≠ 任务完成。** 测试是地板，不是天花板。报告里"137 passed"不得作为"做得好"的证据。

**写 UI 代码之前**，先用一句话写明"这一步用户在干嘛、他希望看到什么"。写不出来这句话，就不许写这段代码。

**每个 UI 改动的提交说明里必须回答**：用户这一步的感受改变了什么？答不上来的提交会被打回。

## 3. 安全的位置

- Core 层那套诚实语义（丢了回执标 UNKNOWN、绝不自动重放、held 不假装释放）是**正确的底层**，保留，不用推翻。
- **禁止事项**：在下面这五件事完成之前，仓库里不允许新增任何安全 / 收据 / epoch / 审计 / 加固类基础设施代码。不许给水管再加一层装甲。
  1. 共享的 Picker / Popover / Dialog primitive（消灭重复实现）
  2. 焦点 / 草稿 / 轮询快照三条生命周期的分离
  3. 独立的会话标题生成（不污染主对话，额度不足时用本地标题，不阻塞正文）
  4. 类型化的 provider 错误映射（如额度错误的结构化处理，而非猜字符串）
  5. Agent 可观察的调试接口（preview_snapshot / click / evaluate 一级工具）
- 前置完成状态（2026-10-04 记录，PR #24 修复轮交付）：#1 共享浮层 primitive（`src/ui/GoalLayer.tsx`，Base UI 封装；composer 输入规则合一 `useComposerInput`）；#2 焦点/草稿/轮询生命周期分离（`useConversationDrafts` + 轮询 epoch 守卫 + draft composer 稳定挂载）；#3 独立会话标题生成（`crates/goalport-core/src/async_title.rs`，脱线程、限额回退本地标题）；#4 类型化 provider 错误映射（`crates/goalport-core/src/provider_failure.rs` 闭集 + 前端 union + 锁测试）；#5 Agent 可观察调试接口（`scripts/connected/ui-debug.mjs`，preview_snapshot/click/evaluate，localhost-only，不进生产路径）。此后本条禁令恢复完全效力：再加安全/收据/epoch/审计/加固基础设施前，先回到本清单核对。
- 当你发现自己又在写"可证明正确"的东西、而过去两小时没人看过一眼界面时，**停下来，这就是那个病**。

## 4. UI 的正确姿势：抄，别发明

- 浮层、对话框、菜单、composer——这些是 solved problem。**不抄才是罪过。** 直接采用成熟 primitive（Base UI），或移植 t3code（pingdotgg/t3code，MIT）的 popover / dialog / composer 输入规则与对应测试。
- **同一组件只存在一份。** 反面教材：`DraftGoalComposer.tsx` 和 `Composer.tsx` 里两份逐字雷同的手写浮层（各自维护 open state、document 鼠标监听、Esc 监听）。再出现两份雷同实现，视为任务未完成。
- 文案只说一遍。占位符说了"Enter to send"，hint 行就不许再说一次。
- 错误与阻塞状态：一句人话 + 折叠的 Technical details。不许堆内部名词（Attempt、epoch、responsibility）到用户脸上。
- 交互状态分开定义：用户意图、turn 状态、session 存续、发送能力，是四个东西（参考 t3code 的 `isRunning / isSendBusy / sendDisabledReason`），不许揉成一个布尔值。

## 5. 已知耻辱柱（这些 bug 真实发生过，不要再犯）

| 罪行 | 教训 |
| --- | --- |
| ≤860px 时侧栏抽屉默认展开、无遮罩、压住主内容；New goal 首启表单被裁掉半边 | 布局改动必须做多宽度截图验收（见 §2.3） |
| 每 750ms 快照轮询都对同一个 pending decision 发系统通知 | 用户可见副作用必须有去重/记忆 |
| 决策卡全宽琥珀色、内容只占左半，右半一大块空 | 组件在大宽度下也要看一眼 |
| 同一状态两个词：HandoffDialog 叫 "Preview"，别处叫 "Limited" | 同一概念全应用一个词汇 |
| 生产代码里留测试钩子：无条件写 `window.__goalportCloseRequestId`、handoff 硬编码 `goal-runs/.../evidence/locks/...` 路径 | 测试设施不许进生产路径，除非隔离在 test 构建 |
| limitations.md 说"时间戳是原始 epoch 毫秒"，代码早已本地化 | 文档与代码一起改，漂移即谎言 |
| README 截图展示旧版 raw timeline UI | 截图随代码更新，用户第一印象必须等于实物 |
| 为 file:// 主文档身份维护一串大小写/百分号编码仪式 | 方向是自定义协议（`t3code://app/` 模式），别再给 file:// 擦屁股 |
| 渲染层 `goalport.ipc.v1`、主进程 `goalport.ipc.v2`，Core 双版本通吃 | 协议版本收敛，安全边界不容稀释 |

## 6. 当前产品方向（据此判断每个任务该不该做）

- **前端基线转向 t3code**：认真评估以 pingdotgg/t3code 为 fork 基线，而不是继续在现有前端上增量修补。
- 现有 Core 仅在以下差异化确实是要卖的产品价值时才保留：跨 Runtime handoff、held responsibility、后台续跑。否则它们是负担不是资产。
- 更新（2026-10-04，事实已按上游源码核实）：t3code 的 orchestration-v2 现在**有** first-class provider switching（同一条 app thread 可包含多个 provider 的 run，各保留原生会话句柄）、`ProviderThread` 与 `ContextHandoff` 概念（上游 `docs/orchestration-v2/provider-switching-and-context.md`、`apps/server/src/orchestration-v2/ContextHandoffService.ts`）。旧说法"same-thread 拒绝跨 driver、handoff 不存在"已过时。仍然只抄 primitive、输入规则、错误映射、测试；provider 切换/handoff 的业务语义与 GoalPort 的 durable hold 语义不同，评估 fork 基线时逐项对照，不整体照搬。
- t3code 的 MIT 许可证允许复制修改，但必须保留其版权与许可声明；其组件依赖的其他库需分别核查。

## 7. 与我的沟通规则

- **直接。** 指出问题时不许委婉，不许"虽然……但是……"式的平衡话术。一个问题一分严重度，说清证据。
- **不许用"工程纪律很好"来评价一个用户不会喜欢的东西。** 工程纪律是卫生，不是功劳。表扬它之前先回答：用户喜欢吗？
- 当我（项目负责人）的指令会明显伤害用户体验时，指出来，并给出更好的做法。这条优先级高于"照做"。
- 每次交付结尾，用一句话回答："用户为什么会更喜欢用这个？" 答不上来就别说做完了。

---

*本文件高于一切局部优化冲动。当它与"再加一层验证"的诱惑冲突时，记住：2026 年，想法廉价、实现已自动化，软件业剩下的唯一稀缺品是"让用户喜欢"的判断力。*
