# HIR/hirCodegen 强制路径修复计划（技术方案）

> 目标：在保持 `experimentalHIR + hirCodegen` 为默认/强制的前提下，补齐产物正确性与运行时对齐，消除当前不可运行的输出与语义回归。

## 总体原则

- **保真输出**：保留所有顶层语句（import/export/声明/表达式），函数体还原完整控制流与返回值。
- **渐进落地**：先保证“能跑、对齐”，再补优化（SSA/Region/Fine-grained DOM）。
- **双路径对比**：对典型 fixture 同时产出 legacy/HIR，持续回归守护。

## 修复主题与技术动作

1. **HIR 构建器完备性**
   - 支持 break/continue/labeled break、for-in/for-of、try/catch/finally、可选链调用、call/await/new、序列表达式、逻辑赋值等。
   - 箭头函数/函数表达式体完整线性化，保留所有语句（不只首 return）。
   - 记录并保留顶层 import/export/表达式语句，非函数语句按原样存入 Program 的“前缀”列表。
   - 为 terminator 添加类型信息（return/throw/break/continue/switch fallthrough），后端可重建。
   - 构建器输出 entry/exit block，保证 CFG 连通且每函数至少有终结符。

2. **SSA/CFG 健壮性**
   - 校验并修正支配树/支配边界计算，对不可达块做剔除或标记 Unreachable。
   - Phi 插入使用变量定义全集（含参数、捕获的闭包变量），避免漏版本。
   - 在 rename 阶段保留“原始名”映射，供回写还原。

3. **Region/Scope 生成修正**
   - `isInstructionInScope` 包含 Expression/副作用语句；Region 收集 terminator（return/throw）并在 codegen 中输出。
   - Region 依赖/声明集与 SSA 名字映射回原始标识符，避免 `_1` 等泄露到产物。
   - Region 嵌套与顺序：基于块包含关系和支配关系，保证输出顺序与原执行序一致。

4. **Babel 回写与运行时对齐**
   - 在 `lowerHIRWithRegions` 前保留/回写顶层 import/export/指令；若 HIR 无法处理的语句，保底透传原 AST 节点。
   - `instructionToStatement` 区分“声明/赋值/表达式”；循环或重复赋值生成赋值表达式而非 `const`。
   - terminator -> Babel：Return/Throw/Branch/Switch/Jump 生成真实结构或在不可结构化时 fallback 标记。
   - 确保在使用 `$state/$effect/$memo` 或 region/memo 时注入 `__fictCtx = __fictUseContext()`。
   - 表达式回写支持 JSX、Call/New/Optional/Template、Await、Spread、Object/Array pattern、宏 `$state/$effect` 降级到运行时调用。

5. **Fine-grained DOM / Region 元数据桥接**
   - 提供 `applyRegionMetadata` 挂钩：从 RegionMetadata 注入依赖 getter，选择性生成 memo/destructuring。
   - 对接 existing helper 导入：按 `helpersUsed` 自动注入别名 import，防止缺 helper。
   - JSX 降级：组件走 `createElement`，原生节点走 fine-grained DOM helpers，保持与 legacy 一致的绑定/事件策略。

6. **顶层/模块级完整性**
   - 模块包装：保留 `'use strict'`/指令、顶层变量/表达式、副作用导入顺序。
   - Export default/named 还原；构造函数声明/类声明需被纳入 HIR 或在回写阶段透传。

7. **回退与容错**
   - 对无法结构化的 CFG（如异常场景）添加安全降级：保留原 AST 片段或在编译时抛出明确错误码，避免生成半成品。
   - 生成期增加断言：入口块、终结符、SSA 覆盖、Region 覆盖非空。

8. **测试与守护**
   - 双路径 fixture：核心场景（控制流、可选链、列表、spread、事件、effect）比对 AST 或文本快照。
   - 单元：HIR builder（含 break/continue/for-of/try）、SSA phi、Region 生成（包含 terminator/表达式）、JSX 降级、宏降级。
   - 集成：实际运行快照（可通过 vitest + @babel/register 输出字符串），验证 import/export/return/JSX 还原。
   - 运行时调用数与 helper 导入数的断言，避免漏注入。

## 里程碑拆解

- **M0：可运行回写**
  - 保留顶层 import/export/表达式，terminator->return/throw/branch 回写，赋值语义修正，\_\_fictCtx 注入。
- **M1：HIR 覆盖与 SSA 校准**
  - 补全控制流/表达式覆盖，修正 SSA/Phi/不可达块处理，Region 收集副作用+terminator。
- **M2：DOM/Region 对齐**
  - JSX 降级覆盖，RegionMetadata -> fine-grained DOM 挂钩，helpers 自动导入。
- **M3：双路径与回归守护**
  - 大型 fixture 双跑快照，基于 `FICT_HIR=1` 与 legacy 对比；新增断言与错误码。
- **M4：优化与清理**
  - 删除 legacy 专用分支（待验证），精简 fallback，补充文档/CHANGELOG。

## 验收准则

- 同一源码在 HIR/hirCodegen 下产物可执行，import/export/return/JSX 不缺失。
- 控制流（if/loop/switch/try）输出结构化正确，无重复声明或 ReferenceError（尤其 \_\_fictCtx）。
- `$state/$effect/$memo` 调用映射到运行时，DOM 绑定与 legacy 行为一致或差异已记录。
- 双路径快照绿，新增测试覆盖上述缺口。
