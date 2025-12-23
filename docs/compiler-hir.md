# Fict Compiler HIR（实验性）

> 默认编译仍走旧的 Babel 直接变换路径；`experimentalHIR` 目前只构建/打印 HIR，未替换输出。

- **实验开关**：`experimentalHIR`（编译选项，默认 `false`）。开启后在 `Program` 入口构建 HIR 存入 state，后续仍执行 legacy 变换。
- **实验输出**：`hirCodegen`（默认 `false`，需配合 `experimentalHIR`）。开启后直接走 `HIR → SSA → Region` codegen，跳过 legacy 变换，仅用于实验/测试。
- **已实现（分析/测试层）**：
  - HIR 基本类型与 CFG 构建：`buildHIR` 覆盖函数体线性化、`if/else`、`while/for/do-while`、switch、try-catch、嵌套循环/条件，`printHIR` 文本输出。
  - SSA 雏形：`enterSSA` 版本化 + 支配边界驱动的占位 Phi 插入与重命名，未做精确 φ 优化。
  - Reactive Scope/Region/依赖分析：SSA/CFG 感知的 `analyzeReactiveScopesWithSSA`，`generateRegions`，控制流读检测、可选链依赖分析、对象形状 lattice。
  - Codegen 雏形：`lowerHIRWithRegions`、`codegenWithScopes`、`lowerHIRToBabel` 仅在单测中运行，未接入插件或运行时导入。
- **未完成/限制**：
  - Babel 插件未消费 HIR：`experimentalHIR` 不会触发 SSA/Scope/Region/Codegen，输出仍来自 legacy 路径。
  - 新 codegen 产物未对齐运行时 helpers/模板生成器，`applyRegionMetadata` 入口未被调用。
  - 可选链/形状分析的订阅决策未用于真实依赖收集，未有 fixtures 级别的双路径对比。
- **下一步方向**：按升级计划接入“HIR → SSA → Scope/Region → fine-grained-dom”链路到实验 flag，增加双路径 fixture snapshot，对齐运行时导入与 region metadata。
