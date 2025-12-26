# Fict Compiler 技术升级计划

目标：在保持开发者体验的前提下，引入更健壮的中间表示与分析管线，减少不必要的重算/绑定，改进依赖精度与校验，并提供更好的测试与调试支撑。重点借鉴 React Compiler 的 HIR/SSA、Reactive Scope、校验与调试工具，但结合 Fict 现有 fine-grained DOM 与控制流重执行模型。

---

## 现状概览

- **Babel AST 直接变换**：`packages/compiler/src/index.ts` 中多阶段扫描/改写，未抽象出独立 IR/CFG。
- **派生分类**：`rule-d.ts`/`transform-expression.ts` 依据使用场景生成 memo/getter，存在保守重算与控制流判断粗糙的问题。
- **区域 memo**：有初步的 control-flow region 分组，但缺少系统化的 scope 合并/裁剪。
- **依赖精度**：可选链、动态属性、对象形状等处理简化，易产生过度重算或漏算。
- **校验/工具**：仅编译期警告，缺少独立 lint/健康检查与 IR 快照工具。

---

## 状态校准（当前分支）

> **✅ HIR 现为唯一编译路径，Legacy 代码已移除。**

- 编译选项中不再支持关闭 HIR；插件直接走 `HIR → SSA → Region → fine-grained DOM`。
- 所有编译/运行时集成测试均在 HIR 管线上通过。
- 后续工作聚焦于边缘场景完善与性能/体积回归监控。

---

## 升级目标

1. 引入高阶 IR/CFG 与 SSA，提升复杂控制流与依赖分析的准确性与可维护性。
2. 构建 Reactive Scope 管线，减少冗余 memo/绑定，提供可控的失效粒度。
3. 强化依赖收集（可选链/对象形状/动态属性），降低过度重算。
4. 提供统一的校验与 IDE/lint 支撑，提前暴露 `$state/$effect` 误用。
5. 增强调试与测试基建（IR 打印、健康检查、性能回归防护）。
6. 保持 fine-grained DOM 输出与现有运行时兼容，可阶段性落地、逐步启用。

---

## 设计原则

- 输出代码尽量保留高阶语法形态，便于调试与体积控制。
- 渐进式迁移：新 IR 与旧 Babel 变换共存，按实验标志切换。
- “先校验后优化”：新增静态校验不应破坏现有可编译代码路径。
- 可测试性：每个新 pass 需具备独立快照或 golden 测试。

---

## 方案与步骤

### 1. 引入 High-Level IR 与 CFG

- **IR 定义**：在 `packages/compiler/src/ir/` 新增 HIR 结构（基本块 + 指令 + 终结符），保留 if/逻辑/循环的高阶形态。
- **构建器**：实现 `buildHIR`（Babel AST → HIR），解决 break/continue/label 跳转，保持求值顺序。
- **桥接层**：暂时保留 Babel 直接变换路径；为新管线添加 `--experimental-hir` 选项（编译/测试仅此路径）。
- **产物回写**：HIR → Babel AST 的 codegen 先复用现有生成器，确保输出与当前 fine-grained DOM helper 调用兼容。

### 2. SSA 与基础优化

- **SSA 转换**：实现 `enterSSA`（φ 插入、版本化标识符），支撑后续数据流分析。
- **简单优化**：常量折叠、死代码消除、复制传播，降低生成代码噪音与体积。
- **验证**：加入 `assertValidBlockNesting`、`assertTerminalBlocksExist` 等检查，确保 CFG 健壮。

### 3. Reactive Scope 管线

- **Scope 发现**：基于 SSA/HIR 识别创建/写入同频率失效的变量组（state/memo/derived），记录触发点。
- **Scope 对齐/合并**：参考 React Compiler 的 `AlignReactiveScopesToBlockScopes`、`MergeOverlappingReactiveScopes` 思路，对齐 block 边界，合并必然同时失效的 scopes，裁剪包含 hook-like/不合法节点的 scope。
- **Region 构建**：将控制流区域打包成单个 memo/getter 输出（替换现有 `findNextRegion`/`generateRegionMemo` 的散点实现），统一生成 “region memo + destructuring” 模式。
- **失效策略**：定义 scope metadata（依赖集合、控制流触发标志），驱动后端决定“重执行组件”还是“fine-grained 绑定更新”。

### 4. 依赖收集与形状推断增强

- **可选链/空值传播**：实现 `collectOptionalChainDependencies` 式分析，避免为可选链过度订阅根节点。
- **对象形状推断**：轻量形状 lattice（已知 key/可变 key/逃逸），指导属性订阅与 spread 包装（避免全对象订阅）。
- **动态属性访问**：区分可静态化的计算属性与真动态元素访问，对动态访问降级为重执行、并发出编译提示。
- **控制流读检测**：更精确地标记“控制流读” → 组件重执行 vs “纯 JSX 读” → 绑定更新，减少假阳性。

### 5. 类型/值类推断（轻量）

- **类型格**：原语/对象/函数/unknown + “isSignal/isMemo” 标志，支撑依赖与合法性校验。
- **集成方式**：不依赖 TypeScript 类型服务，采用语法驱动 + 常见模式推断；保留 hook-like 调用与 `$state` 特征。

### 6. 校验与 IDE/Lint 支撑

- **校验模块抽离**：将现有编译期警告封装为可重用校验（如 `$state` 位置、循环/条件中的非法写）。
- **ESLint 插件**：在 `packages/eslint-plugin` 增加基于校验模块的 rule 集，暴露与编译器一致的错误码/信息。
- **指令/配置**：扩展 `"use no memo"` → 支持函数级/文件级 opt-in/out（如 `"use fict-compiler"`, `"use fict-compiler-disable"`），并在 Babel 插件入口解析。

### 7. 调试与测试基建

- **IR 打印**：提供 `printHIR`、`printReactiveScopes`（类似 React Compiler 的 snap 工具），方便 golden 测试与回归对比。
- **健康检查 CLI**：新增脚本（类似 `react-compiler-healthcheck`）对仓库运行一轮编译 + 校验 + 统计（scope 数量、绑定数、输出体积）。
- **基线性能测试**：为典型基准（列表、大型控制流、嵌套 effect）记录产物大小、运行耗时，作为回归阈值。
- **Fixture 双路径**：测试用例同时跑旧 Babel 直接变换与新 HIR 路径，对比输出/警告差异。

### 8. 运行时/DOM 输出对齐

- **后端映射**：确保新 Region memo 输出继续调用现有 fine-grained DOM helper（`createKeyedBlock/createVersionedSignal` 等），必要时调整 helper 签名保持兼容。
- **逐步启用**：默认仍使用旧路径；提供 env/flag 在 CI 运行新路径并产生日志，准备切换。

---

## 里程碑与交付物

### M1：IR/HIR 框架落地（2 周）

- 交付：`ir/` 目录、`buildHIR`、CFG 验证、基础回写（无优化）。
- 验收：核心 fixtures 在 `--experimental-hir` 下生成代码与旧路径等价或仅有无害重排。

### M2：SSA 与基础优化（1.5 周）

- 交付：`enterSSA`、常量折叠/死代码消除、复制传播。
- 验收：体积回归报告稳定；新增 SSA 单测覆盖循环/分支/三元。

### M3：Reactive Scope 管线（3 周）

- 交付：scope 发现/对齐/合并/裁剪、Region memo 构建重写。
- 验收：控制流复杂示例的 memo 数量下降（有统计），无行为回归；基准性能不退。

### M4：依赖/形状分析增强（2 周）

- 交付：可选链精确订阅、对象形状 lattice、动态属性降级提示。
- 验收：针对 spread/可选链的过度重算测试通过，警告信息完善。

### M5：校验与 Lint、指令扩展（1.5 周）

- 交付：共享校验模块、ESLint 规则、opt-in/out 指令支持。
- 验收：IDE lint 可重现编译错误码；指令生效可控。

### M6：调试/健康检查与性能基线（1.5 周）

- 交付：IR 打印工具、健康检查脚本、基准与回归阈值。
- 验收：CI 可运行健康检查，生成报告；回归阈值可配置。

### M7：切换与清理（1 周）

- 交付：默认启用 HIR 路径，旧直接变换退场或隐藏在 flag；文档更新。
- 验收：全仓 CI 绿；docs/CHANGELOG 记录迁移指南。

---

## 风险与缓解

- **体积/启动回归**：通过常量折叠、scope 合并与回归基线监控；必要时保留性能守卫阈值。
- **行为回归**：双路径 fixture 对比 + 健康检查；新增错误码保持向后兼容。
- **落地周期过长**：里程碑拆分、每步可回滚；flag 控制渐进启用。
- **工具链耦合过深**：桥接层在 Babel AST 与 HIR 之间保持最小接口，便于逐步替换。

---

## 开发与验证策略

- 单元测试：每个 pass 独立测试；IR 打印的快照测试。
- 集成测试：真实 fixtures 走双路径比对 AST/输出文本；允许格式差异但不允许运行时差异。
- 性能测试：基准场景记录体积/运行时耗时，CI 报告回归。
- 文档：同步更新 `docs/architecture.md`、新增 `docs/compiler-hir.md` 描述新管线与指令。

---

## 立即行动清单（本周）

1. 搭建 `ir/` 目录与 buildHIR 骨架，创建实验 flag。
2. 为现有 fixtures 增加双路径测试 harness。
3. 设计 IR 打印格式与 snapshot 测试模板。
4. Draft ESLint rule 列表（映射现有编译警告），规划错误码表。
5. 选取 3 个基准用例（复杂控制流、深度列表、可选链 + spread）作为性能/行为金样本。

---

## 优先级 TODO 列表

- **P0｜管线支架与可回退**
  - ✅ HIR 已默认且不可关闭，Legacy 入口与 flag 已移除。
  - ✅ 创建 `packages/compiler/src/ir/` 目录：定义 HIR 基本块/指令/终结符类型、`buildHIR` 骨架与 Babel AST ↔ HIR 桥接函数。
  - ⏳ Fixture 双跑 harness：可按需增加历史对比，但主干仅跑 HIR。
  - ✅ IR 打印器雏形：`printHIR` 输出文本版 CFG（块 ID、终结符、指令列表），用于早期 snapshot 与调试。
  - (原) 文档 stub：`docs/compiler-hir.md` 已移除，信息收敛到升级计划。

- **P0｜回写与运行时对齐**
  - ⚠️ 在新管线实现最小化 codegen：`lowerHIRWithRegions` 仅在单测中运行，未接入 Babel 插件/运行时导入，生成代码未实际落地。（已实现：`lowerHIRWithRegions`、`getRegionMetadataForFunction`、`hasReactiveRegions` 单测通过）
  - ⚠️ 在 `fine-grained-dom.ts` 增加可选的 "region metadata" 输入口（预留位），但尚未被调用。（已实现：`RegionMetadata` 接口、`applyRegionMetadata`、`createRegionMemoWrapper`、`shouldMemoizeRegion` 函数）

- **P1｜分析与优化核心**
  - ✅ HIR/CFG 扩展：已支持函数体线性化、`if` 分支拆块、`while`/`for`/`do-while` 循环、嵌套 if/else、switch 语句、try-catch、嵌套循环、循环内条件。（10 个测试通过）
  - ⏳ `enterSSA` 实现：提供版本重命名、基于支配边界的占位 Phi 插入与重命名，计算支配/支配边界；仍需精确/优化的 φ 放置与控制流敏感处理。
  - ✅ Reactive Scope pass：SSA/控制流敏感的合并/裁剪与 metadata（单测覆盖：`analyzeReactiveScopesWithSSA`、`getLoopDependentScopes`、`needsVersionedMemo`）。
  - ⚠️ Region 生成：`generateRegions` 系列已实现并单测通过，但尚未替换现有 `findNextRegion`/`generateRegionMemo`，未接入 Babel 插件。
  - ⚠️ 可选链依赖分析：pass 已实现/测通，但未对真实订阅/依赖收集路径生效。
  - ⚠️ 对象形状 lattice：分析与测试已完成，但未驱动真实 codegen 的订阅策略。
  - ✅ 控制流读检测升级：在 HIR/CFG 上标记"控制流读"与"纯表达式读"（分析层可用）。

- **P1｜测试与基线**
  - 扩充 fixtures 覆盖：可选链、深层 destructuring + spread、嵌套条件/循环、keyed list 与 versioned signal 交互。
  - 基准脚本：在 `scripts/` 添加基准运行（产物体积、绑定数、scope 数、生成时间），CI 上记录历史对比。

- **P2｜工具化与生态**
  - 校验模块抽离：将现有 `emitWarning` 逻辑迁入可复用的校验模块，导出统一错误码表；编译器与 ESLint 共用。
  - ESLint 规则：在 `packages/eslint-plugin` 添加新 rule，复用校验模块；提供自动修复建议（如 “使用 prop 包装”）。
  - 健康检查 CLI：在 `scripts/` 或独立包中实现 `fict-compiler-healthcheck`，调用编译器新/旧管线并输出统计与警告摘要。
  - 指令扩展：实现 `"use fict-compiler"` / `"use fict-compiler-disable"` / `"use no memo"` 的优先级解析（文件级覆盖函数级），文档更新。
  - IR/Scope 可视化：为 Devtools 或独立页面输出 JSON/Graphviz（可选），便于分析 scope 合并效果。
