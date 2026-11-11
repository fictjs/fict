use std::cell::Cell;

thread_local! {
    static ON_COMPILER_STACK: Cell<bool> = const { Cell::new(false) };
}

/// Run an owned compiler operation on a stack sized for the bounded AST walks.
///
/// Node's main thread, libuv workers, and Rust test threads have different stack
/// sizes. A private scoped thread gives them the same recursion budget. Nested
/// compiler adapter calls reuse it, and unwinds still reach the caller's panic
/// boundary. AST depth is checked separately before recursive semantic passes.
pub fn with_compiler_stack<T: Send>(operation: impl FnOnce() -> T + Send) -> T {
    if ON_COMPILER_STACK.get() {
        return operation();
    }
    std::thread::scope(|scope| {
        let thread = std::thread::Builder::new()
            .name("fict-compiler".to_owned())
            .stack_size(64 * 1024 * 1024)
            .spawn_scoped(scope, || {
                ON_COMPILER_STACK.set(true);
                operation()
            })
            .expect("cannot allocate compiler worker stack");
        match thread.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}
