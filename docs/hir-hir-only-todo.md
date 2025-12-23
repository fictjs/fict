# HIR-only 落地与 RegionMetadata→DOM 对齐 TODO（按优先级）

## P0 — 先跑通主链路

- 插件接入 HIR：Program 入口调用 `buildHIR` → `analyzeReactiveScopesWithSSA` → `generateRegions` → `lowerHIRWithRegions`，用生成函数替换原声明/导出，透传顶层 import/其它语句。
- 移除/停用 legacy JSX 降级与 `applyRegionTransform`，确保 JSX 只走 HIR 生成的 fine-grained DOM。
- 统一 Region 依赖命名：在 Region 生成或 DOM 匹配时拆解 `foo.bar`/`foo[...]`，保证 `findContainingRegion` 和 `applyRegionMetadata` 能命中 property 级依赖。
- Region memo 产出：在 DOM 降级处真正使用 RegionMetadata 决定 memo 包装与 destructuring（现有 `createRegionMemoWrapper` 未被调用）。
- Helper 注入对齐：让 `attachHelperImports`（或等效逻辑）对 HIR 产物生效，确保 useContext/useMemo/bind\*/template 等自动导入。

## P1 — 行为/覆盖完善

- JSX 特性补齐：Spread attrs、Fragment、组件调用、ref/style/class 等在 HIR 路径验证，与 legacy 行为对齐。
- 列表/条件节点：确认 `lowerIntrinsicElement` 使用 RegionMetadata 处理 list/conditional 子树时依赖 getter 注入与 memo 决策正确。
- 性能/健壮性：对无 JSX/无 Region 的函数走快路径，避免多余上下文/助手；跨 Region 的依赖访问确认不会重复调用 getter。
- Shapes/可选链：属性级订阅策略在 RegionMetadata→DOM 中生效，不回退到全对象订阅。

## P2 — 清理与验证

- 测试切换：将编译快照/行为测试默认跑 HIR 输出，移除 legacy 专用用例，新增 Region+DOM 结合的 property 依赖/控制流/列表场景。
- 配置/文档：删除 `experimentalHIR`/`hirCodegen` 关闭选项，文档声明 HIR-only；CI/脚本仅跑 HIR。
- 死代码清理：删除 unused 的 legacy region/memo 逻辑（`findNextRegion` 等）和未引用的 helper 路径，保持单一实现。

## 最终验收检查（确保无遗留路径）

- 运行时对齐：所有绑定/helper 导入与运行时版本一致，打包/tsc 使用 HIR 产物，构建流程无 legacy 分支。
- 属性级依赖：`props.value`/可选链等 property 级依赖能命中 Region，memo 与依赖 getter 注入正确。
- 无 JSX/无 Region 函数快路径：不会额外注入上下文或 helper，输出与直接 JS 相当。
- CI/样例：CI 和 examples 全部跑 HIR，没有隐含 env flag 或 fallback；如有 flag，则默认 HIR，禁用 legacy。
