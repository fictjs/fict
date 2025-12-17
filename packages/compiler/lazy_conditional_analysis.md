## 🔬 Lazy Conditional深度分析报告

### 问题描述

测试 "lazily evaluates branch-only derived regions when conditionally rendered" 使用 `lazyConditional: true, fineGrainedDom: false` 期望fallback内容显示 `"fallback=0"` 但实际返回空字符串。

### Lazy Conditional机制分析

**1. analyzeConditionalUsage (rule-j.ts)**

- 扫描代码中的条件表达式（IfStatement、ConditionalExpression、createConditional调用）
- 识别只在true分支使用的derived值 → `trueBranchOnlyDerived`
- 识别只在false分支使用的derived值 → `falseBranchOnlyDerived`
- 如果没有branch-only值，返回null（不应用优化）

**2. generateLazyConditionalRegionMemo (rule-d.ts)**

- 将derived值语句分为三类：
  - `lazyTrue`: 只在true分支使用的
  - `lazyFalse`: 只在false分支使用的
  - `always`: 总是需要的
- 生成条件代码结构：

```javascript
const __fictCond_N = condition
const alwaysValue1 = ...
const alwaysValue2 = ...
if (__fictCond_N) {
  const trueBranchValue = ...
  return { ..., falseBranchValue: null, ... }
} else {
  const falseBranchValue = ...
  return { ..., trueBranchValue: null, ... }
}
```

**3. createReturnWithNulls关键逻辑**

- 在true分支：将`falseBranchOnlyDerived`的值设为`null`
- 在false分支：将`trueBranchOnlyDerived`的值设为`null`
- 对于非null值，检查是否为函数并调用它

### 根本原因假设

**假设1**: JSX在非fine-grained模式下无法正确处理null derived值

- 当`fallbackSummary`被设为null时，JSX `<p>{fallbackSummary}</p>`可能渲染为空

**假设2**: 条件分析误判

- `analyzeConditionalUsage`可能未正确识别JSX ternary中的条件
- 在非fine-grained模式下，JSX可能尚未转换为`createConditional调用

**假设3**: 测试配置问题

- `lazyConditional: true, fineGrainedDom: false`的组合可能不兼容
- lazy conditional可能设计为只在fine-grained模式下工作

### 验证步骤

1. ✅ 分析rule-j.ts和rule-d.ts实现
2. ⏳ 检查测试的编译输出，看derived值是否被正确分类
3. ⏳ 验证JSX如何处理null值
4. ⏳ 确定lazy conditional是否应该在非fine-grained模式下工作
