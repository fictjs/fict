# HIR 全量落地实施方案（大胆版）

> 目标：移除 legacy 路径，彻底以 HIR → SSA → Region → fine-grained DOM 为唯一编译链路。当前代码已完成切换，以下内容保留为实施记录与守护清单。

## 1. CFG 结构化回写（if/loop/switch/try + for-of/in 实语义）

- **块级结构识别**：基于支配树/回边识别循环头与自然循环，使用 RPO/支配关系重建 while/for/for-of/for-in/do-while；回写 break/continue 目标。
- **分支合成**：对 Branch/Switch 转换为 if/switch 语句，合并 join 块；必要时插入占位语句保持语义顺序。
- **try/catch/finally**：捕获 try 块与 handler/finalizer 的块域，将 terminator 映射为真实 try 结构，保留 catch 参数绑定。
- **for-of/for-in 实语义**：builder 收集迭代变量、右值、body 块，codegen 输出真实 for-of/for-in；删除占位 `__forOf/__forIn`，同时更新 SSA 前驱/后继对新 terminator 的支持。
- **Jump 消解**：在结构化时消除单纯跳转（Jump），“不可结构化”路径用显式块列表回写或抛编译错误，避免 goto 占位。
- **Early return/throw**：保留块内 return/throw，确保 CFG 中的早退在回写后依然可达/正确。

## 2. Region/terminator 全覆盖与 SSA/命名还原

- **Region 内控制流**：Region 输出不再线性指令；按结构化 CFG 回写（if/loop/switch/try），终结符全部落地，包含 Break/Continue/Return/Throw。
- **SSA 名称回写**：保留 baseName 映射，生成代码使用原始标识符（或确定性的去版本化），避免 `_1` 泄露；phi 结果在回写时选择合适的版本或先做简化。
- **依赖与声明对齐**：Region 依赖、声明与回写名称一致；memo/destructuring 使用 RegionMetadata，children 嵌套保持。
- **未覆盖结构容错**：无法结构化的 CFG 直接编译报错（明确错误码），避免生成半成品。

## 3. JSX → fine-grained DOM 对齐（RegionMetadata 驱动）

- **组件 vs 原生**：组件 JSX 降为 `createElement`，原生 JSX 使用 fine-grained-dom helpers（template/bindAttribute/bindProperty/bindEvent/...），复用现有策略。
- **RegionMetadata 应用**：在 fine-grained-dom 中调用 `applyRegionMetadata`，按 dependencies/hasControlFlow 决定 memo/destructuring/依赖 getter 注入。
- **可选链/shape 影响绑定**：利用 shapes/optional-chain 分析决定订阅粒度，生成属性级绑定而非全对象订阅。
- **事件/列表/条件**：条件子树走 `conditional` helper，列表走 `keyedList`/`list`，保持 legacy 行为一致；Spread/Ref/Style/Class 等按现有规范降级。
- **Helper 导入**：`helpersUsed` 精确收集 DOM/runtime helper，自动注入 import，移除占位 goto 生成的无意义语句。

## 4. HIR-only 测试与 legacy 清理

- **测试基线**：更新 test harness 默认 HIR/hirCodegen，移除双路径/legacy 代码路径；环境变量 `FICT_HIR` 等废弃。
- **覆盖面**：新增/更新用例覆盖控制流（if/loop/switch/try/finally/break/continue）、for-of/in、可选链/shape、列表/事件/effect/可选链 spread 等核心场景，快照或文本断言与运行时期望一致。
- **CI/配置**：调整脚本/CI 仅跑 HIR；清理 legacy transform 流程/入口代码与相关测试文件。
- **文档/警告**：更新文档说明 HIR 为唯一路径，移除 legacy 警告与配置选项。

## 建议的执行顺序

1. **CFG 结构化 + for-of/in**：先让函数回写产物可读/可运行，替换 goto 占位。
2. **Region/SSA 命名回写**：确保控制流+Region 组合输出正确变量名/terminator。
3. **DOM 对齐**：JSX 降级到 fine-grained helpers，并接入 RegionMetadata。
4. **测试与清理**：切换 HIR-only 测试，移除 legacy，文档同步。
