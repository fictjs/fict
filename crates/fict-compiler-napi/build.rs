fn main() {
    napi_build::setup();
    println!(
        "cargo:rustc-env=FICT_NATIVE_TARGET={}",
        std::env::var("TARGET").expect("Cargo must provide TARGET to build scripts")
    );
}
