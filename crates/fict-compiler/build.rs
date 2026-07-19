use std::{
    env,
    error::Error,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

#[path = "src/build_id_input.rs"]
mod build_id_input;

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-env-changed=FICT_COMPILER_BUILD_REVISION");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_PREVIEW");

    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR")
            .ok_or("CARGO_MANIFEST_DIR is required to compute the compiler build id")?,
    );
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("fict-compiler must remain under <workspace>/crates")?;

    let mut inputs = vec![
        workspace_root.join("Cargo.lock"),
        workspace_root.join("Cargo.toml"),
        workspace_root.join("packages/compiler/compiler-capabilities.json"),
        workspace_root.join("rust-toolchain.toml"),
    ];
    collect_native_crate_inputs(&workspace_root.join("crates"), &mut inputs)?;
    inputs.sort();
    inputs.dedup();

    let mut hasher = Sha256::new();
    hasher.update(b"fict-compiler-build-id-v1\0");
    hasher.update(if env::var_os("CARGO_FEATURE_PREVIEW").is_some() {
        b"preview=1\0".as_slice()
    } else {
        b"preview=0\0".as_slice()
    });
    if let Some(revision) = env::var_os("FICT_COMPILER_BUILD_REVISION") {
        let revision = revision
            .into_string()
            .map_err(|_| "FICT_COMPILER_BUILD_REVISION must be valid UTF-8")?;
        if revision.len() != 40
            || !revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(
                "FICT_COMPILER_BUILD_REVISION must be a lowercase 40-character Git SHA-1".into(),
            );
        }
        println!("cargo:rustc-env=FICT_COMPILER_BUILD_REVISION={revision}");
        hasher.update(b"revision\0");
        hasher.update(revision.as_bytes());
        hasher.update(b"\0");
    }

    for input in inputs {
        let relative = input.strip_prefix(workspace_root)?;
        println!("cargo:rerun-if-changed={}", input.display());
        hasher.update(normalize_relative_path(relative).as_bytes());
        hasher.update(b"\0");
        let source = fs::read(&input)?;
        hasher.update(build_id_input::normalize_source_bytes(&source).as_ref());
        hasher.update(b"\0");
    }

    let digest = hasher.finalize();
    let mut source_hash = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut source_hash, "{byte:02x}")?;
    }
    println!("cargo:rustc-env=FICT_COMPILER_SOURCE_HASH={source_hash}");
    Ok(())
}

fn collect_native_crate_inputs(
    crates_directory: &Path,
    inputs: &mut Vec<PathBuf>,
) -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed={}", crates_directory.display());
    let mut entries = fs::read_dir(crates_directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);

    for entry in entries {
        if !entry.file_type()?.is_dir() || !entry.file_name().to_string_lossy().starts_with("fict-")
        {
            continue;
        }
        let crate_directory = entry.path();
        let manifest = crate_directory.join("Cargo.toml");
        if manifest.is_file() {
            inputs.push(manifest);
        }
        let build_script = crate_directory.join("build.rs");
        if build_script.is_file() {
            inputs.push(build_script);
        }
        let source_directory = crate_directory.join("src");
        if source_directory.is_dir() {
            collect_rust_sources(&source_directory, inputs)?;
        }
    }
    Ok(())
}

fn collect_rust_sources(directory: &Path, inputs: &mut Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);

    for entry in entries {
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_rust_sources(&path, inputs)?;
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            inputs.push(path);
        }
    }
    Ok(())
}

fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
