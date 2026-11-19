//! Keep one compiler stack alive for the lifetime of a fuzz target. Creating a
//! fresh instrumented thread for every input accumulates sanitizer thread state.
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

pub struct CompilerWorker {
    inputs: SyncSender<Vec<u8>>,
    completed: Receiver<()>,
}

impl CompilerWorker {
    pub fn new(check: fn(&[u8])) -> Self {
        let (inputs, pending) = sync_channel::<Vec<u8>>(0);
        let (done, completed) = sync_channel(0);
        std::thread::spawn(move || {
            fict_compiler::with_compiler_stack(|| {
                for input in pending {
                    check(&input);
                    if done.send(()).is_err() {
                        break;
                    }
                }
            });
        });
        Self { inputs, completed }
    }

    pub fn run(&self, input: &[u8]) {
        self.inputs
            .send(input.to_vec())
            .expect("compiler worker stopped");
        // libFuzzer must attribute coverage and failures to this exact input.
        self.completed
            .recv()
            .expect("compiler worker did not finish");
    }
}
